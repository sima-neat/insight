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
import { boardState, DEVKIT, FakeBoard } from '../board/board.testing';
import type { DeleteAnswer, RunAnswer, RunSummary } from './api';
import {
  ACTIVE_TRACE,
  RECORDING_RUN,
  RUNS_LIST,
  runsAnswer,
  SAVED_RUN,
  savedRun,
  traceAnswer,
} from './runs.testing';
import { SentinelRuns } from './sentinel-runs';
import { METRICS_LIVE } from './stats.testing';

const TRACES_URL = '/api/sentinel/traces';
const STOP_URL = '/api/sentinel/traces/stop';
const RUNS_URL = '/api/sentinel/runs';
/** The board generation the fixtures answer under, which the tests select. */
const GENERATION = METRICS_LIVE.generation;
const FINISHED = RUNS_LIST.filter((run) => run.ended_at !== null);

/** A failure body as the backend answers it, under board `generation`. */
function failed(code: string, generation = GENERATION) {
  return { error: `Failed with ${code}.`, code, generation };
}

const STATUS: Record<string, { status: number; statusText: string }> = {
  not_found: { status: 404, statusText: 'Not Found' },
  trace_conflict: { status: 409, statusText: 'Conflict' },
  stale_snapshot: { status: 409, statusText: 'Conflict' },
};
const badGateway = { status: 502, statusText: 'Bad Gateway' };

/** The answer of deleting `id` from `RUNS_LIST`: the runs left. */
function deleteAnswer(id: string, left: RunSummary[], generation = GENERATION): DeleteAnswer {
  const run = RUNS_LIST.find((each) => each.id === id);
  return { ...runsAnswer(left, generation), deleted: { id, name: run?.name ?? id } };
}

describe('SentinelRuns', () => {
  let http: HttpTestingController;
  let board: FakeBoard;
  let visibility: DocumentVisibilityState;
  let page: EnvironmentInjector | null;
  let runs: SentinelRuns;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    board = new FakeBoard();
    board.state.set(boardState({ target: DEVKIT, generation: GENERATION }));
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

  /** Opens the page: the service lives in the page's injector, as the Stats page provides it. */
  function open(): void {
    page = createEnvironmentInjector([SentinelRuns], TestBed.inject(EnvironmentInjector));
    runs = page.get(SentinelRuns);
    TestBed.tick();
  }

  /** Leaves the page, which destroys the service with it. */
  function close(): void {
    page?.destroy();
    page = null;
  }

  /** Lets the promise chains behind a flushed request run. */
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  // Matched by path and method: a URL string would be compared with the query parameters included.
  const traceRead = () =>
    http.expectOne((request) => request.url === TRACES_URL && request.method === 'GET');
  const noTraceRead = () =>
    http.expectNone((request) => request.url === TRACES_URL && request.method === 'GET');
  const runsRead = () => http.expectOne((request) => request.url === RUNS_URL);
  const noRunsRead = () => http.expectNone((request) => request.url === RUNS_URL);
  const startRequest = () =>
    http.expectOne((request) => request.url === TRACES_URL && request.method === 'POST');
  const stopRequest = () => http.expectOne((request) => request.url === STOP_URL);
  const deleteRequest = (id: string) =>
    http.expectOne(
      (request) =>
        request.method === 'DELETE' && request.url === `${RUNS_URL}/${encodeURIComponent(id)}`,
    );
  const runRead = (id: string) =>
    http.expectOne(
      (request) =>
        request.method === 'GET' && request.url === `${RUNS_URL}/${encodeURIComponent(id)}`,
    );

  async function flush(request: TestRequest, body: object): Promise<void> {
    request.flush(body);
    await settle();
  }

  async function fail(request: TestRequest, code: string, generation = GENERATION) {
    request.flush(failed(code, generation), STATUS[code] ?? badGateway);
    await settle();
  }

  /** Opens the page with no trace recording, the runs shown and read. */
  async function openWithRuns(list: RunSummary[] = RUNS_LIST): Promise<void> {
    open();
    await flush(traceRead(), traceAnswer(null, null));
    runs.setRunsShown(true);
    await flush(runsRead(), runsAnswer(list));
  }

  function setVisibility(state: DocumentVisibilityState): void {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  }

  function switchBoard(generation: number, target: BoardTarget | null = DEVKIT): void {
    board.state.set(boardState({ target, generation }));
    TestBed.tick();
  }

  it('reads the active trace on start and every 30 s while visible', async () => {
    open();
    const first = traceRead();
    noRunsRead();
    await flush(first, traceAnswer(ACTIVE_TRACE, RECORDING_RUN));
    expect(runs.trace()).toEqual(ACTIVE_TRACE);
    expect(runs.traceSummary()).toEqual(RECORDING_RUN);

    await advance(29_999);
    noTraceRead();
    await advance(1);
    await flush(traceRead(), traceAnswer(null, null));
    expect(runs.trace()).toBeNull();
    expect(runs.traceSummary()).toBeNull();

    // A hidden tab sends nothing; showing it reads at once.
    setVisibility('hidden');
    await advance(90_000);
    noTraceRead();
    setVisibility('visible');
    await fail(traceRead(), 'timeout');
    expect(runs.traceFailure()?.code).toBe('timeout');
    // A failed read keeps what was read before it.
    expect(runs.trace()).toBeNull();

    await advance(30_000);
    await flush(traceRead(), traceAnswer(ACTIVE_TRACE, RECORDING_RUN));
    expect(runs.traceFailure()).toBeNull();
  });

  it('traceReadAt is the local time the trace shown was read or started, and null without one', async () => {
    vi.setSystemTime(Date.parse('2026-10-25T08:00:00Z'));
    open();
    expect(runs.traceReadAt()).toBeNull();
    await advance(1500);
    await flush(traceRead(), traceAnswer(ACTIVE_TRACE, RECORDING_RUN));
    expect(runs.traceReadAt()).toBe(Date.parse('2026-10-25T08:00:01.500Z'));

    // A refused read keeps the trace, and when it was read.
    await advance(30_000);
    await fail(traceRead(), 'timeout');
    expect(runs.traceReadAt()).toBe(Date.parse('2026-10-25T08:00:01.500Z'));

    const stopped = runs.stopTrace();
    await flush(stopRequest(), traceAnswer(null, null));
    expect(await stopped).toBeNull();
    expect(runs.traceReadAt()).toBeNull();

    await advance(2000);
    const started = runs.startTrace({ name: 'bench' });
    await flush(startRequest(), traceAnswer(ACTIVE_TRACE));
    expect(await started).toBeNull();
    expect(runs.traceSummary()).toBeNull();
    expect(runs.traceReadAt()).toBe(Date.now());

    switchBoard(GENERATION + 1);
    expect(runs.traceReadAt()).toBeNull();
    http.match((request) => request.url === TRACES_URL);
  });

  it('a periodic trace read is skipped while one is out', async () => {
    open();
    const out = traceRead();
    await advance(30_000);
    noTraceRead();
    await flush(out, traceAnswer(null, null));
    await advance(30_000);
    await flush(traceRead(), traceAnswer(null, null));
  });

  it('reads runs when shown, every 30 s while shown, not while hidden or not shown', async () => {
    open();
    await flush(traceRead(), traceAnswer(null, null));
    expect(runs.runs()).toBeNull();
    await advance(60_000);
    for (const read of http.match(TRACES_URL)) await flush(read, traceAnswer(null, null));
    noRunsRead();

    runs.setRunsShown(true);
    await flush(runsRead(), runsAnswer());
    expect(runs.runs()).toEqual(RUNS_LIST);

    await advance(29_999);
    noRunsRead();
    await advance(1);
    for (const read of http.match(TRACES_URL)) await flush(read, traceAnswer(null, null));
    await fail(runsRead(), 'sentinel_failed');
    expect(runs.runsFailure()?.code).toBe('sentinel_failed');
    expect(runs.runs()).toEqual(RUNS_LIST);

    // Hidden: nothing; shown again: at once, once.
    setVisibility('hidden');
    await advance(60_000);
    noRunsRead();
    setVisibility('visible');
    setVisibility('hidden');
    setVisibility('visible');
    for (const read of http.match(TRACES_URL)) await flush(read, traceAnswer(null, null));
    await flush(runsRead(), runsAnswer(FINISHED));
    expect(runs.runs()).toEqual(FINISHED);
    expect(runs.runsFailure()).toBeNull();

    // Not shown: nothing more, though the trace is still read.
    runs.setRunsShown(false);
    await advance(30_000);
    await flush(traceRead(), traceAnswer(null, null));
    noRunsRead();
  });

  it('start sends the generation and the trimmed request; success sets the trace and re-reads runs', async () => {
    await openWithRuns(FINISHED);
    const started = runs.startTrace({
      name: '  compiler-v2-bench ',
      note: ' Compiler v2 on the YOLO pipeline ',
      tags: [' compiler-v2', '', 'yolo ', '  '],
    });
    expect(runs.traceBusy()).toBe('start');
    const request = startRequest();
    expect(request.request.params.get('generation')).toBe(String(GENERATION));
    expect(request.request.body).toEqual({
      name: 'compiler-v2-bench',
      note: 'Compiler v2 on the YOLO pipeline',
      tags: ['compiler-v2', 'yolo'],
    });
    await flush(request, traceAnswer(ACTIVE_TRACE));
    expect(await started).toBeNull();
    expect(runs.traceBusy()).toBeNull();
    expect(runs.trace()).toEqual(ACTIVE_TRACE);

    await flush(runsRead(), runsAnswer());
    expect(runs.runs()).toEqual(RUNS_LIST);
  });

  it('start leaves out an empty note and tags and words a refusal as a start', async () => {
    await openWithRuns();
    const started = runs.startTrace({ name: 'bench', note: '   ', tags: [' '] });
    const request = startRequest();
    expect(request.request.body).toEqual({ name: 'bench' });
    await fail(request, 'trace_conflict');
    const failure = await started;
    expect([failure?.code, failure?.action, failure?.title]).toEqual([
      'trace_conflict',
      'start',
      'That trace cannot start',
    ]);
    expect(runs.traceBusy()).toBeNull();
    expect(runs.trace()).toBeNull();
    // Another trace may be recording: the trace is read again, the runs are not.
    await flush(traceRead(), traceAnswer(ACTIVE_TRACE, RECORDING_RUN));
    expect(runs.trace()).toEqual(ACTIVE_TRACE);
    noRunsRead();
  });

  it('stop sends the generation and the shown trace id', async () => {
    open();
    await flush(traceRead(), traceAnswer(ACTIVE_TRACE, RECORDING_RUN));
    runs.setRunsShown(true);
    await flush(runsRead(), runsAnswer());

    const stopped = runs.stopTrace();
    expect(runs.traceBusy()).toBe('stop');
    const request = stopRequest();
    expect(request.request.method).toBe('POST');
    expect(request.request.params.get('generation')).toBe(String(GENERATION));
    expect(request.request.params.get('trace_id')).toBe(ACTIVE_TRACE.id);
    const ended = '2026-09-25T09:15:40.120Z';
    await flush(
      request,
      traceAnswer({ ...ACTIVE_TRACE, ended_at: ended }, { ...RECORDING_RUN, ended_at: ended }),
    );
    expect(await stopped).toBeNull();
    expect(runs.traceBusy()).toBeNull();
    expect(runs.trace()).toBeNull();
    expect(runs.traceSummary()).toBeNull();

    const finished = RUNS_LIST.map((run) => ({ ...run, ended_at: run.ended_at ?? ended }));
    await flush(runsRead(), runsAnswer(finished));
    expect(runs.runs()).toEqual(finished);
  });

  it('a trace_conflict on stop returns the stop wording', async () => {
    open();
    await flush(traceRead(), traceAnswer(ACTIVE_TRACE, RECORDING_RUN));
    const stopped = runs.stopTrace();
    await fail(stopRequest(), 'trace_conflict');
    const failure = await stopped;
    expect([failure?.code, failure?.action, failure?.title]).toEqual([
      'trace_conflict',
      'stop',
      'The trace changed before it was stopped',
    ]);
    expect(runs.traceBusy()).toBeNull();
    // The trace shown is out of date: it is read again.
    expect(runs.trace()).toEqual(ACTIVE_TRACE);
    await flush(traceRead(), traceAnswer(null, null));
    expect(runs.trace()).toBeNull();
  });

  it('stop without a trace shown sends nothing', async () => {
    open();
    await flush(traceRead(), traceAnswer(null, null));
    expect(await runs.stopTrace()).toBeNull();
    http.expectNone(STOP_URL);
  });

  it('a trace read out before a start does not overwrite the started trace', async () => {
    open();
    await flush(traceRead(), traceAnswer(null, null));
    await advance(30_000);
    const out = traceRead();
    const started = runs.startTrace({ name: 'compiler-v2-bench' });
    await flush(startRequest(), traceAnswer(ACTIVE_TRACE));
    expect(await started).toBeNull();
    await flush(out, traceAnswer(null, null));
    expect(runs.trace()).toEqual(ACTIVE_TRACE);
  });

  describe('an answer for another generation is dropped and the board reloaded', () => {
    it('for the trace read', async () => {
      open();
      await flush(traceRead(), traceAnswer(ACTIVE_TRACE, RECORDING_RUN, GENERATION + 1));
      expect(runs.trace()).toBeNull();
      expect(board.reload).toHaveBeenCalledTimes(1);

      // A failure naming another board is dropped the same way.
      await advance(30_000);
      await fail(traceRead(), 'timeout', GENERATION + 1);
      expect(runs.traceFailure()).toBeNull();
      expect(board.reload).toHaveBeenCalledTimes(2);
    });

    it('for the runs read', async () => {
      open();
      await flush(traceRead(), traceAnswer(null, null));
      runs.setRunsShown(true);
      await flush(runsRead(), runsAnswer(RUNS_LIST, GENERATION + 1));
      expect(runs.runs()).toBeNull();
      expect(board.reload).toHaveBeenCalledTimes(1);
    });

    it('for a start', async () => {
      await openWithRuns();
      const started = runs.startTrace({ name: 'compiler-v2-bench' });
      await flush(startRequest(), traceAnswer(ACTIVE_TRACE, undefined, GENERATION + 1));
      expect((await started)?.code).toBe('stale_snapshot');
      expect(runs.trace()).toBeNull();
      expect(runs.traceBusy()).toBeNull();
      expect(board.reload).toHaveBeenCalledTimes(1);
      noRunsRead();

      // The backend's own stale_snapshot names the board selected now: that reloads too.
      const again = runs.startTrace({ name: 'compiler-v2-bench' });
      await fail(startRequest(), 'stale_snapshot', GENERATION + 1);
      const failure = await again;
      expect([failure?.code, failure?.title]).toEqual([
        'stale_snapshot',
        'The board changed while Insight was working',
      ]);
      expect(board.reload).toHaveBeenCalledTimes(2);
    });

    it('for a delete, which stops the batch', async () => {
      await openWithRuns();
      const [first, second] = FINISHED;
      const deleting = runs.deleteRuns([first.id, second.id]);
      await flush(
        deleteRequest(first.id),
        deleteAnswer(
          first.id,
          RUNS_LIST.filter((run) => run !== first),
          GENERATION + 1,
        ),
      );
      const outcome = await deleting;
      expect(outcome.deleted).toEqual([]);
      expect(outcome.failed.map(({ id, failure }) => [id, failure.code])).toEqual([
        [first.id, 'stale_snapshot'],
      ]);
      expect(outcome.notTried).toEqual([second.id]);
      expect(runs.runs()).toEqual(RUNS_LIST);
      expect(board.reload).toHaveBeenCalledTimes(1);
      await flush(runsRead(), runsAnswer());
    });
  });

  it('delete runs one at a time and continues past not_found', async () => {
    await openWithRuns();
    const [first, second, third] = FINISHED;
    const deleting = runs.deleteRuns([first.id, second.id, third.id]);

    const one = deleteRequest(first.id);
    expect(one.request.params.get('generation')).toBe(String(GENERATION));
    // The next is sent only once this one answered.
    http.expectNone((request) => request.method === 'DELETE' && request.url !== one.request.url);
    const afterFirst = RUNS_LIST.filter((run) => run !== first);
    await flush(one, deleteAnswer(first.id, afterFirst));
    await fail(deleteRequest(second.id), 'not_found');
    const left = afterFirst.filter((run) => run !== third);
    await flush(deleteRequest(third.id), deleteAnswer(third.id, left));

    const outcome = await deleting;
    expect(outcome.deleted).toEqual([first.id, third.id]);
    expect(outcome.failed.map(({ id, failure }) => [id, failure.code, failure.title])).toEqual([
      [second.id, 'not_found', 'That run is no longer on the board'],
    ]);
    expect(outcome.notTried).toEqual([]);
    // The last answer's runs apply at once; then the list is read again.
    expect(runs.runs()).toEqual(left);
    await flush(runsRead(), runsAnswer(left));
  });

  it('delete continues past a recording run’s trace_conflict', async () => {
    await openWithRuns();
    const deleting = runs.deleteRuns([RECORDING_RUN.id, FINISHED[0].id]);
    await fail(deleteRequest(RECORDING_RUN.id), 'trace_conflict');
    const left = RUNS_LIST.filter((run) => run !== FINISHED[0]);
    await flush(deleteRequest(FINISHED[0].id), deleteAnswer(FINISHED[0].id, left));
    const outcome = await deleting;
    expect(outcome.failed[0].failure.title).toBe('That run is still recording');
    expect(outcome.deleted).toEqual([FINISHED[0].id]);
    await flush(runsRead(), runsAnswer(left));
  });

  it('delete stops at stale_snapshot and reports the rest as not tried', async () => {
    await openWithRuns();
    const [first, second, third] = FINISHED;
    const deleting = runs.deleteRuns([first.id, second.id, third.id]);
    const afterFirst = RUNS_LIST.filter((run) => run !== first);
    await flush(deleteRequest(first.id), deleteAnswer(first.id, afterFirst));
    await fail(deleteRequest(second.id), 'stale_snapshot');

    const outcome = await deleting;
    expect(outcome.deleted).toEqual([first.id]);
    expect(outcome.failed.map(({ id, failure }) => [id, failure.code])).toEqual([
      [second.id, 'stale_snapshot'],
    ]);
    expect(outcome.notTried).toEqual([third.id]);
    expect(runs.runs()).toEqual(afterFirst);
    await flush(runsRead(), runsAnswer(afterFirst));
  });

  it('delete stops at a board, daemon, network or bad response failure', async () => {
    await openWithRuns();
    const [first, second] = FINISHED;
    for (const code of ['unreachable', 'sentinel_stopped', 'network', 'bad_response']) {
      const deleting = runs.deleteRuns([first.id, second.id]);
      await fail(deleteRequest(first.id), code);
      const outcome = await deleting;
      expect(
        outcome.failed.map(({ failure }) => failure.code),
        code,
      ).toEqual([code]);
      expect(outcome.notTried, code).toEqual([second.id]);
      await flush(runsRead(), runsAnswer());
    }
  });

  it('a board switch mid-delete sends nothing more to the board and applies nothing', async () => {
    await openWithRuns();
    const [first, second] = FINISHED;
    const deleting = runs.deleteRuns([first.id, second.id]);
    const one = deleteRequest(first.id);
    switchBoard(GENERATION + 1);
    // The new board's trace and runs are read at once.
    const newTrace = traceRead();
    const newRuns = runsRead();
    await flush(one, deleteAnswer(first.id, FINISHED));

    const outcome = await deleting;
    expect(outcome.deleted).toEqual([]);
    expect(outcome.failed.map(({ id, failure }) => [id, failure.code])).toEqual([
      [first.id, 'stale_snapshot'],
    ]);
    expect(outcome.notTried).toEqual([second.id]);
    expect(runs.runs()).toBeNull();
    await flush(newTrace, traceAnswer(null, null, GENERATION + 1));
    await flush(newRuns, runsAnswer(RUNS_LIST, GENERATION + 1));
    expect(runs.runs()).toEqual(RUNS_LIST);
  });

  it('a board switch clears trace and runs', async () => {
    open();
    await flush(traceRead(), traceAnswer(ACTIVE_TRACE, RECORDING_RUN));
    runs.setRunsShown(true);
    await flush(runsRead(), runsAnswer());
    await advance(30_000);
    // Failed reads keep what was read before them, beside their failures.
    await fail(traceRead(), 'timeout');
    await fail(runsRead(), 'timeout');
    expect(runs.trace()).toEqual(ACTIVE_TRACE);
    expect(runs.traceSummary()).toEqual(RECORDING_RUN);
    expect(runs.runs()).toEqual(RUNS_LIST);
    expect(runs.traceFailure()).not.toBeNull();
    expect(runs.runsFailure()).not.toBeNull();
    await advance(30_000);
    const traceOut = traceRead();
    const runsOut = runsRead();

    switchBoard(GENERATION + 1);
    expect(runs.trace()).toBeNull();
    expect(runs.traceSummary()).toBeNull();
    expect(runs.traceFailure()).toBeNull();
    expect(runs.runs()).toBeNull();
    expect(runs.runsFailure()).toBeNull();

    // The new board is read at once, though the previous board's reads are still out; theirs
    // land on nothing.
    const newTrace = traceRead();
    const newRuns = runsRead();
    await flush(traceOut, traceAnswer(ACTIVE_TRACE, RECORDING_RUN));
    await flush(runsOut, runsAnswer());
    expect(runs.trace()).toBeNull();
    expect(runs.runs()).toBeNull();
    expect(board.reload).not.toHaveBeenCalled();

    await flush(newTrace, traceAnswer(null, null, GENERATION + 1));
    await flush(newRuns, runsAnswer(FINISHED, GENERATION + 1));
    expect(runs.runs()).toEqual(FINISHED);

    // Without a board nothing is read.
    switchBoard(GENERATION + 2, null);
    await advance(60_000);
    noTraceRead();
    noRunsRead();
    expect(runs.runs()).toBeNull();
  });

  it('a board switch while a start is out applies nothing of it', async () => {
    open();
    await flush(traceRead(), traceAnswer(null, null));
    const started = runs.startTrace({ name: 'compiler-v2-bench' });
    const request = startRequest();
    switchBoard(GENERATION + 1);
    expect(runs.traceBusy()).toBeNull();
    const newTrace = traceRead();

    await flush(request, traceAnswer(ACTIVE_TRACE));
    const failure = await started;
    expect([failure?.code, failure?.action, failure?.problem.message]).toEqual([
      'stale_snapshot',
      'start',
      'The selected board changed before the answer arrived; ' +
        'the change may have been made on the board selected before.',
    ]);
    expect(failure?.hint).toBe('Check the board selected now.');
    expect(runs.trace()).toBeNull();
    expect(runs.traceBusy()).toBeNull();
    expect(board.reload).not.toHaveBeenCalled();
    await flush(newTrace, traceAnswer(null, null, GENERATION + 1));
    expect(runs.trace()).toBeNull();
  });

  it('a stop refusal landing after a board switch is not shown for the new board', async () => {
    open();
    await flush(traceRead(), traceAnswer(ACTIVE_TRACE, RECORDING_RUN));
    const stopped = runs.stopTrace();
    const request = stopRequest();
    switchBoard(GENERATION + 1);
    expect(runs.traceBusy()).toBeNull();
    const other = { ...ACTIVE_TRACE, id: 'other', name: 'other' };
    await flush(traceRead(), traceAnswer(other, null, GENERATION + 1));

    await fail(request, 'trace_conflict');
    const failure = await stopped;
    expect([failure?.code, failure?.action]).toEqual(['stale_snapshot', 'stop']);
    // The new board's trace stays shown, and the old board's conflict reads nothing.
    expect(runs.trace()).toEqual(other);
    expect(runs.traceBusy()).toBeNull();
    noTraceRead();
  });

  it('a delete failure naming another generation stops the batch', async () => {
    await openWithRuns();
    const [first, second] = FINISHED;
    const deleting = runs.deleteRuns([first.id, second.id]);
    await fail(deleteRequest(first.id), 'not_found', GENERATION + 1);
    const outcome = await deleting;
    expect(outcome.failed.map(({ id, failure }) => [id, failure.code])).toEqual([
      [first.id, 'not_found'],
    ]);
    expect(outcome.notTried).toEqual([second.id]);
    expect(board.reload).toHaveBeenCalledTimes(1);
    await flush(runsRead(), runsAnswer());
  });

  it('before the board is known nothing is sent', async () => {
    board.state.set(null);
    open();
    runs.setRunsShown(true);
    await advance(60_000);
    const refused = await runs.startTrace({ name: 'bench' });
    expect([refused?.code, refused?.title, refused?.problem.message]).toEqual([
      'no_target',
      'No board is selected',
      'Choose a board in the top bar first.',
    ]);
    const read = await runs.readRun(FINISHED[0].id);
    expect('failure' in read && read.failure.code).toBe('no_target');
    expect(await runs.deleteRuns([FINISHED[0].id])).toEqual({
      deleted: [],
      failed: [],
      notTried: [FINISHED[0].id],
    });
    http.expectNone(() => true);
  });

  it('encodes run ids with slashes in the path', async () => {
    await openWithRuns();
    const id = 'bench/yolo 26';
    const read = runs.readRun(id);
    const request = http.expectOne(`${RUNS_URL}/bench%2Fyolo%2026`);
    expect(request.request.method).toBe('GET');
    await flush(request, runAnswer(savedRun()));
    expect(await read).toEqual({ run: SAVED_RUN });

    const deleting = runs.deleteRuns([id]);
    const removal = http.expectOne(
      (each) => each.method === 'DELETE' && each.url === `${RUNS_URL}/bench%2Fyolo%2026`,
    );
    await flush(removal, deleteAnswer(id, RUNS_LIST));
    expect((await deleting).deleted).toEqual([id]);
    await flush(runsRead(), runsAnswer());
  });

  it('readRun: the newest request wins and older ones resolve stale', async () => {
    await openWithRuns();
    const [first, second] = FINISHED;
    const older = runs.readRun(first.id);
    const newer = runs.readRun(second.id);
    const olderRequest = runRead(first.id);
    const newerRequest = runRead(second.id);

    const newerRun = savedRun({ metadata: { ...SAVED_RUN.metadata, id: second.id } });
    await flush(newerRequest, runAnswer(newerRun));
    expect(await newer).toEqual({ run: newerRun });
    await flush(olderRequest, runAnswer(savedRun()));
    expect(await older).toEqual({ stale: true });

    // A failure is the newest request's answer like any other.
    const missing = runs.readRun('gone');
    await fail(runRead('gone'), 'not_found');
    const result = await missing;
    expect('failure' in result && [result.failure.code, result.failure.action]).toEqual([
      'not_found',
      'read',
    ]);

    // An answer for another board, or one landing after a board switch, is stale.
    const elsewhere = runs.readRun(first.id);
    await flush(runRead(first.id), runAnswer(savedRun(), GENERATION + 1));
    expect(await elsewhere).toEqual({ stale: true });
    expect(board.reload).toHaveBeenCalledTimes(1);

    const switched = runs.readRun(first.id);
    const out = runRead(first.id);
    switchBoard(GENERATION + 1);
    await flush(out, runAnswer(savedRun()));
    expect(await switched).toEqual({ stale: true });
    await flush(traceRead(), traceAnswer(null, null, GENERATION + 1));
    await flush(runsRead(), runsAnswer(RUNS_LIST, GENERATION + 1));
    expect(board.reload).toHaveBeenCalledTimes(1);
  });

  it('destroying the service stops every timer and continuations do nothing', async () => {
    await openWithRuns();
    await advance(30_000);
    const traceOut = traceRead();
    const runsOut = runsRead();
    const deleting = runs.deleteRuns([FINISHED[0].id, FINISHED[1].id]);
    const removal = deleteRequest(FINISHED[0].id);
    const reading = runs.readRun(FINISHED[2].id);
    const runOut = runRead(FINISHED[2].id);
    close();
    expect(vi.getTimerCount()).toBe(0);

    await flush(traceOut, traceAnswer(ACTIVE_TRACE, RECORDING_RUN, GENERATION + 1));
    await flush(runsOut, runsAnswer(FINISHED));
    await flush(removal, deleteAnswer(FINISHED[0].id, RUNS_LIST, GENERATION + 1));
    await flush(runOut, runAnswer(savedRun()));
    expect((await deleting).notTried).toEqual([FINISHED[1].id]);
    expect(await reading).toEqual({ stale: true });
    expect(runs.trace()).toBeNull();
    expect(runs.runs()).toEqual(RUNS_LIST);
    expect(board.reload).not.toHaveBeenCalled();

    await advance(120_000);
    setVisibility('hidden');
    setVisibility('visible');
    noTraceRead();
    noRunsRead();
  });
});

/** The answer of `GET /api/sentinel/runs/<id>` for `run`. */
function runAnswer(run = SAVED_RUN, generation = GENERATION): RunAnswer {
  return { board: METRICS_LIVE.board, generation, sentinel: run };
}
