// Stats fixtures for specs and for Playwright: Sentinel's cache as a Modalix DevKit answered it,
// typed as the API's shapes, a window of history over it, and Sentinel's health. It imports only
// types and the JSON fixture, with no vitest globals and no Angular, so Playwright can load it too.
import cacheLive from '../../../../tests/fixtures/sentinel/cache-live.json';
import type { MetricDefinition, SentinelCache, SentinelHealthAnswer, SentinelSample } from './api';

/**
 * What `GET .../sentinel/cache` answered on a Modalix DevKit (59 metrics, 2026-09-24), reduced to
 * its newest sample. The capture has no descriptions.
 */
export const CACHE_LIVE: SentinelCache = cacheLive;

/** The capture's 59 metric definitions, in Sentinel's order. */
export const LIVE_METRICS: readonly MetricDefinition[] = CACHE_LIVE.metrics ?? [];

/** The capture's readings, by key. */
export const LIVE_VALUES: Readonly<Record<string, number | null>> = CACHE_LIVE.samples[0].values;

/** The capture's newest sample's time. */
export const LIVE_SAMPLED_AT: string = CACHE_LIVE.samples[0].timestamp;

export interface HistoryOptions {
  /** The first sample's time. */
  start?: string;
  /** Milliseconds between samples; Sentinel samples every 2 s. */
  stepMs?: number;
  /** Whether the answer replaces what the page holds; true by default. */
  full?: boolean;
  /** The definitions the answer carries; the capture's by default. */
  metrics?: readonly MetricDefinition[];
  /**
   * The reading of a metric at sample `i`, `null` for one not taken, `undefined` for one the
   * sample leaves out. Flat at its captured reading by default.
   */
  values?: (key: string, i: number) => number | null | undefined;
}

/**
 * A cache answer with `samples` samples of every defined metric, from `start` on. A window that
 * continues another starts after the other's newest.
 */
export function cacheWith(
  samples: number,
  {
    start = '2026-10-24T10:00:00Z',
    stepMs = 2000,
    full = true,
    metrics = LIVE_METRICS,
    values = (key) => LIVE_VALUES[key] ?? null,
  }: HistoryOptions = {},
): SentinelCache {
  const first = Date.parse(start);
  const taken: SentinelSample[] = Array.from({ length: samples }, (_, i) => {
    const readings: Record<string, number | null> = {};
    for (const { key } of metrics) {
      const value = values(key, i);
      if (value !== undefined) readings[key] = value;
    }
    return { timestamp: new Date(first + i * stepMs).toISOString(), values: readings };
  });
  return { version: CACHE_LIVE.version, metrics: [...metrics], samples: taken, errors: [], full };
}

/** An incremental answer (`full` false): `samples` samples from `start` on. */
export function nextSamples(
  samples: number,
  start: string,
  options: HistoryOptions = {},
): SentinelCache {
  return cacheWith(samples, { ...options, start, full: false });
}

/** A running Sentinel's health, unless `overrides` say otherwise. */
export function sentinelHealth(
  overrides: Partial<SentinelHealthAnswer['health']> = {},
  startedAt: string | null = '2026-10-24T09:30:00Z',
): SentinelHealthAnswer {
  return {
    health: {
      version: 'main:80ab7de4da31',
      cached_samples: 240,
      metric_count: LIVE_METRICS.length,
      errors: [],
      latest_sample_at: LIVE_SAMPLED_AT,
      updated_at: LIVE_SAMPLED_AT,
      active_trace: null,
      ...overrides,
    },
    started_at: startedAt,
  };
}

/**
 * The error body of a Sentinel failure as the server answers it: `sentinel_missing` with the
 * command that installs it in the hint, by default.
 */
export function sentinelError(
  code = 'sentinel_missing',
  message = 'Sentinel is not installed on sima@192.168.1.20.',
  hint = 'Install it on the board with `sima-cli neat install sentinel`, then retry.',
): { error: { code: string; message: string; hint: string } } {
  return { error: { code, message, hint } };
}
