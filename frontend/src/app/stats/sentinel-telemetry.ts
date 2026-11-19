import { HttpClient } from '@angular/common/http';
import {
  computed,
  DestroyRef,
  DOCUMENT,
  effect,
  inject,
  Injectable,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { boardUrl } from '../board/api';
import { BOARD_GONE_CODES } from '../board/board-error';
import { BoardService } from '../board/board.service';
import { LatestOnly, visiblePoller } from '../polling';
import { withRequestErrors } from '../sources/stream-lines';
import type { SentinelCache, SentinelHealthAnswer } from './api';
import type { SentinelReading } from './daemon-view';
import {
  failureOf,
  haltsPolling,
  pollDelay,
  sentinelUnusable,
  type SentinelFailure,
} from './sentinel-failure';
import { cacheAfter, mergeTelemetry, type TelemetryWindow } from './telemetry';

/** How often Sentinel's health is re-read, to catch restarts and health changes made elsewhere. */
const STATE_CHECK_MS = 30_000;

/** What the Stats page's chip says about the metrics: updating, paused by the user, or not updating. */
export type TelemetryUpdate = 'live' | 'paused' | 'stopped';

/**
 * The selected board's Sentinel telemetry, for the Stats page. Provided by the page, so it lives
 * exactly as long as the page: leaving Stats stops every request to the board, and Sentinel keeps
 * its own recent samples, so coming back shows the whole window at once.
 *
 * **State.** `GET /api/boards/<id>/sentinel/health` says whether Sentinel answers. It is read
 * when the page opens and when the board changes, every 30 s while a board is selected (paused or
 * not), and when the window regains focus; the periodic and focus reads are skipped while one is
 * out, which answers for them. Only the newest answer is applied. A failure that says Sentinel
 * cannot be used (`sentinelUnusable`: not installed, stopped, refusing the user, another API)
 * drops the state; any other keeps the last one beside the reason it could not be read: one lost
 * read must not take the telemetry off the page.
 *
 * **Metrics.** `GET /api/boards/<id>/sentinel/cache` is polled one request at a time while a
 * board is selected, Sentinel answers, the page shows the metrics (`setWatching`), the user has
 * not paused, no failure halted polling and the tab is visible. The first poll asks for the whole
 * cache; the next ones pass `after`, the newest sample held, and get only the newer ones unless
 * the answer is `full` (`mergeTelemetry`). The next poll is due 2 s after the previous one
 * started, or longer after failures in a row (`pollDelay`). A failure whose code says the board or
 * the daemon cannot answer (`haltsPolling`) halts polling and re-reads the state. A state read
 * that answers lifts the halt, and the next poll waits out the halting poll's backoff: the state
 * can answer while the cache read keeps failing (a timeout, say), and polling at once would hit
 * the board back to back. `retry()` lifts it and polls at once.
 *
 * **Board changes.** Everything held is the selected board's, named by its id. A board change
 * drops it, re-reads the state and frees the poll slot: a request still out to the previous board
 * is ignored when it lands, never waited for, so the new board is polled as soon as its state
 * says Sentinel answers. A failure saying the board was replaced (`BOARD_GONE_CODES`) reloads the
 * board, whose new id then drops what is held.
 *
 * **Hidden tab.** A hidden tab sends nothing: each request runs on the board. Showing it again
 * reads the state and polls at once, once, however often it was hidden and shown.
 */
@Injectable()
export class SentinelTelemetry {
  private readonly http = inject(HttpClient);
  private readonly board = inject(BoardService);
  private readonly document = inject(DOCUMENT);

  private readonly stateValue = signal<SentinelReading | null>(null);
  /** Sentinel's health on the current board, while it answers; null until read, or while it does not. */
  readonly state = this.stateValue.asReadonly();

  private readonly stateFailureValue = signal<SentinelFailure | null>(null);
  /** Why the newest state read failed; cleared by the next good one. */
  readonly stateFailure = this.stateFailureValue.asReadonly();

  /** Sentinel answers on the current board: its telemetry, traces and runs can be read. */
  readonly ready = computed(() => this.stateValue()?.board === this.board.id());

  /** State reads out to the current board. */
  private readonly stateReadsOut = signal(0);
  /** The state is being read and none is known yet: the page says it is checking. */
  readonly checking = computed(
    () =>
      this.stateReadsOut() > 0 && this.stateValue() === null && this.stateFailureValue() === null,
  );

  /** "Check again" reads out to the current board. */
  private readonly rechecksOut = signal(0);
  /** Sentinel is being asked again ("Check again"): the page waits with the button until it answers. */
  readonly rechecking = computed(() => this.rechecksOut() > 0);

  private readonly windowValue = signal<TelemetryWindow | null>(null);
  /** The telemetry held for the current board; null until its first answer. */
  readonly window = this.windowValue.asReadonly();

  private readonly failureValue = signal<SentinelFailure | null>(null);
  /** Why the last poll failed; cleared by the next answer. The window stays as it was. */
  readonly failure = this.failureValue.asReadonly();

  private readonly pausedValue = signal(false);
  /** The user paused the metrics. A board change keeps it: it is the user's choice, not the board's. */
  readonly paused = this.pausedValue.asReadonly();

  /**
   * The page shows the metrics (Live). The state is read either way: the other views' gating
   * (checking, not ready) and the Record button follow it.
   */
  private readonly watching = signal(true);

  /** A failure said the board or the daemon cannot answer: no poll until the state says it can. */
  private readonly halted = signal(false);
  private readonly visible = signal(this.document.visibilityState === 'visible');
  private readonly targeted = computed(() => this.board.id() !== null);

  /** Whether metrics are polled now. */
  private readonly polling = computed(
    () =>
      this.ready() && this.watching() && !this.pausedValue() && !this.halted() && this.visible(),
  );

  /**
   * Paused by the user; stopped while the last poll failed, though the backoff keeps polling
   * underneath (the values on screen are not changing), or while nothing is polled; live otherwise.
   */
  readonly update = computed<TelemetryUpdate>(() => {
    if (this.pausedValue()) return 'paused';
    return this.failureValue() !== null || !this.polling() ? 'stopped' : 'live';
  });

  /** Failed polls in a row, for the backoff. */
  private failures = 0;
  /** The next poll, while one is scheduled. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The poll out to the current board, while one is: an answer is applied only while it is its own. */
  private polled: object | null = null;
  private readonly stateReads = new LatestOnly();
  /**
   * Counts board changes. A state read counts towards `stateReadsOut` only while no change came
   * after it was sent: the previous board's count went with that board.
   */
  private switches = 0;
  /**
   * When the poll that halted polling started: a state read that lifts the halt schedules the next
   * poll from it.
   */
  private haltedAt = 0;
  /** The id of the board everything held is of; undefined before the first look at the board. */
  private boardId: string | null | undefined = undefined;
  private destroyed = false;

  private readonly stateChecks = visiblePoller(STATE_CHECK_MS, () => this.checkState());

  constructor() {
    effect(() => {
      const id = this.board.id();
      untracked(() => this.follow(id));
    });

    const onVisibility = () => {
      this.visible.set(this.document.visibilityState === 'visible');
      this.sync();
    };
    // A read still out answers for this focus too, as for the board's own focus re-read.
    const onFocus = () => {
      if (this.targeted()) this.checkState();
    };
    const view = this.document.defaultView;
    this.document.addEventListener('visibilitychange', onVisibility);
    view?.addEventListener('focus', onFocus);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      // A poll still out lands on nothing: its answer or failure applies, reloads and reads nothing.
      this.polled = null;
      this.stopTimer();
      this.document.removeEventListener('visibilitychange', onVisibility);
      view?.removeEventListener('focus', onFocus);
    });
  }

  /**
   * Whether the page shows the metrics. While it does not, no metric is polled (a poll already
   * out still lands); showing them again polls at once, for the samples after the newest held.
   */
  setWatching(watching: boolean): void {
    this.watching.set(watching);
    // The page calls this from its own effect, which must not come to depend on the polling.
    untracked(() => this.sync());
  }

  /** No more metric polls until `resume()`. A poll already out still lands. */
  pause(): void {
    this.pausedValue.set(true);
    this.sync();
  }

  /** Polls at once, and on from there. */
  resume(): void {
    this.pausedValue.set(false);
    this.sync();
  }

  /**
   * Clears the halt and the backoff and polls at once. A poll still out is this retry's poll; a
   * backed-off one waiting is sent now. The failure stays until a poll answers. While Sentinel is
   * not known to answer, nothing would be polled on it: the state is read again (the user may just
   * have started the service), and an answer polls.
   */
  retry(): void {
    this.failures = 0;
    this.halted.set(false);
    if (this.polled === null) this.stopTimer();
    if (!this.ready()) void this.readState(true);
    this.sync();
  }

  /**
   * Reads the state again now ("Check again"), even while another read is out. Resolves once the
   * answer is applied or dropped; never rejects, since a failure is reported in `stateFailure`.
   */
  recheck(): Promise<void> {
    return this.readState(true);
  }

  /** Follows the selected board: another id drops everything held of the previous one. */
  private follow(id: string | null): void {
    if (id !== this.boardId) {
      this.boardId = id;
      this.reset();
    }
    // Restarting the check reads the board at once (once the tab shows, if it is hidden) and
    // counts its 30 s from now.
    this.stateChecks.setActive(false);
    this.stateChecks.setActive(id !== null);
  }

  private reset(): void {
    this.switches++;
    this.stateReads.discard();
    this.stateReadsOut.set(0);
    this.rechecksOut.set(0);
    this.polled = null;
    this.stopTimer();
    this.failures = 0;
    this.halted.set(false);
    this.stateValue.set(null);
    this.stateFailureValue.set(null);
    this.windowValue.set(null);
    this.failureValue.set(null);
  }

  /**
   * Reads the state unless a read is out, which answers for this one, or the tab is hidden: the
   * state check reads it at once when the tab shows. The document is asked, not `visible`: the
   * state check's own visibilitychange listener may run before the one that updates `visible`.
   */
  private checkState(): void {
    if (this.document.visibilityState !== 'visible') return;
    if (this.stateReadsOut() === 0) void this.readState(false);
  }

  private async readState(recheck: boolean): Promise<void> {
    const id = this.board.id();
    if (this.destroyed || id === null) return;
    const request = this.stateReads.next();
    const switches = this.switches;
    this.stateReadsOut.update((count) => count + 1);
    if (recheck) this.rechecksOut.update((count) => count + 1);
    let lifted = false;
    try {
      const answer = await firstValueFrom(
        this.http
          .get<SentinelHealthAnswer>(boardUrl(id, 'sentinel/health'))
          .pipe(withRequestErrors()),
      );
      // A board change discarded the reads out to the previous board.
      if (this.destroyed || !this.stateReads.accept(request)) return;
      this.stateValue.set({ board: id, health: answer.health ?? {}, startedAt: answer.started_at });
      this.stateFailureValue.set(null);
      lifted = this.halted();
      this.halted.set(false);
    } catch (error) {
      // A failure answers for the reads sent before it as well, as an answer would.
      if (this.destroyed || !this.stateReads.isNewest(request)) return;
      if (!this.stateReads.accept(request)) return;
      const failure = failureOf(error, id);
      if (BOARD_GONE_CODES.has(failure.code)) void this.board.reload();
      if (sentinelUnusable(failure.code)) this.stateValue.set(null);
      this.stateFailureValue.set(failure);
    } finally {
      if (switches === this.switches) {
        this.stateReadsOut.update((count) => count - 1);
        if (recheck) this.rechecksOut.update((count) => count - 1);
      }
    }
    // While halted nothing is scheduled or out, so the halting poll's backoff is armed here.
    if (lifted) this.scheduleAfter(this.haltedAt);
    else this.sync();
  }

  /**
   * Starts polling when it should run and no poll is scheduled or out, and stops the scheduled
   * one when it should not. A poll out is left to land: its answer is still this board's.
   */
  private sync(): void {
    if (this.destroyed || !this.polling()) {
      this.stopTimer();
      return;
    }
    if (this.timer === null && this.polled === null) void this.poll();
  }

  private async poll(): Promise<void> {
    this.timer = null;
    const id = this.board.id();
    if (id === null) return;
    const token = {};
    this.polled = token;
    const started = Date.now();
    const after = cacheAfter(this.windowValue(), id);
    try {
      const answer = await firstValueFrom(
        this.http
          .get<SentinelCache>(boardUrl(id, 'sentinel/cache'), {
            params: after === null ? {} : { after },
          })
          .pipe(withRequestErrors()),
      );
      if (this.polled !== token) return;
      this.polled = null;
      this.windowValue.set(mergeTelemetry(this.windowValue(), answer, id));
      this.failures = 0;
      this.failureValue.set(null);
    } catch (error) {
      if (this.polled !== token) return;
      this.polled = null;
      const failure = failureOf(error, id);
      if (BOARD_GONE_CODES.has(failure.code)) void this.board.reload();
      this.failureValue.set(failure);
      this.failures++;
      // The next poll would fail the same way: the state says why, and when to go on.
      if (haltsPolling(failure.code)) {
        this.halted.set(true);
        this.haltedAt = started;
        this.checkState();
      }
    }
    this.scheduleAfter(started);
  }

  /**
   * Schedules the next poll `pollDelay` after the one that started at `started`, so a slow answer
   * does not stretch the cadence; one slower than the delay is followed at once.
   */
  private scheduleAfter(started: number): void {
    if (this.destroyed || !this.polling()) return;
    const wait = Math.max(0, pollDelay(this.failures) - (Date.now() - started));
    this.timer = setTimeout(() => void this.poll(), wait);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
