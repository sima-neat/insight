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

/**
 * The page's own titles, for the codes whose message can be Sentinel's own text or a technical
 * detail (a socket path, a Go error) that needs a plain heading over it. Every other failure is
 * headed by the backend's message, which is a sentence of its own.
 */
const TITLES: Record<string, string> = {
  unreachable: 'The board could not be reached',
  timeout: 'The board took too long to answer',
  sentinel_missing: 'Sentinel is not installed on this board',
  sentinel_outdated: 'Sentinel on the board is older than Insight',
  sentinel_failed: 'Sentinel could not answer',
  sentinel_busy: 'Sentinel is busy',
  invalid_request: 'The request was rejected',
  request_too_large: 'The request was too large',
  bad_response: 'Insight answered something unexpected',
};

/**
 * What a Sentinel request was for. A read is the default; the rest change something on the board,
 * and the same codes mean something else for them.
 */
export type SentinelAction = 'read' | 'start' | 'stop' | 'delete';

/**
 * `trace_conflict` is the one code three requests answer for different reasons, with Sentinel's
 * own text for a start and a stop: starting while a trace runs or a name is taken, and stopping a
 * trace that is no longer the one shown. Deleting a run still being recorded says so in its
 * message.
 */
const ACTION_TITLES: Partial<Record<SentinelAction, Record<string, string>>> = {
  start: { trace_conflict: 'That trace cannot start' },
  stop: { trace_conflict: 'The trace changed before it was stopped' },
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
  /** The failure's heading: the page's own title for the code, else the backend's message. */
  title: string;
  /** The backend's message when the title is the page's own; '' when the title is the message. */
  detail: string;
  /** The backend's hint; '' when there is none. */
  hint: string;
  /** The board's own failure: its settings are the place to fix it. */
  board: boolean;
  /** The daemon is not there to answer. */
  daemon: boolean;
  /** Whether asking again can help; false where the fix lies elsewhere. */
  retryable: boolean;
}

/**
 * One readable failure: a title, the backend's sentence (in `problem`) where the title is not it,
 * its hint, and where the fix is. `board` is the id of the board the request was sent to, so a
 * failure that lands after a board switch can be told from the new board's. `action` says what
 * was being asked, since the same codes mean something else for a start or a stop.
 */
export function failureOf(
  failure: unknown,
  board: string | null,
  action: SentinelAction = 'read',
): SentinelFailure {
  const problem = problemOf(failure);
  const code = problem.code;
  const title = ACTION_TITLES[action]?.[code] ?? TITLES[code];
  return {
    problem,
    code,
    boardId: board,
    action,
    title: title ?? problem.message,
    detail: title === undefined ? '' : problem.message,
    hint: problem.hint,
    board: BOARD_CODES.has(code),
    daemon: DAEMON_CODES.has(code),
    retryable: !NOT_RETRYABLE.has(code),
  };
}

/**
 * An answer Insight could not read: its body lacks what the page needs (a Sentinel build that
 * answers in another shape, or an answer cut short). `message` says what was expected, under
 * `bad_response`'s title, and asking again may help.
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
