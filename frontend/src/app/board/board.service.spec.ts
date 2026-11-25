import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { BoardList, BoardTarget, SelectedBoard } from './api';
import { messageOf } from '../sources/api-errors';
import { BoardProblem } from './board-error';
import { BoardService } from './board.service';
import { boardList, boardWith, MANUAL, selectedBoard } from './board.testing';

const BOARDS_URL = '/api/boards';

function target(host: string): BoardTarget {
  return {
    id: `ssh:sima@${host}:22`,
    mode: 'ssh',
    source: 'manual',
    host,
    port: 22,
    user: 'sima',
    label: `sima@${host}`,
  };
}

const targetA = target('192.168.2.2');
const targetB = target('192.168.2.9');

/** `target` selected; connected unless a test says otherwise: an unknown state makes the service check it. */
function board(on: BoardTarget, overrides: Partial<SelectedBoard> = {}): BoardList {
  return boardWith(on, {
    status: { state: 'connected', checked_at: '2026-10-26T10:00:00Z' },
    ...overrides,
  });
}

const boardA = board(targetA);
const boardB = board(targetB);
const unchecked: Partial<SelectedBoard> = { status: { state: 'unknown' } };
const checkUrl = (on: BoardTarget) => `/api/boards/${encodeURIComponent(on.id)}/check`;

const badGateway = { status: 502, statusText: 'Bad Gateway' };
const errorBody = (code: string, message: string, hint?: string) => ({
  error: { code, message, ...(hint ? { hint } : {}) },
});

/** Lets the promise chains behind a flushed request run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve));

describe('BoardService', () => {
  let http: HttpTestingController;
  let toasts: { status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    toasts = { status: vi.fn(), error: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: NeatToasts, useValue: toasts },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  /** The service, with the read it sends on construction answered by `initial`. */
  async function started(initial: BoardList = boardA): Promise<BoardService> {
    const service = TestBed.inject(BoardService);
    http.expectOne(BOARDS_URL).flush(initial);
    await tick();
    return service;
  }

  /** The board reads now pending, oldest first; they are taken, so a second call returns only newer ones. */
  function reads() {
    return http.match((request) => request.method === 'GET' && request.url === BOARDS_URL);
  }

  it('reloads on construction and on window focus, and never on a timer', async () => {
    vi.useFakeTimers();
    const service = TestBed.inject(BoardService);
    // Before the first answer: loading, which is neither a state nor an error.
    expect(service.state()).toBeNull();
    expect(service.error()).toBeNull();
    expect(service.id()).toBeNull();
    http.expectOne(BOARDS_URL).flush(boardA);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.state()).toEqual(boardA);
    expect(service.id()).toBe(targetA.id);
    expect(service.target()).toEqual(targetA);
    expect(service.selected()).toEqual(boardA.selected);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    http.expectNone(BOARDS_URL);
    expect(vi.getTimerCount()).toBe(0);

    window.dispatchEvent(new Event('focus'));
    http.expectOne(BOARDS_URL).flush(boardB);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.state()).toEqual(boardB);
    expect(service.id()).toBe(targetB.id);
  });

  it('names no board, id or target while none is selected', async () => {
    const service = await started(boardList([MANUAL], null));
    expect(service.selected()).toBeNull();
    expect(service.id()).toBeNull();
    expect(service.target()).toBeNull();
  });

  it('a focus while a read is out sends no second read; an explicit reload always does', async () => {
    const service = TestBed.inject(BoardService);
    // Browsers may fire focus right after load, while the construction read is still out.
    window.dispatchEvent(new Event('focus'));
    const pending = reads();
    expect(pending).toHaveLength(1);
    const [first] = pending;

    const asked = service.reload();
    const [second] = reads();
    expect(second).toBeDefined();
    second.flush(boardB);
    await asked;
    first.flush(boardA);
    await tick();
    expect(service.state()).toEqual(boardB);

    // A failed read is no longer out either.
    window.dispatchEvent(new Event('focus'));
    http.expectOne(BOARDS_URL).error(new ProgressEvent('error'));
    await tick();
    window.dispatchEvent(new Event('focus'));
    http.expectOne(BOARDS_URL).flush(boardA);
    await tick();
    expect(service.state()).toEqual(boardA);
  });

  it('keeps the last good state when a read fails, and clears the error with the next good answer', async () => {
    const service = await started(boardA);

    const failed = service.reload();
    http
      .expectOne(BOARDS_URL)
      .flush(errorBody('timeout', 'The board is busy.', 'Retry the action.'), {
        status: 504,
        statusText: 'Gateway Timeout',
      });
    await failed;
    expect(service.state()).toEqual(boardA);
    const error = service.error();
    expect(error).toBeInstanceOf(BoardProblem);
    expect(error?.message).toBe('The board is busy.');
    expect(error?.code).toBe('timeout');
    expect(error?.hint).toBe('Retry the action.');

    const next = service.reload();
    http.expectOne(BOARDS_URL).flush(boardB);
    await next;
    expect(service.state()).toEqual(boardB);
    expect(service.error()).toBeNull();
  });

  it('a first read that fails sets the error with no state', async () => {
    const service = TestBed.inject(BoardService);
    http.expectOne(BOARDS_URL).error(new ProgressEvent('error'));
    await tick();
    expect(service.state()).toBeNull();
    expect(service.error()?.code).toBe('network');
  });

  // A read never connects to the board, so Insight checks the connection itself, once per app
  // load, rather than leaving the board block at "Not checked" until the user asks.
  describe('connection check on load', () => {
    const checks = (on: BoardTarget = targetA) => http.match({ method: 'POST', url: checkUrl(on) });

    it('checks a selected board whose state is unknown, once, and applies the answer', async () => {
      const service = await started(board(targetA, unchecked));
      const [check] = checks();
      expect(check).toBeDefined();
      expect(check.request.body).toEqual({});
      check.flush(boardA);
      await tick();
      expect(service.state()).toEqual(boardA);

      // Neither a focus nor an explicit reload checks again, whatever they find.
      window.dispatchEvent(new Event('focus'));
      http.expectOne(BOARDS_URL).flush(board(targetA, unchecked));
      await tick();
      const reload = service.reload();
      http.expectOne(BOARDS_URL).flush(board(targetA, unchecked));
      await reload;
      await tick();
      expect(checks()).toHaveLength(0);
    });

    it.each([
      ['connected', boardA],
      ['failed', board(targetA, { status: { state: 'error' } })],
      ['unselected', boardList([targetA], null)],
    ])('does not check a board that is %s', async (_, state) => {
      await started(state);
      expect(checks()).toHaveLength(0);
    });

    it('waits for the first read that succeeds, and decides on it for the rest of the load', async () => {
      const service = TestBed.inject(BoardService);
      http.expectOne(BOARDS_URL).error(new ProgressEvent('error'));
      await tick();
      expect(checks()).toHaveLength(0);

      const retry = service.reload();
      http.expectOne(BOARDS_URL).flush(boardA);
      await retry;
      // That read found the board connected: the check is spent, not owed to a later unknown.
      window.dispatchEvent(new Event('focus'));
      http.expectOne(BOARDS_URL).flush(board(targetA, unchecked));
      await tick();
      expect(checks()).toHaveLength(0);
    });

    it('a board change while the check is out wins: the slow answer for the old board is dropped', async () => {
      const service = await started(board(targetA, unchecked));
      const [check] = checks();

      const select = service.select({ host: '192.168.2.9', port: 22, user: 'sima' });
      http.expectOne({ method: 'POST', url: BOARDS_URL }).flush(boardB);
      await select;

      check.flush(boardA);
      await tick();
      expect(service.state()).toEqual(boardB);
      expect(service.id()).toBe(targetB.id);
    });

    it('says a check is out until its answer is applied, or its failure re-read', async () => {
      const service = await started(board(targetA, unchecked));
      expect(service.checking()).toBe(true);
      checks()[0].flush(boardA);
      await tick();
      expect(service.checking()).toBe(false);

      const again = service.check().catch(() => undefined);
      expect(service.checking()).toBe(true);
      checks()[0].flush(errorBody('unreachable', 'Unreachable.'), badGateway);
      await tick();
      // Still checking while the failure is re-read: the block goes from Checking… to its result.
      expect(service.checking()).toBe(true);
      http.expectOne(BOARDS_URL).flush(boardA);
      await again;
      expect(service.checking()).toBe(false);
    });

    it('says no check is out when none was needed', async () => {
      const service = await started(boardA);
      expect(checks()).toHaveLength(0);
      expect(service.checking()).toBe(false);
    });

    it('a failed check lands in the state only: the board is re-read, and nothing is toasted or thrown', async () => {
      const service = await started(board(targetA, unchecked));
      checks()[0].flush(
        errorBody('unreachable', 'Could not connect to sima@192.168.2.2.'),
        badGateway,
      );
      await tick();
      // The failed action reloads the state, where the server recorded the failure.
      const failed = board(targetA, {
        status: {
          state: 'error',
          checked_at: '2026-10-26T10:00:05Z',
          error: { code: 'unreachable', message: 'Could not connect to sima@192.168.2.2.' },
        },
      });
      http.expectOne(BOARDS_URL).flush(failed);
      await tick();
      expect(service.selected()?.status.state).toBe('error');
      expect(service.error()).toBeNull();
      expect(toasts.error).not.toHaveBeenCalled();
      expect(toasts.status).not.toHaveBeenCalled();
      expect(checks()).toHaveLength(0);
    });
  });

  describe('board sync', () => {
    it('a board read that was sent before a board change cannot undo it', async () => {
      const service = await started(boardA);
      const load = service.reload();
      // The POST that selected B answered first.
      const select = service.select({ host: '192.168.2.9', port: 22, user: 'sima' });
      http.expectOne({ method: 'POST', url: BOARDS_URL }).flush(boardB);
      await select;
      // Then the older GET, answered before the change.
      reads()[0].flush(boardA);
      await load;
      expect(service.state()).toEqual(boardB);
    });

    it('a failed board read that was superseded does not raise an error', async () => {
      const service = await started(boardA);
      const load = service.reload();
      const select = service.select({ host: '192.168.2.9', port: 22, user: 'sima' });
      http.expectOne({ method: 'POST', url: BOARDS_URL }).flush(boardB);
      await select;
      reads()[0].flush(errorBody('network', 'network'), badGateway);
      await load;
      expect(service.error()).toBeNull();
      expect(service.state()).toEqual(boardB);
    });

    it('overlapping board reads keep the newest answer, whatever order they arrive in', async () => {
      const service = await started(boardA);
      const first = service.reload();
      const second = service.reload();
      const [older, newer] = reads();
      newer.flush(boardB);
      older.flush(boardA);
      await Promise.all([first, second]);
      expect(service.state()).toEqual(boardB);
    });

    it('a board read sent after a change applies normally', async () => {
      const service = await started(boardB);
      const select = service.select({ host: '192.168.2.2', port: 22, user: 'sima' });
      http.expectOne({ method: 'POST', url: BOARDS_URL }).flush(boardA);
      await select;
      const load = service.reload();
      // While the read is out, the last good state stays.
      expect(service.state()).toEqual(boardA);
      reads()[0].flush(boardB);
      await load;
      expect(service.state()).toEqual(boardB);
    });

    it('an older read that fails while a newer one is out reports nothing: the newer one decides', async () => {
      const service = await started(boardA);
      const first = service.reload();
      const second = service.reload();
      const [older, newer] = reads();
      older.flush(errorBody('unreachable', 'gone'), badGateway);
      await first;
      expect(service.error()).toBeNull();
      newer.flush(boardB);
      await second;
      expect(service.state()).toEqual(boardB);
      expect(service.error()).toBeNull();
    });
  });

  it('an action applies its answer and drops reads sent before it; a failed action rethrows and reloads', async () => {
    const service = await started(boardA);

    // A read on focus is out when Check again answers: its answer is from before the check.
    window.dispatchEvent(new Event('focus'));
    const connected = board(targetA, {
      status: { state: 'connected', checked_at: '2026-10-24T12:00:00Z' },
    });
    const check = service.check();
    const checkRequest = http.expectOne({ method: 'POST', url: checkUrl(targetA) });
    expect(checkRequest.request.body).toEqual({});
    checkRequest.flush(connected);
    await expect(check).resolves.toEqual(connected);
    reads()[0].flush(boardA);
    await tick();
    expect(service.state()).toEqual(connected);

    // The trust call names the board and sends the fingerprint the user confirmed.
    const trust = service.trustHostKey('SHA256:new');
    const trustRequest = http.expectOne({
      method: 'POST',
      url: `/api/boards/${encodeURIComponent(targetA.id)}/trust-host-key`,
    });
    expect(trustRequest.request.body).toEqual({ fingerprint: 'SHA256:new' });
    trustRequest.flush(boardB);
    await trust;
    expect(service.state()).toEqual(boardB);

    // A failed check rethrows the board's problem, after the reload brought the status it recorded.
    const unreachable = {
      code: 'unreachable',
      message: 'Could not connect to 192.168.2.9:22: timed out',
      hint: 'Check that the board is powered on.',
    };
    const failedState = board(targetB, {
      status: { state: 'error', checked_at: '2026-10-24T12:01:00Z', error: unreachable },
    });
    const failing = service.check();
    http
      .expectOne({ method: 'POST', url: checkUrl(targetB) })
      .flush({ error: unreachable }, badGateway);
    const outcome = failing.then(
      () => 'resolved',
      (problem: unknown) => problem,
    );
    await tick();
    http.expectOne(BOARDS_URL).flush(failedState);
    const problem = await outcome;
    expect(problem).toBeInstanceOf(BoardProblem);
    expect(messageOf(problem)).toBe(unreachable.message);
    expect(problem).toMatchObject({ code: 'unreachable', hint: unreachable.hint });
    expect(service.state()).toEqual(failedState);
    // A failed action is not a failed read.
    expect(service.error()).toBeNull();
  });

  it('selects by the SSH address, and Use default forgets the board entered by hand', async () => {
    const entered = boardList(
      [MANUAL, targetA],
      selectedBoard(MANUAL, { status: { state: 'connected' } }),
    );
    const service = await started(entered);

    const select = service.select({ host: '10.0.0.5', port: 2222, user: 'sima' });
    const selectRequest = http.expectOne({ method: 'POST', url: BOARDS_URL });
    expect(selectRequest.request.body).toEqual({ host: '10.0.0.5', port: 2222, user: 'sima' });
    selectRequest.flush(entered);
    await select;

    const forget = service.forget();
    http
      .expectOne({ method: 'DELETE', url: `/api/boards/${encodeURIComponent(MANUAL.id)}` })
      .flush(boardA);
    await expect(forget).resolves.toEqual(boardA);
    expect(service.state()).toEqual(boardA);
  });

  it('Use default without an entered board, and a check or trust without a selected one, ask nothing', async () => {
    const service = await started(boardList());
    await expect(service.forget()).rejects.toBeInstanceOf(BoardProblem);
    await expect(service.check()).rejects.toBeInstanceOf(BoardProblem);
    await expect(service.trustHostKey('SHA256:new')).rejects.toBeInstanceOf(BoardProblem);
  });

  it('an action’s answer clears the error a failed read left', async () => {
    const service = await started(boardA);
    const failed = service.reload();
    http.expectOne(BOARDS_URL).error(new ProgressEvent('error'));
    await failed;
    expect(service.error()).not.toBeNull();

    const select = service.select({ host: '192.168.2.9', port: 22, user: 'sima' });
    http.expectOne({ method: 'POST', url: BOARDS_URL }).flush(boardB);
    await select;
    expect(service.error()).toBeNull();
    expect(service.state()).toEqual(boardB);
  });
});
