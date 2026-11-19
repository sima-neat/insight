/**
 * Sentinel's metric definitions joined with its readings, as the Stats page shows them: the joining
 * the page does itself, since Insight passes Sentinel's answers through as they are. Definitions
 * carry the label, unit, group and thresholds and a sample carries values only; joined, nothing is
 * shown as a bare key, and a metric the board did not measure is null with the status
 * `unavailable`, never zero, which would read as a real measurement.
 */
import type { MetricDefinition, MetricStatus, SentinelMetric } from './api';
import { isNumber } from './format';

/** The group of a metric whose definition names none. */
export const OTHER_GROUP = 'Other';

/** How a value ranks against its thresholds; an unmeasured value is never "ok". */
export function metricStatus(
  value: number | null | undefined,
  warn: number | null | undefined,
  critical: number | null | undefined,
): MetricStatus {
  if (!isNumber(value)) return 'unavailable';
  if (isNumber(critical) && value >= critical) return 'critical';
  return isNumber(warn) && value >= warn ? 'warn' : 'ok';
}

/** A key as words, for a metric without a label: `npu_temp_c` is "Npu temp c". */
function keyLabel(key: string): string {
  const text = key.replace(/_/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const threshold = (value: unknown): number | null => (isNumber(value) ? value : null);

/** The definitions Sentinel sent that name a key; anything else in the list is left out. */
export function definitionsOf(metrics: unknown): MetricDefinition[] {
  if (!Array.isArray(metrics)) return [];
  return metrics.filter(
    (definition): definition is MetricDefinition =>
      typeof definition === 'object' &&
      definition !== null &&
      typeof (definition as { key?: unknown }).key === 'string' &&
      (definition as { key: string }).key !== '',
  );
}

/** One metric from its definition (or only its key) and its reading. */
export function joinMetric(definition: MetricDefinition, value: number | null): SentinelMetric {
  const { key } = definition;
  const label = text(definition.label) ?? keyLabel(key);
  const warn = threshold(definition.warn);
  const critical = threshold(definition.critical);
  return {
    key,
    label,
    short: text(definition.short) ?? label,
    unit: text(definition.unit),
    description: text(definition.description),
    group: text(definition.group) ?? OTHER_GROUP,
    warn,
    critical,
    value,
    status: metricStatus(value, warn, critical),
  };
}

/**
 * Every metric to show, in Sentinel's order (which its own ops view lists in: sensors of one group
 * are not adjacent), then the keys `sampled` holds without a definition, sorted: a board can
 * report a value Insight has no definition for, which is shown rather than dropped. `valueOf`
 * gives each key's newest reading.
 */
export function joinMetrics(
  definitions: readonly MetricDefinition[],
  sampled: Iterable<string>,
  valueOf: (key: string) => number | null,
): SentinelMetric[] {
  const defined = new Set<string>();
  const metrics: SentinelMetric[] = [];
  for (const definition of definitions) {
    if (defined.has(definition.key)) continue;
    defined.add(definition.key);
    metrics.push(joinMetric(definition, valueOf(definition.key)));
  }
  const extra = [...new Set(sampled)].filter((key) => !defined.has(key)).sort();
  return [...metrics, ...extra.map((key) => joinMetric({ key }, valueOf(key)))];
}
