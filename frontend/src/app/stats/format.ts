import type { NeatTone } from '@sima/neat-ui';
// Types only, so that System Info, which uses `formatBytes`, does not load the charts entry.
import type { NeatChartTone, NeatThreshold } from '@sima/neat-ui/charts';
import type { MetricStatus, SentinelMetric } from './api';

/** The parts of a metric these helpers read; a partial one, as a spec or a caller may hold. */
type MetricFacts = Partial<Pick<SentinelMetric, 'key' | 'label' | 'unit' | 'group'>>;

/** A reading, as opposed to one the board did not take (null) or one that is not a number. */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A number to two digits below 10, one below 100 and none from 100, without trailing zeros:
 * "7.13", "95.5", "1235". '' for anything but a number.
 */
export function formatNumber(value: number | null | undefined): string {
  if (!isNumber(value)) return '';
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return String(Number(value.toFixed(digits)));
}

/**
 * A unit as Sentinel spells it, as it reads after a number: `C` is "°C", and a load average is a
 * plain number, since "6.01 load" reads as a typo.
 */
export function unitSuffix(unit: string | null | undefined): string {
  const text = (unit ?? '').trim();
  if (text === 'C' || text === 'celsius') return '°C';
  return text === 'load' ? '' : text;
}

/** A unit as it follows a number: "°C", "%" with no space before it, else " W". */
export function unitAfter(unit: string | null | undefined): string {
  const suffix = unitSuffix(unit);
  if (!suffix) return '';
  return suffix === '%' ? '%' : ` ${suffix}`;
}

/** A value with its unit and as many digits as it needs. A reading not taken is an em dash, never zero. */
export function formatValue(
  value: number | null | undefined,
  unit: string | null | undefined,
): string {
  if (!isNumber(value)) return '—';
  return `${formatNumber(value)}${unitAfter(unit)}`;
}

/** A value to fixed decimals with its unit, so figures in a row line up: "12.0 W", "0.56 W". */
export function fixedValue(
  value: number | null | undefined,
  unit: string | null | undefined,
  digits: number,
): string {
  if (!isNumber(value)) return '—';
  return `${value.toFixed(digits)}${unitAfter(unit)}`;
}

const TEMPERATURE_UNITS = new Set(['c', '°c', 'degc', 'deg c', 'celsius']);
const POWER_UNITS = new Set(['w', 'mw', 'kw']);
const TEMPERATURE_NAME = /temp|rtsn|thermal/i;

function unitKey(unit: string | null | undefined): string {
  return (unit ?? '').trim().toLowerCase();
}

/** Whether a unit names degrees Celsius, in any spelling Sentinel may use: the one test for every view. */
export function isTemperatureUnit(unit: string | null | undefined): boolean {
  return TEMPERATURE_UNITS.has(unitKey(unit));
}

/**
 * A temperature, wherever Sentinel grouped it: the board sensors sit under Board, the SoC's RTSN
 * sensors under MLA, APU, CVU and TOP. The unit decides when there is one, so a percentage or a
 * size whose name happens to hold "temp" is never read as a temperature; a metric with no unit is
 * a temperature when its key or label names a sensor.
 */
export function isThermalMetric(metric: MetricFacts | null | undefined): boolean {
  const unit = unitKey(metric?.unit);
  if (unit) return TEMPERATURE_UNITS.has(unit);
  return TEMPERATURE_NAME.test(`${metric?.key ?? ''} ${metric?.label ?? ''}`);
}

/**
 * The one section a metric belongs to. Thermal is decided first, so a temperature Sentinel filed
 * under Power is still found under Thermal. Power is Sentinel's Power and PowerRail groups, and
 * anything else measured in watts. Everything left is System.
 */
export function metricSection(
  metric: MetricFacts | null | undefined,
  groupName: string | null | undefined = metric?.group,
): 'thermal' | 'power' | 'system' {
  if (isThermalMetric(metric)) return 'thermal';
  const group = (groupName ?? '').replace(/[\s_-]+/g, '').toLowerCase();
  if (group.startsWith('power') || POWER_UNITS.has(unitKey(metric?.unit))) return 'power';
  return 'system';
}

/** How many of these metrics are past a threshold, as the worst tone and its count; null when none is. */
export function metricAlert(
  metrics: readonly Pick<SentinelMetric, 'status'>[],
): { tone: 'warn' | 'critical'; count: number } | null {
  const critical = metrics.filter((metric) => metric.status === 'critical').length;
  const warn = metrics.filter((metric) => metric.status === 'warn').length;
  if (critical) return { tone: 'critical', count: critical };
  return warn ? { tone: 'warn', count: warn } : null;
}

/** A metric's thresholds as a sentence: "warn at 70 °C, critical at 85 °C"; '' when it has none. */
export function thresholdText(metric: Pick<SentinelMetric, 'warn' | 'critical' | 'unit'>): string {
  const parts: string[] = [];
  if (isNumber(metric.warn)) parts.push(`warn at ${formatValue(metric.warn, metric.unit)}`);
  if (isNumber(metric.critical)) {
    parts.push(`critical at ${formatValue(metric.critical, metric.unit)}`);
  }
  return parts.join(', ');
}

const STATUS_LABELS: Record<MetricStatus, { label: string; tone: NeatTone }> = {
  ok: { label: 'Normal', tone: 'neutral' },
  warn: { label: 'Warning', tone: 'warning' },
  critical: { label: 'Critical', tone: 'danger' },
  unavailable: { label: 'Not measured', tone: 'neutral' },
};

/** A status in words and the chip tone that carries it; a status Insight does not know is not measured. */
export function statusLabel(status: MetricStatus): { label: string; tone: NeatTone } {
  return STATUS_LABELS[status] ?? STATUS_LABELS.unavailable;
}

/** How many metrics are past a threshold, in the worst tone among them: "2 warnings", "1 critical". */
export function alertLabel(alert: { tone: 'warn' | 'critical'; count: number }): {
  label: string;
  tone: NeatTone;
} {
  if (alert.tone === 'critical') return { label: `${alert.count} critical`, tone: 'danger' };
  return { label: `${alert.count} ${alert.count === 1 ? 'warning' : 'warnings'}`, tone: 'warning' };
}

/** The tone a line is drawn in: a metric past a threshold draws in that threshold's. */
export function lineTone(status: MetricStatus): NeatChartTone {
  if (status === 'warn') return 'warning';
  return status === 'critical' ? 'danger' : 'default';
}

/** The levels a chart marks for a metric: "Warning 70 °C" and "Critical 85 °C", each only when defined. */
export function thresholdsOf(metric: SentinelMetric): NeatThreshold[] {
  const thresholds: NeatThreshold[] = [];
  if (isNumber(metric.warn)) {
    thresholds.push({
      value: metric.warn,
      tone: 'warning',
      label: `Warning ${formatValue(metric.warn, metric.unit)}`,
    });
  }
  if (isNumber(metric.critical)) {
    thresholds.push({
      value: metric.critical,
      tone: 'danger',
      label: `Critical ${formatValue(metric.critical, metric.unit)}`,
    });
  }
  return thresholds;
}

/** How long a run took: seconds with one decimal under an hour ("34.4 s"), then "1 h 2 min". */
export function formatDuration(ms: number): string {
  if (ms < 3_600_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The energy of a run: whole joules ("275 J"), kilojoules from 1000 J ("1.02 kJ"), a dash for none. */
export function formatEnergy(joules: number | null): string {
  if (!isNumber(joules)) return '—';
  const whole = Math.round(joules);
  return whole < 1000 ? `${whole} J` : `${(joules / 1000).toFixed(2)} kJ`;
}

/** The time a trace has been recording, as a clock: "0:34", "12:05", "1:02:05". */
export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}
