import { Page, Request } from '@playwright/test';
// Types only, erased at run time: the answers are checked against the shapes the app reads.
import type { BoardList } from '../src/app/api.generated';
import type {
  CompareExport,
  RunMetadata,
  RunSummary,
  SavedRun,
  SentinelCache,
} from '../src/app/stats/api';
// Loaded at run time: Playwright reads the app's own fixtures (the capture of a Modalix DevKit's
// cache and runs, and the builders over them), so the specs and the e2e share one copy of the
// board.
import {
  ACTIVE_TRACE,
  COMPARE_RAW,
  RECORDING_RUN,
  RUNS_LIST,
  runsAnswer,
  SAVED_RUN,
  savedRun,
  traceAnswer,
} from '../src/app/stats/runs.testing';
import { cacheWith, sentinelError, sentinelHealth } from '../src/app/stats/stats.testing';
import { answerTopBar, TOP_BAR_BOARD, TOP_BAR_BOARD_ID } from './top-bar';

// The answers of the board's Sentinel routes for the Stats e2e, built from `stats.testing.ts`: the
// whole cache first, then the samples after the one asked for.

/** Sentinel takes a sample every 2 s; the cache the fake keeps is shorter than Sentinel's. */
const STEP_MS = 2000;
const WINDOW_SAMPLES = 30;
/** The first sample's time; the fake's clock counts samples from here. */
const FIRST_SAMPLE = Date.parse('2026-10-24T10:00:00Z');

/** The path of a board's Sentinel routes, which every request below starts with. */
const sentinelBase = (id: string) => `/api/boards/${encodeURIComponent(id)}/sentinel`;

/** A trace recording on the board: what Sentinel keeps about it, and its run's totals so far. */
interface FakeTrace {
  metadata: RunMetadata;
  summary: RunSummary;
}

export class FakeStatsBackend {
  /** What `GET /api/boards` answers: the SDK-paired DevKit (`TOP_BAR_BOARD`) unless a test sets another. */
  board: BoardList = TOP_BAR_BOARD;
  /** The trace recording on the board; null while none is (`recording()` starts the fixture's). */
  private trace: FakeTrace | null = null;
  /** The finished runs on the board, newest first, as `RUNS_LIST` has them. */
  private readonly runs: RunSummary[] = RUNS_LIST.filter((run) => run.ended_at !== null);

  /** The `after` of every cache read, in order: null for one that asked for the whole cache. */
  readonly queries: (string | null)[] = [];
  /** The newest sample's time of every answer to a cache read, in order. */
  readonly answered: (string | null)[] = [];
  /** The path of every request to the board's Sentinel routes, in order. */
  readonly sentinelRequests: string[] = [];
  /** The `runs` of every comparison, in order: the baseline's id first. */
  readonly compares: string[] = [];

  /** The newest sample's place in the fake's clock; each poll finds one more. */
  private head = WINDOW_SAMPLES - 1;

  /** The fixture's trace records on the board: its run (`RECORDING_RUN`) heads the run list. */
  recording(): void {
    this.trace = { metadata: ACTIVE_TRACE, summary: RECORDING_RUN };
  }

  /** The runs Sentinel lists: the recording one first, as Sentinel lists it. */
  private get listed(): RunSummary[] {
    return this.trace ? [this.trace.summary, ...this.runs] : this.runs;
  }

  /** The cache reads so far. */
  get polls(): number {
    return this.queries.length;
  }

  /**
   * Answers the boards, the board's Sentinel routes that Stats reads and System Info, and the
   * Streaming page's slots (empty), where the flows leave Stats to. Call it before the page loads.
   */
  async install(page: Page): Promise<void> {
    await answerTopBar(page);
    const sentinelPath = (request: Request) => {
      const { pathname } = new URL(request.url());
      this.sentinelRequests.push(pathname);
    };
    // The routes of the board the test answers as selected, read at each request: a test may
    // set `board` to another one before the page loads.
    const base = () => sentinelBase(this.board.selected?.id ?? TOP_BAR_BOARD_ID);
    const route = (path: string) => (url: URL) => url.pathname === `${base()}/${path}`;

    await page.route(
      (url) => url.pathname === '/api/boards',
      (route) => route.fulfill({ json: this.board }),
    );
    await page.route(route('health'), (route) => {
      sentinelPath(route.request());
      return route.fulfill({ json: sentinelHealth() });
    });
    await page.route(route('cache'), (route) => {
      sentinelPath(route.request());
      const after = new URL(route.request().url()).searchParams.get('after');
      this.queries.push(after);
      const answer = this.cacheAnswer(after);
      this.answered.push(answer.samples.at(-1)?.timestamp ?? null);
      return route.fulfill({ json: answer });
    });
    // The trace the toolbar shows: Record while none records.
    await page.route(route('traces/active'), (route) => {
      sentinelPath(route.request());
      return route.fulfill({
        json: traceAnswer(this.trace?.metadata ?? null, this.trace?.summary ?? null),
      });
    });
    await page.route(route('runs'), (route) => {
      sentinelPath(route.request());
      return route.fulfill({ json: runsAnswer(this.listed) });
    });
    // One run, read in full. Ids from the Sentinel CLI may hold slashes, encoded.
    await page.route(
      (url) => url.pathname.startsWith(`${base()}/runs/`),
      (route) => {
        const request = route.request();
        sentinelPath(request);
        const { pathname } = new URL(request.url());
        const id = decodeURIComponent(pathname.slice(`${base()}/runs/`.length));
        const run = this.listed.find((listed) => listed.id === id);
        return route.fulfill(run ? { json: runBody(run) } : notFound(`No run ${id} on the board.`));
      },
    );
    await page.route(route('compare'), (route) => {
      sentinelPath(route.request());
      const runs = new URL(route.request().url()).searchParams.get('runs') ?? '';
      this.compares.push(runs);
      const answer = comparison(runs.split(','));
      return route.fulfill(answer ? { json: answer } : notFound('A run is not on the board.'));
    });
    await page.route(
      (url) => url.pathname === '/api/slots',
      (route) => route.fulfill({ json: { count: 48, slots: [] } }),
    );
  }

  /**
   * One more sample is in, and the answer is what Sentinel's would be: the whole cache when the
   * caller holds none, else the samples after the one it names.
   */
  private cacheAnswer(after: string | null): SentinelCache {
    this.head++;
    const sampleTime = (index: number) => FIRST_SAMPLE + index * STEP_MS;
    if (after !== null) {
      const held = Math.round((Date.parse(after) - FIRST_SAMPLE) / STEP_MS);
      if (held >= this.head - WINDOW_SAMPLES && held <= this.head) {
        const start = new Date(sampleTime(held + 1)).toISOString();
        return cacheWith(this.head - held, { start, stepMs: STEP_MS, full: false });
      }
    }
    return cacheWith(WINDOW_SAMPLES, {
      start: new Date(sampleTime(this.head - WINDOW_SAMPLES + 1)).toISOString(),
      stepMs: STEP_MS,
      full: true,
    });
  }
}

/** The server's 404 `not_found` for something the board does not have. */
function notFound(message: string) {
  return { status: 404, json: sentinelError('not_found', message, '') };
}

/**
 * A run in full: the detail fixture's own run as captured, any other with its samples under that
 * run's id and name, which is all the run panel shows of them.
 */
function runBody(run: RunSummary): SavedRun {
  return run.id === SAVED_RUN.metadata.id
    ? SAVED_RUN
    : savedRun({ metadata: { ...SAVED_RUN.metadata, id: run.id, name: run.name } });
}

/**
 * Sentinel's comparison of the runs of `ids`, the first as baseline, from the runs `COMPARE_RAW`
 * holds (in any order, its deltas measured against the baseline asked for); null when it does not
 * hold one of them.
 */
function comparison(ids: string[]): CompareExport | null {
  const byId = new Map(COMPARE_RAW.runs.map((run) => [run.metadata.id, run]));
  if (ids.length < 2 || !ids.every((id) => byId.has(id))) return null;
  const [baseline] = ids;
  const meanOf = (id: string, key: string) => COMPARE_RAW.summaries[id].metrics[key]?.mean ?? null;
  const deltas = (id: string) =>
    Object.fromEntries(
      Object.keys(COMPARE_RAW.summaries[id].metrics).map((key) => {
        const [base, mean] = [meanOf(baseline, key), meanOf(id, key)];
        return [
          key,
          base === null || mean === null || base === 0 ? null : ((mean - base) / base) * 100,
        ];
      }),
    );
  return {
    ...COMPARE_RAW,
    baseline_id: baseline,
    runs: ids.map((id) => byId.get(id)!),
    summaries: Object.fromEntries(ids.map((id) => [id, COMPARE_RAW.summaries[id]])),
    baseline_deltas_pct: Object.fromEntries(ids.map((id) => [id, deltas(id)])),
  };
}
