import { ApiRequestError } from '../sources/stream-lines';
import { CONNECTION_CODES, problemOf } from './board-error';

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
    expect(problemOf(body)).toEqual(normalized);
    expect(problemOf(new ApiRequestError(502, 'Request failed: 502', null))).toEqual({
      message: 'Request failed: 502',
      code: '',
      hint: '',
      details: {},
    });
    expect(problemOf('boom')).toEqual({ message: 'boom', code: '', hint: '', details: {} });
  });

  it('a request that never reached Insight has the code network and the hint to check Insight', () => {
    expect(problemOf(new ApiRequestError(0, 'Could not reach the server.', null))).toEqual({
      message: 'Could not reach the server.',
      code: 'network',
      hint: 'Check that Insight is still running, then retry.',
      details: {},
    });
  });

  it('a null hint reads as none, and an error from outside the API keeps only its message', () => {
    const body = { error: 'Board busy', code: 'timeout', hint: null };
    expect(problemOf(new ApiRequestError(504, 'Board busy', body))).toEqual({
      message: 'Board busy',
      code: 'timeout',
      hint: '',
      details: body,
    });
    expect(problemOf(new Error('interceptor'))).toEqual({
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
