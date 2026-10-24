// Stats fixtures for specs and for Playwright: #170's captured Modalix answer typed as the API's
// shapes, a window of history over it, and a daemon state. It imports only types and the JSON
// fixture, with no vitest globals and no Angular, so Playwright can load it too.
import metricsLive from '../../../../tests/fixtures/sentinel/metrics-live.json';
import type { MetricStatus, SentinelBoard, SentinelMetrics, SentinelState } from './api';

const liveMetrics = metricsLive.groups.flatMap((group) => group.metrics);

/**
 * What `GET /api/sentinel/metrics` returned on a Modalix DevKit (59 metrics, 2026-09-24), in the
 * API's shape. The capture has no descriptions and no `order`, so the descriptions are null and
 * the order is the groups' own; its history is empty, as an answer to `history=0` is.
 */
export const METRICS_LIVE: SentinelMetrics = {
  board: metricsLive.board as SentinelBoard,
  generation: metricsLive.generation,
  sampled_at: metricsLive.sampled_at,
  version: metricsLive.version,
  counts: metricsLive.counts,
  highlights: metricsLive.highlights,
  groups: metricsLive.groups.map((group) => ({
    name: group.name,
    metrics: group.metrics.map((metric) => ({
      ...metric,
      description: null,
      status: metric.status as MetricStatus,
    })),
  })),
  order: liveMetrics.map((metric) => metric.key),
  history: { timestamps: [], series: {}, full: true, epoch: 1 },
};

export interface HistoryOptions {
  /** The first sample's time. */
  start?: string;
  /** Milliseconds between samples; Sentinel samples every 2 s. */
  stepMs?: number;
  full?: boolean;
  epoch?: number;
  /** The reading of a metric at sample `i`, `null` for one not taken. Flat at its current value by default. */
  values?: (key: string, i: number) => number | null;
}

/**
 * `metrics` with `samples` samples of history for every metric in `order`, the newest at the
 * time `sampled_at` names. `start` is the first one's time, so a window that continues another
 * starts after the other's newest.
 */
export function withHistory(
  metrics: SentinelMetrics,
  samples: number,
  {
    start = '2026-10-24T10:00:00Z',
    stepMs = 2000,
    full = true,
    epoch = 1,
    values = (key) => current(metrics, key),
  }: HistoryOptions = {},
): SentinelMetrics {
  const first = Date.parse(start);
  const timestamps = Array.from({ length: samples }, (_, i) =>
    new Date(first + i * stepMs).toISOString(),
  );
  const series: Record<string, (number | null)[]> = {};
  for (const key of metrics.order) {
    series[key] = Array.from({ length: samples }, (_, i) => values(key, i));
  }
  return {
    ...metrics,
    sampled_at: timestamps.at(-1) ?? metrics.sampled_at,
    history: { timestamps, series, full, epoch },
  };
}

function current(metrics: SentinelMetrics, key: string): number | null {
  for (const group of metrics.groups) {
    const metric = group.metrics.find((candidate) => candidate.key === key);
    if (metric) return metric.value;
  }
  return null;
}

/** A running Sentinel on the board of `METRICS_LIVE`, unless `overrides` say otherwise. */
export function sentinelState(overrides: Partial<SentinelState> = {}): SentinelState {
  return {
    board: METRICS_LIVE.board,
    generation: METRICS_LIVE.generation,
    available: true,
    schema: 1,
    version: 'main:80ab7de4da31',
    status: { state: 'ready', error: null },
    daemon: {
      installed: true,
      healthy: true,
      service: 'active',
      socket: true,
      socket_path: '/run/simaai-sentinel/api.sock',
      sima_cli: '/usr/bin/sima-cli',
      instance_id: 'f3c1a9e0b27d4c5e8a61',
      started_at: '2026-10-24T09:30:00+00:00',
    },
    health: {
      version: 'main:80ab7de4da31',
      cached_samples: 240,
      metric_count: METRICS_LIVE.counts.total,
      errors: [],
      latest_sample_at: METRICS_LIVE.sampled_at,
      updated_at: METRICS_LIVE.sampled_at,
      active_trace: null,
    },
    ...overrides,
  };
}
