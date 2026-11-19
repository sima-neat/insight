// Windows for the area specs: the live Modalix board with a window of history, then changed.
import { DEVKIT } from '../../board/board.testing';
import type { SentinelMetric } from '../../stats/api';
import { cacheWith, type HistoryOptions } from '../../stats/stats.testing';
import { mergeTelemetry, type TelemetryWindow } from '../../stats/telemetry';

/** The live board's 59 metrics with `samples` samples of history, every metric flat at its reading. */
export function liveWindow(samples = 20, options?: HistoryOptions): TelemetryWindow {
  return mergeTelemetry(null, cacheWith(samples, options), DEVKIT.id);
}

/** `window` with each metric `change` returns something for replaced by that. */
export function withMetrics(
  window: TelemetryWindow,
  change: (metric: SentinelMetric) => Partial<SentinelMetric> | undefined,
): TelemetryWindow {
  return {
    ...window,
    metrics: window.metrics.map((metric) => ({ ...metric, ...change(metric) })),
  };
}

/** `window` with the metrics `drop` names left out, as a board that does not report them. */
export function without(
  window: TelemetryWindow,
  drop: (metric: SentinelMetric) => boolean,
): TelemetryWindow {
  const metrics = window.metrics.filter((metric) => !drop(metric));
  return {
    ...window,
    metrics,
    series: Object.fromEntries(metrics.map((metric) => [metric.key, window.series[metric.key]])),
  };
}

/** `window` with one more metric, and `values` as its history. */
export function withExtra(
  window: TelemetryWindow,
  metric: SentinelMetric,
  values: (number | null)[],
): TelemetryWindow {
  return {
    ...window,
    metrics: [...window.metrics, metric],
    series: { ...window.series, [metric.key]: values },
  };
}

/** `window` with these metrics' history replaced. */
export function withSeries(
  window: TelemetryWindow,
  series: Record<string, (number | null)[]>,
): TelemetryWindow {
  return { ...window, series: { ...window.series, ...series } };
}
