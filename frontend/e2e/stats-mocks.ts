import { Page, Request } from '@playwright/test';
// Types only, erased at run time: the answers are checked against the shapes the app reads.
import type { BoardState } from '../src/app/board/api';
import type {
  CompareAnswer,
  CompareExport,
  DeleteAnswer,
  MetricsQuery,
  RunAnswer,
  RunMetadata,
  RunSummary,
  SentinelInstallResult,
  SentinelMetrics,
  SentinelState,
  TraceAnswer,
  TraceRequest,
} from '../src/app/stats/api';
// Loaded at run time: Playwright reads the app's own fixtures (the capture of a Modalix DevKit's
// metrics and runs, and the builders over them), so the specs and the e2e share one copy of the
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
import { METRICS_LIVE, sentinelState, withHistory } from '../src/app/stats/stats.testing';
import { answerTopBar, TOP_BAR_BOARD } from './top-bar';

// The answers of the board, Sentinel and System Info endpoints for the Stats e2e, built from
// `stats.testing.ts`: a full window of history first, then the samples after the one asked for.

/** Sentinel takes a sample every 2 s; the window the fake keeps is shorter than the app asks for. */
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
export const STATS_BOARD: BoardState = { ...TOP_BAR_BOARD, generation: METRICS_LIVE.generation };

/** No board is selected: the page offers to choose one. */
export const NO_BOARD: BoardState = {
  ...STATS_BOARD,
  target: null,
  saved: null,
  status: { state: 'unknown', checked_at: null, error: null },
  board: null,
};

/** A poll Sentinel could not answer (502 `sentinel_failed`), as the backend words it. */
export const SENTINEL_FAILED = {
  status: 502,
  body: {
    error: 'Sentinel did not answer within 5 s.',
    code: 'sentinel_failed',
    hint: 'Check `systemctl status simaai-sentinel` on the board.',
    generation: METRICS_LIVE.generation,
  },
};

/** What `GET /api/sentinel` answers while the daemon is not installed, on a board with `sima-cli`. */
function missingSentinel(): SentinelState {
  const running = sentinelState();
  return sentinelState({
    available: false,
    version: null,
    status: { state: 'missing', error: null },
    daemon: {
      ...running.daemon,
      installed: false,
      healthy: false,
      service: 'inactive',
      socket: false,
      instance_id: null,
      started_at: null,
    },
    health: null,
  });
}

/** A trace recording on the board: what Sentinel keeps about it, and its run's totals so far. */
interface FakeTrace {
  metadata: RunMetadata;
  summary: RunSummary;
}

/** A change the fake was asked for: the board generation it was sent under (`?generation=`). */
interface Sent {
  generation: string | null;
}

export class FakeStatsBackend {
  /** What `GET /api/board` answers. */
  board: BoardState = STATS_BOARD;
  /** Whether the daemon runs; an install makes it so. */
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

  /** Every `GET /api/sentinel/metrics`, in order, as the query it carried. */
  readonly queries: MetricsQuery[] = [];
  /** The newest sample's time of every answer to a metrics request, in order. */
  readonly answered: (string | null)[] = [];
  /**
   * The path of every request to Sentinel's endpoints (state, metrics, install and the trace), in
   * order.
   */
  readonly sentinelRequests: string[] = [];
  /** The `generation` of every `POST /api/sentinel/install`, in order. */
  readonly installs: (string | null)[] = [];
  /** Every `POST /api/sentinel/traces`, in order, with the trace it asked for. */
  readonly starts: (Sent & { request: TraceRequest })[] = [];
  /** Every `POST /api/sentinel/traces/stop`, in order, with the trace it named (`trace_id`). */
  readonly stops: (Sent & { traceId: string | null })[] = [];
  /** Every `DELETE /api/sentinel/runs/<id>`, in order. */
  readonly deletes: (Sent & { id: string })[] = [];
  /** The `runs` of every `GET /api/sentinel/compare`, in order: the baseline's id first. */
  readonly compares: string[] = [];

  /** Set while an install is held open (`holdInstall`): it answers once it is released. */
  private held: Promise<void> | null = null;
  /** The newest sample's place in the fake's clock; each poll finds one more. */
  private head = WINDOW_SAMPLES - 1;
  private readonly epoch = METRICS_LIVE.history.epoch;

  /** The fixture's trace records on the board: its run (`RECORDING_RUN`) heads the run list. */
  recording(): void {
    this.trace = { metadata: ACTIVE_TRACE, summary: RECORDING_RUN };
  }

  /** The runs `GET /api/sentinel/runs` lists: the recording one first, as Sentinel lists it. */
  get listed(): RunSummary[] {
    return this.trace ? [this.trace.summary, ...this.runs] : this.runs;
  }

  /** Holds every install open until the returned function is called. */
  holdInstall(): () => void {
    let release!: () => void;
    this.held = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.held = null;
      release();
    };
  }

  /** The metrics requests so far. */
  get polls(): number {
    return this.queries.length;
  }

  /**
   * Answers the board, Sentinel and System Info endpoints, and the Streaming page's slots (empty),
   * where the flows leave Stats to. Call it before the page loads.
   */
  async install(page: Page): Promise<void> {
    await answerTopBar(page);
    const sentinelPath = (request: Request) => {
      const { pathname } = new URL(request.url());
      this.sentinelRequests.push(pathname);
    };

    await page.route(
      (url) => url.pathname === '/api/board',
      (route) => route.fulfill({ json: this.board }),
    );
    await page.route(
      (url) => url.pathname === '/api/sentinel',
      (route) => {
        sentinelPath(route.request());
        return route.fulfill({
          json: this.sentinel === 'running' ? sentinelState() : missingSentinel(),
        });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/sentinel/metrics',
      (route) => {
        sentinelPath(route.request());
        const query = queryOf(route.request());
        this.queries.push(query);
        if (this.metricsFailure) {
          return route.fulfill({
            status: this.metricsFailure.status,
            json: this.metricsFailure.body,
          });
        }
        const answer = this.metricsAnswer(query);
        this.answered.push(answer.sampled_at);
        return route.fulfill({ json: answer });
      },
    );
    // The trace: read (the toolbar offers Record while none records) and started.
    await page.route(
      (url) => url.pathname === '/api/sentinel/traces',
      (route) => {
        const request = route.request();
        sentinelPath(request);
        if (request.method() === 'POST') {
          return route.fulfill({ json: this.start(request) });
        }
        return route.fulfill({
          json: traceAnswer(this.trace?.metadata ?? null, this.trace?.summary ?? null),
        });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/sentinel/traces/stop',
      (route) => {
        const request = route.request();
        sentinelPath(request);
        const traceId = new URL(request.url()).searchParams.get('trace_id');
        this.stops.push({ generation: generationOf(request), traceId });
        if (this.trace === null || this.trace.metadata.id !== traceId) {
          return route.fulfill(failure(409, 'trace_conflict', 'Another trace is recording.'));
        }
        return route.fulfill({ json: this.stop(this.trace) });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/sentinel/runs',
      (route) => {
        sentinelPath(route.request());
        return route.fulfill({ json: runsAnswer(this.listed) });
      },
    );
    // One run: read in full, or deleted. Ids from the Sentinel CLI may hold slashes, encoded.
    await page.route(
      (url) => url.pathname.startsWith('/api/sentinel/runs/'),
      (route) => {
        const request = route.request();
        sentinelPath(request);
        const { pathname } = new URL(request.url());
        const id = decodeURIComponent(pathname.slice('/api/sentinel/runs/'.length));
        const run = this.listed.find((listed) => listed.id === id);
        const gone = failure(404, 'not_found', `No run ${id} on the board.`);
        if (request.method() !== 'DELETE') {
          return route.fulfill(run ? { json: runAnswer(run) } : gone);
        }
        this.deletes.push({ id, generation: generationOf(request) });
        if (run?.ended_at === null) {
          return route.fulfill(failure(409, 'trace_conflict', `${run.name} is recording.`));
        }
        return route.fulfill(run ? { json: this.delete(run) } : gone);
      },
    );
    await page.route(
      (url) => url.pathname === '/api/sentinel/compare',
      (route) => {
        sentinelPath(route.request());
        const runs = new URL(route.request().url()).searchParams.get('runs') ?? '';
        this.compares.push(runs);
        const answer = comparison(runs.split(','));
        if (!answer) return route.fulfill(failure(404, 'not_found', 'A run is not on the board.'));
        return route.fulfill({ json: answer });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/sentinel/install',
      async (route) => {
        sentinelPath(route.request());
        this.installs.push(new URL(route.request().url()).searchParams.get('generation'));
        await this.held;
        this.sentinel = 'running';
        const result: SentinelInstallResult = {
          board: METRICS_LIVE.board,
          generation: METRICS_LIVE.generation,
          daemon: sentinelState().daemon,
          log: 'Installed simaai-sentinel main:80ab7de4da31.',
        };
        return route.fulfill({ json: result });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/mediasrc',
      (route) => route.fulfill({ json: [] }),
    );
  }

  /** Starts the trace a request asks for, as Sentinel would: its id from the time and the name. */
  private start(request: Request): TraceAnswer {
    const asked = request.postDataJSON() as TraceRequest;
    this.starts.push({ generation: generationOf(request), request: asked });
    const startedAt = new Date(TRACE_START).toISOString();
    const metadata: RunMetadata = {
      ...ACTIVE_TRACE,
      id: `${startedAt.replace(/[-:]/g, '')}-${asked.name}`,
      name: asked.name,
      note: asked.note ?? null,
      tags: asked.tags ?? [],
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
  private stop({ metadata, summary }: FakeTrace): TraceAnswer {
    const endedAt = new Date(Date.parse(metadata.started_at) + STOPPED_TOTALS.duration_ms);
    const ended = { ended_at: endedAt.toISOString() };
    const run: RunSummary = { ...summary, ...STOPPED_TOTALS, ...ended };
    this.trace = null;
    this.runs = [run, ...this.runs];
    return traceAnswer({ ...metadata, ...ended }, run);
  }

  private delete(run: RunSummary): DeleteAnswer {
    this.runs = this.runs.filter((kept) => kept.id !== run.id);
    return { ...runsAnswer(this.listed), deleted: { id: run.id, name: run.name } };
  }

  /**
   * One more sample is in, and the answer is what Sentinel's would be: the whole window when the
   * caller holds none (or another epoch's), else the samples after the one it names.
   */
  private metricsAnswer({ history, after, epoch }: MetricsQuery): SentinelMetrics {
    this.head++;
    const sampleTime = (index: number) => FIRST_SAMPLE + index * STEP_MS;
    if (after !== undefined && epoch === this.epoch) {
      const held = Math.round((Date.parse(after) - FIRST_SAMPLE) / STEP_MS);
      const start = new Date(sampleTime(held + 1)).toISOString();
      return withHistory(METRICS_LIVE, this.head - held, {
        start,
        stepMs: STEP_MS,
        full: false,
        epoch: this.epoch,
      });
    }
    const samples = Math.min(history, WINDOW_SAMPLES);
    return withHistory(METRICS_LIVE, samples, {
      start: new Date(sampleTime(this.head - samples + 1)).toISOString(),
      stepMs: STEP_MS,
      full: true,
      epoch: this.epoch,
    });
  }
}

/** The metrics query a request carried. */
function queryOf(request: Request): MetricsQuery {
  const params = new URL(request.url()).searchParams;
  const after = params.get('after');
  const epoch = params.get('epoch');
  return {
    history: Number(params.get('history')),
    ...(after === null ? {} : { after }),
    ...(epoch === null ? {} : { epoch: Number(epoch) }),
  };
}

/** The board generation a change was sent under. */
function generationOf(request: Request): string | null {
  return new URL(request.url()).searchParams.get('generation');
}

/** A refusal as the backend words one, for the board of every test. */
function failure(status: number, code: string, error: string) {
  return { status, json: { error, code, hint: '', generation: METRICS_LIVE.generation } };
}

/**
 * A run in full: the detail fixture's own run as captured, any other with its samples under that
 * run's id and name, which is all the run panel shows of them.
 */
function runAnswer(run: RunSummary): RunAnswer {
  const saved =
    run.id === SAVED_RUN.metadata.id
      ? SAVED_RUN
      : savedRun({ metadata: { ...SAVED_RUN.metadata, id: run.id, name: run.name } });
  return { board: METRICS_LIVE.board, generation: METRICS_LIVE.generation, sentinel: saved };
}

/**
 * Sentinel's comparison of the runs of `ids`, the first as baseline, from the runs `COMPARE_RAW`
 * holds (in any order, its deltas measured against the baseline asked for); null when it does not
 * hold one of them.
 */
function comparison(ids: string[]): CompareAnswer | null {
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
  const sentinel: CompareExport = {
    ...COMPARE_RAW,
    baseline_id: baseline,
    runs: ids.map((id) => byId.get(id)!),
    summaries: Object.fromEntries(ids.map((id) => [id, COMPARE_RAW.summaries[id]])),
    baseline_deltas_pct: Object.fromEntries(ids.map((id) => [id, deltas(id)])),
  };
  return { board: METRICS_LIVE.board, generation: METRICS_LIVE.generation, sentinel };
}
