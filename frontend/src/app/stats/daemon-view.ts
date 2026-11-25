import type { SentinelHealthBody } from './api';
import { hintCommand, type SentinelFailure } from './sentinel-failure';

/**
 * Sentinel answering on a board: its health as the last good read of
 * `GET .../sentinel/health` gave it, for the board of `board` (its id), and when its service
 * started (null when the board's service manager does not say).
 */
export interface SentinelReading {
  board: string;
  health: SentinelHealthBody;
  startedAt: string | null;
}

/**
 * Whether Sentinel answers on the board: `ready`, else why not. `missing` is not installed,
 * `stopped` is installed but not running, and `error` is any other failure (a daemon that does not
 * answer, refuses the user or speaks another API).
 */
export type DaemonState = 'ready' | 'missing' | 'stopped' | 'error';

/** What the Stats page says about Sentinel's daemon. */
export interface DaemonView {
  /** `unknown` before the first answer, and after one that failed without saying why. */
  state: DaemonState | 'unknown';
  label: string;
  version: string | null;
  /** ISO time the daemon started; null while it is not running or the board does not say. */
  startedAt: string | null;
  /**
   * The command the failure's hint gives to run on the board (the one that installs Sentinel, or
   * starts its service), for the user to copy; '' when there is none.
   */
  command: string;
}

const LABELS: Record<DaemonState, string> = {
  ready: 'Running',
  missing: 'Not installed',
  stopped: 'Installed but stopped',
  error: 'Not answering',
};

const STATES: Record<string, DaemonState> = {
  sentinel_missing: 'missing',
  sentinel_stopped: 'stopped',
};

/**
 * The daemon in the page's words, from the newest health read: `reading` when it answered,
 * `failure` when it failed. A reading kept beside a later failure that does not say Sentinel is
 * gone (a lost connection) still counts as ready. Insight installs nothing and starts nothing: a
 * missing or stopped daemon comes with the command its hint names, which the user runs on the
 * board.
 */
export function daemonView(
  reading: SentinelReading | null,
  failure: SentinelFailure | null,
): DaemonView {
  if (reading) {
    return {
      state: 'ready',
      label: LABELS.ready,
      version: reading.health.version ?? null,
      startedAt: reading.startedAt,
      command: '',
    };
  }
  if (!failure) {
    return { state: 'unknown', label: 'Unknown', version: null, startedAt: null, command: '' };
  }
  const state = STATES[failure.code] ?? 'error';
  return {
    state,
    label: LABELS[state],
    version: null,
    startedAt: null,
    command: state === 'error' ? '' : hintCommand(failure.hint),
  };
}

/** The collector failures the daemon itself reports: strings or objects with a message. */
export function healthProblems(health: SentinelHealthBody | null): string[] {
  return (health?.errors ?? [])
    .map((item) => (typeof item === 'string' ? item : item?.error || item?.message || ''))
    .filter(Boolean);
}
