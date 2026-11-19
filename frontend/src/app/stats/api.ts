/**
 * The bodies of the board's Sentinel routes (`/api/boards/<id>/sentinel/...`) that the Stats page
 * reads. Insight passes Sentinel's answers through as Sentinel gives them, without its schema
 * marker, so most of these are Sentinel's own shapes (its public API), typed here as far as the
 * page reads them: the generated `SentinelBody` is an open object. Types only:
 * `SentinelTelemetry`, `SentinelRuns` and the Compare view call the routes.
 *
 * A failed request answers the error shape (with a board's `host_key` or `command`), which
 * `failureOf` in `sentinel-failure.ts` reads. A missing daemon is an error too: 502
 * `sentinel_missing` (not installed; the hint holds the command that installs it),
 * `sentinel_stopped`, `sentinel_denied`, `sentinel_schema`, `sentinel_outdated` or
 * `sentinel_failed`.
 */

export type { RunDeleted, TraceRequest } from '../api.generated';

/**
 * Sentinel's own health (`/v1/health`). `errors` are the daemon's collector failures, as strings
 * or as objects with an `error` or a `message`.
 */
export interface SentinelHealthBody {
  version?: string | null;
  cached_samples?: number;
  metric_count?: number;
  errors?: (string | { error?: string; message?: string } | null)[];
  latest_sample_at?: string | null;
  updated_at?: string | null;
  /** The trace being recorded, if any; the traces route reads it in full. */
  active_trace?: Record<string, unknown> | null;
}

/** `GET .../sentinel/health`: Sentinel's health and when its service started, on Insight's clock. */
export interface SentinelHealthAnswer {
  health: SentinelHealthBody;
  /** Null when the board's service manager does not say. */
  started_at: string | null;
}

/**
 * One of Sentinel's metric definitions (`/v1/metrics`, and the cache's `metrics`). `unit` is
 * Sentinel's spelling (`C`, `%`, `W`, `MB`, `MB/s`, `load`); the thresholds are null where
 * Sentinel defines none. Any field but `key` may be missing.
 */
export interface MetricDefinition {
  key: string;
  label?: string | null;
  short?: string | null;
  unit?: string | null;
  description?: string | null;
  group?: string | null;
  warn?: number | null;
  critical?: number | null;
}

/** One of Sentinel's samples: every metric it read at `timestamp`, null for one it could not. */
export interface SentinelSample {
  timestamp: string;
  values: Record<string, number | null>;
}

/**
 * `GET .../sentinel/cache`, the Live view's one read: Sentinel's `/v1/cache` (its definitions, its
 * recent samples oldest first, at most 240, and its collector `errors`) with `full`. Asked with
 * `after` (the newest sample the page holds), it holds only the newer samples and `full` is false;
 * `full` true means its samples replace what the page holds (no `after`, a daemon that restarted,
 * a page that fell too far behind, a board clock that stepped back).
 */
export interface SentinelCache {
  version?: string | null;
  metrics?: MetricDefinition[];
  samples: SentinelSample[];
  errors?: unknown[];
  full: boolean;
}

/** `unavailable` is a metric the board did not measure, which is never "ok" and never zero. */
export type MetricStatus = 'ok' | 'warn' | 'critical' | 'unavailable';

/**
 * One metric as the page shows it: Sentinel's definition, with the fallbacks a definition lacks
 * (`metrics.ts`), joined with its newest reading and that reading's status. `value` is null when
 * the board did not measure it.
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
 * A run as the list shows it (`GET .../sentinel/runs`, and the stop answer's `summary`). It holds
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

/**
 * A metric as a run recorded it: the definition, without a reading or a status. Sentinel stores
 * `unit` and `description` as plain strings, so a metric with neither has "" (the live metrics
 * use null for none).
 */
export interface RunMetricDefinition {
  key: string;
  label: string;
  short: string;
  description: string;
  group: string;
  unit: string;
  warn: number | null;
  critical: number | null;
}

/** One reading of every metric the run recorded; a metric not read at that time is null or absent. */
export interface RunSample {
  timestamp: string;
  values: Record<string, number | null>;
}

/** `GET .../sentinel/runs/<id>`: a run in full. */
export interface SavedRun {
  /** Sentinel's file format; the run route drops it, a raw comparison's runs keep it. */
  schema?: number;
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
 * `GET .../sentinel/compare`, keyed by run id. `runs` are full runs, their samples included. Each
 * run's `baseline_deltas_pct` is its mean's change against the baseline's, in percent; null where
 * either run has no mean for the metric.
 */
export interface CompareExport {
  baseline_id: string;
  generated_at: string;
  runs: SavedRun[];
  summaries: Record<string, RunTotals>;
  baseline_deltas_pct: Record<string, Record<string, number | null>>;
}

/** `GET .../sentinel/runs`, and the `runs` of a delete's answer. */
export interface RunsBody {
  runs: RunSummary[];
}

/**
 * The trace being recorded: `GET .../sentinel/traces/active` (both null when none is, with its
 * summary so far otherwise), the start answer (a `trace`, no summary) and the stop answer (the
 * finished trace with the summary of its run).
 */
export interface TraceBody {
  trace: RunMetadata | null;
  summary?: RunSummary | null;
}

/** `DELETE .../sentinel/runs/<id>`: the run that went and the runs that are left. */
export interface DeleteAnswer {
  deleted: { id: string; name: string };
  runs: RunsBody;
}
