import { ApiRequestError, messageOf } from '../sources/stream-lines';
import { BoardProblem, CONNECTION_CODES, problemOf } from './board-error';

/** A problem's four fields, for comparing it with a plain object. */
function fields(problem: BoardProblem) {
  const { message, code, hint, details } = problem;
  return { message, code, hint, details };
}

describe('problemOf', () => {
  // #170's "API errors keep code, hint, and extra fields": its apiError is the app's
  // ApiRequestError, and its normalizeError is problemOf.
  it('API errors keep code, hint, and extra fields', () => {
    const body = {
      error: 'Host key changed',
      code: 'host_key_changed',
      hint: 'Confirm the board was reflashed.',
      host: '192.168.2.2',
      expected_fingerprint: 'SHA256:old',
      presented_fingerprint: 'SHA256:new',
    };
    const err = new ApiRequestError(409, 'Host key changed', body);
    expect(err.message).toBe('Host key changed');
    const normalized = problemOf(err);
    expect(normalized.code).toBe('host_key_changed');
    expect(normalized.hint).toBe('Confirm the board was reflashed.');
    expect(normalized.details['presented_fingerprint']).toBe('SHA256:new');
    // The same error read from a board state's `status.error`.
    expect(fields(problemOf(body))).toEqual(fields(normalized));
    expect(fields(problemOf(new ApiRequestError(502, 'Request failed: 502', null)))).toEqual({
      message: 'Request failed: 502',
      code: '',
      hint: '',
      details: {},
    });
    expect(fields(problemOf('boom'))).toEqual({ message: 'boom', code: '', hint: '', details: {} });
  });

  it('a problem is an Error, so the app’s messageOf words it like any other failure', () => {
    const problem = problemOf(
      new ApiRequestError(502, 'SSH key authentication as sima on 10.0.0.4 failed.', {
        error: 'SSH key authentication as sima on 10.0.0.4 failed.',
        code: 'auth_failed',
        hint: 'Authorize a key on the board, then retry.',
        command: 'ssh-copy-id -p 22 sima@10.0.0.4',
      }),
    );
    expect(problem).toBeInstanceOf(BoardProblem);
    expect(problem).toBeInstanceOf(Error);
    expect(problem.name).toBe('BoardProblem');
    expect(messageOf(problem)).toBe('SSH key authentication as sima on 10.0.0.4 failed.');
    for (const failure of [{ error: 'x', code: 'timeout' }, new Error('y'), 'z']) {
      expect(problemOf(failure)).toBeInstanceOf(BoardProblem);
    }
  });

  it('a problem read again is the same problem, with its extras', () => {
    const problem = problemOf({
      error: 'Host key changed',
      code: 'host_key_changed',
      hint: 'Trust the new key if you reflashed the board.',
      presented_fingerprint: 'SHA256:new',
    });
    expect(problemOf(problem)).toBe(problem);
    expect(problemOf(problem).details['presented_fingerprint']).toBe('SHA256:new');
  });

  it('a request that never reached Insight says so in #170’s words, with the code network', () => {
    expect(fields(problemOf(new ApiRequestError(0, 'Could not reach the server.', null)))).toEqual({
      message: 'Could not reach the Insight server.',
      code: 'network',
      hint: 'Check that Insight is still running, then retry.',
      details: {},
    });
  });

  it('a null hint reads as none, and an error from outside the API keeps only its message', () => {
    const body = { error: 'Board busy', code: 'timeout', hint: null };
    expect(fields(problemOf(new ApiRequestError(504, 'Board busy', body)))).toEqual({
      message: 'Board busy',
      code: 'timeout',
      hint: '',
      details: body,
    });
    expect(fields(problemOf(new Error('interceptor')))).toEqual({
      message: 'interceptor',
      code: '',
      hint: '',
      details: {},
    });
  });

  it('the connection codes are the three failures of the SSH connection itself', () => {
    expect([...CONNECTION_CODES].sort()).toEqual([
      'auth_failed',
      'host_key_changed',
      'unreachable',
    ]);
  });
});
