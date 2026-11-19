import { BoardProblem } from '../board/board-error';
import { ApiRequestError } from '../sources/stream-lines';
import {
  MAX_POLL_MS,
  POLL_MS,
  failureOf,
  haltsPolling,
  hintCommand,
  pollDelay,
  sentinelUnusable,
} from './sentinel-failure';

const BOARD_ITEM = 'from the board item in the rail';

/** An error as an answer's `error` carries it: a code, a sentence and maybe a hint. */
const detail = (code: string, message = 'x', hint?: string) => ({
  code,
  message,
  ...(hint === undefined ? {} : { hint }),
});

/** A failed request as the server answers it: the error shape, with a board's extras. */
const answered = (status: number, code: string, message: string, extra: object = {}) =>
  new ApiRequestError(status, message, { error: { code, message }, ...extra });

describe('polling', () => {
  it('polling backs off from 2 s to a cap of 30 s', () => {
    expect([0, 1, 3, 99].map(pollDelay)).toEqual([POLL_MS, 4000, 16000, MAX_POLL_MS]);
    expect([POLL_MS, MAX_POLL_MS]).toEqual([2000, 30000]);
    // A count that is not a count of failures polls as normal.
    expect([-1, 1.5, Number.NaN].map(pollDelay)).toEqual([POLL_MS, POLL_MS, POLL_MS]);
  });

  it('a failure about the board or the daemon halts polling; one about a request does not', () => {
    for (const code of [
      'no_target',
      'unreachable',
      'auth_failed',
      'host_key_changed',
      'timeout',
      'permission_denied',
      'tool_missing',
      'command_failed',
      'sentinel_missing',
      'sentinel_stopped',
      'sentinel_denied',
    ]) {
      expect(haltsPolling(code), code).toBe(true);
    }
    for (const code of [
      'sentinel_schema',
      'sentinel_failed',
      'response_too_large',
      'network',
      '',
    ]) {
      expect(haltsPolling(code), code).toBe(false);
    }
  });

  it('only a daemon that is not there, or speaks another API, makes Sentinel unusable', () => {
    for (const code of [
      'sentinel_missing',
      'sentinel_stopped',
      'sentinel_denied',
      'sentinel_schema',
      'sentinel_outdated',
    ]) {
      expect(sentinelUnusable(code), code).toBe(true);
    }
    for (const code of ['sentinel_failed', 'timeout', 'unreachable', 'network', 'not_found', '']) {
      expect(sentinelUnusable(code), code).toBe(false);
    }
  });
});

describe('failureOf', () => {
  it('every backend failure becomes a title, a sentence and a place to fix it', () => {
    const noBoard = failureOf(
      detail('no_target', 'No board is selected.', 'Enter the board address.'),
      null,
    );
    expect([noBoard.title, noBoard.hint, noBoard.board, noBoard.retryable]).toEqual([
      'No board is selected',
      'Enter the board address.',
      true,
      false,
    ]);
    expect(noBoard.problem.message).toBe('No board is selected.');

    const unreachable = failureOf(answered(502, 'unreachable', 'ssh: connect failed'), null);
    expect(unreachable.board).toBe(true);
    expect(unreachable.hint).toContain(BOARD_ITEM);

    const hostKey = { host: '192.168.1.20', expected: 'SHA256:old', presented: 'SHA256:new' };
    expect(
      failureOf(answered(409, 'host_key_changed', 'host key changed', { host_key: hostKey }), null)
        .problem.hostKey,
    ).toEqual(hostKey);

    const schema = failureOf(detail('sentinel_schema', 'Sentinel speaks schema 2'), null);
    expect([schema.title, schema.board]).toEqual([
      'Sentinel and Insight speak different API versions',
      false,
    ]);
    expect(failureOf(detail('sentinel_denied'), null).daemon).toBe(true);
    expect(failureOf(detail('sentinel_outdated'), null).title).toBe(
      'Sentinel on the board is older than Insight',
    );

    const tooLarge = failureOf(detail('response_too_large'), null);
    expect([tooLarge.title, tooLarge.board, tooLarge.daemon]).toEqual([
      'Sentinel answered with more than Insight reads',
      false,
      false,
    ]);
    expect(failureOf(detail('unheard_of'), null).title).toBe('Something went wrong');
    expect(failureOf(new Error('plain'), null)).toMatchObject({
      code: '',
      title: 'Something went wrong',
      hint: '',
    });
    // A problem the board already read is read as it is.
    const problem = new BoardProblem('Sentinel is gone', 'sentinel_missing', '');
    expect(failureOf(problem, 'local').problem).toBe(problem);
  });

  it('a request that never reached Insight is titled as that, with the hint to retry', () => {
    const failure = failureOf(new ApiRequestError(0, 'Failed to fetch', null), 'local');
    expect([failure.code, failure.title, failure.board, failure.retryable]).toEqual([
      'network',
      'Insight is not answering',
      false,
      true,
    ]);
    expect(failure.hint).toBe('Check that Insight is still running, then retry.');
  });

  it('fallback hints point at the board item in the rail, or name the command', () => {
    const hint = (code: string) => failureOf(detail(code), null).hint;
    for (const code of ['no_target', 'unreachable', 'auth_failed', 'host_key_changed']) {
      expect(hint(code), code).toContain('board item in the rail');
    }
    expect(hint('sentinel_missing')).toContain('`sima-cli neat install sentinel`');
    expect(hint('sentinel_stopped')).toContain('`sudo systemctl start simaai-sentinel`');
    expect(hint('unheard_of')).toBe('');
  });

  it('the backend’s own hint wins over the fallback', () => {
    const gone = failureOf(
      detail(
        'unreachable',
        'The board could not be reached.',
        'Check that the board is powered on and on the network, and that `ssh -p 22 sima@192.168.2.254` works from this machine.',
      ),
      null,
    );
    expect([gone.board, gone.daemon]).toEqual([true, false]);
    expect(gone.hint).toMatch(/ssh -p 22 sima@192\.168\.2\.254/);
  });

  it('only failures a retry can fix are retryable', () => {
    for (const code of [
      'no_target',
      'auth_failed',
      'host_key_changed',
      'sentinel_missing',
      'sentinel_denied',
      'sentinel_schema',
      'sentinel_outdated',
    ]) {
      expect(failureOf(detail(code), null).retryable, code).toBe(false);
    }
    for (const code of [
      'unreachable',
      'timeout',
      'permission_denied',
      'tool_missing',
      'command_failed',
      'sentinel_stopped',
      'sentinel_failed',
      'trace_conflict',
      'not_found',
      'invalid_request',
      'request_too_large',
      'response_too_large',
      'network',
      'bad_response',
      'board_changed',
      'unheard_of',
      '',
    ]) {
      expect(failureOf(detail(code), null).retryable, code).toBe(true);
    }
  });

  it('a board that changed under a request says so, whatever the request was', () => {
    for (const action of ['read', 'start', 'stop', 'delete'] as const) {
      const failure = failureOf(detail('board_changed'), 'local', action);
      expect([failure.title, failure.hint, failure.action], action).toEqual([
        'The board changed while Insight was working',
        'Insight has read the board again.',
        action,
      ]);
    }
    // The backend's own hint still wins over the page's.
    expect(failureOf(detail('board_changed', 'x', 'Try again.'), 'local', 'start').hint).toBe(
      'Try again.',
    );
  });

  it('a trace conflict is titled by what was being asked', () => {
    const title = (action: 'read' | 'start' | 'stop' | 'delete') =>
      failureOf(detail('trace_conflict'), 'local', action).title;
    expect(title('start')).toBe('That trace cannot start');
    expect(title('stop')).toBe('The trace changed before it was stopped');
    expect(title('delete')).toBe('That run is still recording');
    // The default keeps the wording the code had before the actions existed.
    expect(title('read')).toBe('That trace cannot start');
  });

  it('a run that is gone is titled as a deleted run only when it was being deleted', () => {
    const gone = detail('not_found');
    expect(failureOf(gone, 'local', 'delete').title).toBe('That run is no longer on the board');
    expect(failureOf(gone, 'local').title).toBe('That run is not on this board');
    expect(failureOf(gone, 'local', 'stop').title).toBe('That run is not on this board');
  });

  it('a failure carries the board it was asked of', () => {
    expect(failureOf(detail('unreachable'), 'local').boardId).toBe('local');
    expect(failureOf(detail('unreachable'), null).boardId).toBeNull();
  });
});

describe('hintCommand', () => {
  it('is the first command a hint names in backticks', () => {
    expect(
      hintCommand('Install it on the board with `sima-cli neat install sentinel`, then retry.'),
    ).toBe('sima-cli neat install sentinel');
    expect(hintCommand('Run ` sudo a ` and then `b`.')).toBe('sudo a');
    expect(hintCommand('Check the board.')).toBe('');
    expect(hintCommand('')).toBe('');
  });
});
