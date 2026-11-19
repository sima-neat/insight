import { BoardProblem, problemOf } from '../board/board-error';

/** Sentinel samples every two seconds; a failing board is polled ever more slowly. */
export const POLL_MS = 2000;
export const MAX_POLL_MS = 30_000;

/** The wait before the next poll after `failures` failed ones in a row: 2 s, doubling to 30 s. */
export function pollDelay(failures: number): number {
  const count = Number.isInteger(failures) && failures > 0 ? failures : 0;
  return Math.min(MAX_POLL_MS, POLL_MS * 2 ** Math.min(count, 8));
}

/** Board-level failures: the fix is in the board's settings, not in Sentinel. */
const BOARD_CODES: ReadonlySet<string> = new Set([
  'no_target',
  'unreachable',
  'auth_failed',
  'host_key_changed',
  'timeout',
  'permission_denied',
  'tool_missing',
  'command_failed',
]);

/** Sentinel is reachable only once its daemon runs; these say it does not. */
const DAEMON_CODES: ReadonlySet<string> = new Set([
  'sentinel_missing',
  'sentinel_stopped',
  'sentinel_denied',
]);

/**
 * The codes that say Sentinel cannot be used on the board as it is: its daemon is not there to
 * answer, or it speaks an API Insight does not (`sentinel_schema`, `sentinel_outdated`). A health
 * read failing with one of them means Sentinel is not ready; any other failure (a lost
 * connection, a timeout) says nothing about whether it is.
 */
const UNUSABLE_CODES: ReadonlySet<string> = new Set([
  ...DAEMON_CODES,
  'sentinel_schema',
  'sentinel_outdated',
]);

/**
 * Whether a failure with this code says the board or the daemon cannot answer: the next poll would
 * fail the same way, so polling stops until the state is read again.
 */
export function haltsPolling(code: string): boolean {
  return BOARD_CODES.has(code) || DAEMON_CODES.has(code);
}

/** Whether a failure with this code says Sentinel cannot be used on the board (`UNUSABLE_CODES`). */
export function sentinelUnusable(code: string): boolean {
  return UNUSABLE_CODES.has(code);
}

/**
 * The codes whose fix lies elsewhere than in asking again: the board's settings (`no_target`,
 * `auth_failed`, `host_key_changed`), Sentinel's installation (`sentinel_missing`,
 * `sentinel_denied`) or its version (`sentinel_schema`, `sentinel_outdated`).
 */
const NOT_RETRYABLE: ReadonlySet<string> = new Set([
  'no_target',
  'auth_failed',
  'host_key_changed',
  'sentinel_missing',
  'sentinel_denied',
  'sentinel_schema',
  'sentinel_outdated',
]);

// Titles say what failed; the backend's own message and hint carry the detail.
const TITLES: Record<string, string> = {
  no_target: 'No board is selected',
  unreachable: 'The board could not be reached',
  auth_failed: 'The board refused the SSH key',
  host_key_changed: 'The board presented a different host key',
  timeout: 'The board took too long to answer',
  permission_denied: 'The board refused the command',
  tool_missing: 'A tool is missing on the board',
  command_failed: 'A command failed on the board',
  sentinel_missing: 'Sentinel is not installed on this board',
  sentinel_stopped: 'The Sentinel service is stopped',
  sentinel_denied: 'Sentinel refused this user',
  sentinel_schema: 'Sentinel and Insight speak different API versions',
  sentinel_outdated: 'Sentinel on the board is older than Insight',
  sentinel_failed: 'Sentinel could not answer',
  sentinel_busy: 'Sentinel is busy',
  board_changed: 'The board changed while Insight was working',
  trace_conflict: 'That trace cannot start',
  not_found: 'That run is not on this board',
  invalid_request: 'The request was rejected',
  request_too_large: 'The request was too large',
  response_too_large: 'Sentinel answered with more than Insight reads',
  network: 'Insight is not answering',
  bad_response: 'Insight answered something unexpected',
};
const FALLBACK_TITLE = 'Something went wrong';

/** What the backend's own hint is missing. The board's settings are the rail's board item. */
const FALLBACK_HINTS: Record<string, string> = {
  no_target: 'Choose a board with the board item in the rail.',
  unreachable: 'Fix the connection from the board item in the rail, then retry.',
  auth_failed: 'Fix the connection from the board item in the rail, then retry.',
  host_key_changed:
    'Confirm the fingerprint in the board dialog, from the board item in the rail, before trusting the new key.',
  timeout: 'Check the board is awake and on the network, then retry.',
  board_changed: 'Insight has read the board again.',
  sentinel_missing: 'Install it on the board with `sima-cli neat install sentinel`.',
  sentinel_stopped: 'Start it on the board with `sudo systemctl start simaai-sentinel`.',
  sentinel_failed: 'Check `systemctl status simaai-sentinel` on the board.',
};

/**
 * What a Sentinel request was for. A read is the default; the rest change something on the board,
 * and the same codes mean something else for them.
 */
export type SentinelAction = 'read' | 'start' | 'stop' | 'delete';

/**
 * `trace_conflict` is the one code three requests answer for different reasons: starting while a
 * trace runs or a name is taken (the default title says that, so a start needs no entry),
 * stopping a trace that is no longer the one shown, and deleting a run still being recorded.
 * Deleting a run another client already removed is a `not_found`.
 */
const STOP_TITLES: Record<string, string> = {
  trace_conflict: 'The trace changed before it was stopped',
};

const DELETE_TITLES: Record<string, string> = {
  trace_conflict: 'That run is still recording',
  not_found: 'That run is no longer on the board',
};

const ACTION_TITLES: Partial<Record<SentinelAction, Record<string, string>>> = {
  stop: STOP_TITLES,
  delete: DELETE_TITLES,
};

/** What a Sentinel request failed with: what the page says about it, and where the fix is. */
export interface SentinelFailure {
  /** The failure as the board's UI reads it. */
  problem: BoardProblem;
  code: string;
  /**
   * The id of the board the request was sent to; null when none was selected. A failure that
   * lands after a board switch is told apart by it.
   */
  boardId: string | null;
  /** What the failure came out of. */
  action: SentinelAction;
  title: string;
  /** The backend's hint, else the page's own for the code; '' when there is none. */
  hint: string;
  /** The board's own failure: its settings are the place to fix it. */
  board: boolean;
  /** The daemon is not there to answer. */
  daemon: boolean;
  /** Whether asking again can help; false where the fix lies elsewhere. */
  retryable: boolean;
}

/**
 * One readable failure: a title, the backend's sentence (in `problem`), its hint, and where the fix
 * is. `board` is the id of the board the request was sent to, so a failure that lands after a
 * board switch can be told from the new board's. `action` says what was being asked, since the
 * same codes mean something else for a stop or a delete.
 */
export function failureOf(
  failure: unknown,
  board: string | null,
  action: SentinelAction = 'read',
): SentinelFailure {
  const problem = problemOf(failure);
  const code = problem.code;
  return {
    problem,
    code,
    boardId: board,
    action,
    title: ACTION_TITLES[action]?.[code] || TITLES[code] || FALLBACK_TITLE,
    hint: problem.hint || FALLBACK_HINTS[code] || '',
    board: BOARD_CODES.has(code),
    daemon: DAEMON_CODES.has(code),
    retryable: !NOT_RETRYABLE.has(code),
  };
}

/**
 * An answer Insight could not read: its body lacks what the page needs (a Sentinel build that
 * answers in another shape, or an answer cut short). `message` says what was expected; the title
 * is `bad_response`'s, and asking again may help.
 */
export function unexpectedAnswer(
  message: string,
  board: string | null,
  action: SentinelAction = 'read',
): SentinelFailure {
  return failureOf(new BoardProblem(message, 'bad_response', ''), board, action);
}

/**
 * The command a hint names in backticks, for the user to copy and run on the board ("Install it
 * on the board with `sima-cli neat install sentinel`, then retry."): the first such span; '' when
 * the hint names none.
 */
export function hintCommand(hint: string): string {
  return /`([^`]+)`/.exec(hint)?.[1].trim() ?? '';
}
