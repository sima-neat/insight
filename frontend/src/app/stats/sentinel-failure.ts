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
 * Whether a failure with this code says the board or the daemon cannot answer: the next poll would
 * fail the same way, so polling stops until the state is read again.
 */
export function haltsPolling(code: string): boolean {
  return BOARD_CODES.has(code) || DAEMON_CODES.has(code);
}

/**
 * The codes whose fix lies elsewhere than in asking again: the board's settings (`no_target`,
 * `auth_failed`, `host_key_changed`), Sentinel's installation (`sentinel_missing`,
 * `sentinel_denied`) or its version (`sentinel_schema`).
 */
const NOT_RETRYABLE: ReadonlySet<string> = new Set([
  'no_target',
  'auth_failed',
  'host_key_changed',
  'sentinel_missing',
  'sentinel_denied',
  'sentinel_schema',
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
  sentinel_missing: 'Sentinel is not running on this board',
  sentinel_stopped: 'The Sentinel service is stopped',
  sentinel_denied: 'Sentinel refused this user',
  sentinel_schema: 'Sentinel and Insight speak different API versions',
  sentinel_failed: 'Sentinel could not answer',
  already_installed: 'Sentinel is already installed',
  trace_conflict: 'That trace cannot start',
  not_found: 'That run is not on this board',
  invalid_request: 'The request was rejected',
  request_too_large: 'The request was too large',
  response_too_large: 'Sentinel answered with more than Insight reads',
  network: 'Insight is not answering',
  bad_response: 'Insight answered something unexpected',
};
const FALLBACK_TITLE = 'Something went wrong';

/**
 * What the backend's own hint is missing. The board's settings are the board pill in the top bar,
 * where #170 pointed at a "Board panel above".
 */
const FALLBACK_HINTS: Record<string, string> = {
  no_target: 'Choose a board with the board pill in the top bar.',
  unreachable: 'Fix the connection from the board pill in the top bar, then retry.',
  auth_failed: 'Fix the connection from the board pill in the top bar, then retry.',
  host_key_changed:
    'Confirm the fingerprint in the board dialog, from the board pill in the top bar, before trusting the new key.',
  timeout: 'Check the board is awake and on the network, then retry.',
  sentinel_missing: 'Install Sentinel from this page, or start it on the board.',
  sentinel_stopped: 'Start it on the board with `sudo systemctl start simaai-sentinel`.',
  sentinel_failed: 'Check `systemctl status simaai-sentinel` on the board.',
};

/**
 * The same codes mean something else when they come back from POST /api/sentinel/install. Nothing
 * was being read there, so "Sentinel could not answer" is not what failed and not where the fix
 * is: `sentinel_failed` is how the backend reports a missing `sima-cli`, an installer that exited
 * non-zero, and an installer that finished with the service still down; `sentinel_denied` is how
 * it reports that the board's user has no passwordless sudo; and a `timeout` is the 15-minute
 * installer budget, not an unresponsive board.
 */
const INSTALL_TITLES: Record<string, string> = {
  sentinel_failed: 'Sentinel could not be installed',
  sentinel_denied: 'Installing Sentinel needs sudo on the board',
  timeout: 'The installer did not finish in time',
};

const INSTALL_HINTS: Record<string, string> = {
  timeout: 'Run the install in a shell on the board, where it can take as long as it needs.',
  sentinel_failed: 'Check the installer output below, or run the install in a shell on the board.',
};

/** What a Sentinel request failed with: what the page says about it, and where the fix is. */
export interface SentinelFailure {
  /** The failure as the board's UI reads it, with the whole error body in `details`. */
  problem: BoardProblem;
  code: string;
  /**
   * The board generation the failure belongs to: the one the backend answered under when it names
   * one, else the one the request was sent to. Null when neither is known. A failure that lands
   * after a board switch is told apart by it.
   */
  generation: number | null;
  /** What the failure came out of, so the page can label the output attached to it. */
  action: 'read' | 'install';
  title: string;
  /** The backend's hint, else the page's own for the code; '' when there is none. */
  hint: string;
  /** The installer's output tail, or whatever else the backend attached; '' when none. */
  detail: string;
  /** The board's own failure: its settings are the place to fix it. */
  board: boolean;
  /** The daemon is not there to answer. */
  daemon: boolean;
  /** Whether asking again can help; false where the fix lies elsewhere. */
  retryable: boolean;
}

/**
 * One readable failure: a title, the backend's sentence (in `problem`), its hint, and where the fix
 * is. `generation` is the board generation the request was issued under, so a failure that lands
 * after a board switch can be told from the new board's. `action` says what was being asked, since
 * the same codes mean something else for an install.
 */
export function failureOf(
  failure: unknown,
  generation: number | null,
  action: 'read' | 'install' = 'read',
): SentinelFailure {
  const problem = problemOf(failure);
  const code = problem.code;
  const installing = action === 'install';
  const answered = problem.details['generation'];
  const detail = problem.details['detail'];
  return {
    problem,
    code,
    generation: Number.isInteger(answered) ? (answered as number) : generation,
    action,
    title: (installing && INSTALL_TITLES[code]) || TITLES[code] || FALLBACK_TITLE,
    hint: problem.hint || (installing && INSTALL_HINTS[code]) || FALLBACK_HINTS[code] || '',
    detail: typeof detail === 'string' ? detail : '',
    board: BOARD_CODES.has(code),
    daemon: DAEMON_CODES.has(code),
    retryable: !NOT_RETRYABLE.has(code),
  };
}
