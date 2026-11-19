import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BoardTarget } from '../board/api';
import { BoardService } from '../board/board.service';
import { boardList, boardWith, DEVKIT, FakeBoard, LOCAL } from '../board/board.testing';
import type { SentinelCache } from './api';
import { SentinelTelemetry } from './sentinel-telemetry';
import { cacheWith, sentinelError, sentinelHealth } from './stats.testing';

const badGateway = { status: 502, statusText: 'Bad Gateway' };

const healthUrl = (target: BoardTarget = DEVKIT) =>
  `/api/boards/${encodeURIComponent(target.id)}/sentinel/health`;
const cacheUrl = (target: BoardTarget = DEVKIT) =>
  `/api/boards/${encodeURIComponent(target.id)}/sentinel/cache`;

/** Sentinel's cache: `samples` samples from `start`. */
function cache(samples = 3, { start = '2026-10-24T10:00:00Z', full = true } = {}): SentinelCache {
  return cacheWith(samples, { start, full });
}

/** The sample after the three of `cache()`, as an incremental answer. */
const nextSample = (): SentinelCache => cache(1, { start: '2026-10-24T10:00:06Z', full: false });

/** A failure body as the server answers it. */
const failed = (code: string) => sentinelError(code, `Failed with ${code}.`, '');

describe('SentinelTelemetry', () => {
  let http: HttpTestingController;
  let board: FakeBoard;
  let visibility: DocumentVisibilityState;
  let page: EnvironmentInjector | null;
  let telemetry: SentinelTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    board = new FakeBoard();
    board.state.set(boardWith(DEVKIT));
    page = null;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: BoardService, useValue: board },
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

  // Matched by path: a URL string would be compared with the query parameters included.
  const stateRead = (target?: BoardTarget) =>
    http.expectOne((request) => request.url === healthUrl(target));
  const cachePoll = (target?: BoardTarget) =>
    http.expectOne((request) => request.url === cacheUrl(target));
  const stateReads = () => http.match((request) => request.url.endsWith('/sentinel/health'));
  const cachePolls = () => http.match((request) => request.url.endsWith('/sentinel/cache'));
  const noStateRead = () => http.expectNone((request) => request.url.endsWith('/sentinel/health'));
  const noPoll = () => http.expectNone((request) => request.url.endsWith('/sentinel/cache'));

  async function flush(request: TestRequest, body: object, failure = false): Promise<void> {
    request.flush(body, failure ? badGateway : undefined);
    await settle();
  }

  const answerState = (target?: BoardTarget) => flush(stateRead(target), sentinelHealth());
  const failState = (code: string, target?: BoardTarget) =>
    flush(stateRead(target), failed(code), true);
  const answerCache = (answer: SentinelCache = cache(), target?: BoardTarget) =>
    flush(cachePoll(target), answer);
  const failCache = (code: string) => flush(cachePoll(), failed(code), true);

  /** Opens the page on a running Sentinel and answers its first poll, at 0 s. */
  async function openLive(): Promise<void> {
    open();
    await answerState();
    await answerCache();
  }

  function setVisibility(state: DocumentVisibilityState): void {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  }

  function switchBoard(target: BoardTarget | null): void {
    board.state.set(target ? boardWith(target) : boardList());
    TestBed.tick();
  }

  it('polls the cache every 2 s from each poll’s start while Sentinel answers and the tab is visible', async () => {
    open();
    expect(telemetry.checking()).toBe(true);
    // Sentinel's health is read first: nothing is polled before it answers.
    const read = stateRead();
    noPoll();
    await flush(read, sentinelHealth());
    expect(telemetry.checking()).toBe(false);
    expect(telemetry.ready()).toBe(true);
    expect(telemetry.state()).toEqual({
      board: DEVKIT.id,
      health: sentinelHealth().health,
      startedAt: '2026-10-24T09:30:00Z',
    });

    // The first poll goes out at once; its answer takes 0.5 s.
    const first = cachePoll();
    expect(first.request.method).toBe('GET');
    await advance(500);
    await flush(first, cache());

    // Due 2 s after that poll started, not 2 s after its answer.
    await advance(1499);
    noPoll();
    await advance(1);
    const second = cachePoll();

    // An answer slower than 2 s holds the next poll back; it then goes at once.
    await advance(5000);
    noPoll();
    await flush(second, nextSample());
    await answerCache(cache(0, { full: false }));
  });

  it('asks for the whole cache first, then only the samples after the newest held one', async () => {
    open();
    await answerState();
    const first = cachePoll();
    expect(first.request.params.keys()).toEqual([]);
    await flush(first, cache(3));
    expect(telemetry.window()?.timestamps).toHaveLength(3);
    expect(telemetry.window()?.board).toBe(DEVKIT.id);

    await advance(2000);
    const next = cachePoll();
    expect(next.request.params.keys()).toEqual(['after']);
    expect(next.request.params.get('after')).toBe('2026-10-24T10:00:04.000Z');
    await flush(next, nextSample());
    expect(telemetry.window()?.timestamps).toHaveLength(4);

    // A full answer (the daemon restarted, say) replaces what is held.
    await advance(2000);
    await answerCache(cache(2, { start: '2026-10-24T11:00:00Z' }));
    expect(telemetry.window()?.timestamps).toEqual([
      '2026-10-24T11:00:00.000Z',
      '2026-10-24T11:00:02.000Z',
    ]);
  });

  it('backs off 4, 8, 16 then 30 s after consecutive failures and returns to 2 s after a success', async () => {
    await openLive();
    await advance(2000);
    await failCache('sentinel_failed');

    const waits = [4000, 8000, 16_000, 30_000, 30_000];
    for (const [i, wait] of waits.entries()) {
      await advance(wait - 1);
      noPoll();
      await advance(1);
      if (i < waits.length - 1) await failCache('sentinel_failed');
      else await answerCache(nextSample());
      // Sentinel's health is re-read every 30 s meanwhile.
      for (const read of stateReads()) await flush(read, sentinelHealth());
    }

    await advance(1999);
    noPoll();
    await advance(1);
    await answerCache(cache(0, { full: false }));
  });

  it('a halting code stops polling and re-reads the state; a state that answers starts it again', async () => {
    await openLive();
    await advance(2000);
    await failCache('sentinel_stopped');
    expect(telemetry.failure()).toMatchObject({ code: 'sentinel_stopped', daemon: true });

    // The state is re-read at once, and says why: Sentinel is not ready any more.
    await failState('sentinel_stopped');
    expect(telemetry.state()).toBeNull();
    expect(telemetry.ready()).toBe(false);
    expect(telemetry.stateFailure()?.code).toBe('sentinel_stopped');
    expect(telemetry.checking()).toBe(false);
    // The window stays, for the page to show under the failure.
    expect(telemetry.window()?.timestamps).toHaveLength(3);
    await advance(27_999);
    noPoll();

    // The 30 s re-read finds the daemon back: the halting poll's backoff is long over, so polling
    // starts again at once.
    await advance(1);
    await answerState();
    expect(telemetry.stateFailure()).toBeNull();
    await answerCache(nextSample());
    expect(telemetry.failure()).toBeNull();
    expect(telemetry.window()?.timestamps).toHaveLength(4);

    // A halting failure that lands while the tab is hidden leaves the re-read to the tab showing.
    await advance(2000);
    const out = cachePoll();
    setVisibility('hidden');
    await flush(out, failed('unreachable'), true);
    expect(telemetry.failure()?.code).toBe('unreachable');
    noStateRead();
    setVisibility('visible');
    noPoll();
    // The state answers a moment after the failure: the poll waits out its backoff.
    await answerState();
    await advance(3999);
    noPoll();
    await advance(1);
    await answerCache(cache(0, { full: false }));
  });

  it('a halting failure whose state read answers polls again after the backoff, not at once', async () => {
    await openLive();
    await advance(2000);
    // A cache read that times out halts polling, while the state read beside it still answers.
    // Polling at once would hit the board back to back for as long as that lasts.
    await failCache('timeout');
    await answerState();
    expect(telemetry.failure()?.code).toBe('timeout');
    await advance(3999);
    noPoll();
    await advance(1);
    await failCache('timeout');
    await answerState();
    // The backoff grows as for any failures in a row.
    await advance(7999);
    noPoll();
    await advance(1);
    await answerCache(nextSample());
    expect(telemetry.failure()).toBeNull();
  });

  it('retry re-reads the state while Sentinel is not known to answer', async () => {
    await openLive();
    await advance(2000);
    await failCache('sentinel_stopped');
    await failState('sentinel_stopped');

    // The user started the service and pressed Retry: nothing is polled without a state, so the
    // state is read again, and an answer polls at once.
    telemetry.retry();
    const read = stateRead();
    noPoll();
    await flush(read, sentinelHealth());
    await answerCache(nextSample());
    expect(telemetry.failure()).toBeNull();
  });

  it('a failed poll keeps the window and records the failure; retry clears the halt and polls at once', async () => {
    await openLive();
    const held = telemetry.window();
    await advance(2000);
    await failCache('timeout');
    expect(telemetry.window()).toBe(held);
    expect(telemetry.failure()).toMatchObject({
      code: 'timeout',
      boardId: DEVKIT.id,
      retryable: true,
    });

    // The halt's state read fails too, without saying Sentinel is gone: the last state stays,
    // with the reason it could not be read.
    await failState('timeout');
    expect(telemetry.ready()).toBe(true);
    expect(telemetry.stateFailure()?.code).toBe('timeout');
    await advance(10_000);
    noPoll();

    telemetry.retry();
    // The backoff starts over: one failure waits 4 s, not the 8 s a second one in a row would.
    await failCache('sentinel_failed');
    await advance(3999);
    noPoll();
    await advance(1);
    await failCache('sentinel_failed');

    // Retry also sends a backed-off poll that is still waiting, at once.
    telemetry.retry();
    await answerCache(nextSample());
    expect(telemetry.failure()).toBeNull();
    expect(telemetry.window()?.timestamps).toHaveLength(4);
  });

  it('pause stops polls but not the 30 s state re-read; resume polls at once', async () => {
    await openLive();
    telemetry.pause();
    expect(telemetry.paused()).toBe(true);

    await advance(30_000);
    await answerState();
    noPoll();

    telemetry.resume();
    expect(telemetry.paused()).toBe(false);
    await answerCache(nextSample());
  });

  it('setWatching(false) stops polls but not the 30 s state re-read; watching again polls at once, incrementally', async () => {
    await openLive();
    telemetry.setWatching(false);

    await advance(30_000);
    await answerState();
    noPoll();

    telemetry.setWatching(true);
    const next = cachePoll();
    expect(next.request.params.get('after')).toBe('2026-10-24T10:00:04.000Z');
    await flush(next, nextSample());
    expect(telemetry.window()?.timestamps).toHaveLength(4);
    expect(telemetry.update()).toBe('live');
  });

  it('a poll out when watching stops still lands, and schedules no next one', async () => {
    await openLive();
    await advance(2000);
    const out = cachePoll();
    telemetry.setWatching(false);
    await flush(out, nextSample());
    expect(telemetry.window()?.timestamps).toHaveLength(4);

    await advance(10_000);
    noPoll();
  });

  it('a page opened while not watching reads the state but polls nothing until it watches', async () => {
    open();
    telemetry.setWatching(false);
    await answerState();
    noPoll();

    telemetry.setWatching(true);
    const first = cachePoll();
    expect(first.request.params.keys()).toEqual([]);
    await flush(first, cache());
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
    const polls = cachePolls();
    const reads = stateReads();
    expect(polls).toHaveLength(1);
    expect(reads).toHaveLength(1);
    await flush(reads[0], sentinelHealth());

    // A poll that answers while the tab is hidden schedules nothing until it shows again.
    setVisibility('hidden');
    await flush(polls[0], nextSample());
    await advance(10_000);
    noPoll();
    setVisibility('visible');
    await answerState();
    await answerCache(cache(0, { full: false }));
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
    await flush(read, sentinelHealth());

    window.dispatchEvent(new Event('focus'));
    await answerState();
  });

  it('a board that is no longer the selected one reloads the boards', async () => {
    open();
    await flush(
      stateRead(),
      sentinelError('not_found', `${DEVKIT.id} is not the selected board.`),
      true,
    );
    expect(board.reload).toHaveBeenCalledTimes(1);
    expect(telemetry.stateFailure()?.code).toBe('not_found');

    window.dispatchEvent(new Event('focus'));
    await answerState();
    await advance(0);
    await flush(cachePoll(), sentinelError('board_changed', 'The board was replaced.'), true);
    expect(board.reload).toHaveBeenCalledTimes(2);
    expect(telemetry.failure()?.code).toBe('board_changed');
  });

  it('a board change clears the window, state and failure and re-reads the state', async () => {
    await openLive();
    await advance(2000);
    await failCache('sentinel_failed');
    expect(telemetry.window()).not.toBeNull();

    switchBoard(LOCAL);
    expect(telemetry.window()).toBeNull();
    expect(telemetry.state()).toBeNull();
    expect(telemetry.failure()).toBeNull();
    expect(telemetry.checking()).toBe(true);

    await answerState(LOCAL);
    expect(telemetry.state()?.board).toBe(LOCAL.id);
    // A new board starts from the whole cache, and its backoff from the start.
    const first = cachePoll(LOCAL);
    expect(first.request.params.keys()).toEqual([]);
    await flush(first, failed('sentinel_failed'), true);
    await advance(3999);
    noPoll();
    await advance(1);
    await answerCache(cache(), LOCAL);
    expect(telemetry.window()?.board).toBe(LOCAL.id);
  });

  it('a board switch is not blocked by a request still out to the previous board', async () => {
    open();
    await answerState();
    const onA = cachePoll();
    window.dispatchEvent(new Event('focus'));
    const readA = stateRead();

    switchBoard(LOCAL);
    // The new board's state is read at once, though the old board's read is still out.
    const readB = stateRead(LOCAL);
    // The old board's read lands first and is ignored; the new board is still being checked.
    await flush(readA, failed('sentinel_missing'), true);
    expect(telemetry.state()).toBeNull();
    expect(telemetry.stateFailure()).toBeNull();
    expect(telemetry.checking()).toBe(true);

    await flush(readB, sentinelHealth());
    // The new board is polled at once, though the old board's poll is still out.
    const onB = cachePoll(LOCAL);

    // The old board's poll lands late and is ignored: nothing applied, reloaded or scheduled.
    await flush(onA, cache());
    expect(telemetry.window()).toBeNull();
    expect(telemetry.state()?.board).toBe(LOCAL.id);
    expect(board.reload).not.toHaveBeenCalled();
    noPoll();

    await flush(onB, cache());
    expect(telemetry.window()?.board).toBe(LOCAL.id);
  });

  it('polls nothing for a new board on the previous board’s state before the change is followed', async () => {
    await openLive();
    telemetry.pause();
    // The board changed, and the effect that follows it has not run yet.
    board.state.set(boardWith(LOCAL));
    telemetry.resume();
    noPoll();

    TestBed.tick();
    await answerState(LOCAL);
    await answerCache(cache(), LOCAL);
  });

  it('a failure from the previous board landing after a switch is ignored', async () => {
    open();
    await answerState();
    const onA = cachePoll();
    switchBoard(LOCAL);
    await answerState(LOCAL);
    const onB = cachePoll(LOCAL);

    await flush(onA, failed('unreachable'), true);
    expect(telemetry.failure()).toBeNull();
    expect(telemetry.update()).toBe('live');
    // No halt, so no state re-read for it.
    noStateRead();
    await flush(onB, cache());
  });

  it('update reads live, paused or stopped', async () => {
    open();
    expect(telemetry.update()).toBe('stopped');
    await answerState();
    expect(telemetry.update()).toBe('live');
    await answerCache();

    telemetry.pause();
    expect(telemetry.update()).toBe('paused');
    telemetry.resume();
    expect(telemetry.update()).toBe('live');
    await answerCache(nextSample());

    setVisibility('hidden');
    expect(telemetry.update()).toBe('stopped');
    setVisibility('visible');
    expect(telemetry.update()).toBe('live');
    await failState('sentinel_missing');
    expect(telemetry.update()).toBe('stopped');
    // The poll out when the state said Sentinel is gone lands; nothing follows it.
    await answerCache(cache(0, { full: false }));
    await advance(2000);
    noPoll();
  });

  it('a failed poll reads stopped while the backoff retries; a success reads live again', async () => {
    await openLive();
    await advance(2000);
    await failCache('sentinel_failed');
    expect(telemetry.update()).toBe('stopped');

    await advance(4000);
    const retried = cachePoll();
    expect(telemetry.update()).toBe('stopped');
    await flush(retried, nextSample());
    expect(telemetry.update()).toBe('live');
  });

  it('nothing is requested without a board, and destroying the controller stops every timer', async () => {
    board.state.set(boardList());
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
    switchBoard(LOCAL);
    await answerState(LOCAL);
    await answerCache(cache(), LOCAL);
    window.dispatchEvent(new Event('focus'));
    const out = stateRead(LOCAL);
    close();

    // The read still out lands on nothing, and nothing is sent any more.
    await flush(out, sentinelHealth());
    await advance(120_000);
    window.dispatchEvent(new Event('focus'));
    setVisibility('hidden');
    setVisibility('visible');
    noStateRead();
    noPoll();
    expect(vi.getTimerCount()).toBe(0);

    // A poll still out when the page goes lands on nothing, even a failure saying the board went.
    open();
    await answerState(LOCAL);
    const polled = cachePoll(LOCAL);
    close();
    await flush(polled, failed('not_found'), true);
    expect(board.reload).not.toHaveBeenCalled();
    noStateRead();
    noPoll();
  });

  it('recheck reads the state again and settles with its answer', async () => {
    open();
    await failState('sentinel_missing');
    expect(telemetry.stateFailure()?.code).toBe('sentinel_missing');

    let settled = false;
    const done = telemetry.recheck().then(() => (settled = true));
    const read = stateRead();
    expect(read.request.params.keys()).toEqual([]);
    expect(telemetry.rechecking()).toBe(true);
    // A failure already said keeps the page off its checking state while it is asked again.
    expect(telemetry.checking()).toBe(false);
    await settle();
    expect(settled).toBe(false);
    await flush(read, sentinelHealth());
    await done;
    expect(telemetry.rechecking()).toBe(false);
    expect(telemetry.ready()).toBe(true);
    await answerCache();
  });

  it('rechecking holds while its read is out to the current board, and a board change ends it', async () => {
    open();
    await failState('sentinel_missing');
    expect(telemetry.rechecking()).toBe(false);

    void telemetry.recheck();
    expect(telemetry.rechecking()).toBe(true);

    // The read went with the board it was sent to; the new board's own read is not a recheck.
    switchBoard(LOCAL);
    expect(telemetry.rechecking()).toBe(false);
    await flush(stateRead(), sentinelHealth());
    expect(telemetry.state()).toBeNull();
    await failState('sentinel_missing', LOCAL);
    expect(telemetry.rechecking()).toBe(false);
  });
});
