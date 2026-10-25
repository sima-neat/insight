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
 * The traces and runs endpoints (`neat_insight/sentinel/api.py`; the shapes are Sentinel's own,
 * `runs.rs` and `api.rs` in its repo) answer the board envelope with Sentinel's body, minus its
 * schema marker, under `sentinel`.
 *
 * `GET /api/metrics` (this computer, not the board) is typed beside System Info, which reads it.
 */

import type { BoardErrorBody, BoardSummary } from '../board/api';

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
  board: BoardSummary;
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
  board: BoardSummary;
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
 * unless `full`: then it replaces the caller's window. The backend answers `full` for a request
 * without `after`, one naming another `epoch`, one whose `after` it no longer holds, and one with
 * more newer samples than its `history` limit. `epoch` names which history it is of; it changes
 * when the history restarts (another board, a daemon restart, a polling gap, a clock step) and when
 * a reseed adds samples before the ones held.
 */
export interface MetricsHistory {
  timestamps: (string | null)[];
  series: Record<string, (number | null)[]>;
  full: boolean;
  epoch: number;
}

/** `GET /api/sentinel/metrics`. */
export interface SentinelMetrics {
  board: BoardSummary;
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

/**
 * A run as the list shows it (`GET /api/sentinel/runs`, and the stop answer's `summary`). It holds
 * no note or tags: those are in the run's metadata. A run still being recorded has a null
 * `ended_at`, and the totals are of the samples taken so far.
 */
export interface RunSummary {
  id: string;
  name: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number;
  samples: number;
  /** The integral of the board power over the run; null when it took no power reading. */
  energy_joules: number | null;
}

/** What Sentinel keeps about a run besides its samples. */
export interface RunMetadata {
  id: string;
  name: string;
  note: string | null;
  tags: string[];
  started_at: string;
  /** Null while the run is being recorded. */
  ended_at: string | null;
  sample_interval_ms: number | null;
  sentinel_version: string;
  /** Facts about the board the run was taken on: `architecture`, `hostname`, `os_release`, ... */
  system: Record<string, string>;
}

/** A metric as a run recorded it: the definition, without a reading or a status. */
export interface RunMetricDefinition {
  key: string;
  label: string;
  short: string;
  description: string | null;
  group: string;
  unit: string | null;
  warn: number | null;
  critical: number | null;
}

/** One reading of every metric the run recorded; a metric not read at that time is null or absent. */
export interface RunSample {
  timestamp: string;
  values: Record<string, number | null>;
}

/** `GET /api/sentinel/runs/<id>`: a run in full. */
export interface SavedRun {
  metadata: RunMetadata;
  metrics: RunMetricDefinition[];
  samples: RunSample[];
}

/** A metric's readings in a run: how many there were and, unless none, their spread. */
export interface RunStatistics {
  count: number;
  minimum: number | null;
  maximum: number | null;
  mean: number | null;
  median: number | null;
  p95: number | null;
}

/** A run's totals in a comparison. */
export interface RunTotals {
  duration_ms: number;
  samples: number;
  energy_joules: number | null;
  metrics: Record<string, RunStatistics>;
}

/**
 * `GET /api/sentinel/compare?raw=1`, keyed by run id. `runs` are full runs (without `raw` they
 * are the metadata only). Each run's `baseline_deltas_pct` is its mean's change against the
 * baseline's, in percent; null where either run has no mean for the metric.
 */
export interface CompareExport {
  baseline_id: string;
  generated_at: string;
  runs: SavedRun[];
  summaries: Record<string, RunTotals>;
  baseline_deltas_pct: Record<string, Record<string, number | null>>;
}

/** The body of `POST /api/sentinel/traces`; the server trims the name and checks every limit. */
export interface TraceRequest {
  name: string;
  note?: string;
  tags?: string[];
}

/** What every traces and runs answer holds besides Sentinel's own body. */
export interface SentinelAnswer<T> {
  board: BoardSummary;
  generation: number;
  sentinel: T;
}

/** `GET /api/sentinel/runs`, and the answer of a delete (see `DeleteAnswer`). */
export type RunsAnswer = SentinelAnswer<{ runs: RunSummary[] }>;

/**
 * The trace being recorded: `GET /api/sentinel/traces` (null when none is, with its summary so
 * far otherwise), the start answer (a `trace`, no summary) and the stop answer (the finished
 * trace with the summary of its run).
 */
export type TraceAnswer = SentinelAnswer<{
  trace: RunMetadata | null;
  summary?: RunSummary | null;
}>;

/** `GET /api/sentinel/runs/<id>`. */
export type RunAnswer = SentinelAnswer<SavedRun>;

/** `DELETE /api/sentinel/runs/<id>`: the run that went and the runs that are left. */
export type DeleteAnswer = RunsAnswer & { deleted: { id: string; name: string } };

/** `GET /api/sentinel/compare?raw=1`. */
export type CompareAnswer = SentinelAnswer<CompareExport>;
