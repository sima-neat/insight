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
import { BoardService } from '../board/board.service';
import { LatestOnly, visiblePoller } from '../polling';
import { withRequestErrors } from '../sources/stream-lines';
import type { MetricsQuery, SentinelMetrics, SentinelState } from './api';
import { failureOf, haltsPolling, pollDelay, type SentinelFailure } from './sentinel-failure';
import { SentinelInstall } from './sentinel-install';
import { mergeTelemetry, metricsQuery, type TelemetryWindow } from './telemetry';

const STATE_URL = '/api/sentinel';
const METRICS_URL = '/api/sentinel/metrics';
/** How often the daemon's state is re-read, to catch restarts and health changes made elsewhere. */
const STATE_CHECK_MS = 30_000;

/** What the Stats page's chip says about the metrics: updating, paused by the user, or not updating. */
export type TelemetryUpdate = 'live' | 'paused' | 'stopped';

/**
 * The selected board's Sentinel telemetry, for the Stats page. Provided by the page, so it lives
 * exactly as long as the page: leaving Stats stops every request to the board, and the backend
 * holds the history, so coming back shows the whole window at once.
 *
 * **State.** `GET /api/sentinel` says whether Sentinel answers. It is read when the page opens
 * and when the board changes, every 30 s while a board is selected (paused or not), and when the
 * window regains focus; the periodic and focus reads are skipped while one is out, which answers
 * for them. Only the newest answer is applied. A failed read keeps the last state, beside the
 * reason it could not be read: one lost read must not take the telemetry off the page.
 *
 * **Metrics.** `GET /api/sentinel/metrics` is polled one request at a time while a board is
 * selected, its state says available, the user has not paused, no failure halted polling and the
 * tab is visible. The next poll is due 2 s after the previous one started, or longer after
 * failures in a row (`pollDelay`). A failure whose code says the board or the daemon cannot
 * answer (`haltsPolling`) halts polling and re-reads the state; a state read that says available,
 * or `retry()`, starts it again.
 *
 * **Board changes.** Everything held is the current board generation's. A board change drops it,
 * re-reads the state and frees the poll slot: a request still out to the previous board is
 * ignored when it lands, never waited for, so the new board is polled as soon as its state says
 * available (#170's "a board switch is not blocked by a request still out to the previous
 * board"). An answer or failure that names another generation than the one it was asked under
 * means another client switched the board: the board is reloaded and the answer dropped.
 *
 * **Hidden tab.** A hidden tab sends nothing: each request runs on the board. Showing it again
 * reads the state and polls at once, once, however often it was hidden and shown.
 */
@Injectable()
export class SentinelTelemetry {
  private readonly http = inject(HttpClient);
  private readonly board = inject(BoardService);
  private readonly install = inject(SentinelInstall);
  private readonly document = inject(DOCUMENT);

  private readonly stateValue = signal<SentinelState | null>(null);
  /** The daemon's state on the current board; null until read. */
  readonly state = this.stateValue.asReadonly();

  private readonly stateFailureValue = signal<SentinelFailure | null>(null);
  /** Why the newest state read failed; cleared by the next good one. */
  readonly stateFailure = this.stateFailureValue.asReadonly();

  /** State reads out to the current board. */
  private readonly stateReadsOut = signal(0);
  /** The state is being read and none is known yet: the page says it is checking. */
  readonly checking = computed(() => this.stateReadsOut() > 0 && this.stateValue() === null);

  private readonly windowValue = signal<TelemetryWindow | null>(null);
  /** The telemetry held for the current board; null until its first answer. */
  readonly window = this.windowValue.asReadonly();

  private readonly failureValue = signal<SentinelFailure | null>(null);
  /** Why the last poll failed; cleared by the next answer. The window stays as it was. */
  readonly failure = this.failureValue.asReadonly();

  private readonly pausedValue = signal(false);
  /** The user paused the metrics. A board change keeps it: it is the user's choice, not the board's. */
  readonly paused = this.pausedValue.asReadonly();

  /** A failure said the board or the daemon cannot answer: no poll until the state says it can. */
  private readonly halted = signal(false);
  private readonly visible = signal(this.document.visibilityState === 'visible');
  private readonly targeted = computed(() => this.board.state()?.target != null);

  /**
   * Whether metrics are polled now. The state must be the current board's: between a board change
   * and the effect that drops what was held of the previous board, it still names that one.
   */
  private readonly polling = computed(() => {
    const state = this.stateValue();
    return (
      this.targeted() &&
      state !== null &&
      state.available &&
      state.generation === this.board.generation() &&
      !this.pausedValue() &&
      !this.halted() &&
      this.visible()
    );
  });

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
  /** The board generation everything held is of; undefined before the first look at the board. */
  private generation: number | null | undefined = undefined;
  private destroyed = false;

  private readonly stateChecks = visiblePoller(STATE_CHECK_MS, () => this.checkState());

  constructor() {
    effect(() => {
      const generation = this.board.generation();
      const targeted = this.targeted();
      untracked(() => this.follow(generation, targeted));
    });

    // An install that ended before this page existed is covered by the page's first state read.
    let seen = this.install.outcome();
    effect(() => {
      const outcome = this.install.outcome();
      if (outcome === seen) return;
      seen = outcome;
      // A hidden tab sends nothing. It reads the state when it shows again, and the install left
      // the daemon status it ended with in the backend's cache for that read.
      untracked(() => {
        if (outcome?.ok && outcome.generation === this.board.generation() && this.visible()) {
          void this.recheck();
        }
      });
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
   * backed-off one waiting is sent now. The failure stays until a poll answers.
   */
  retry(): void {
    this.failures = 0;
    this.halted.set(false);
    if (this.polled === null) this.stopTimer();
    this.sync();
  }

  /**
   * Reads the state with `refresh=1`, which makes the backend ask the board's service manager
   * again instead of answering its cached daemon status ("Check again"). Resolves once the answer
   * is applied or dropped; never rejects, since a failure is reported in `stateFailure`.
   */
  recheck(): Promise<void> {
    return this.readState(true);
  }

  /** Follows the selected board: another generation drops everything held of the previous one. */
  private follow(generation: number | null, targeted: boolean): void {
    if (generation !== this.generation) {
      this.generation = generation;
      this.reset();
    }
    // Restarting the check reads the board at once (once the tab shows, if it is hidden) and
    // counts its 30 s from now.
    this.stateChecks.setActive(false);
    this.stateChecks.setActive(targeted);
  }

  private reset(): void {
    this.switches++;
    this.stateReads.discard();
    this.stateReadsOut.set(0);
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
    if (this.stateReadsOut() === 0 && this.document.visibilityState === 'visible') {
      void this.readState(false);
    }
  }

  private async readState(refresh: boolean): Promise<void> {
    const generation = this.board.generation();
    if (this.destroyed || !this.targeted() || generation === null) return;
    const request = this.stateReads.next();
    const switches = this.switches;
    this.stateReadsOut.update((count) => count + 1);
    try {
      const state = await firstValueFrom(
        this.http
          .get<SentinelState>(STATE_URL, refresh ? { params: { refresh: 1 } } : {})
          .pipe(withRequestErrors()),
      );
      // A board change discarded the reads out to the previous board.
      if (this.destroyed || !this.stateReads.accept(request)) return;
      if (state.generation !== generation) {
        void this.board.reload();
        return;
      }
      this.stateValue.set(state);
      this.stateFailureValue.set(null);
      if (state.available) this.halted.set(false);
    } catch (error) {
      // A failure answers for the reads sent before it as well, as an answer would.
      if (this.destroyed || !this.stateReads.isNewest(request)) return;
      if (!this.stateReads.accept(request)) return;
      const failure = failureOf(error, generation);
      if (failure.generation !== generation) {
        void this.board.reload();
        return;
      }
      this.stateFailureValue.set(failure);
    } finally {
      if (switches === this.switches) this.stateReadsOut.update((count) => count - 1);
    }
    this.sync();
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
    const generation = this.board.generation();
    if (generation === null) return;
    const token = {};
    this.polled = token;
    const started = Date.now();
    try {
      const answer = await firstValueFrom(
        this.http
          .get<SentinelMetrics>(METRICS_URL, {
            params: queryParams(metricsQuery(this.windowValue(), generation)),
          })
          .pipe(withRequestErrors()),
      );
      if (this.polled !== token) return;
      this.polled = null;
      if (answer.generation !== generation) {
        void this.board.reload();
      } else {
        this.windowValue.set(mergeTelemetry(this.windowValue(), answer));
        this.failures = 0;
        this.failureValue.set(null);
      }
    } catch (error) {
      if (this.polled !== token) return;
      this.polled = null;
      const failure = failureOf(error, generation);
      if (failure.generation !== generation) {
        void this.board.reload();
      } else {
        this.failureValue.set(failure);
        this.failures++;
        // The next poll would fail the same way: the state says why, and when to go on.
        if (haltsPolling(failure.code)) {
          this.halted.set(true);
          this.checkState();
        }
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

/** The metrics query as request parameters, leaving out what it does not set. */
function queryParams({ history, after, epoch }: MetricsQuery): Record<string, string | number> {
  return {
    history,
    ...(after === undefined ? {} : { after }),
    ...(epoch === undefined ? {} : { epoch }),
  };
}
