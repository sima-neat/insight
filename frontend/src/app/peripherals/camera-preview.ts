import { HttpClient } from '@angular/common/http';
import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { boardUrl } from '../board/api';
import { problemOf } from '../board/board-error';
import { BoardService } from '../board/board.service';
import { visiblePoller } from '../polling';
import { withRequestErrors } from '../sources/api-errors';
import type {
  CameraItem,
  CameraModeChoice,
  PreviewAnswer,
  PreviewMode,
  PreviewSession,
} from './api';
import {
  adoptedSelection,
  type CameraSelection,
  nextPreviewState,
  PREVIEW_IDLE,
  PREVIEW_POLL_MS,
  type PreviewEvent,
  previewNeedsRestart,
  type PreviewState,
  type PreviewTimer,
  previewUrl,
  type PreviewView,
  restartSelection,
  runPreviewStart,
  streamErrorEvent,
  watchPreview,
} from './preview-state';
import type { PreviewResume } from './peripherals-session';

/** What the page shows a preview for: nothing, once it was stopped or the page left. */
const NOTHING_SHOWN: Pick<PreviewView, 'cameraId' | 'selection'> = {
  cameraId: null,
  selection: null,
};

/**
 * The camera preview of the Peripherals page, provided by the page so that it lives exactly as
 * long as the page: leaving Peripherals stops the preview. It composes the pure steps of
 * `preview-state.ts` with the requests, and holds what the page shows a preview for (the camera
 * and the mode of the last start or mode change), which every step that resumes after an await
 * reads again.
 *
 * **Board changes.** Every request names the board by its id, and the server stops a board's
 * preview when the board is replaced. So a preview of another board than the selected one is
 * only let go of here; a start that answers after the board changed is stopped and not restarted.
 *
 * **Two tabs.** The server runs one preview per board and its stream has one reader. A preview
 * another tab shows is `elsewhere`, with Stop; a start refused with `preview_active` adopts the
 * running preview instead of failing, whatever camera it is on. Every adoption goes through the
 * page first (`onAdopt`), which shows the preview's camera, so that the page never leaves, and
 * thereby stops, a preview it just took up.
 *
 * **Watching.** While `live` or `elsewhere`, the preview is read every 2.5 s through
 * `visiblePoller` (a hidden tab reads nothing, and reads at once when it shows): an `<img>` fires
 * no event when a multipart stream ends cleanly, and a MIPI camera's rate arrives after the start.
 */
@Injectable()
export class CameraPreview {
  private readonly http = inject(HttpClient);
  private readonly board = inject(BoardService);

  private readonly stateValue = signal<PreviewState>(PREVIEW_IDLE);
  readonly state = this.stateValue.asReadonly();

  private readonly shown = signal(NOTHING_SHOWN);
  /**
   * The camera of the preview this page holds: the session's once there is one, else the camera
   * the last start was asked for (one still starting, or failed); null once stopped or let go of.
   * The camera's panel shows the preview by it, and the page leaves it when that panel goes.
   */
  readonly camera = computed(() => this.stateValue().session?.camera ?? this.shown().cameraId);
  /** The board of the last start asked for (`start`'s `board`). */
  private startedOn: string | null = null;
  /** The starts asked for by the page that have not settled yet, restarts within them included. */
  private readonly starts = new Set<Promise<void>>();
  /** The stop request out, if one is. */
  private stopping: Promise<boolean> | null = null;
  /** Set by `release()`: the page is gone, so nothing is watched any more. */
  private released = false;
  /** The page's step for an adopted session (`onAdopt`); without a page, every session is taken up. */
  private show: (session: PreviewSession) => boolean = () => true;

  private watch: { sessionId: string; cancel: () => void } | null = null;
  private watchTick: (() => void) | null = null;
  private readonly poller = visiblePoller(PREVIEW_POLL_MS, () => this.watchTick?.());
  /** The one watch running at a time ticks with the poller. */
  private readonly timer: PreviewTimer = {
    start: (tick) => {
      this.watchTick = tick;
      this.poller.setActive(true);
    },
    stop: () => {
      this.watchTick = null;
      this.poller.setActive(false);
    },
  };

  constructor() {
    effect(() => {
      const board = this.board.id();
      untracked(() => {
        const session = this.stateValue().session;
        // The server stopped it when the board changed; there is nothing to stop or explain.
        if (session && board !== null && session.board !== board) this.dispatch({ type: 'reset' });
      });
    });
  }

  /**
   * The preview the selected board runs (`GET .../cameras/preview`, which never contacts the
   * board); null when none runs or no board is selected. Rejects with a `BoardProblem` when it
   * could not be read: a failed read says nothing about the preview.
   */
  async current(): Promise<PreviewSession | null> {
    const board = this.board.id();
    if (board === null) return null;
    try {
      const { preview } = await firstValueFrom(
        this.http.get<PreviewAnswer>(boardUrl(board, 'cameras/preview')).pipe(withRequestErrors()),
      );
      return preview ? { ...preview, board } : null;
    } catch (failure) {
      throw problemOf(failure);
    }
  }

  /**
   * Starts the camera's preview in `mode` on `board`. A start the user moves away from while the
   * board starts it (another camera, board or mode) is stopped once it answers, and the mode shown
   * then is started; one refused because another tab started a preview adopts that preview.
   * Resolves when the start and any restart it led to have settled; never rejects, since a
   * failure is shown in `state`. The caller blocks a start for a snapshot of another board
   * (`previewBlock`'s `stale`): such a start is superseded from the outset, so its refusal would
   * not be shown.
   */
  start(camera: CameraItem, mode: CameraModeChoice, board: string): Promise<void> {
    const run = this.runStart(camera, mode, board);
    this.starts.add(run);
    void run.finally(() => this.starts.delete(run));
    return run;
  }

  private async runStart(camera: CameraItem, mode: CameraModeChoice, board: string): Promise<void> {
    const selection: CameraSelection = { ...mode, id: camera.id };
    this.shown.set({ cameraId: camera.id, selection });
    this.startedOn = board;
    await runPreviewStart(
      { cameraId: camera.id, board, mode: selection },
      {
        post: (next) => this.post(camera, next, board),
        lookup: () => this.current().catch(() => null),
        stop: (session) => this.stopSession(session, session),
        start: (next) => this.start(camera, next, board),
        adopt: (session) => this.adopt(session),
        dispatch: (event) => this.dispatch(event),
        view: () => this.view(),
        normalize: problemOf,
        reloadBoard: () => void this.board.reload(),
      },
    );
  }

  /**
   * Stops the preview, also one another tab shows (its Stop). A start still out has no session to
   * stop yet: it is stopped once it answers, and the preview reads as stopping meanwhile. Called
   * while a stop is already under way, it sends nothing and settles with that stop (and with a
   * start still out, which makes the stop once it answers).
   */
  async stop(): Promise<void> {
    this.shown.set(NOTHING_SHOWN);
    const { status, session } = this.stateValue();
    if (status === 'stopping') {
      await Promise.all([this.stopping, ...this.starts]);
      return;
    }
    if (session) await this.stopSession(session);
    else if (status === 'starting') this.dispatch({ type: 'stopping' });
  }

  /**
   * The page leaves the camera this preview shows (another camera is selected, or the page goes):
   * this page's preview stops, and one still starting is stopped once it answers. One another tab
   * shows is that tab's to stop, so it is only let go of here.
   */
  async leave(): Promise<void> {
    if (this.stateValue().status === 'elsewhere') {
      this.shown.set(NOTHING_SHOWN);
      this.dispatch({ type: 'reset' });
    } else {
      await this.stop();
    }
  }

  /**
   * How the page shows a session it adopts, on entry and after a refused start alike: it selects
   * the session's camera, opens the side panel and remembers the mode the session streams, and
   * answers whether that camera's panel shows now. The page sets it once, as it is created.
   */
  onAdopt(show: (session: PreviewSession) => boolean): void {
    this.show = show;
  }

  /**
   * Takes up a session this page did not start: one running when the page opened, or the one a
   * refused start found. The page shows it first (`onAdopt`); one it cannot show (its camera is not
   * listed) is not taken up, since the page leaves a preview no panel shows, which would stop
   * another tab's preview. Answers whether it was taken up.
   */
  adopt(session: PreviewSession): boolean {
    if (!this.show(session)) return false;
    this.shown.set({ cameraId: session.camera, selection: adoptedSelection(session) });
    this.dispatch({ type: 'adopt', session });
    return true;
  }

  /**
   * The mode picked for `camera`. A preview of that camera that is live restarts on it (a stop,
   * then a start); one still starting is restarted once it answers. Another camera's preview, or
   * the mode already streaming, is left alone.
   */
  async changeMode(camera: CameraItem, mode: CameraModeChoice): Promise<void> {
    const selection: CameraSelection = { ...mode, id: camera.id };
    if (this.shown().cameraId === camera.id) this.shown.set({ cameraId: camera.id, selection });
    const state = this.stateValue();
    if (!state.session || !previewNeedsRestart(state, camera.id, mode)) return;
    this.shown.set({ cameraId: camera.id, selection });
    const requested = { cameraId: camera.id, board: state.session.board };
    if (!(await this.stopSession(state.session))) return;
    // A mode picked while the stop ran made no restart of its own (the preview was stopping), so
    // the mode selected now is started, not this call's.
    const next = restartSelection(requested, this.view());
    if (next) await this.start(camera, next, requested.board);
  }

  /**
   * The `<img>` could not load the stream. The server stops a preview whose stream ends (and one
   * whose stream nobody opened), so the preview has ended; unless another tab claimed the stream
   * first, which shows it as running there. No stop is sent: a stream this tab could not open may
   * be the one another tab is showing.
   */
  async streamFailed(): Promise<void> {
    const session = this.stateValue().session;
    if (!session) return;
    this.dispatch(await streamErrorEvent(() => this.current(), session.id));
  }

  /**
   * What to start again when the page comes back (leaving Peripherals stops the preview, coming
   * back starts it again): the camera, mode and board of this page's preview while it starts
   * (what was asked for) or is live (what the board streams). Null otherwise: one stopping or
   * failed has nothing to come back to, and one shown in another tab is that tab's.
   */
  resumable(): PreviewResume | null {
    const { status, session } = this.stateValue();
    if (status === 'live' && session) {
      const { format, width, height, fps } = session.mode;
      return {
        cameraId: session.camera,
        mode: { format, width, height, fps },
        board: session.board,
      };
    }
    const selection = this.shown().selection;
    if (status === 'starting' && selection && this.startedOn !== null) {
      const { format, width, height, fps } = selection;
      return {
        cameraId: selection.id,
        mode: { format, width, height, fps },
        board: this.startedOn,
      };
    }
    return null;
  }

  /**
   * Called when the page is destroyed. This page's preview, live or starting, is stopped at once
   * rather than left to the server's 15 s reaper: a live one with a POST, one still starting as
   * soon as its session id arrives. One shown in another tab is that tab's to stop, so it is only
   * let go of here. Settles once those stops have answered (failed or not) and every start still
   * out has settled: the page's next visit waits for it before it reads the preview and starts it
   * again, or its start would find the old one still running on the board and adopt a preview
   * about to be stopped. Never rejects.
   */
  release(): Promise<void> {
    this.released = true;
    return Promise.all([this.leave(), ...this.starts]).then(() => undefined);
  }

  private async post(
    camera: CameraItem,
    mode: CameraSelection,
    board: string,
  ): Promise<PreviewSession> {
    const body: PreviewMode = {
      format: mode.format,
      width: mode.width,
      height: mode.height,
      fps: mode.fps,
    };
    const url = boardUrl(board, `cameras/${encodeURIComponent(camera.id)}/preview`);
    // A start answers its preview, never null.
    const { preview } = await firstValueFrom(
      this.http.post<PreviewAnswer>(url, body).pipe(withRequestErrors()),
    );
    if (!preview) throw problemOf(new Error('The board answered the start without its preview.'));
    return { ...preview, board };
  }

  /**
   * Stops a session; resolves whether it stopped. `known` is a session this page does not hold
   * yet (a start that answered too late), shown while it stops. A failed stop keeps the preview
   * as it was (live, or shown in another tab) with its failure, so Stop can be retried: it must
   * not look successful while the board may still be streaming.
   */
  private stopSession(
    session: PreviewSession,
    known: PreviewSession | null = null,
  ): Promise<boolean> {
    const from = this.stateValue().status === 'elsewhere' ? 'elsewhere' : 'live';
    this.dispatch({ type: 'stopping', for: session.id, session: known });
    const stopped = this.postStop(session, from);
    this.stopping = stopped;
    void stopped.finally(() => {
      if (this.stopping === stopped) this.stopping = null;
    });
    return stopped;
  }

  private async postStop(session: PreviewSession, from: 'live' | 'elsewhere'): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http
          .post<PreviewAnswer>(
            previewUrl(session, '/stop'),
            {},
            { params: { preview: session.id } },
          )
          .pipe(withRequestErrors()),
      );
    } catch (failure) {
      const error = problemOf(failure);
      // A board that is no longer selected stopped its preview when it was replaced.
      if (error.code !== 'not_found') {
        this.dispatch({ type: 'stop-failed', for: session.id, from, error });
        return false;
      }
      void this.board.reload();
    }
    this.dispatch({ type: 'stopped', for: session.id });
    return true;
  }

  private view(): PreviewView {
    return { ...this.shown(), board: this.board.id() };
  }

  private dispatch(event: PreviewEvent): void {
    const next = nextPreviewState(this.stateValue(), event);
    this.stateValue.set(next);
    this.syncWatch(next);
  }

  /** Watches the session while it is live or shown elsewhere, and nothing otherwise. */
  private syncWatch(state: PreviewState): void {
    const watched =
      !this.released && (state.status === 'live' || state.status === 'elsewhere')
        ? (state.session?.id ?? null)
        : null;
    if (watched === (this.watch?.sessionId ?? null)) return;
    this.watch?.cancel();
    this.watch = null;
    if (watched !== null) {
      const cancel = watchPreview(
        () => this.current(),
        watched,
        (event) => this.dispatch(event),
        this.timer,
      );
      this.watch = { sessionId: watched, cancel };
    }
  }
}
