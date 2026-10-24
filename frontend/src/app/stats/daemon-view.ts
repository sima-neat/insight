import { BoardProblem, problemOf } from '../board/board-error';
import type { DaemonState, SentinelHealth, SentinelState } from './api';

/** What the Stats page says about Sentinel's daemon, and whether it can install it. */
export interface DaemonView {
  /** `unknown` before the first answer, and after one that failed. */
  state: DaemonState | 'unknown';
  label: string;
  /** Sentinel answered its health: telemetry can be read. */
  available: boolean;
  version: string | null;
  /** ISO time the daemon started; null while it is not running. */
  startedAt: string | null;
  /** Where `sima-cli` is on the board; null when it is not there. */
  simaCli: string | null;
  /** Whether this page offers the install: a missing daemon and a `sima-cli` to install it with. */
  canInstall: boolean;
  /** Why the install is not on offer, when it is not; '' when it is, or when there is nothing to say. */
  installBlocked: string;
  /** Why the daemon is in this state, as the board's UI reads it. */
  error: BoardProblem | null;
}

const LABELS: Record<DaemonState, string> = {
  ready: 'Running',
  missing: 'Not installed',
  stopped: 'Installed but stopped',
  error: 'Not answering',
};

/**
 * What `GET /api/sentinel` says about the daemon, in the page's words. A stopped or failing daemon
 * is not installed over: the installer restarts the daemon and would end a trace in flight, and the
 * state's own hint says how to start it. `null` is no answer yet.
 */
export function daemonView(state: SentinelState | null): DaemonView {
  const daemon = state?.daemon ?? null;
  const simaCli = daemon?.sima_cli ?? null;
  const status = state?.status ?? null;
  return {
    state: status?.state ?? 'unknown',
    label: status ? LABELS[status.state] : 'Unknown',
    available: state?.available ?? false,
    version: state?.version ?? null,
    startedAt: daemon?.started_at ?? null,
    simaCli,
    canInstall: status?.state === 'missing' && simaCli !== null,
    installBlocked: installBlocked(state),
    error: status?.error ? problemOf(status.error) : null,
  };
}

function installBlocked(state: SentinelState | null): string {
  if (!state) return 'Sentinel state is unknown; reload before installing.';
  if (state.daemon.healthy) {
    return 'Sentinel is already running. Reinstalling would restart it and end a trace in flight.';
  }
  return state.daemon.sima_cli
    ? ''
    : 'sima-cli was not found on the board, so Insight cannot install Sentinel from here.';
}

/** The collector failures the daemon itself reports: strings or objects with a message. */
export function healthProblems(health: SentinelHealth | null): string[] {
  return (health?.errors ?? [])
    .map((item) => (typeof item === 'string' ? item : item?.error || item?.message || ''))
    .filter(Boolean);
}
