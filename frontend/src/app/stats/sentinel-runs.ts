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
import { boardUrl } from '../board/api';
import { BOARD_GONE_CODES, BoardProblem } from '../board/board-error';
import { BoardService } from '../board/board.service';
import { LatestOnly, visiblePoller } from '../polling';
import { withRequestErrors } from '../sources/api-errors';
import type {
  DeleteAnswer,
  RunMetadata,
  RunsBody,
  RunSummary,
  SavedRun,
  TraceBody,
  TraceRequest,
} from './api';
import { isSavedRun } from './runs';
import {
  failureOf,
  haltsPolling,
  type SentinelAction,
  type SentinelFailure,
  unexpectedAnswer,
} from './sentinel-failure';

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
  /** The route's path under the board. */
  path: string;
  reads: LatestOnly;
  /** The newest read still out, which answers for a periodic read due meanwhile. */
  out: number | null;
  failure: WritableSignal<SentinelFailure | null>;
  apply(answer: T): void;
}

const STALE: RunRead = { stale: true };

/** What a run body without a run's parts is said to be. */
const UNKNOWN_RUN = 'This Sentinel build answered with a run body Insight does not know.';

/**
 * The selected board's Sentinel traces and runs, for the Stats page. Provided by the page beside
 * `SentinelTelemetry`, so it lives exactly as long as the page: leaving Stats stops every read.
 *
 * **Reads.** Nothing is read until the page says Sentinel is ready (`setSentinelReady`): a
 * missing or stopped daemon would only answer each read with the failure the page already shows.
 * From then on the active trace (`GET .../sentinel/traces/active`) is read at once and when the
 * board changes, then every 30 s, so a trace started or stopped elsewhere (the Sentinel CLI,
 * another browser) shows within that. The run list (`GET .../sentinel/runs`) is read the same way
 * while the page says it is shown (`setRunsShown`), and again after each start, stop and delete,
 * and when a trace read finds another trace than the one before (started or stopped elsewhere),
 * so the list and the toolbar agree. A hidden tab sends nothing: each read runs on the board, and
 * showing the tab again reads at once. A periodic read due while one is out is left to that one.
 * Only the newest answer applies; a failed read keeps what was read before, beside its failure.
 *
 * **Changes.** Start, stop and delete go to the board they were asked for, by its id, so one that
 * outlives a board switch is refused (404 `not_found`) rather than made on the new board. Each
 * resolves with what the page reports and never rejects. A change makes the reads out before it
 * obsolete: their answers are dropped, so a read sent before a start cannot hide the trace it
 * started.
 *
 * **Board changes.** Everything held is the selected board's: a board change drops it and reads
 * the new board at once, never waiting for a request still out to the previous one. A failure
 * saying the board was replaced (`BOARD_GONE_CODES`) reloads the board, whose new id then drops
 * what is held. A change whose answer or failure lands after the board shown changed is reported
 * as a `board_changed` failure and nothing of it applies: the previous board's refusal must not
 * show against the new one.
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

  private readonly traceReadAtValue = signal<number | null>(null);
  /**
   * When the trace shown and its summary were applied, on this browser's clock (`Date.now()`);
   * null without a trace. How long a trace has recorded is told from it and the summary's
   * `duration_ms` (or from it alone after a start, which answers no summary), never from the
   * board's `started_at`: a board's clock is often not set, and the two clocks cannot be compared.
   */
  readonly traceReadAt = this.traceReadAtValue.asReadonly();

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

  private readonly traceSlot: ReadSlot<TraceBody> = {
    path: 'sentinel/traces/active',
    reads: new LatestOnly(),
    out: null,
    failure: this.traceFailureValue,
    apply: ({ trace, summary }) => {
      // Another trace than the last read showed was started or stopped elsewhere, which changes
      // the run list too: it is read now rather than up to 30 s later.
      if (this.showTrace(trace, summary ?? null)) this.rereadRuns();
    },
  };

  private readonly runsSlot: ReadSlot<RunsBody> = {
    path: 'sentinel/runs',
    reads: new LatestOnly(),
    out: null,
    failure: this.runsFailureValue,
    apply: ({ runs }) => this.runsValue.set(runs),
  };

  /** Run reads, of which only the newest one's answer is shown. */
  private readonly runReads = new LatestOnly();
  /** The start or stop `traceBusy` stands for; only that one clears it. */
  private busyWith: object | null = null;
  private runsShown = false;
  /** The page says Sentinel answers on the board: until then nothing is read. */
  private sentinelReady = false;
  /** The id of the trace shown (null for none); undefined before the board's first trace answer. */
  private traceSeen: string | null | undefined = undefined;
  /** The id of the board everything held is of; undefined before the first look at the board. */
  private boardId: string | null | undefined = undefined;
  private destroyed = false;

  private readonly targeted = computed(() => this.board.id() !== null);
  private readonly traceReads = visiblePoller(READ_MS, () => void this.read(this.traceSlot));
  private readonly runsReads = visiblePoller(READ_MS, () => void this.read(this.runsSlot));

  constructor() {
    effect(() => {
      const id = this.board.id();
      untracked(() => this.follow(id));
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
    untracked(() => this.runsReads.setActive(this.reading() && shown));
  }

  /**
   * Whether Sentinel is ready on the board, as the page's state read says. Until it is, and while
   * it is not (missing, stopped, not answering), nothing is read and what was read stays; once
   * it is, the trace (and the run list while shown) is read at once.
   */
  setSentinelReady(ready: boolean): void {
    this.sentinelReady = ready;
    untracked(() => {
      this.traceReads.setActive(this.reading());
      this.runsReads.setActive(this.reading() && this.runsShown);
    });
  }

  /**
   * Reads the run list again at once while it is shown: after a change, and for the page's Retry
   * after a failed read. A read still out is dropped; this one answers for it.
   */
  rereadRuns(): void {
    if (!this.runsShown) return;
    this.invalidate(this.runsSlot);
    void this.read(this.runsSlot);
  }

  /**
   * Starts a trace on the current board, with the name, note and tags trimmed and an empty note or
   * tag left out. Resolves with null once the trace is shown, else with why it did not start; a
   * `trace_conflict` (another trace records, or the name is taken) re-reads the trace.
   */
  async startTrace(request: TraceRequest): Promise<SentinelFailure | null> {
    const id = this.board.id();
    if (id === null) return noBoard('start');
    const busy = this.markBusy('start');
    const result = await this.change(
      this.http.post<TraceBody>(boardUrl(id, 'sentinel/traces'), trimmed(request)),
      id,
      'start',
    );
    this.clearBusy(busy);
    if ('failure' in result) return this.failedTrace(result.failure);
    this.invalidate(this.traceSlot);
    const { trace, summary } = result.answer;
    this.showTrace(trace, summary ?? null);
    this.traceFailureValue.set(null);
    this.rereadRuns();
    return null;
  }

  /**
   * Stops the trace shown, naming it (`trace`) so a trace started elsewhere since is not stopped
   * in its place: the backend answers `trace_conflict` instead, which re-reads the trace. Resolves
   * with null once the trace is no longer shown, else with why it was not stopped. Without a trace
   * shown there is nothing to stop: it resolves with null at once.
   */
  async stopTrace(): Promise<SentinelFailure | null> {
    const trace = this.traceValue();
    if (trace === null) return null;
    const id = this.board.id();
    if (id === null) return noBoard('stop');
    const busy = this.markBusy('stop');
    const result = await this.change(
      this.http.post<TraceBody>(boardUrl(id, 'sentinel/traces/stop'), null, {
        params: { trace: trace.id },
      }),
      id,
      'stop',
    );
    this.clearBusy(busy);
    if ('failure' in result) return this.failedTrace(result.failure);
    this.invalidate(this.traceSlot);
    this.showTrace(null, null);
    this.traceFailureValue.set(null);
    this.rereadRuns();
    return null;
  }

  /**
   * Reads one run in full. The newest call wins: every older call still out resolves with
   * `{stale: true}`, as does one whose answer lands after a board change or after the page was
   * left, so a caller shows what it gets unless it is stale. A body without a run's parts
   * (`isSavedRun`) resolves with a `bad_response` failure rather than as a run.
   */
  async readRun(run: string): Promise<RunRead> {
    const id = this.board.id();
    if (id === null) return { failure: noBoard('read') };
    const request = this.runReads.next();
    const current = () => !this.destroyed && this.runReads.isNewest(request) && this.isShown(id);
    try {
      const answer = await firstValueFrom(
        this.http.get<unknown>(runUrl(id, run)).pipe(withRequestErrors()),
      );
      if (!current()) return STALE;
      return isSavedRun(answer) ? { run: answer } : { failure: unexpectedAnswer(UNKNOWN_RUN, id) };
    } catch (error) {
      if (!current()) return STALE;
      const failure = failureOf(error, id);
      if (BOARD_GONE_CODES.has(failure.code)) void this.board.reload();
      return { failure };
    }
  }

  /**
   * Deletes runs one at a time, in the order given, each by its id. A failure that says the board,
   * the daemon or Insight cannot answer, or that the board changed, stops the batch: the next
   * request would fail the same way, or hit another board. Any other (a run another client
   * removed, `not_found`; a run still recording, `trace_conflict`) is recorded and the batch goes
   * on. The runs the last successful answer leaves apply at once, then the list is read again.
   */
  async deleteRuns(ids: readonly string[]): Promise<DeleteOutcome> {
    const id = this.board.id();
    const outcome: DeleteOutcome = { deleted: [], failed: [], notTried: [] };
    let left: RunSummary[] | null = null;
    for (const [index, run] of ids.entries()) {
      if (id === null || !this.isShown(id)) {
        outcome.notTried.push(...ids.slice(index));
        break;
      }
      const result = await this.change(
        this.http.delete<DeleteAnswer>(runUrl(id, run)),
        id,
        'delete',
      );
      if ('answer' in result) {
        outcome.deleted.push(run);
        left = result.answer.runs.runs;
        continue;
      }
      outcome.failed.push({ id: run, failure: result.failure });
      if (stopsBatch(result.failure)) {
        outcome.notTried.push(...ids.slice(index + 1));
        break;
      }
    }
    if (id !== null && this.isShown(id)) {
      if (left !== null) {
        this.invalidate(this.runsSlot);
        this.runsValue.set(left);
      }
      this.rereadRuns();
    }
    return outcome;
  }

  /** Follows the selected board: another id drops everything held of the previous one. */
  private follow(id: string | null): void {
    if (id !== this.boardId) {
      this.boardId = id;
      this.reset();
    }
    // Restarting the pollers reads the board at once (once the tab shows, if it is hidden) and
    // counts their 30 s from now.
    const reading = this.reading();
    this.traceReads.setActive(false);
    this.traceReads.setActive(reading);
    this.runsReads.setActive(false);
    this.runsReads.setActive(reading && this.runsShown);
  }

  /** Whether reads go to the board: one is selected and the page says Sentinel is ready. */
  private reading(): boolean {
    return this.targeted() && this.sentinelReady;
  }

  /**
   * Shows `trace` with its summary, as read now (the start's answer counts as a read), and says
   * whether it is another trace than the one shown before. The board's first answer is not: there
   * was nothing before it to differ from.
   */
  private showTrace(trace: RunMetadata | null, summary: RunSummary | null): boolean {
    const id = trace?.id ?? null;
    const moved = this.traceSeen !== undefined && this.traceSeen !== id;
    this.traceSeen = id;
    this.traceValue.set(trace);
    this.traceSummaryValue.set(summary);
    this.traceReadAtValue.set(trace === null ? null : Date.now());
    return moved;
  }

  private reset(): void {
    this.invalidate(this.traceSlot);
    this.invalidate(this.runsSlot);
    this.busyWith = null;
    this.traceBusyValue.set(null);
    this.showTrace(null, null);
    this.traceSeen = undefined;
    this.traceFailureValue.set(null);
    this.runsValue.set(null);
    this.runsFailureValue.set(null);
  }

  /** Whether the page is still open on the board of `id`, so an answer of it applies. */
  private isShown(id: string): boolean {
    return !this.destroyed && this.board.id() === id;
  }

  /** Drops the answers of the reads of this kind still out: they describe a moment now past. */
  private invalidate(slot: ReadSlot<unknown>): void {
    slot.reads.discard();
    slot.out = null;
  }

  /**
   * Reads the trace or the run list unless one is out, which answers for this one, the tab is
   * hidden (the poller reads at once when it shows) or nothing is read now (`reading`).
   */
  private async read<T>(slot: ReadSlot<T>): Promise<void> {
    const id = this.board.id();
    if (this.destroyed || !this.reading() || id === null) return;
    if (this.document.visibilityState !== 'visible' || slot.out !== null) return;
    const request = slot.reads.next();
    slot.out = request;
    try {
      const answer = await firstValueFrom(
        this.http.get<T>(boardUrl(id, slot.path)).pipe(withRequestErrors()),
      );
      if (this.destroyed || !slot.reads.accept(request) || !this.isShown(id)) return;
      slot.apply(answer);
      slot.failure.set(null);
    } catch (error) {
      // A failure answers for the reads sent before it as well, as an answer would.
      if (this.destroyed || !slot.reads.isNewest(request) || !slot.reads.accept(request)) return;
      const failure = failureOf(error, id);
      if (BOARD_GONE_CODES.has(failure.code)) void this.board.reload();
      if (this.isShown(id)) slot.failure.set(failure);
    } finally {
      if (slot.out === request) slot.out = null;
    }
  }

  /** A start or stop failed. A conflict means the trace shown is out of date: it is read again. */
  private failedTrace(failure: SentinelFailure): SentinelFailure {
    if (failure.code === 'trace_conflict' && failure.boardId === this.board.id()) {
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
   * Sends a change to the board of `id` and says how it went: the answer or failure when the page
   * still shows that board, else that it was not applied. A failure saying the board was replaced
   * reloads the board; after the page was left nothing more happens.
   */
  private async change<T>(
    request: Observable<T>,
    id: string,
    action: SentinelAction,
  ): Promise<{ answer: T } | { failure: SentinelFailure }> {
    const unapplied = { failure: notApplied(id, action) };
    try {
      const answer = await firstValueFrom(request.pipe(withRequestErrors()));
      return this.isShown(id) ? { answer } : unapplied;
    } catch (error) {
      if (this.destroyed) return unapplied;
      const failure = failureOf(error, id, action);
      if (BOARD_GONE_CODES.has(failure.code)) void this.board.reload();
      return this.isShown(id) ? { failure } : unapplied;
    }
  }
}

/** The path of one run on the board of `id`. Ids from the Sentinel CLI may hold slashes. */
function runUrl(id: string, run: string): string {
  return boardUrl(id, `sentinel/runs/${encodeURIComponent(run)}`);
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
 * Whether a delete failure stops the batch: the board or the daemon cannot answer
 * (`haltsPolling`), the board changed, or Insight itself did not answer as it should.
 */
function stopsBatch({ code }: SentinelFailure): boolean {
  return (
    haltsPolling(code) || code === 'board_changed' || code === 'network' || code === 'bad_response'
  );
}

/** A change asked for while no board is known; the page offers none then. */
function noBoard(action: SentinelAction): SentinelFailure {
  const problem = new BoardProblem(
    'No board is selected.',
    'no_target',
    'Choose a board in the rail first.',
  );
  return failureOf(problem, null, action);
}

/**
 * A change whose answer is not for the board shown now: the board changed while it was out. It
 * may have been made on the previous board, which the hint says.
 */
function notApplied(id: string, action: SentinelAction): SentinelFailure {
  const problem = new BoardProblem(
    'The selected board changed before the answer arrived; ' +
      'the change may have been made on the board selected before.',
    'board_changed',
    'Check the board selected now.',
  );
  return failureOf(problem, id, action);
}
