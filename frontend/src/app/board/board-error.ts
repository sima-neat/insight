import { ApiRequestError, messageOf } from '../sources/stream-lines';

/**
 * A board failure as the board's UI shows it (#170's normalized error): the message, the API's
 * stable `code` and recovery `hint` ('' when there is none), and the whole error body in `details`,
 * where the extras of a code live (the fingerprints of `host_key_changed`, the `command` of
 * `auth_failed`). It is an `Error`, so a caller that only reports failures words it with
 * `messageOf` like any other.
 */
export class BoardProblem extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly hint: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BoardProblem';
  }
}

/** The failures of the SSH connection itself, which the board's settings are the place to fix. */
export const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'unreachable',
  'auth_failed',
  'host_key_changed',
]);

/**
 * #170's words for a request that never reached Insight (Inv-PB §2.5). The board names Insight,
 * since the board itself may be just as unreachable and the two must not be confused.
 */
const NETWORK_MESSAGE = 'Could not reach the Insight server.';
const NETWORK_HINT = 'Check that Insight is still running, then retry.';

/**
 * The problem a failure describes. It reads a failed request (an `ApiRequestError`), a board error
 * body as `GET /api/board` repeats it in `status.error`, or anything else by its message; a
 * problem is returned as it is. A request that never reached Insight (status 0) has the code
 * `network` and #170's message and hint for it.
 */
export function problemOf(failure: unknown): BoardProblem {
  if (failure instanceof BoardProblem) return failure;
  if (failure instanceof ApiRequestError) {
    const details = failure.body ?? {};
    const network = failure.status === 0;
    return new BoardProblem(
      network ? NETWORK_MESSAGE : failure.message,
      text(details['code']) || (network ? 'network' : ''),
      text(details['hint']) || (network ? NETWORK_HINT : ''),
      details,
    );
  }
  if (isRecord(failure)) {
    return new BoardProblem(
      text(failure['error']) || text(failure['message']) || 'Unknown error',
      text(failure['code']),
      text(failure['hint']),
      failure,
    );
  }
  return new BoardProblem(messageOf(failure), '', '', {});
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A plain object, such as a JSON body; not an `Error`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !(value instanceof Error);
}
