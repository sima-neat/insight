import { Page, Request } from '@playwright/test';
// Types only, erased at run time: the answers are checked against the shapes the app reads.
import type { BoardState } from '../src/app/board/api';
import type {
  MetricsQuery,
  SentinelInstallResult,
  SentinelMetrics,
  SentinelState,
} from '../src/app/stats/api';
// Loaded at run time: Playwright reads the app's own fixtures (the capture of a Modalix DevKit's
// metrics and the builders over it), so the specs and the e2e share one copy of the board.
import { METRICS_LIVE, sentinelState, withHistory } from '../src/app/stats/stats.testing';
import { answerTopBar, TOP_BAR_BOARD } from './top-bar';

// The answers of the board, Sentinel and System Info endpoints for the Stats e2e, built from
// `stats.testing.ts`: a full window of history first, then the samples after the one asked for.

/** Sentinel takes a sample every 2 s; the window the fake keeps is shorter than the app asks for. */
const STEP_MS = 2000;
const WINDOW_SAMPLES = 30;
/** The first sample's time; the fake's clock counts samples from here. */
const FIRST_SAMPLE = Date.parse('2026-10-24T10:00:00Z');

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

export class FakeStatsBackend {
  /** What `GET /api/board` answers. */
  board: BoardState = STATS_BOARD;
  /** Whether the daemon runs; an install makes it so. */
  sentinel: 'running' | 'missing' = 'running';
  /** Every poll answers this failure while it is set. */
  metricsFailure: { status: number; body: object } | null = null;

  /** Every `GET /api/sentinel/metrics`, in order, as the query it carried. */
  readonly queries: MetricsQuery[] = [];
  /** The newest sample's time of every answer to a metrics request, in order. */
  readonly answered: (string | null)[] = [];
  /** The path of every request to Sentinel's endpoints (state, metrics and install), in order. */
  readonly sentinelRequests: string[] = [];
  /** The `generation` of every `POST /api/sentinel/install`, in order. */
  readonly installs: (string | null)[] = [];

  /** Set while an install is held open (`holdInstall`): it answers once it is released. */
  private held: Promise<void> | null = null;
  /** The newest sample's place in the fake's clock; each poll finds one more. */
  private head = WINDOW_SAMPLES - 1;
  private readonly epoch = METRICS_LIVE.history.epoch;

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
