import { ApiRequestError, messageOf } from '../sources/api-errors';
import {
  BOARD_GONE_CODES,
  BoardProblem,
  CONNECTION_CODES,
  problemOf,
  recordedProblem,
} from './board-error';

/** A problem's fields, for comparing it with a plain object. */
function fields(problem: BoardProblem) {
  const { message, code, hint, hostKey, command } = problem;
  return { message, code, hint, hostKey, command };
}

const HOST_KEY = { host: '192.168.2.2', expected: 'SHA256:old', presented: 'SHA256:new' };

describe('problemOf', () => {
  it('a board error keeps its code and hint, and the host key a changed key adds', () => {
    const body = {
      error: {
        code: 'host_key_changed',
        message: 'Host key changed',
        hint: 'Confirm the board was reflashed.',
      },
      host_key: HOST_KEY,
    };
    expect(fields(problemOf(new ApiRequestError(409, 'Host key changed', body)))).toEqual({
      message: 'Host key changed',
      code: 'host_key_changed',
      hint: 'Confirm the board was reflashed.',
      hostKey: HOST_KEY,
      command: '',
    });
    expect(fields(problemOf(new ApiRequestError(502, 'Request failed: 502', null)))).toEqual({
      message: 'Request failed: 502',
      code: '',
      hint: '',
      hostKey: null,
      command: '',
    });
    expect(fields(problemOf('boom'))).toEqual({
      message: 'boom',
      code: '',
      hint: '',
      hostKey: null,
      command: '',
    });
  });

  it('a refused key keeps the command that authorizes Insight’s key', () => {
    const problem = problemOf(
      new ApiRequestError(502, 'SSH key authentication as sima on 10.0.0.4 failed.', {
        error: {
          code: 'auth_failed',
          message: 'SSH key authentication as sima on 10.0.0.4 failed.',
          hint: 'Authorize a key on the board, then retry.',
        },
        command: 'ssh-copy-id -p 22 sima@10.0.0.4',
      }),
    );
    expect(problem.command).toBe('ssh-copy-id -p 22 sima@10.0.0.4');
    expect(problem.hostKey).toBeNull();
  });

  it('a host key without all of its parts is none', () => {
    const body = {
      error: { code: 'host_key_changed', message: 'Host key changed' },
      host_key: { host: 'board', expected: 'SHA256:old' },
    };
    expect(problemOf(new ApiRequestError(409, 'Host key changed', body)).hostKey).toBeNull();
  });

  it('a problem is an Error, so the app’s messageOf words it like any other failure', () => {
    const problem = problemOf(
      new ApiRequestError(502, 'SSH key authentication failed.', {
        error: { code: 'auth_failed', message: 'SSH key authentication failed.' },
      }),
    );
    expect(problem).toBeInstanceOf(BoardProblem);
    expect(problem).toBeInstanceOf(Error);
    expect(problem.name).toBe('BoardProblem');
    expect(messageOf(problem)).toBe('SSH key authentication failed.');
    for (const failure of [{ message: 'x', code: 'timeout' }, new Error('y'), 'z']) {
      expect(problemOf(failure)).toBeInstanceOf(BoardProblem);
    }
  });

  it('an error detail as an answer carries it reads as a problem; a problem read again is itself', () => {
    const problem = problemOf({
      code: 'microphone_in_use',
      message: 'The microphone is in use.',
      hint: 'Stop the other program.',
    });
    expect(fields(problem)).toEqual({
      message: 'The microphone is in use.',
      code: 'microphone_in_use',
      hint: 'Stop the other program.',
      hostKey: null,
      command: '',
    });
    expect(problemOf(problem)).toBe(problem);
  });

  it('a request that never reached Insight says so, with the code network', () => {
    expect(fields(problemOf(new ApiRequestError(0, 'Could not reach the server.', null)))).toEqual({
      message: 'Could not reach the Insight server.',
      code: 'network',
      hint: 'Check that Insight is still running, then retry.',
      hostKey: null,
      command: '',
    });
  });

  it('a missing hint reads as none, and an error from outside the API keeps only its message', () => {
    const body = { error: { code: 'timeout', message: 'Board busy' } };
    expect(fields(problemOf(new ApiRequestError(504, 'Board busy', body)))).toEqual({
      message: 'Board busy',
      code: 'timeout',
      hint: '',
      hostKey: null,
      command: '',
    });
    expect(fields(problemOf(new Error('interceptor')))).toEqual({
      message: 'interceptor',
      code: '',
      hint: '',
      hostKey: null,
      command: '',
    });
  });
});

describe('recordedProblem', () => {
  it('reads the board status’s error with the host key or command beside it', () => {
    expect(
      fields(
        recordedProblem({
          state: 'error',
          error: { code: 'host_key_changed', message: 'Host key changed', hint: 'Check it.' },
          host_key: HOST_KEY,
        })!,
      ),
    ).toEqual({
      message: 'Host key changed',
      code: 'host_key_changed',
      hint: 'Check it.',
      hostKey: HOST_KEY,
      command: '',
    });
    expect(
      recordedProblem({
        state: 'error',
        error: { code: 'auth_failed', message: 'Refused' },
        command: 'ssh-copy-id sima@b',
      })?.command,
    ).toBe('ssh-copy-id sima@b');
  });

  it('is null while the last contact went well', () => {
    expect(recordedProblem({ state: 'connected' })).toBeNull();
    expect(recordedProblem({ state: 'unknown' })).toBeNull();
  });
});

describe('codes', () => {
  it('the connection codes are the three failures of the SSH connection itself', () => {
    expect([...CONNECTION_CODES].sort()).toEqual([
      'auth_failed',
      'host_key_changed',
      'unreachable',
    ]);
  });

  it('a board that is gone is not_found or board_changed', () => {
    expect([...BOARD_GONE_CODES].sort()).toEqual(['board_changed', 'not_found']);
  });
});
