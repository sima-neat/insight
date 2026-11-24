/**
 * The telemetry window the Stats page holds and what it derives from it: merging Sentinel's
 * incremental cache answers, the sections of the side panel, the overview cards, the inputs of
 * every chart and the CSV export. Pure functions over plain data.
 */
import type { NeatChartTone, NeatReference, NeatSeries, NeatThreshold } from '@sima/neat-ui/charts';
import { NO_VALUE } from '../no-value';
import type { SentinelCache, SentinelMetric, SentinelSample } from './api';
import { definitionsOf, joinMetrics, metricStatus } from './metrics';
import {
  fixedValue,
  estimated,
  formatValue,
  isNumber,
  isThermalMetric,
  lineTone,
  metricAlert,
  metricSection,
  thresholdsOf,
  unitSuffix,
} from './format';
import { powerCeiling, scaleFor } from './scales';

/** How many samples the page holds: Sentinel's own history is this long. */
export const HISTORY_SAMPLES = 240;

/**
 * What the page holds of Sentinel's history, for the board `board` (its id). `metrics` are in
 * Sentinel's order with their newest readings (`metrics.ts`), `times` are the timestamps as
 * milliseconds (null where one cannot be read), and `series[key][i]` was measured at
 * `timestamps[i]`: every series is as long as the timestamps. `sampled` are the keys the newest
 * sample held, which keep a metric without a definition listed.
 */
export interface TelemetryWindow {
  readonly board: string;
  readonly metrics: readonly SentinelMetric[];
  readonly sampled: readonly string[];
  readonly timestamps: readonly string[];
  readonly times: readonly (number | null)[];
  readonly series: Readonly<Record<string, readonly (number | null)[]>>;
}

/**
 * The `after` of the next cache read: the newest sample held of `board`, so the answer holds only
 * what is newer; null for the whole cache (nothing held of that board yet).
 */
export function cacheAfter(held: TelemetryWindow | null, board: string): string | null {
  return held?.board === board ? (held.timestamps.at(-1) ?? null) : null;
}

const nulls = (count: number): null[] => new Array<null>(count).fill(null);

function timeOf(timestamp: string): number | null {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? time : null;
}

/** A reading as the page holds it: a number, else null (Sentinel's null, or anything else). */
const reading = (value: unknown): number | null => (isNumber(value) ? value : null);

/** The samples of an answer that have a timestamp and values; anything else is left out. */
function samplesOf(samples: unknown): SentinelSample[] {
  if (!Array.isArray(samples)) return [];
  return samples.filter(
    (sample): sample is SentinelSample =>
      typeof sample === 'object' &&
      sample !== null &&
      typeof (sample as { timestamp?: unknown }).timestamp === 'string' &&
      typeof (sample as { values?: unknown }).values === 'object' &&
      (sample as { values?: unknown }).values !== null,
  );
}

/**
 * The window of `board` after Sentinel's cache `answer`. A full answer, or what is held of another
 * board, is replaced; an incremental one (`full` false) is appended. Either way the newest 240
 * samples stay, every series keeps the timestamps' length (a metric that is new gets nulls for
 * the samples before it), and a metric's value is the newest sample's reading of it. The metrics
 * are the answer's definitions in Sentinel's order and then the keys of the newest sample that
 * have none; one neither defines nor samples any more leaves.
 */
export function mergeTelemetry(
  held: TelemetryWindow | null,
  answer: SentinelCache,
  board: string,
): TelemetryWindow {
  const keep = held !== null && held.board === board && !answer.full ? held : null;
  const fresh = samplesOf(answer.samples);
  const sampled = fresh.length
    ? Object.keys(fresh[fresh.length - 1].values)
    : (keep?.sampled ?? []);
  const definitions = definitionsOf(answer.metrics);
  const keys = [...new Set([...definitions.map(({ key }) => key), ...sampled])];
  const before = keep?.timestamps.length ?? 0;
  const timestamps = [
    ...(keep?.timestamps ?? []),
    ...fresh.map((sample) => sample.timestamp),
  ].slice(-HISTORY_SAMPLES);
  const series = Object.fromEntries(
    keys.map((key) => {
      const old = keep ? (keep.series[key] ?? nulls(before)) : [];
      const added = fresh.map((sample) => reading(sample.values[key]));
      return [key, [...old, ...added].slice(-HISTORY_SAMPLES)];
    }),
  );
  return {
    board,
    metrics: joinMetrics(definitions, sampled, (key) => reading(series[key]?.at(-1))),
    sampled,
    timestamps,
    times: timestamps.map(timeOf),
    series,
  };
}

/** A series' newest reading; null when the board took none there. */
export function currentValue(values: readonly (number | null | undefined)[]): number | null {
  const value = values.at(-1);
  return isNumber(value) ? value : null;
}

/** The sum of the readings, only when every one of them is available: a partial sum was never measured. */
export function currentTotal(values: readonly (number | null | undefined)[]): number | null {
  return values.length && values.every(isNumber)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

const seriesOf = (window: TelemetryWindow, key: string): readonly (number | null)[] =>
  window.series[key] ?? [];

/** A metric by its key; undefined when the board does not report it. */
export const metricByKey = (window: TelemetryWindow, key: string): SentinelMetric | undefined =>
  window.metrics.find((metric) => metric.key === key);

/** Thresholds that apply to every sensor: the first's when all have the same levels, else none. */
function sharedThresholds(sensors: readonly SentinelMetric[]): NeatThreshold[] {
  const first = thresholdsOf(sensors[0]);
  const same = sensors.every((sensor) => {
    const own = thresholdsOf(sensor);
    return (
      own.length === first.length &&
      own.every((line, i) => line.value === first[i].value && line.tone === first[i].tone)
    );
  });
  return same ? first : [];
}

/**
 * The hottest of the board's temperature sensors per sample (null where none reported), the one
 * that is hottest now, and the thresholds that apply to every sensor. Null when the board reports
 * no temperature.
 */
export function thermalMax(window: TelemetryWindow): {
  values: (number | null)[];
  hottest: SentinelMetric | null;
  thresholds: NeatThreshold[];
} | null {
  const sensors = window.metrics.filter(isThermalMetric);
  if (!sensors.length) return null;
  const lists = sensors.map((sensor) => seriesOf(window, sensor.key));
  const values = window.timestamps.map((_, i) => {
    const readings = lists.map((list) => list[i]).filter(isNumber);
    return readings.length ? Math.max(...readings) : null;
  });
  const hottest = sensors.reduce<SentinelMetric | null>(
    (hot, sensor) =>
      isNumber(sensor.value) && (!hot || sensor.value > (hot.value as number)) ? sensor : hot,
    null,
  );
  return { values, hottest, thresholds: sharedThresholds(sensors) };
}

/** The board's temperature sensors under Sentinel's own group names, in Sentinel's order. */
export function thermalGroups(window: TelemetryWindow): {
  name: string;
  metrics: SentinelMetric[];
  alert: ReturnType<typeof metricAlert>;
}[] {
  const groups = new Map<string, SentinelMetric[]>();
  for (const metric of window.metrics.filter(isThermalMetric)) {
    groups.set(metric.group, [...(groups.get(metric.group) ?? []), metric]);
  }
  return [...groups].map(([name, metrics]) => ({ name, metrics, alert: metricAlert(metrics) }));
}

/** Metrics whose key matches, in Sentinel's order: the per-core CPUs, the power rails. */
export function metricsMatching(window: TelemetryWindow, pattern: RegExp): SentinelMetric[] {
  return window.metrics.filter((metric) => pattern.test(metric.key));
}

/** How far back a core's "recent" reading reaches, by board time. */
const RECENT_MS = 60_000;
/** The samples that stand in for the last minute when the timestamps cannot tell (Sentinel's 2 s cadence). */
const RECENT_SAMPLES = 30;

function mean(values: readonly (number | null)[]): number | null {
  const readings = values.filter(isNumber);
  return readings.length ? readings.reduce((sum, value) => sum + value, 0) / readings.length : null;
}

/**
 * The samples of the last minute by board time, so a back-off in polling does not stretch it; the
 * last 30 when the times do not cover every sample in order.
 */
function recentValues(
  values: readonly (number | null)[],
  times: readonly (number | null)[],
): readonly (number | null)[] {
  const ordered = times.every(
    (time, i) => time !== null && (i === 0 || time >= (times[i - 1] as number)),
  );
  if (!ordered || times.length !== values.length || !times.length) {
    return values.slice(-RECENT_SAMPLES);
  }
  const since = (times.at(-1) as number) - RECENT_MS;
  return values.filter((_, i) => (times[i] as number) > since);
}

/**
 * Each CPU core's one-minute average and the tone it reads in (against that core's own
 * thresholds), the average of the cores that reported, and the busiest core. A row's `values` are
 * its whole series, which the heatmap folds into columns itself.
 */
export function coreSummary(window: TelemetryWindow): {
  rows: {
    key: string;
    label: string;
    values: (number | null)[];
    recent: number | null;
    tone: NeatChartTone;
  }[];
  average: number | null;
  busiest: { label: string; recent: number } | null;
} {
  const rows = metricsMatching(window, /^cpu_core_\d+_usage_pct$/).map((core) => {
    const values = [...seriesOf(window, core.key)];
    const recent = mean(recentValues(values, window.times));
    return {
      key: core.key,
      label: core.short || core.label,
      values,
      recent,
      tone: lineTone(metricStatus(recent, core.warn, core.critical)),
    };
  });
  const reporting = rows.filter((row): row is typeof row & { recent: number } =>
    isNumber(row.recent),
  );
  const busiest = reporting.reduce<(typeof reporting)[number] | null>(
    (top, row) => (!top || row.recent > top.recent ? row : top),
    null,
  );
  return {
    rows,
    average: mean(reporting.map((row) => row.recent)),
    busiest: busiest && { label: busiest.label, recent: busiest.recent },
  };
}

/** The sections of the side panel; the overview cards open one each. */
export type StatsArea = 'thermal' | 'power' | 'system' | 'storage';

export const AREA_LABELS: Readonly<Record<StatsArea, string>> = {
  thermal: 'Thermal',
  power: 'Power',
  system: 'System',
  storage: 'Storage & Network',
};

// The EV74's CMA pool (`ev74_cma_`) is the board-wide pool, not the EV74's: it stays in All metrics.
const SYSTEM_KEYS = /^(cpu_|linux_mem|mla_mem|ev74_mem)/;
const STORAGE_GROUPS = /^(disk|diskio|network|storage|nvme)$/i;
const STORAGE_KEYS = /^(disk_|net_|nvme)/;

/** The metrics an area lists, in Sentinel's order. */
export function areaMetrics(window: TelemetryWindow, area: StatsArea): SentinelMetric[] {
  switch (area) {
    case 'thermal':
      return window.metrics.filter(isThermalMetric);
    case 'power':
      return window.metrics.filter((metric) => metricSection(metric) === 'power');
    case 'system':
      return window.metrics.filter((metric) => SYSTEM_KEYS.test(metric.key));
    case 'storage':
      return window.metrics.filter(
        (metric) => STORAGE_GROUPS.test(metric.group) || STORAGE_KEYS.test(metric.key),
      );
  }
}

export type OverviewCardId =
  'thermal-max' | 'board-power' | 'cpu' | 'linux-memory' | 'accelerator-memory' | 'network';

export interface OverviewCard {
  readonly id: OverviewCardId;
  readonly heading: string;
  /** The area the card opens. */
  readonly area: StatsArea;
  /** The metrics the card shows. Thermal max has none of its own: it shows every temperature. */
  readonly keys: readonly string[];
}

/** Network in and out, which the Network card and the Storage & Network area chart together. */
const NETWORK_KEYS = ['net_rx_mbps', 'net_tx_mbps'] as const;

/** The accelerators' DMA-BUF memory, MLA then EV74, which the Accelerator memory chart stacks. */
const ACCELERATORS = [
  { key: 'mla_mem_allocated_mb', label: 'MLA' },
  { key: 'ev74_mem_allocated_mb', label: 'EV74' },
] as const;
const ACCELERATOR_KEYS: readonly string[] = ACCELERATORS.map((accelerator) => accelerator.key);

/** The board power's name wherever it is shown: Sentinel's sum of the rails is an estimate. */
export const BOARD_POWER_LABEL = estimated('Board power');

/** The cards, in the order the page shows them. */
export const OVERVIEW_CARDS: readonly OverviewCard[] = [
  { id: 'thermal-max', heading: 'Thermal max', area: 'thermal', keys: [] },
  {
    id: 'board-power',
    heading: BOARD_POWER_LABEL,
    area: 'power',
    keys: ['power_current_watts'],
  },
  { id: 'cpu', heading: 'CPU usage', area: 'system', keys: ['cpu_usage_pct'] },
  { id: 'linux-memory', heading: 'Linux memory', area: 'system', keys: ['linux_mem_used_pct'] },
  {
    id: 'accelerator-memory',
    heading: 'Accelerator memory',
    area: 'system',
    keys: ACCELERATOR_KEYS,
  },
  { id: 'network', heading: 'Network', area: 'storage', keys: NETWORK_KEYS },
];

/** A card is shown while the board reports anything in its area. */
export function cardShown(window: TelemetryWindow, card: OverviewCard): boolean {
  return areaMetrics(window, card.area).length > 0;
}

/** A shown card has a reading to draw while any of its own metrics is reported (any temperature, for Thermal max). */
export function cardReported(window: TelemetryWindow, card: OverviewCard): boolean {
  if (card.id === 'thermal-max') return window.metrics.some(isThermalMetric);
  return card.keys.some((key) => metricByKey(window, key));
}

/**
 * What a time chart is given for one chart, so that an overview card and the side panel's chart
 * of the same metric never disagree about scale, thresholds or tone.
 */
export interface ChartInputs {
  series: NeatSeries[];
  /** What the values are measured in, as Sentinel spells it: the chart words them with it. */
  unit: string | null;
  domain: readonly [number, number];
  thresholds: NeatThreshold[];
  tone: NeatChartTone;
  headline: string;
}

/**
 * A chart of one metric, or null when the board does not report it. The domain is the scale of its
 * unit over the samples and the current value, or `ceiling` when the metric's capacity is known.
 */
export function metricChart(
  window: TelemetryWindow,
  key: string,
  ceiling: number | null = null,
): ChartInputs | null {
  const metric = metricByKey(window, key);
  if (!metric) return null;
  const values = seriesOf(window, key);
  return {
    series: [{ key, label: metric.short || metric.label, values }],
    unit: metric.unit,
    domain: scaleFor(metric.unit, [values, [metric.value]], ceiling),
    thresholds: thresholdsOf(metric),
    tone: lineTone(metric.status),
    headline: formatValue(metric.value, metric.unit),
  };
}

/**
 * Two metrics of one unit on one chart (network in and out, disk reads and writes), with their
 * current total as the headline: "—" unless both are reported. A label belongs to the key at its
 * position in `keys`, whichever of them the board reports. Null when it reports none.
 */
export function pairChart(
  window: TelemetryWindow,
  keys: readonly string[],
  labels: readonly string[],
): ChartInputs | null {
  const requested = keys.map((key, i) => ({ metric: metricByKey(window, key), label: labels[i] }));
  const reported = requested.flatMap(({ metric, label }) => (metric ? [{ metric, label }] : []));
  if (!reported.length) return null;
  const unit = reported[0].metric.unit;
  const series = reported.map(({ metric, label }) => ({
    key: metric.key,
    label: label || metric.short || metric.label,
    values: seriesOf(window, metric.key),
  }));
  return {
    series,
    unit,
    domain: scaleFor(
      unit,
      series.map((item) => item.values),
    ),
    thresholds: [],
    tone: 'default',
    headline: formatValue(currentTotal(requested.map(({ metric }) => metric?.value ?? null)), unit),
  };
}

/** Network in and out on one chart, headed by their current total: the Network card's and its area's. */
export function networkChart(window: TelemetryWindow): ChartInputs | null {
  return pairChart(window, NETWORK_KEYS, ['Receive', 'Transmit']);
}

/**
 * The hottest sensor's reading per sample, drawn with the thresholds every sensor shares and in the
 * tone of the hottest sensor now; null when the board reports no temperature. The headline names
 * that sensor: "78 °C (MLA-3)".
 */
export function thermalMaxChart(window: TelemetryWindow): ChartInputs | null {
  const max = thermalMax(window);
  if (!max) return null;
  const { values, hottest, thresholds } = max;
  const name = hottest ? ` (${hottest.short || hottest.label})` : '';
  return {
    series: [{ key: 'thermal-max', label: 'Hottest sensor', values }],
    unit: 'C',
    domain: scaleFor('C', [values]),
    thresholds,
    tone: lineTone(hottest?.status ?? 'unavailable'),
    headline: `${formatValue(currentValue(values), 'C')}${name}`,
  };
}

const POWER_KEYS = ['power_current_watts', 'power_average_watts', 'power_peak_watts'] as const;

/**
 * The board power chart: the current power on a ceiling that also holds the session average and
 * peak, so the three read on one scale, and the average as its reference line. Null when the
 * board does not report the current power.
 */
export function boardPowerChart(
  window: TelemetryWindow,
): (ChartInputs & { reference: NeatReference | null }) | null {
  const readings = POWER_KEYS.flatMap((key) => [
    ...seriesOf(window, key),
    metricByKey(window, key)?.value ?? null,
  ]);
  const chart = metricChart(window, POWER_KEYS[0], powerCeiling(readings));
  if (!chart) return null;
  const average = metricByKey(window, 'power_average_watts')?.value;
  return {
    ...chart,
    reference: isNumber(average)
      ? { value: average, label: `Session average ${fixedValue(average, 'W', 1)}` }
      : null,
  };
}

/** What a stacked chart is given: the bands, a scale that holds the stack, and its headline. */
export type StackInputs = Pick<ChartInputs, 'series' | 'domain' | 'headline'>;

/**
 * MLA and EV74 memory as the two bands of one stack: Sentinel counts each DMA-BUF once, so the
 * top edge is their sum. The headline is the sum now, "–" while a reported band has no reading.
 * A board that reports one of the two stacks that one; null when it reports neither.
 */
export function acceleratorMemoryChart(window: TelemetryWindow): StackInputs | null {
  const parts = ACCELERATORS.flatMap(({ key, label }) => {
    const metric = metricByKey(window, key);
    return metric ? [{ metric, label }] : [];
  });
  if (!parts.length) return null;
  const series = parts.map(({ metric, label }) => ({
    key: metric.key,
    label,
    values: seriesOf(window, metric.key),
  }));
  const totals = window.timestamps.map((_, i) =>
    currentTotal(series.map((band) => band.values[i])),
  );
  return {
    series,
    domain: scaleFor('MB', [totals]),
    headline: formatValue(currentTotal(parts.map(({ metric }) => metric.value)), 'MB'),
  };
}

/**
 * The power rails as the bands of one stack, each in Sentinel's order and under its short name,
 * on a scale that holds the largest total any sample reached. The headline is the rails' total now
 * with their count, "—" in place of the total while a rail has no reading (a partial sum was never
 * measured). Null when the board reports no rail.
 */
export function powerRailsChart(window: TelemetryWindow): StackInputs | null {
  const rails = metricsMatching(window, /^power_rail_/);
  if (!rails.length) return null;
  const series = rails.map((rail) => ({
    key: rail.key,
    label: rail.short || rail.label,
    values: seriesOf(window, rail.key),
  }));
  const totals = window.timestamps.map((_, i) =>
    currentTotal(series.map((band) => band.values[i])),
  );
  const total = currentTotal(rails.map((rail) => rail.value));
  return {
    series,
    domain: scaleFor('W', [totals]),
    headline: `${isNumber(total) ? fixedValue(total, 'W', 2) : NO_VALUE} across ${rails.length} ${rails.length === 1 ? 'rail' : 'rails'}`,
  };
}

/**
 * One CSV field (RFC 4180): quoted when it holds a quote, comma or line break, or would lose
 * leading or trailing space. A number is written as it is and a missing value is an empty field.
 * Text a spreadsheet would run as a formula is prefixed with an apostrophe: names are whatever
 * someone typed.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The window as CSV: a row per sample (its board timestamp), a column per metric in Sentinel's
 * order headed with its label and unit. A reading the board did not take is an empty cell, never
 * 0. '' when there is nothing to export.
 */
export function sessionCsv(window: TelemetryWindow): string {
  if (!window.metrics.length || !window.timestamps.length) return '';
  const header = [
    'timestamp',
    ...window.metrics.map((metric) => {
      const unit = unitSuffix(metric.unit);
      return unit ? `${metric.label} (${unit})` : metric.label;
    }),
  ];
  const rows = window.timestamps.map((stamp, i) => [
    stamp,
    ...window.metrics.map((metric) => window.series[metric.key]?.[i] ?? null),
  ]);
  return [header, ...rows].map((line) => line.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** `sentinel-session-<YYYY-MM-DD>-<HHMMSS>.csv` in local time, safe on every filesystem. */
export function sessionCsvFilename(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `sentinel-session-${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.csv`;
}
