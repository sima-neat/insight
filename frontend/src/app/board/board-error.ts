import { ApiRequestError, messageOf } from '../sources/stream-lines';

/**
 * A board failure as the board's UI shows it (#170's normalized error): the message, the API's
 * stable `code` and recovery `hint` ('' when there is none), and the whole error body in `details`,
 * where the extras of a code live (the fingerprints of `host_key_changed`, the `command` of
 * `auth_failed`).
 */
export interface BoardProblem {
  message: string;
  code: string;
  hint: string;
  details: Record<string, unknown>;
}

/** The failures of the SSH connection itself, which the board's settings are the place to fix. */
export const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'unreachable',
  'auth_failed',
  'host_key_changed',
]);

/** #170's hint for a request that never reached Insight (Inv-PB §2.5). */
const NETWORK_HINT = 'Check that Insight is still running, then retry.';

/**
 * The problem a failure describes. It reads a failed request (an `ApiRequestError`), a board error
 * body as `GET /api/board` repeats it in `status.error`, or anything else by its message. A request
 * that never reached Insight (status 0) has the code `network`.
 */
export function problemOf(failure: unknown): BoardProblem {
  if (failure instanceof ApiRequestError) {
    const details = failure.body ?? {};
    const network = failure.status === 0;
    return {
      message: failure.message,
      code: text(details['code']) || (network ? 'network' : ''),
      hint: text(details['hint']) || (network ? NETWORK_HINT : ''),
      details,
    };
  }
  if (isRecord(failure)) {
    return {
      message: text(failure['error']) || text(failure['message']) || 'Unknown error',
      code: text(failure['code']),
      hint: text(failure['hint']),
      details: failure,
    };
  }
  return { message: messageOf(failure), code: '', hint: '', details: {} };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A plain object, such as a JSON body; not an `Error`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !(value instanceof Error);
}
