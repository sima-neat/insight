import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { createEnvironmentInjector, EnvironmentInjector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BoardTarget } from '../board/api';
import { BoardService } from '../board/board.service';
import { boardState, DEVKIT, FakeBoard } from '../board/board.testing';
import type { SentinelMetrics, SentinelState } from './api';
import { failureOf } from './sentinel-failure';
import { type InstallOutcome, SentinelInstall } from './sentinel-install';
import { SentinelTelemetry } from './sentinel-telemetry';
import { METRICS_LIVE, sentinelState, withHistory } from './stats.testing';

const STATE_URL = '/api/sentinel';
const METRICS_URL = '/api/sentinel/metrics';
const badGateway = { status: 502, statusText: 'Bad Gateway' };

/** Sentinel's answer on board `generation`: `samples` samples from `start`, of history `epoch`. */
function metrics(
  generation: number,
  samples = 3,
  { start = '2026-10-24T10:00:00Z', full = true, epoch = 1 } = {},
): SentinelMetrics {
  return { ...withHistory(METRICS_LIVE, samples, { start, full, epoch }), generation };
}

/** The sample after the three of `metrics(generation)`, as an incremental answer. */
function nextSample(generation: number): SentinelMetrics {
  return metrics(generation, 1, { start: '2026-10-24T10:00:06Z', full: false });
}

/** A failure body as the backend answers it, under board `generation`. */
function failed(code: string, generation: number) {
  return { error: `Failed with ${code}.`, code, generation };
}

describe('SentinelTelemetry', () => {
  let http: HttpTestingController;
  let board: FakeBoard;
  let outcome: ReturnType<typeof signal<InstallOutcome | null>>;
  let visibility: DocumentVisibilityState;
  let page: EnvironmentInjector | null;
  let telemetry: SentinelTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    board = new FakeBoard();
    board.state.set(boardState({ target: DEVKIT, generation: 3 }));
    outcome = signal<InstallOutcome | null>(null);
    page = null;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: BoardService, useValue: board },
        { provide: SentinelInstall, useValue: { outcome } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    close();
    http.verify();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Opens the page: the controller lives in the page's injector, as the Stats page provides it. */
  function open(): void {
    page = createEnvironmentInjector([SentinelTelemetry], TestBed.inject(EnvironmentInjector));
    telemetry = page.get(SentinelTelemetry);
    TestBed.tick();
  }

  /** Leaves the page, which destroys the controller with it. */
  function close(): void {
    page?.destroy();
    page = null;
  }

  /** Lets the promise chains behind a flushed request run. */
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  const stateRead = () => http.expectOne((request) => request.url === STATE_URL);
  const metricsPoll = () => http.expectOne((request) => request.url === METRICS_URL);
  const stateReads = () => http.match((request) => request.url === STATE_URL);
  const metricPolls = () => http.match((request) => request.url === METRICS_URL);
  // Matched by path: a URL string would be compared with the query parameters included.
  const noStateRead = () => http.expectNone((request) => request.url === STATE_URL);
  const noPoll = () => http.expectNone((request) => request.url === METRICS_URL);

  async function flush(request: TestRequest, body: object, failure = false): Promise<void> {
    request.flush(body, failure ? badGateway : undefined);
    await settle();
  }

  const answerState = (overrides: Partial<SentinelState> = {}) =>
    flush(stateRead(), sentinelState({ generation: 3, ...overrides }));
  const answerMetrics = (answer: SentinelMetrics = metrics(3)) => flush(metricsPoll(), answer);
  const failMetrics = (code: string, generation = 3) =>
    flush(metricsPoll(), failed(code, generation), true);

  /** Opens the page on an available Sentinel and answers its first poll, at 0 s. */
  async function openLive(): Promise<void> {
    open();
    await answerState();
    await answerMetrics();
  }

  function setVisibility(state: DocumentVisibilityState): void {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  }

  function switchBoard(generation: number, target: BoardTarget | null = DEVKIT): void {
    board.state.set(boardState({ target, generation }));
    TestBed.tick();
  }

  it('polls /api/sentinel/metrics every 2 s from each poll’s start while Sentinel is available and the tab is visible', async () => {
    open();
    expect(telemetry.checking()).toBe(true);
    // The board's state is read first: nothing is polled before it says available.
    const read = stateRead();
    expect(read.request.params.has('refresh')).toBe(false);
    noPoll();
    await flush(read, sentinelState({ generation: 3 }));
    expect(telemetry.checking()).toBe(false);
    expect(telemetry.state()?.available).toBe(true);

    // The first poll goes out at once; its answer takes 0.5 s.
    const first = metricsPoll();
    expect(first.request.method).toBe('GET');
    await advance(500);
    await flush(first, metrics(3));

    // Due 2 s after that poll started, not 2 s after its answer.
    await advance(1499);
    noPoll();
    await advance(1);
    const second = metricsPoll();

    // An answer slower than 2 s holds the next poll back; it then goes at once.
    await advance(5000);
    noPoll();
    await flush(second, nextSample(3));
    await answerMetrics(metrics(3, 0, { full: false }));
  });

  it('asks for the full window first, then only the samples after the newest held one with its epoch', async () => {
    open();
    await answerState();
    const first = metricsPoll();
    expect(first.request.params.keys()).toEqual(['history']);
    expect(first.request.params.get('history')).toBe('240');
    await flush(first, metrics(3, 3, { epoch: 7 }));
    expect(telemetry.window()?.timestamps).toHaveLength(3);

    await advance(2000);
    const next = metricsPoll();
    expect(next.request.params.get('history')).toBe('240');
    expect(next.request.params.get('after')).toBe('2026-10-24T10:00:04.000Z');
    expect(next.request.params.get('epoch')).toBe('7');
    await flush(next, metrics(3, 1, { start: '2026-10-24T10:00:06Z', full: false, epoch: 7 }));
    expect(telemetry.window()?.timestamps).toHaveLength(4);
  });

  it('backs off 4, 8, 16 then 30 s after consecutive failures and returns to 2 s after a success', async () => {
    await openLive();
    await advance(2000);
    await failMetrics('sentinel_failed');

    const waits = [4000, 8000, 16_000, 30_000, 30_000];
    for (const [i, wait] of waits.entries()) {
      await advance(wait - 1);
      noPoll();
      await advance(1);
      if (i < waits.length - 1) await failMetrics('sentinel_failed');
      else await answerMetrics(nextSample(3));
      // The daemon's state is re-read every 30 s meanwhile.
      for (const read of stateReads()) await flush(read, sentinelState({ generation: 3 }));
    }

    await advance(1999);
    noPoll();
    await advance(1);
    await answerMetrics(metrics(3, 0, { full: false }));
  });

  it('a halting code stops polling and re-reads the state; an available state starts it again', async () => {
    await openLive();
    await advance(2000);
    await failMetrics('sentinel_stopped');
    expect(telemetry.failure()).toMatchObject({ code: 'sentinel_stopped', daemon: true });

    // The state is re-read at once, and says why.
    await answerState({ available: false, status: { state: 'stopped', error: null } });
    expect(telemetry.state()?.status.state).toBe('stopped');
    await advance(27_999);
    noPoll();

    // The 30 s re-read finds the daemon back: polling starts again at once.
    await advance(1);
    await answerState();
    await answerMetrics(nextSample(3));
    expect(telemetry.failure()).toBeNull();
    expect(telemetry.window()?.timestamps).toHaveLength(4);

    // A halting failure that lands while the tab is hidden leaves the re-read to the tab showing.
    await advance(2000);
    const out = metricsPoll();
    setVisibility('hidden');
    await flush(out, failed('unreachable', 3), true);
    expect(telemetry.failure()?.code).toBe('unreachable');
    noStateRead();
    setVisibility('visible');
    noPoll();
    await answerState();
    await answerMetrics(metrics(3, 0, { full: false }));
  });

  it('a failed poll keeps the window and records the failure; retry clears the halt and polls at once', async () => {
    await openLive();
    const held = telemetry.window();
    await advance(2000);
    await failMetrics('timeout');
    expect(telemetry.window()).toBe(held);
    expect(telemetry.failure()).toMatchObject({ code: 'timeout', generation: 3, retryable: true });

    // The halt's state read fails too: the last state stays, with the reason it could not be read.
    await flush(stateRead(), failed('timeout', 3), true);
    expect(telemetry.state()?.available).toBe(true);
    expect(telemetry.stateFailure()?.code).toBe('timeout');
    await advance(10_000);
    noPoll();

    telemetry.retry();
    // The backoff starts over: one failure waits 4 s, not the 8 s a second one in a row would.
    await failMetrics('sentinel_failed');
    await advance(3999);
    noPoll();
    await advance(1);
    await failMetrics('sentinel_failed');

    // Retry also sends a backed-off poll that is still waiting, at once.
    telemetry.retry();
    await answerMetrics(nextSample(3));
    expect(telemetry.failure()).toBeNull();
    expect(telemetry.window()?.timestamps).toHaveLength(4);
  });

  it('pause stops metric polls but not the 30 s state re-read; resume polls at once', async () => {
    await openLive();
    telemetry.pause();
    expect(telemetry.paused()).toBe(true);

    await advance(30_000);
    await answerState();
    noPoll();

    telemetry.resume();
    expect(telemetry.paused()).toBe(false);
    await answerMetrics(nextSample(3));
  });

  it('hiding the tab stops both; showing it polls once at once, however often it was hidden and shown', async () => {
    await openLive();
    setVisibility('hidden');
    await advance(60_000);
    noStateRead();
    noPoll();

    setVisibility('visible');
    setVisibility('hidden');
    setVisibility('visible');
    setVisibility('hidden');
    setVisibility('visible');
    const polls = metricPolls();
    const reads = stateReads();
    expect(polls).toHaveLength(1);
    expect(reads).toHaveLength(1);
    await flush(reads[0], sentinelState({ generation: 3 }));

    // A poll that answers while the tab is hidden schedules nothing until it shows again.
    setVisibility('hidden');
    await flush(polls[0], nextSample(3));
    await advance(10_000);
    noPoll();
    setVisibility('visible');
    await flush(stateRead(), sentinelState({ generation: 3 }));
    await answerMetrics(metrics(3, 0, { full: false }));
    await advance(1999);
    noPoll();
  });

  it('re-reads the state at once when the window regains focus', async () => {
    await openLive();
    window.dispatchEvent(new Event('focus'));
    const read = stateRead();
    // A read still out answers for this focus too.
    window.dispatchEvent(new Event('focus'));
    noStateRead();
    await flush(read, sentinelState({ generation: 3 }));

    window.dispatchEvent(new Event('focus'));
    await answerState();
  });

  it('drops an answer for another generation and reloads the board', async () => {
    open();
    // The state, read under board 3, answers for board 4: another client switched the board.
    await answerState({ generation: 4 });
    expect(telemetry.state()).toBeNull();
    expect(board.reload).toHaveBeenCalledTimes(1);
    // A failure that names another generation is no failure of this board: dropped too.
    window.dispatchEvent(new Event('focus'));
    await flush(stateRead(), failed('sentinel_failed', 4), true);
    expect(telemetry.stateFailure()).toBeNull();
    expect(board.reload).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event('focus'));
    await answerState();
    await answerMetrics(metrics(4));
    expect(telemetry.window()).toBeNull();
    expect(board.reload).toHaveBeenCalledTimes(3);

    // Nor is a poll's failure counted towards the backoff.
    await advance(2000);
    await failMetrics('sentinel_failed', 4);
    expect(telemetry.failure()).toBeNull();
    expect(board.reload).toHaveBeenCalledTimes(4);
    await advance(2000);
    await answerMetrics();
    expect(telemetry.window()?.generation).toBe(3);
  });

  it('a board change clears the window, state and failure and re-reads the state', async () => {
    await openLive();
    await advance(2000);
    await failMetrics('sentinel_failed');
    expect(telemetry.window()).not.toBeNull();

    switchBoard(4);
    expect(telemetry.window()).toBeNull();
    expect(telemetry.state()).toBeNull();
    expect(telemetry.failure()).toBeNull();
    expect(telemetry.checking()).toBe(true);

    await flush(stateRead(), sentinelState({ generation: 4 }));
    expect(telemetry.state()?.generation).toBe(4);
    // A new board starts from the full window, and its backoff from the start.
    const first = metricsPoll();
    expect(first.request.params.keys()).toEqual(['history']);
    await flush(first, failed('sentinel_failed', 4), true);
    await advance(3999);
    noPoll();
    await advance(1);
    await answerMetrics(metrics(4));
    expect(telemetry.window()?.generation).toBe(4);
  });

  it('a board switch is not blocked by a request still out to the previous board', async () => {
    open();
    await answerState();
    const onA = metricsPoll();
    window.dispatchEvent(new Event('focus'));
    const readA = stateRead();

    switchBoard(4);
    // Board 4's state is read at once, though board 3's read is still out.
    const readB = stateRead();
    // Board 3's read lands first and is ignored; board 4's is still being checked.
    await flush(readA, sentinelState({ generation: 3, available: false }));
    expect(telemetry.state()).toBeNull();
    expect(telemetry.checking()).toBe(true);

    await flush(readB, sentinelState({ generation: 4 }));
    // Board 4 is polled at once, though board 3's poll is still out.
    const onB = metricsPoll();

    // Board 3's poll lands late and is ignored: nothing applied, reloaded or scheduled.
    await flush(onA, metrics(3));
    expect(telemetry.window()).toBeNull();
    expect(telemetry.state()?.generation).toBe(4);
    expect(board.reload).not.toHaveBeenCalled();
    noPoll();

    await flush(onB, metrics(4));
    expect(telemetry.window()?.generation).toBe(4);
  });

  it('polls nothing for a new board on the previous board’s state before the change is followed', async () => {
    await openLive();
    telemetry.pause();
    // The board changed, and the effect that follows it has not run yet.
    board.state.set(boardState({ target: DEVKIT, generation: 4 }));
    telemetry.resume();
    noPoll();

    TestBed.tick();
    await flush(stateRead(), sentinelState({ generation: 4 }));
    await answerMetrics(metrics(4));
  });

  it('a failure from the previous board landing after a switch is ignored', async () => {
    open();
    await answerState();
    const onA = metricsPoll();
    switchBoard(4);
    await flush(stateRead(), sentinelState({ generation: 4 }));
    const onB = metricsPoll();

    await flush(onA, failed('unreachable', 3), true);
    expect(telemetry.failure()).toBeNull();
    expect(telemetry.update()).toBe('live');
    // No halt, so no state re-read for it.
    noStateRead();
    await flush(onB, metrics(4));
  });

  it('update reads live, paused or stopped', async () => {
    open();
    expect(telemetry.update()).toBe('stopped');
    await answerState();
    expect(telemetry.update()).toBe('live');
    await answerMetrics();

    telemetry.pause();
    expect(telemetry.update()).toBe('paused');
    telemetry.resume();
    expect(telemetry.update()).toBe('live');
    await answerMetrics(nextSample(3));

    setVisibility('hidden');
    expect(telemetry.update()).toBe('stopped');
    setVisibility('visible');
    expect(telemetry.update()).toBe('live');
    await flush(stateRead(), sentinelState({ generation: 3, available: false }));
    expect(telemetry.update()).toBe('stopped');
    // The poll out when the state said unavailable lands; nothing follows it.
    await answerMetrics(metrics(3, 0, { full: false }));
    await advance(2000);
    noPoll();
  });

  it('a failed poll reads stopped while the backoff retries; a success reads live again', async () => {
    await openLive();
    await advance(2000);
    await failMetrics('sentinel_failed');
    expect(telemetry.update()).toBe('stopped');

    await advance(4000);
    const retried = metricsPoll();
    expect(telemetry.update()).toBe('stopped');
    await flush(retried, nextSample(3));
    expect(telemetry.update()).toBe('live');
  });

  it('nothing is requested without a board target, and destroying the controller stops every timer', async () => {
    board.state.set(boardState({ target: null, generation: 3 }));
    open();
    await advance(60_000);
    window.dispatchEvent(new Event('focus'));
    setVisibility('hidden');
    setVisibility('visible');
    await telemetry.recheck();
    telemetry.retry();
    telemetry.resume();
    noStateRead();
    noPoll();
    expect(telemetry.checking()).toBe(false);
    expect(telemetry.update()).toBe('stopped');

    // Once a board is selected it is read and polled; then the page goes, with the next poll
    // scheduled and a state read out.
    switchBoard(4);
    await flush(stateRead(), sentinelState({ generation: 4 }));
    await flush(metricsPoll(), metrics(4));
    window.dispatchEvent(new Event('focus'));
    const out = stateRead();
    close();

    // The read still out lands on nothing, and nothing is sent any more.
    await flush(out, sentinelState({ generation: 4 }));
    await advance(120_000);
    window.dispatchEvent(new Event('focus'));
    setVisibility('hidden');
    setVisibility('visible');
    outcome.set({ generation: 4, ok: true, log: '' });
    TestBed.tick();
    noStateRead();
    noPoll();
    expect(vi.getTimerCount()).toBe(0);

    // A poll still out when the page goes lands on nothing, even one that names another board.
    open();
    await flush(stateRead(), sentinelState({ generation: 4 }));
    const polled = metricsPoll();
    close();
    await flush(polled, metrics(5));
    expect(board.reload).not.toHaveBeenCalled();
    noStateRead();
    noPoll();
  });

  it('a successful install for this generation re-reads the state with refresh=1', async () => {
    // An install that ended before the page opened is covered by the page's first read.
    outcome.set({ generation: 3, ok: true, log: 'installed' });
    open();
    const first = stateRead();
    expect(first.request.params.has('refresh')).toBe(false);
    await flush(first, sentinelState({ generation: 3 }));
    await answerMetrics();
    TestBed.tick();
    noStateRead();

    outcome.set({ generation: 3, ok: true, log: 'installed again' });
    TestBed.tick();
    const recheck = stateRead();
    expect(recheck.request.params.get('refresh')).toBe('1');
    await flush(recheck, sentinelState({ generation: 3 }));

    // Another board's install, or a failed one, changes nothing here.
    outcome.set({ generation: 2, ok: true, log: 'installed' });
    TestBed.tick();
    outcome.set({
      generation: 3,
      ok: false,
      failure: failureOf(new Error('No sudo.'), 3, 'install'),
    });
    TestBed.tick();
    noStateRead();

    // One that ends while the tab is hidden is read when the tab shows again.
    setVisibility('hidden');
    outcome.set({ generation: 3, ok: true, log: 'installed once more' });
    TestBed.tick();
    noStateRead();
    setVisibility('visible');
    await flush(stateRead(), sentinelState({ generation: 3 }));
    await answerMetrics(nextSample(3));
  });

  it('recheck asks for a fresh state and settles with its answer', async () => {
    open();
    await answerState({ available: false, status: { state: 'missing', error: null } });

    let settled = false;
    const done = telemetry.recheck().then(() => (settled = true));
    const read = stateRead();
    expect(read.request.params.get('refresh')).toBe('1');
    await settle();
    expect(settled).toBe(false);
    await flush(read, sentinelState({ generation: 3 }));
    await done;
    expect(telemetry.state()?.available).toBe(true);
    await answerMetrics();
  });
});
