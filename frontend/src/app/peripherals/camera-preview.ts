import { HttpClient } from '@angular/common/http';
import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { problemOf } from '../board/board-error';
import { BoardService } from '../board/board.service';
import { visiblePoller } from '../polling';
import { withRequestErrors } from '../sources/stream-lines';
import type {
  CameraItem,
  CameraModeChoice,
  PreviewResponse,
  PreviewSession,
  PreviewStartRequest,
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
  type PreviewView,
  restartSelection,
  runPreviewStart,
  streamErrorEvent,
  watchPreview,
} from './preview-state';

const PREVIEW_URL = '/api/peripherals/preview';
const START_URL = '/api/peripherals/cameras/preview';

/** What the page shows a preview for: nothing, once it was stopped or the page left. */
const NOTHING_SHOWN: Pick<PreviewView, 'cameraId' | 'selection'> = {
  cameraId: null,
  selection: null,
};

/**
 * The camera preview of the Peripherals page, provided by the page so that it lives exactly as
 * long as the page: leaving Peripherals stops the preview (spec). It composes the pure steps of
 * `preview-state.ts` with the requests, and holds what the page shows a preview for (the camera
 * and the mode of the last start or mode change), which every step that resumes after an await
 * reads again.
 *
 * **Board changes.** A start, a board change and a refresh are serialized by the backend, and a
 * board change stops the preview there (`PreviewManager.stop_for_board_change`). So a session of
 * another board generation is only let go of here; a start that answers for the old board is
 * stopped and not restarted (Review Focus 1).
 *
 * **Two tabs.** The backend runs one preview per Insight and its stream has one reader. A preview
 * another tab shows is `elsewhere`, with Stop; a start refused with `preview_active` adopts the
 * running session instead of failing (Review Focus 3).
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

  private shown = NOTHING_SHOWN;
  /** Set by `release()`: the page is gone, so nothing is watched any more. */
  private released = false;

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
      const generation = this.board.generation();
      untracked(() => {
        const session = this.stateValue().session;
        // The backend stopped it when the board changed; there is nothing to stop or explain.
        if (session && generation !== null && session.generation !== generation) {
          this.dispatch({ type: 'reset' });
        }
      });
    });
  }

  /**
   * The preview the backend runs (`GET /api/peripherals/preview`, which never contacts the
   * board), for this board generation; null when none runs. Rejects with a `BoardProblem` when
   * it could not be read: a failed read says nothing about the preview.
   */
  async current(): Promise<PreviewSession | null> {
    try {
      const { session } = await firstValueFrom(
        this.http.get<PreviewResponse>(PREVIEW_URL).pipe(withRequestErrors()),
      );
      return session;
    } catch (failure) {
      throw problemOf(failure);
    }
  }

  /**
   * Starts the camera's preview in `mode` on board `generation`. A start the user moves away from
   * while the board starts it (another camera, board or mode) is stopped once it answers, and the
   * mode shown then is started; one refused because another tab started a preview adopts that
   * preview. Resolves when the start and any restart it led to have settled; never rejects, since
   * a failure is shown in `state`. The caller blocks a start for a snapshot of another board
   * generation (`previewBlock`'s `stale`): such a start is superseded from the outset, so its
   * refusal would not be shown.
   */
  async start(camera: CameraItem, mode: CameraModeChoice, generation: number): Promise<void> {
    const selection: CameraSelection = { ...mode, id: camera.id };
    this.shown = { cameraId: camera.id, selection };
    await runPreviewStart(
      { cameraId: camera.id, generation, mode: selection },
      {
        post: (next) => this.post(camera, next),
        lookup: () => this.current().catch(() => null),
        stop: (session) => this.stopSession(session.id, session),
        start: (next) => this.start(camera, next, generation),
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
   * stop yet: it is stopped once it answers, and the preview reads as stopping meanwhile.
   */
  async stop(): Promise<void> {
    this.shown = NOTHING_SHOWN;
    const { status, session } = this.stateValue();
    if (status === 'stopping') return;
    if (session) await this.stopSession(session.id);
    else if (status === 'starting') this.dispatch({ type: 'stopping' });
  }

  /**
   * The page leaves the camera this preview shows (another camera is selected, or the page goes):
   * this page's preview stops, and one still starting is stopped once it answers. One another tab
   * shows is that tab's to stop, so it is only let go of here (#170's `leavePreview`).
   */
  async leave(): Promise<void> {
    if (this.stateValue().status === 'elsewhere') {
      this.shown = NOTHING_SHOWN;
      this.dispatch({ type: 'reset' });
    } else {
      await this.stop();
    }
  }

  /**
   * Shows a session this page did not start: one running when the page opened, or the one a
   * refused start found. The page selects its camera and mode (`adoptedSelection`).
   */
  adopt(session: PreviewSession): void {
    this.shown = { cameraId: session.camera_id, selection: adoptedSelection(session) };
    this.dispatch({ type: 'adopt', session });
  }

  /**
   * The mode picked for `camera`. A preview of that camera that is live restarts on it (a stop,
   * then a start); one still starting is restarted once it answers. Another camera's preview, or
   * the mode already streaming, is left alone.
   */
  async changeMode(camera: CameraItem, mode: CameraModeChoice): Promise<void> {
    const selection: CameraSelection = { ...mode, id: camera.id };
    if (this.shown.cameraId === camera.id) this.shown = { cameraId: camera.id, selection };
    const state = this.stateValue();
    if (!state.session || !previewNeedsRestart(state, camera.id, mode)) return;
    this.shown = { cameraId: camera.id, selection };
    const requested = { cameraId: camera.id, generation: state.session.generation };
    if (!(await this.stopSession(state.session.id))) return;
    // A mode picked while the stop ran made no restart of its own (the preview was stopping), so
    // the mode selected now is started, not this call's.
    const next = restartSelection(requested, this.view());
    if (next) await this.start(camera, next, requested.generation);
  }

  /**
   * The `<img>` could not load the stream. The backend stops a preview whose stream ends (and one
   * whose stream nobody opened), so the preview has ended, with #170's "stream stopped" message;
   * unless another tab claimed the stream first, which shows it as running there. No stop is
   * sent: a stream this tab could not open may be the one another tab is showing.
   */
  async streamFailed(): Promise<void> {
    const session = this.stateValue().session;
    if (!session) return;
    this.dispatch(await streamErrorEvent(() => this.current(), session.id));
  }

  /**
   * Called when the page is destroyed. This page's preview, live or starting, is stopped at once
   * rather than left to the backend's 15 s reaper (Review Focus 2): a live one with a POST, one
   * still starting as soon as its session id arrives. One shown in another tab is that tab's to
   * stop, so it is only let go of here.
   */
  release(): void {
    this.released = true;
    void this.leave();
  }

  private async post(camera: CameraItem, mode: CameraSelection): Promise<PreviewSession> {
    const body: PreviewStartRequest = {
      id: camera.id,
      format: mode.format,
      width: mode.width,
      height: mode.height,
      fps: mode.fps,
    };
    // A start answers its session, never null (Inv-PB §4.3).
    const { session } = await firstValueFrom(
      this.http.post<{ session: PreviewSession }>(START_URL, body).pipe(withRequestErrors()),
    );
    return session;
  }

  /**
   * Stops a session; resolves whether it stopped. `known` is a session this page does not hold
   * yet (a start that answered too late), shown while it stops. A failed stop keeps the preview
   * as it was (live, or shown in another tab) with its failure, so Stop can be retried: it must
   * not look successful while the board may still be streaming.
   */
  private async stopSession(
    sessionId: string,
    known: PreviewSession | null = null,
  ): Promise<boolean> {
    const from = this.stateValue().status === 'elsewhere' ? 'elsewhere' : 'live';
    this.dispatch({ type: 'stopping', for: sessionId, session: known });
    try {
      await firstValueFrom(
        this.http.post<PreviewResponse>(stopUrl(sessionId), {}).pipe(withRequestErrors()),
      );
    } catch (failure) {
      this.dispatch({ type: 'stop-failed', for: sessionId, from, error: problemOf(failure) });
      return false;
    }
    this.dispatch({ type: 'stopped', for: sessionId });
    return true;
  }

  private view(): PreviewView {
    return { ...this.shown, generation: this.board.generation() };
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

function stopUrl(sessionId: string): string {
  return `${START_URL}/${encodeURIComponent(sessionId)}/stop`;
}
