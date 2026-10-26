import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { BoardState, ShellInfo } from './api';
import { messageOf } from '../sources/stream-lines';
import { BoardProblem } from './board-error';
import { BoardService } from './board.service';

const BOARD_URL = '/api/board';

function board(label: string, generation: number, overrides: Partial<BoardState> = {}): BoardState {
  return {
    target: { mode: 'ssh', source: 'manual', host: label, port: 22, user: 'sima', label },
    saved: null,
    defaults: { on_board: false, sdk_env: null },
    generation,
    // Connected unless a test says otherwise: an unknown state makes the service check the board.
    status: { state: 'connected', checked_at: '2026-10-26T10:00:00Z', error: null },
    board: null,
    ...overrides,
  };
}

const boardA = board('sima@192.168.2.2', 1);
const boardB = board('sima@192.168.2.9', 2);
const unchecked: Partial<BoardState> = {
  status: { state: 'unknown', checked_at: null, error: null },
};

const badGateway = { status: 502, statusText: 'Bad Gateway' };

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
  async function started(initial: BoardState = boardA): Promise<BoardService> {
    const service = TestBed.inject(BoardService);
    http.expectOne(BOARD_URL).flush(initial);
    await tick();
    return service;
  }

  /** The board reads now pending, oldest first; they are taken, so a second call returns only newer ones. */
  function reads() {
    return http.match((request) => request.method === 'GET' && request.url === BOARD_URL);
  }

  it('reloads on construction and on window focus, and never on a timer', async () => {
    vi.useFakeTimers();
    const service = TestBed.inject(BoardService);
    // Before the first answer: loading, which is neither a state nor an error.
    expect(service.state()).toBeNull();
    expect(service.error()).toBeNull();
    expect(service.generation()).toBeNull();
    http.expectOne(BOARD_URL).flush(boardA);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.state()).toEqual(boardA);
    expect(service.generation()).toBe(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    http.expectNone(BOARD_URL);
    expect(vi.getTimerCount()).toBe(0);

    window.dispatchEvent(new Event('focus'));
    http.expectOne(BOARD_URL).flush(boardB);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.state()).toEqual(boardB);
    expect(service.generation()).toBe(2);
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
    http.expectOne(BOARD_URL).error(new ProgressEvent('error'));
    await tick();
    window.dispatchEvent(new Event('focus'));
    http.expectOne(BOARD_URL).flush(boardA);
    await tick();
    expect(service.state()).toEqual(boardA);
  });

  it('keeps the last good state when a read fails, and clears the error with the next good answer', async () => {
    const service = await started(boardA);

    const failed = service.reload();
    http
      .expectOne(BOARD_URL)
      .flush(
        { error: 'The board is busy.', code: 'timeout', hint: 'Retry the action.' },
        { status: 504, statusText: 'Gateway Timeout' },
      );
    await failed;
    expect(service.state()).toEqual(boardA);
    const error = service.error();
    expect(error).toBeInstanceOf(BoardProblem);
    expect(error?.message).toBe('The board is busy.');
    expect(error?.code).toBe('timeout');
    expect(error?.hint).toBe('Retry the action.');
    expect(error?.details).toEqual({
      error: 'The board is busy.',
      code: 'timeout',
      hint: 'Retry the action.',
    });

    const next = service.reload();
    http.expectOne(BOARD_URL).flush(boardB);
    await next;
    expect(service.state()).toEqual(boardB);
    expect(service.error()).toBeNull();
  });

  it('a first read that fails sets the error with no state', async () => {
    const service = TestBed.inject(BoardService);
    http.expectOne(BOARD_URL).error(new ProgressEvent('error'));
    await tick();
    expect(service.state()).toBeNull();
    expect(service.error()?.code).toBe('network');
  });

  // "Not checked" goes: a read never connects to the board, so Insight checks the connection
  // itself, once per app load, rather than leaving the pill at "Not checked" until the user asks.
  describe('connection check on load', () => {
    const testRequests = () => http.match({ method: 'POST', url: '/api/board/test' });

    it('checks a selected board whose state is unknown, once, and applies the answer', async () => {
      const service = await started(board('sima@192.168.2.2', 1, unchecked));
      const [check] = testRequests();
      expect(check).toBeDefined();
      expect(check.request.body).toEqual({});
      check.flush(boardA);
      await tick();
      expect(service.state()).toEqual(boardA);

      // Neither a focus nor an explicit reload checks again, whatever they find.
      window.dispatchEvent(new Event('focus'));
      http.expectOne(BOARD_URL).flush(board('sima@192.168.2.2', 1, unchecked));
      await tick();
      const reload = service.reload();
      http.expectOne(BOARD_URL).flush(board('sima@192.168.2.2', 1, unchecked));
      await reload;
      await tick();
      expect(testRequests()).toHaveLength(0);
    });

    it.each([
      ['connected', boardA],
      [
        'failed',
        board('sima@192.168.2.2', 1, {
          status: { state: 'error', checked_at: null, error: null },
        }),
      ],
      ['unselected', board('sima@192.168.2.2', 1, { ...unchecked, target: null })],
    ])('does not check a board that is %s', async (_, state) => {
      await started(state);
      expect(testRequests()).toHaveLength(0);
    });

    it('waits for the first read that succeeds, and decides on it for the rest of the load', async () => {
      const service = TestBed.inject(BoardService);
      http.expectOne(BOARD_URL).error(new ProgressEvent('error'));
      await tick();
      expect(testRequests()).toHaveLength(0);

      const retry = service.reload();
      http.expectOne(BOARD_URL).flush(boardA);
      await retry;
      // That read found the board connected: the check is spent, not owed to a later unknown.
      window.dispatchEvent(new Event('focus'));
      http.expectOne(BOARD_URL).flush(board('sima@192.168.2.2', 1, unchecked));
      await tick();
      expect(testRequests()).toHaveLength(0);
    });

    it('a board change while the check is out wins: the slow answer for the old board is dropped', async () => {
      const service = await started(board('sima@192.168.2.2', 1, unchecked));
      const [check] = testRequests();

      const select = service.select({ host: '192.168.2.9', port: 22, user: 'sima' });
      http.expectOne({ method: 'POST', url: '/api/board/select' }).flush(boardB);
      await select;

      check.flush(boardA);
      await tick();
      expect(service.state()).toEqual(boardB);
      expect(service.generation()).toBe(2);
    });

    it('a failed check lands in the state only: the board is re-read, and nothing is toasted or thrown', async () => {
      const service = await started(board('sima@192.168.2.2', 1, unchecked));
      testRequests()[0].flush(
        { error: 'Could not connect to sima@192.168.2.2.', code: 'unreachable', hint: '' },
        badGateway,
      );
      await tick();
      // The failed action reloads the state, where the backend recorded the failure.
      const failed = board('sima@192.168.2.2', 1, {
        status: { state: 'error', checked_at: '2026-10-26T10:00:05Z', error: null },
      });
      http.expectOne(BOARD_URL).flush(failed);
      await tick();
      expect(service.state()?.status.state).toBe('error');
      expect(service.error()).toBeNull();
      expect(toasts.error).not.toHaveBeenCalled();
      expect(toasts.status).not.toHaveBeenCalled();
      expect(testRequests()).toHaveLength(0);
    });
  });

  // #170's four board-sync tests (ruling F4): the POST that "applies" a state is `select()`, and
  // "the superseded read reports the state that won" is `state()` after the read settled.
  describe('board sync', () => {
    it('a board read that was sent before a board change cannot undo it', async () => {
      const service = await started(boardA);
      const load = service.reload();
      // The POST that selected B answered first.
      const select = service.select({ host: '192.168.2.9', port: 22, user: 'sima' });
      http.expectOne({ method: 'POST', url: '/api/board/select' }).flush(boardB);
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
      http.expectOne({ method: 'POST', url: '/api/board/select' }).flush(boardB);
      await select;
      reads()[0].flush({ error: 'network' }, badGateway);
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
      http.expectOne({ method: 'POST', url: '/api/board/select' }).flush(boardA);
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
      older.flush({ error: 'gone' }, badGateway);
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
    const connected = board('sima@192.168.2.2', 1, {
      status: { state: 'connected', checked_at: '2026-10-24T12:00:00Z', error: null },
    });
    const check = service.test();
    const testRequest = http.expectOne({ method: 'POST', url: '/api/board/test' });
    expect(testRequest.request.body).toEqual({});
    testRequest.flush(connected);
    await expect(check).resolves.toEqual(connected);
    reads()[0].flush(boardA);
    await tick();
    expect(service.state()).toEqual(connected);

    // The trust call sends the fingerprint the user confirmed.
    const trust = service.trustHostKey('SHA256:new');
    const trustRequest = http.expectOne({ method: 'POST', url: '/api/board/trust-host-key' });
    expect(trustRequest.request.body).toEqual({ fingerprint: 'SHA256:new' });
    trustRequest.flush(boardB);
    await trust;
    expect(service.state()).toEqual(boardB);

    // A failed check rethrows the board's problem, after the reload brought the status it recorded.
    const unreachable = {
      error: 'Could not connect to 192.168.2.9:22: timed out',
      code: 'unreachable',
      hint: 'Check that the board is powered on.',
    };
    const failedState = board('sima@192.168.2.9', 2, {
      status: { state: 'error', checked_at: '2026-10-24T12:01:00Z', error: unreachable },
    });
    const failing = service.test();
    http.expectOne({ method: 'POST', url: '/api/board/test' }).flush(unreachable, badGateway);
    const outcome = failing.then(
      () => 'resolved',
      (problem: unknown) => problem,
    );
    await tick();
    http.expectOne(BOARD_URL).flush(failedState);
    const problem = await outcome;
    expect(problem).toBeInstanceOf(BoardProblem);
    expect(messageOf(problem)).toBe(unreachable.error);
    expect(problem).toMatchObject({
      code: 'unreachable',
      hint: unreachable.hint,
      details: unreachable,
    });
    expect(service.state()).toEqual(failedState);
    // A failed action is not a failed read.
    expect(service.error()).toBeNull();

    // Reset sends its own body.
    const reset = service.select({ reset: true });
    const resetRequest = http.expectOne({ method: 'POST', url: '/api/board/select' });
    expect(resetRequest.request.body).toEqual({ reset: true });
    resetRequest.flush(boardA);
    await reset;
    expect(service.state()).toEqual(boardA);
  });

  it('an action’s answer clears the error a failed read left', async () => {
    const service = await started(boardA);
    const failed = service.reload();
    http.expectOne(BOARD_URL).error(new ProgressEvent('error'));
    await failed;
    expect(service.error()).not.toBeNull();

    const select = service.select({ host: '192.168.2.9', port: 22, user: 'sima' });
    http.expectOne({ method: 'POST', url: '/api/board/select' }).flush(boardB);
    await select;
    expect(service.error()).toBeNull();
    expect(service.state()).toEqual(boardB);
  });

  describe('the shell', () => {
    const shell: ShellInfo = {
      configured: true,
      devkit_ip: '192.168.2.2',
      button_label: 'DevKit: 192.168.2.2',
      available: true,
      running: false,
      webssh_port: 8022,
      webssh_host_port: 8022,
      default_username: 'sima',
      credentials_prefilled: true,
      launch_supported: true,
      launch_url: 'https://localhost:8022/?hostname=192.168.2.2',
    };

    it('shellInfo resolves null when the request fails', async () => {
      const service = await started();
      const info = service.shellInfo();
      http.expectOne({ method: 'GET', url: '/api/devkit-shell' }).flush(shell);
      await expect(info).resolves.toEqual(shell);

      const failed = service.shellInfo();
      http.expectOne({ method: 'GET', url: '/api/devkit-shell' }).flush(
        { error: 'NEAT_INSIGHT_WEBSSH_PORT must be an integer, got: x' },
        {
          status: 500,
          statusText: 'Internal Server Error',
        },
      );
      await expect(failed).resolves.toBeNull();
    });

    it('startShell starts webssh and answers the shell info, or rejects with the server’s message', async () => {
      const service = await started();
      const start = service.startShell();
      http
        .expectOne({ method: 'POST', url: '/api/devkit-shell/start' })
        .flush({ ...shell, running: true });
      await expect(start).resolves.toEqual({ ...shell, running: true });

      const refused = service.startShell();
      http
        .expectOne({ method: 'POST', url: '/api/devkit-shell/start' })
        .flush(
          { error: 'The browser shell is available only for the SDK-paired DevKit.' },
          { status: 409, statusText: 'Conflict' },
        );
      await expect(refused).rejects.toThrow(
        'The browser shell is available only for the SDK-paired DevKit.',
      );
    });
  });
});
