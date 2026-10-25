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
  type WritableSignal,
} from '@angular/core';
import { firstValueFrom, type Observable } from 'rxjs';
import { BoardProblem } from '../board/board-error';
import { BoardService } from '../board/board.service';
import { LatestOnly, visiblePoller } from '../polling';
import { withRequestErrors } from '../sources/stream-lines';
import type {
  DeleteAnswer,
  RunAnswer,
  RunMetadata,
  RunsAnswer,
  RunSummary,
  SavedRun,
  TraceAnswer,
  TraceRequest,
} from './api';
import {
  failureOf,
  haltsPolling,
  type SentinelAction,
  type SentinelFailure,
} from './sentinel-failure';

const TRACES_URL = '/api/sentinel/traces';
const STOP_URL = '/api/sentinel/traces/stop';
const RUNS_URL = '/api/sentinel/runs';
/** How often the trace and the shown run list are re-read, to catch changes made elsewhere. */
const READ_MS = 30_000;

/**
 * How a run read ended. `stale` means the answer is not the current one, so nothing of it may be
 * shown: a newer `readRun` was made, the board changed, or the page was left.
 */
export type RunRead = { run: SavedRun } | { failure: SentinelFailure } | { stale: true };

/** What a delete batch did with each id it was given, in the order given. */
export interface DeleteOutcome {
  deleted: string[];
  failed: { id: string; failure: SentinelFailure }[];
  /** The ids after a failure that stopped the batch: nothing was asked for them. */
  notTried: string[];
}

/** One kind of periodic read (the trace, the run list) and what it keeps. */
interface ReadSlot<T> {
  url: string;
  reads: LatestOnly;
  /** The newest read still out, which answers for a periodic read due meanwhile. */
  out: number | null;
  failure: WritableSignal<SentinelFailure | null>;
  apply(answer: T): void;
}

const STALE: RunRead = { stale: true };

/**
 * The selected board's Sentinel traces and runs, for the Stats page. Provided by the page beside
 * `SentinelTelemetry`, so it lives exactly as long as the page: leaving Stats stops every read.
 *
 * **Reads.** The active trace (`GET /api/sentinel/traces`) is read when the page opens and when
 * the board changes, then every 30 s, so a trace started or stopped elsewhere (the Sentinel CLI,
 * another browser) shows within that. The run list (`GET /api/sentinel/runs`) is read the same
 * way while the page says it is shown (`setRunsShown`), and again after each start, stop and
 * delete. A hidden tab sends nothing: each read runs on the board, and showing the tab again
 * reads at once. A periodic read due while one is out is left to that one. Only the newest answer
 * applies; a failed read keeps what was read before, beside its failure.
 *
 * **Changes.** Start, stop and delete send the board generation they were asked under
 * (`?generation=`), so the backend refuses one that outlives a board switch (`stale_snapshot`).
 * Each resolves with what the page reports and never rejects. A change makes the reads out before
 * it obsolete: their answers are dropped, so a read sent before a start cannot hide the trace it
 * started.
 *
 * **Board changes.** Everything held is the current board generation's: a board change drops it
 * and reads the new board at once, never waiting for a request still out to the previous one. An
 * answer or failure naming another generation than it was asked under means another client
 * switched the board: the board is reloaded and the answer dropped. A change whose answer is not
 * for the board shown now is reported as a `stale_snapshot` failure and nothing of it applies.
 */
@Injectable()
export class SentinelRuns {
  private readonly http = inject(HttpClient);
  private readonly board = inject(BoardService);
  private readonly document = inject(DOCUMENT);

  private readonly traceValue = signal<RunMetadata | null>(null);
  /** The trace being recorded on the current board; null when none is, or before the first read. */
  readonly trace = this.traceValue.asReadonly();

  private readonly traceSummaryValue = signal<RunSummary | null>(null);
  /** The recording run's totals so far, as of the last trace read; null without one. */
  readonly traceSummary = this.traceSummaryValue.asReadonly();

  private readonly traceFailureValue = signal<SentinelFailure | null>(null);
  /** Why the newest trace read failed; cleared by the next good one. */
  readonly traceFailure = this.traceFailureValue.asReadonly();

  private readonly traceBusyValue = signal<'start' | 'stop' | null>(null);
  /** A start or stop is out to the current board. */
  readonly traceBusy = this.traceBusyValue.asReadonly();

  private readonly runsValue = signal<RunSummary[] | null>(null);
  /** The current board's runs, newest first; null until read. */
  readonly runs = this.runsValue.asReadonly();

  private readonly runsFailureValue = signal<SentinelFailure | null>(null);
  /** Why the newest run list read failed; cleared by the next good one. */
  readonly runsFailure = this.runsFailureValue.asReadonly();

  private readonly targeted = computed(() => this.board.state()?.target != null);

  private readonly traceSlot: ReadSlot<TraceAnswer> = {
    url: TRACES_URL,
    reads: new LatestOnly(),
    out: null,
    failure: this.traceFailureValue,
    apply: ({ sentinel }) => {
      this.traceValue.set(sentinel.trace);
      this.traceSummaryValue.set(sentinel.summary ?? null);
    },
  };

  private readonly runsSlot: ReadSlot<RunsAnswer> = {
    url: RUNS_URL,
    reads: new LatestOnly(),
    out: null,
    failure: this.runsFailureValue,
    apply: ({ sentinel }) => this.runsValue.set(sentinel.runs),
  };

  /** Run reads, of which only the newest one's answer is shown. */
  private readonly runReads = new LatestOnly();
  /** The start or stop `traceBusy` stands for; only that one clears it. */
  private busyWith: object | null = null;
  private runsShown = false;
  /** The board generation everything held is of; undefined before the first look at the board. */
  private generation: number | null | undefined = undefined;
  private destroyed = false;

  private readonly traceReads = visiblePoller(READ_MS, () => void this.read(this.traceSlot));
  private readonly runsReads = visiblePoller(READ_MS, () => void this.read(this.runsSlot));

  constructor() {
    effect(() => {
      const generation = this.board.generation();
      const targeted = this.targeted();
      untracked(() => this.follow(generation, targeted));
    });
    // The pollers stop themselves with the page; a request still out lands on nothing.
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
  }

  /**
   * Whether the page shows the run list (Runs or Compare). While it does, the list is read at
   * once and every 30 s; otherwise it is not read, and the list held stays as it was.
   */
  setRunsShown(shown: boolean): void {
    this.runsShown = shown;
    // The page calls this from its own effect, which must not come to depend on the board.
    untracked(() => this.runsReads.setActive(shown && this.targeted()));
  }

  /**
   * Starts a trace on the current board, with the name, note and tags trimmed and an empty note or
   * tag left out. Resolves with null once the trace is shown, else with why it did not start; a
   * `trace_conflict` (another trace records, or the name is taken) re-reads the trace.
   */
  async startTrace(request: TraceRequest): Promise<SentinelFailure | null> {
    const generation = this.board.generation();
    if (generation === null) return noBoard('start');
    const busy = this.markBusy('start');
    const result = await this.change(
      this.http.post<TraceAnswer>(TRACES_URL, trimmed(request), { params: { generation } }),
      generation,
      'start',
    );
    this.clearBusy(busy);
    if ('failure' in result) return this.failedTrace(result.failure);
    this.invalidate(this.traceSlot);
    this.traceSlot.apply(result.answer);
    this.traceFailureValue.set(null);
    this.rereadRuns();
    return null;
  }

  /**
   * Stops the trace shown, naming it (`trace_id`) so a trace started elsewhere since is not
   * stopped in its place: the backend answers `trace_conflict` instead, which re-reads the trace.
   * Resolves with null once the trace is no longer shown, else with why it was not stopped.
   * Without a trace shown there is nothing to stop: it resolves with null at once.
   */
  async stopTrace(): Promise<SentinelFailure | null> {
    const trace = this.traceValue();
    if (trace === null) return null;
    const generation = this.board.generation();
    if (generation === null) return noBoard('stop');
    const busy = this.markBusy('stop');
    const result = await this.change(
      this.http.post<TraceAnswer>(STOP_URL, null, {
        params: { generation, trace_id: trace.id },
      }),
      generation,
      'stop',
    );
    this.clearBusy(busy);
    if ('failure' in result) return this.failedTrace(result.failure);
    this.invalidate(this.traceSlot);
    this.traceValue.set(null);
    this.traceSummaryValue.set(null);
    this.traceFailureValue.set(null);
    this.rereadRuns();
    return null;
  }

  /**
   * Reads one run in full. The newest call wins: every older call still out resolves with
   * `{stale: true}`, as does one whose answer lands after a board change or after the page was
   * left, so a caller shows what it gets unless it is stale.
   */
  async readRun(id: string): Promise<RunRead> {
    const generation = this.board.generation();
    if (generation === null) return { failure: noBoard('read') };
    const request = this.runReads.next();
    const current = () => !this.destroyed && this.runReads.isNewest(request);
    try {
      const answer = await firstValueFrom(
        this.http.get<RunAnswer>(runUrl(id)).pipe(withRequestErrors()),
      );
      if (!current()) return STALE;
      if (answer.generation !== generation) {
        void this.board.reload();
        return STALE;
      }
      return this.isShown(generation) ? { run: answer.sentinel } : STALE;
    } catch (error) {
      if (!current()) return STALE;
      const failure = failureOf(error, generation);
      if (failure.generation !== generation) {
        void this.board.reload();
        return STALE;
      }
      return this.isShown(generation) ? { failure } : STALE;
    }
  }

  /**
   * Deletes runs one at a time, in the order given. A failure that says the board, the daemon or
   * Insight cannot answer, or that the board changed (`stale_snapshot`), stops the batch: the
   * next request would fail the same way, or hit another board. Any other (a run another client
   * removed, `not_found`; a run still recording, `trace_conflict`) is recorded and the batch goes
   * on. The runs the last successful answer leaves apply at once, then the list is read again.
   */
  async deleteRuns(ids: readonly string[]): Promise<DeleteOutcome> {
    const generation = this.board.generation();
    const outcome: DeleteOutcome = { deleted: [], failed: [], notTried: [] };
    let left: RunSummary[] | null = null;
    for (const [index, id] of ids.entries()) {
      if (generation === null || !this.isShown(generation)) {
        outcome.notTried.push(...ids.slice(index));
        break;
      }
      const result = await this.change(
        this.http.delete<DeleteAnswer>(runUrl(id), { params: { generation } }),
        generation,
        'delete',
      );
      if ('answer' in result) {
        outcome.deleted.push(id);
        left = result.answer.sentinel.runs;
        continue;
      }
      outcome.failed.push({ id, failure: result.failure });
      if (stopsBatch(result.failure.code)) {
        outcome.notTried.push(...ids.slice(index + 1));
        break;
      }
    }
    if (generation !== null && this.isShown(generation)) {
      if (left !== null) {
        this.invalidate(this.runsSlot);
        this.runsValue.set(left);
      }
      this.rereadRuns();
    }
    return outcome;
  }

  /** Follows the selected board: another generation drops everything held of the previous one. */
  private follow(generation: number | null, targeted: boolean): void {
    if (generation !== this.generation) {
      this.generation = generation;
      this.reset();
    }
    // Restarting the pollers reads the board at once (once the tab shows, if it is hidden) and
    // counts their 30 s from now.
    this.traceReads.setActive(false);
    this.traceReads.setActive(targeted);
    this.runsReads.setActive(false);
    this.runsReads.setActive(targeted && this.runsShown);
  }

  private reset(): void {
    this.invalidate(this.traceSlot);
    this.invalidate(this.runsSlot);
    this.busyWith = null;
    this.traceBusyValue.set(null);
    this.traceValue.set(null);
    this.traceSummaryValue.set(null);
    this.traceFailureValue.set(null);
    this.runsValue.set(null);
    this.runsFailureValue.set(null);
  }

  /** Whether the page is still open on the board of `generation`, so an answer of it applies. */
  private isShown(generation: number): boolean {
    return !this.destroyed && this.board.generation() === generation;
  }

  /** Drops the answers of the reads of this kind still out: they describe a moment now past. */
  private invalidate(slot: ReadSlot<unknown>): void {
    slot.reads.discard();
    slot.out = null;
  }

  /**
   * Reads the trace or the run list unless one is out, which answers for this one, or the tab is
   * hidden: the poller reads at once when it shows.
   */
  private async read<T extends { generation: number }>(slot: ReadSlot<T>): Promise<void> {
    const generation = this.board.generation();
    if (this.destroyed || !this.targeted() || generation === null) return;
    if (this.document.visibilityState !== 'visible' || slot.out !== null) return;
    const request = slot.reads.next();
    slot.out = request;
    try {
      const answer = await firstValueFrom(this.http.get<T>(slot.url).pipe(withRequestErrors()));
      if (this.destroyed || !slot.reads.accept(request)) return;
      if (answer.generation !== generation) {
        void this.board.reload();
        return;
      }
      if (!this.isShown(generation)) return;
      slot.apply(answer);
      slot.failure.set(null);
    } catch (error) {
      // A failure answers for the reads sent before it as well, as an answer would.
      if (this.destroyed || !slot.reads.isNewest(request) || !slot.reads.accept(request)) return;
      const failure = failureOf(error, generation);
      if (failure.generation !== generation) {
        void this.board.reload();
        return;
      }
      if (this.isShown(generation)) slot.failure.set(failure);
    } finally {
      if (slot.out === request) slot.out = null;
    }
  }

  /** Reads the run list again after a change, when it is shown. */
  private rereadRuns(): void {
    if (!this.runsShown) return;
    this.invalidate(this.runsSlot);
    void this.read(this.runsSlot);
  }

  /** A start or stop failed. A conflict means the trace shown is out of date: it is read again. */
  private failedTrace(failure: SentinelFailure): SentinelFailure {
    if (failure.code === 'trace_conflict' && failure.generation === this.board.generation()) {
      this.invalidate(this.traceSlot);
      void this.read(this.traceSlot);
    }
    return failure;
  }

  private markBusy(action: 'start' | 'stop'): object {
    const busy = {};
    this.busyWith = busy;
    this.traceBusyValue.set(action);
    return busy;
  }

  private clearBusy(busy: object): void {
    if (this.busyWith !== busy) return;
    this.busyWith = null;
    this.traceBusyValue.set(null);
  }

  /**
   * Sends a change to the board of `generation` and says how it went: the answer when it is for
   * the board shown now, else the failure to report. An answer or failure naming another
   * generation reloads the board.
   */
  private async change<T extends { generation: number }>(
    request: Observable<T>,
    generation: number,
    action: SentinelAction,
  ): Promise<{ answer: T } | { failure: SentinelFailure }> {
    try {
      const answer = await firstValueFrom(request.pipe(withRequestErrors()));
      if (answer.generation !== generation) void this.board.reload();
      if (answer.generation !== generation || !this.isShown(generation)) {
        return { failure: notApplied(generation, action) };
      }
      return { answer };
    } catch (error) {
      const failure = failureOf(error, generation, action);
      if (failure.generation !== generation) void this.board.reload();
      return { failure };
    }
  }
}

/** The path of one run. Ids from the Sentinel CLI may hold slashes, which Flask's route takes. */
function runUrl(id: string): string {
  return `${RUNS_URL}/${encodeURIComponent(id)}`;
}

/** The request with its text trimmed and an empty note or tag left out, as the server keeps it. */
function trimmed({ name, note, tags }: TraceRequest): TraceRequest {
  const text = note?.trim() ?? '';
  const kept = (tags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== '');
  return {
    name: name.trim(),
    ...(text === '' ? {} : { note: text }),
    ...(kept.length === 0 ? {} : { tags: kept }),
  };
}

/**
 * Whether a delete failing with this code stops the batch: the board or the daemon cannot answer
 * (`haltsPolling`), the board changed, or Insight itself did not answer as it should.
 */
function stopsBatch(code: string): boolean {
  return (
    haltsPolling(code) || code === 'stale_snapshot' || code === 'network' || code === 'bad_response'
  );
}

/** A change asked for while no board is known; the page offers none then. */
function noBoard(action: SentinelAction): SentinelFailure {
  return failureOf(new BoardProblem('No board is selected.', 'no_target', '', {}), null, action);
}

/**
 * A change whose answer is not for the board shown now: the board changed while it was out. It
 * may have happened on the previous board, so the backend's own "nothing was changed" does not
 * apply.
 */
function notApplied(generation: number, action: SentinelAction): SentinelFailure {
  const problem = new BoardProblem(
    'The selected board changed before the answer arrived, so Insight did not apply it.',
    'stale_snapshot',
    'Check the board selected now, then try again.',
    {},
  );
  return failureOf(problem, generation, action);
}
