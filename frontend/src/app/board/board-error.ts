import type { BoardStatus, ErrorDetail, HostKeyChange } from '../api.generated';
import { ApiRequestError, messageOf } from '../sources/stream-lines';

/**
 * A board failure as the board's UI shows it: the message, the API's stable `code` and recovery
 * `hint` ('' when there is none), and what a board's failure adds: `hostKey` with
 * `host_key_changed` (the trusted and the presented fingerprint) and `command` with `auth_failed`
 * (the command that authorizes Insight's key; '' otherwise). It is an `Error`, so a caller that
 * only reports failures words it with `messageOf` like any other.
 */
export class BoardProblem extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly hint: string,
    readonly hostKey: HostKeyChange | null = null,
    readonly command = '',
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
 * The codes that say a request named a board that is no longer the selected one: `not_found` for
 * an id that is not the selected board's (a board route also answers it for a run, a preview or a
 * recording it does not hold) and `board_changed` for a board replaced while the request ran.
 * Either way the boards are worth reading again: if the board changed, that is how the page
 * finds out.
 */
export const BOARD_GONE_CODES: ReadonlySet<string> = new Set(['not_found', 'board_changed']);

/**
 * The words for a request that never reached Insight. They name Insight, since the board itself
 * may be just as unreachable and the two must not be confused.
 */
const NETWORK_MESSAGE = 'Could not reach the Insight server.';
const NETWORK_HINT = 'Check that Insight is still running, then retry.';

/**
 * The problem a failure describes. It reads a failed request (an `ApiRequestError`, whose body is
 * the error shape with a board's `host_key` or `command`), an `ErrorDetail` as an answer carries it
 * (a microphone test's `error`), or anything else by its message; a problem is returned as it is.
 * A request that never reached Insight (status 0) has the code `network` and its own message and
 * hint.
 */
export function problemOf(failure: unknown): BoardProblem {
  if (failure instanceof BoardProblem) return failure;
  if (failure instanceof ApiRequestError) {
    const network = failure.status === 0;
    return new BoardProblem(
      network ? NETWORK_MESSAGE : failure.message,
      failure.code ?? (network ? 'network' : ''),
      failure.hint ?? (network ? NETWORK_HINT : ''),
      hostKeyOf(failure.body?.['host_key']),
      text(failure.body?.['command']),
    );
  }
  if (isRecord(failure)) {
    return new BoardProblem(
      text(failure['message']) || 'Unknown error',
      text(failure['code']),
      text(failure['hint']),
    );
  }
  return new BoardProblem(messageOf(failure), '', '');
}

/**
 * The problem the board's status records for its last contact (`selected.status` of
 * `GET /api/boards`), with its host key or command; null while the last contact went well.
 */
export function recordedProblem(status: BoardStatus): BoardProblem | null {
  const error: ErrorDetail | undefined = status.error;
  if (!error) return null;
  return new BoardProblem(
    error.message,
    error.code,
    error.hint ?? '',
    status.host_key ?? null,
    status.command ?? '',
  );
}

function hostKeyOf(value: unknown): HostKeyChange | null {
  if (!isRecord(value)) return null;
  const [host, expected, presented] = [value['host'], value['expected'], value['presented']];
  return typeof host === 'string' && typeof expected === 'string' && typeof presented === 'string'
    ? { host, expected, presented }
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A plain object, such as a JSON body; not an `Error`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !(value instanceof Error);
}
