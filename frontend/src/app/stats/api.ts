/**
 * Response shapes of Flask's `/api/sentinel*` endpoints that the Stats page reads: the daemon
 * state, the install and the metrics (Inv-S §7.1 to §7.3; `neat_insight/sentinel/api.py`,
 * `install.py` and `metrics.py`). Types only: `SentinelTelemetry` and `SentinelInstall` call the
 * endpoints.
 *
 * A failed request answers a board error body (`BoardErrorBody` in `board/api.ts`), which
 * `failureOf` in `sentinel-failure.ts` reads. Besides the board's codes these endpoints add
 * `sentinel_missing`, `sentinel_stopped`, `sentinel_denied`, `sentinel_schema`, `sentinel_failed`,
 * `already_installed`, `invalid_request`, `request_too_large`, `response_too_large` and
 * `stale_snapshot`, and every body carries the `generation` it was answered under.
 *
 * `GET /api/metrics` (this computer, not the board) is typed beside System Info, which reads it.
 */

import type { BoardErrorBody, BoardSource } from '../board/api';

/**
 * The board an answer describes (`board_summary` in `neat_insight/board/manager.py`). The identity
 * is null until a connection read it.
 */
export interface SentinelBoard {
  label: string;
  source: BoardSource;
  hostname: string | null;
  machine: string | null;
  build_version: string | null;
  fingerprint: string | null;
}

/**
 * What the board's service manager says about Sentinel. `missing` is not installed, `stopped` is
 * installed but not running, and `error` is a daemon that is up but does not answer (or whose
 * socket is gone).
 */
export type DaemonState = 'ready' | 'missing' | 'stopped' | 'error';

/** The daemon as the board's status script reads it (`install.status`). */
export interface SentinelDaemon {
  installed: boolean;
  /** Running with its API socket present. */
  healthy: boolean;
  /** The systemd state: `active`, `inactive`, `failed`, ... or `unknown`. */
  service: string;
  socket: boolean;
  socket_path: string;
  /** Where `sima-cli` is on the board; null when it is not there, and Insight cannot install. */
  sima_cli: string | null;
  /** systemd's id for the daemon's current run; null while it is not active. */
  instance_id: string | null;
  /** ISO time the daemon started, on Insight's clock; null while it is not active. */
  started_at: string | null;
}

/**
 * Sentinel's own health body, as it sends it (minus its schema marker). `errors` are the daemon's
 * collector failures, as strings or as objects with an `error` or a `message`.
 */
export interface SentinelHealth {
  version: string | null;
  cached_samples: number;
  metric_count: number;
  errors: (string | { error?: string; message?: string } | null)[];
  latest_sample_at: string | null;
  updated_at: string | null;
  /** The trace being recorded, if any; the traces endpoint reads it in full. */
  active_trace: Record<string, unknown> | null;
}

/** `GET /api/sentinel`. */
export interface SentinelState {
  board: SentinelBoard;
  generation: number;
  /** Health answered with a schema Insight understands. */
  available: boolean;
  /** The schema Insight understands. */
  schema: number;
  version: string | null;
  status: { state: DaemonState; error: BoardErrorBody | null };
  daemon: SentinelDaemon;
  health: SentinelHealth | null;
}

/** `POST /api/sentinel/install`: the daemon as it is afterwards, and the installer's output. */
export interface SentinelInstallResult {
  board: SentinelBoard;
  generation: number;
  daemon: SentinelDaemon;
  log: string;
}

/** `unavailable` is a metric the board did not measure, which is never "ok" and never zero. */
export type MetricStatus = 'ok' | 'warn' | 'critical' | 'unavailable';

/**
 * One metric: Sentinel's definition joined with its latest value. `unit` is Sentinel's spelling
 * (`C`, `%`, `W`, `MB`, `MB/s`, `load`), absent for a plain number; the thresholds are null where
 * Sentinel defines none. `value` is null when the board did not measure it.
 */
export interface SentinelMetric {
  key: string;
  label: string;
  short: string;
  unit: string | null;
  description: string | null;
  group: string;
  warn: number | null;
  critical: number | null;
  value: number | null;
  status: MetricStatus;
}

/**
 * Sentinel's recent samples, aligned: `series[key][i]` was measured at `timestamps[i]`, `null`
 * where it was not (a `null` timestamp is a sample without a time).
 *
 * With `after` and `epoch` in the request the answer holds only the samples newer than `after`,
 * unless `full`: then it replaces the caller's window. `epoch` names which history it is of; it
 * changes when the board's daemon restarts or the board is switched.
 */
export interface MetricsHistory {
  timestamps: (string | null)[];
  series: Record<string, (number | null)[]>;
  full: boolean;
  epoch: number;
}

/** `GET /api/sentinel/metrics`. */
export interface SentinelMetrics {
  board: SentinelBoard;
  generation: number;
  /** The newest sample's timestamp; null before the daemon took one. */
  sampled_at: string | null;
  version: string | null;
  counts: { total: number; unavailable: number; warn: number; critical: number };
  /** The keys the page leads with. */
  highlights: string[];
  /** Sorted by group name. */
  groups: { name: string; metrics: SentinelMetric[] }[];
  /** Every key in Sentinel's own order, which its ops view lists in. */
  order: string[];
  history: MetricsHistory;
}

/**
 * The query of `GET /api/sentinel/metrics`: the window to hold (at most 240 samples) and, once
 * the caller holds some, the newest timestamp and the epoch they are of, so the answer holds only
 * what is newer.
 */
export interface MetricsQuery {
  history: number;
  after?: string;
  epoch?: number;
}
