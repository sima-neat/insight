import { Page, Request } from '@playwright/test';
// Types only, erased at run time: the answers are checked against the shapes the app reads.
import type { BoardList } from '../src/app/api.generated';
import type {
  CompareExport,
  DeleteAnswer,
  RunMetadata,
  RunSummary,
  SavedRun,
  SentinelCache,
  TraceBody,
  TraceRequest,
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

/**
 * When a trace started here starts: about where the page's clock stands (`holdClock`), so the run
 * list says it started moments ago.
 */
const TRACE_START = Date.parse('2026-10-24T10:05:01Z');
/** How long a trace started here has recorded when it is stopped, and what it took. */
const STOPPED_TOTALS = { duration_ms: 12_000, samples: 6, energy_joules: 60.5 };

/** The board of every test: the SDK-paired DevKit (`TOP_BAR_BOARD`), whose label the toasts name. */
export const STATS_BOARD: BoardList = TOP_BAR_BOARD;

/** No board is selected: the page offers to choose one. */
export const NO_BOARD: BoardList = { boards: [], selected: null };

/** The path of a board's Sentinel routes, which every request below starts with. */
const sentinelBase = (id: string) => `/api/boards/${encodeURIComponent(id)}/sentinel`;

/** A poll Sentinel could not answer (502 `sentinel_failed`), as the server words it. */
export const SENTINEL_FAILED = {
  status: 502,
  body: sentinelError(
    'sentinel_failed',
    'Sentinel did not answer within 5 s.',
    'Check `systemctl status simaai-sentinel` on the board.',
  ),
};

/** Sentinel's health read while the daemon is not installed: the hint names the install command. */
const MISSING = {
  status: 502,
  json: sentinelError(
    'sentinel_missing',
    'Sentinel is not installed on sima@192.168.100.200.',
    'Install it on the board with `sima-cli neat install sentinel`, then retry.',
  ),
};

/** A trace recording on the board: what Sentinel keeps about it, and its run's totals so far. */
interface FakeTrace {
  metadata: RunMetadata;
  summary: RunSummary;
}

export class FakeStatsBackend {
  /** What `GET /api/boards` answers. */
  board: BoardList = STATS_BOARD;
  /** Whether the daemon runs; installed on the board (by the user, with the command shown) it does. */
  sentinel: 'running' | 'missing' = 'running';
  /** Every poll answers this failure while it is set. */
  metricsFailure: { status: number; body: object } | null = null;
  /** The trace recording on the board; null while none is (`recording()` starts the fixture's). */
  trace: FakeTrace | null = null;
  /**
   * The finished runs on the board, newest first, as `RUNS_LIST` has them; a recording trace's run
   * heads the list besides. A stop adds its run, a delete takes one out.
   */
  runs: RunSummary[] = RUNS_LIST.filter((run) => run.ended_at !== null);

  /** The `after` of every cache read, in order: null for one that asked for the whole cache. */
  readonly queries: (string | null)[] = [];
  /** The newest sample's time of every answer to a cache read, in order. */
  readonly answered: (string | null)[] = [];
  /** The path of every request to the board's Sentinel routes, in order. */
  readonly sentinelRequests: string[] = [];
  /** Every trace start, in order, with the trace it asked for. */
  readonly starts: TraceRequest[] = [];
  /** The trace every stop named (`?trace=`), in order. */
  readonly stops: (string | null)[] = [];
  /** The id of every run deleted, in order. */
  readonly deletes: string[] = [];
  /** The `runs` of every comparison, in order: the baseline's id first. */
  readonly compares: string[] = [];

  /** The newest sample's place in the fake's clock; each poll finds one more. */
  private head = WINDOW_SAMPLES - 1;

  /** The fixture's trace records on the board: its run (`RECORDING_RUN`) heads the run list. */
  recording(): void {
    this.trace = { metadata: ACTIVE_TRACE, summary: RECORDING_RUN };
  }

  /** The runs Sentinel lists: the recording one first, as Sentinel lists it. */
  get listed(): RunSummary[] {
    return this.trace ? [this.trace.summary, ...this.runs] : this.runs;
  }

  /** The cache reads so far. */
  get polls(): number {
    return this.queries.length;
  }

  /**
   * Answers the boards, the board's Sentinel routes and System Info, and the Streaming page's slots
   * (empty), where the flows leave Stats to. Call it before the page loads.
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
      return route.fulfill(this.sentinel === 'running' ? { json: sentinelHealth() } : MISSING);
    });
    await page.route(route('cache'), (route) => {
      sentinelPath(route.request());
      const after = new URL(route.request().url()).searchParams.get('after');
      this.queries.push(after);
      if (this.metricsFailure) {
        return route.fulfill({
          status: this.metricsFailure.status,
          json: this.metricsFailure.body,
        });
      }
      const answer = this.cacheAnswer(after);
      this.answered.push(answer.samples.at(-1)?.timestamp ?? null);
      return route.fulfill({ json: answer });
    });
    // The trace: read (the toolbar offers Record while none records), started and stopped.
    await page.route(route('traces/active'), (route) => {
      sentinelPath(route.request());
      return route.fulfill({
        json: traceAnswer(this.trace?.metadata ?? null, this.trace?.summary ?? null),
      });
    });
    await page.route(route('traces'), (route) => {
      sentinelPath(route.request());
      return route.fulfill({ json: this.start(route.request()) });
    });
    await page.route(route('traces/stop'), (route) => {
      const request = route.request();
      sentinelPath(request);
      const traceId = new URL(request.url()).searchParams.get('trace');
      this.stops.push(traceId);
      if (this.trace === null || this.trace.metadata.id !== traceId) {
        return route.fulfill(failure(409, 'trace_conflict', 'Another trace is recording.'));
      }
      return route.fulfill({ json: this.stop(this.trace) });
    });
    await page.route(route('runs'), (route) => {
      sentinelPath(route.request());
      return route.fulfill({ json: runsAnswer(this.listed) });
    });
    // One run: read in full, or deleted. Ids from the Sentinel CLI may hold slashes, encoded.
    await page.route(
      (url) => url.pathname.startsWith(`${base()}/runs/`),
      (route) => {
        const request = route.request();
        sentinelPath(request);
        const { pathname } = new URL(request.url());
        const id = decodeURIComponent(pathname.slice(`${base()}/runs/`.length));
        const run = this.listed.find((listed) => listed.id === id);
        const gone = failure(404, 'not_found', `No run ${id} on the board.`);
        if (request.method() !== 'DELETE') {
          return route.fulfill(run ? { json: runBody(run) } : gone);
        }
        this.deletes.push(id);
        if (run?.ended_at === null) {
          return route.fulfill(failure(409, 'trace_conflict', `${run.name} is recording.`));
        }
        return route.fulfill(run ? { json: this.delete(run) } : gone);
      },
    );
    await page.route(route('compare'), (route) => {
      sentinelPath(route.request());
      const runs = new URL(route.request().url()).searchParams.get('runs') ?? '';
      this.compares.push(runs);
      const answer = comparison(runs.split(','));
      if (!answer) return route.fulfill(failure(404, 'not_found', 'A run is not on the board.'));
      return route.fulfill({ json: answer });
    });
    await page.route(
      (url) => url.pathname === '/api/slots',
      (route) => route.fulfill({ json: { count: 48, slots: [] } }),
    );
  }

  /** Starts the trace a request asks for, as Sentinel would: its id from the time and the name. */
  private start(request: Request): TraceBody {
    const asked = request.postDataJSON() as TraceRequest;
    this.starts.push(asked);
    const startedAt = new Date(TRACE_START).toISOString();
    const metadata: RunMetadata = {
      ...ACTIVE_TRACE,
      id: `${startedAt.replace(/[-:]/g, '')}-${asked.name}`,
      name: asked.name,
      note: asked.note ?? null,
      tags: [...(asked.tags ?? [])],
      started_at: startedAt,
    };
    const summary: RunSummary = {
      id: metadata.id,
      name: metadata.name,
      started_at: startedAt,
      ended_at: null,
      duration_ms: 0,
      samples: 0,
      energy_joules: null,
    };
    this.trace = { metadata, summary };
    return traceAnswer(metadata);
  }

  /** Stops the trace: its run joins the finished ones, first. */
  private stop({ metadata, summary }: FakeTrace): TraceBody {
    const endedAt = new Date(Date.parse(metadata.started_at) + STOPPED_TOTALS.duration_ms);
    const ended = { ended_at: endedAt.toISOString() };
    const run: RunSummary = { ...summary, ...STOPPED_TOTALS, ...ended };
    this.trace = null;
    this.runs = [run, ...this.runs];
    return traceAnswer({ ...metadata, ...ended }, run);
  }

  private delete(run: RunSummary): DeleteAnswer {
    this.runs = this.runs.filter((kept) => kept.id !== run.id);
    return { deleted: { id: run.id, name: run.name }, runs: runsAnswer(this.listed) };
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

/** A refusal as the server words one. */
function failure(status: number, code: string, message: string) {
  return { status, json: sentinelError(code, message, '') };
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
