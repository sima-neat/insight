/**
 * A comparison of saved runs (`GET /api/sentinel/compare?raw=1`) and what the comparison view
 * derives from it: the address, the overlay of one series over the runs' common window with its
 * summary, the per-metric table with its groups and filter, and the CSV. Pure functions over plain
 * data, ported from #170's `dashboard.js` (`compareOverlay`) and `model.js` (`compareTable`,
 * `compareCsv`), with its collapsing overlay fixed (Inv-S §13.28).
 *
 * The runs come in the order `/compare` was asked for, so the first is the baseline (`orderedIds`).
 */
import type { ParamMap } from '@angular/router';
// Types only: the charts entry loads with the Stats view that draws the overlay, not with this.
import type { NeatSeries } from '@sima/neat-ui/charts';
import type { CompareExport, RunSample, RunTotals, SavedRun } from './api';
import { formatNumber, isNumber, isThermalMetric, unitSuffix } from './format';
import { compareText, isObject, isSavedRun, localDay, percentile } from './runs';
import { csvField } from './telemetry';

const POWER_KEY = 'power_current_watts';
const THERMAL_MAX = 'thermal_max';
const RUN_TOTALS_GROUP = 'Run totals';
const OTHER_GROUP = 'Other';

/**
 * Whether a body has a raw comparison's parts: full runs (`isSavedRun`), the summaries and the
 * changes, which the view reads; a body without them is not laid out (spec, "the fallbacks for
 * unknown body shapes"). Only the parts are checked, not every field in them.
 */
export function isCompareExport(body: unknown): body is CompareExport {
  return (
    isObject(body) &&
    Array.isArray(body['runs']) &&
    body['runs'].every(isSavedRun) &&
    isObject(body['summaries']) &&
    isObject(body['baseline_deltas_pct'])
  );
}

/**
 * Whether Sentinel summarised every compared run. A run without a summary has no cells in the
 * per-metric table (they read "—"), which the view says (#170: "Sentinel summarised only some of
 * these runs").
 */
export function summarisesEveryRun(answer: CompareExport): boolean {
  return answer.runs.every((run) => isObject(answer.summaries[run.metadata.id]));
}

/** The group filter that shows every row of the per-metric table. */
export const ALL_GROUPS = 'All';

/** The runs and baseline a compare address names (`?runs=<a>,<b>&baseline=<a>`). */
export interface CompareParams {
  ids: string[];
  /** One of `ids`, or null when the address names none of them. */
  baseline: string | null;
}

/** The ids of a compare address, trimmed, without empty ones or repeats, and its baseline. */
export function readCompareParams(params: ParamMap): CompareParams {
  const ids = (params.get('runs') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const unique = [...new Set(ids)];
  const baseline = params.get('baseline')?.trim() ?? null;
  return {
    ids: unique,
    baseline: baseline !== null && unique.includes(baseline) ? baseline : null,
  };
}

/** The ids in the order `/compare` takes them: the baseline first, the others as they were. */
export function orderedIds(ids: readonly string[], baseline: string | null): string[] {
  if (baseline === null || !ids.includes(baseline)) return [...ids];
  return [baseline, ...ids.filter((id) => id !== baseline)];
}

/** #170's series to compare; thermal max is derived per sample from each run's own sensors. */
export const COMPARE_SERIES: readonly { key: string; label: string }[] = [
  { key: POWER_KEY, label: 'Total power' },
  { key: THERMAL_MAX, label: 'Thermal max' },
  { key: 'cpu_usage_pct', label: 'CPU usage' },
  { key: 'cpu_load_1', label: 'CPU load' },
  { key: 'linux_mem_used_mb', label: 'RAM used' },
  { key: 'mla_mem_allocated_mb', label: 'MLA memory' },
  { key: 'ev74_cma_used_mb', label: 'EV74 CMA' },
];

/** A series the compared runs can share, with its unit as Sentinel spells it (null for none). */
export interface CompareSeries {
  key: string;
  label: string;
  unit: string | null;
}

/**
 * The series every run defines in one unit: lines in two units on one scale would be read as one
 * quantity. Thermal max needs a temperature in every run, and reads in degrees ("C").
 */
export function availableSeries(runs: readonly SavedRun[]): CompareSeries[] {
  if (runs.length === 0) return [];
  return COMPARE_SERIES.flatMap((series): CompareSeries[] => {
    if (series.key === THERMAL_MAX) {
      return runs.every((run) => run.metrics.some((metric) => isThermalMetric(metric)))
        ? [{ ...series, unit: 'C' }]
        : [];
    }
    const units = runs.map((run) => run.metrics.find((metric) => metric.key === series.key)?.unit);
    if (units.some((unit) => unit === undefined) || new Set(units).size > 1) return [];
    return [{ ...series, unit: units[0] || null }];
  });
}

/** A reading `t` ms after the run's first sample; null where the board took none. */
interface Point {
  t: number;
  value: number | null;
}

/** How a series is read from a sample; thermal max is the hottest of the run's own sensors. */
function reader(run: SavedRun, key: string): (values: RunSample['values']) => number | null {
  if (key !== THERMAL_MAX) {
    return (values) => {
      const value = values[key];
      return isNumber(value) ? value : null;
    };
  }
  // The run's own definitions: a run recorded on another build can name its sensors differently.
  const sensors = run.metrics
    .filter((metric) => isThermalMetric(metric))
    .map((metric) => metric.key);
  return (values) => {
    const readings = sensors.map((sensor) => values[sensor]).filter(isNumber);
    return readings.length ? Math.max(...readings) : null;
  };
}

/**
 * A run's readings of a series over time since its first sample, oldest first. A sample whose
 * time cannot be read, or that lies before the first (a clock step), is left out.
 */
function timeline(run: SavedRun, key: string): Point[] {
  const read = reader(run, key);
  const times = run.samples.map((sample) => Date.parse(sample.timestamp));
  const start = times.find((time) => Number.isFinite(time));
  if (start === undefined) return [];
  return run.samples
    .map((sample, index) => ({ t: times[index] - start, value: read(sample.values) }))
    .filter((point) => point.t >= 0)
    .sort((a, b) => a.t - b.t);
}

/** Where a run's readings end, if it has two at different times; one reading spans no time. */
function spanEnd(points: readonly Point[]): number | null {
  const usable = points.filter((point) => isNumber(point.value));
  if (usable.length < 2) return null;
  const end = usable[usable.length - 1].t;
  return end > usable[0].t ? end : null;
}

/**
 * Each run's timeline and the common window: as long as the shortest run among those with
 * readings to span it. A run without them is left out of the window rather than shrinking it to
 * nothing, which collapsed every line in #170 (Inv-S §13.28). Null when no run spans any time.
 */
function commonWindow(
  runs: readonly SavedRun[],
  key: string,
): { lines: Point[][]; windowMs: number | null } {
  const lines = runs.map((run) => timeline(run, key));
  const ends = lines.map(spanEnd).filter(isNumber);
  return { lines, windowMs: ends.length ? Math.min(...ends) : null };
}

/**
 * A run's value at each of the ascending `times`: its reading where it has a sample, else the
 * straight line between its samples either side, so its line through the shared times is exactly
 * its own. Before its first sample, after its last and beside a missing reading it is null, which
 * the chart draws as a break.
 */
function resample(points: readonly Point[], times: readonly number[]): (number | null)[] {
  let next = 0;
  return times.map((t) => {
    while (next < points.length && points[next].t < t) next++;
    const after = points[next] as Point | undefined;
    if (after?.t === t) return after.value;
    const before = points[next - 1] as Point | undefined;
    if (!before || !after || !isNumber(before.value) || !isNumber(after.value)) return null;
    return before.value + ((after.value - before.value) * (t - before.t)) / (after.t - before.t);
  });
}

/**
 * The scale of the overlay: the values padded by a sixth of their spread, so small differences
 * between runs stay visible; a flat line gets a unit either side. One pass rather than a spread
 * into `Math.min`, which has a length limit and long runs can reach it.
 */
function fittedDomain(values: readonly (number | null)[]): [number, number] {
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    if (!isNumber(value)) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const pad = (high - low) / 6 || 1;
  return [low - pad, high + pad];
}

/**
 * One series of the compared runs over their common window, as the kit's time chart takes it:
 * one `times` array (ms since each run's first sample) that every series is read at.
 */
export interface CompareOverlay {
  times: number[];
  /** One per run in run order, so a run's colour is its place; one without readings is all null. */
  series: NeatSeries[];
  domain: [number, number];
  unit: string | null;
  windowMs: number;
}

/**
 * A series of every run over the common window. The shared times are the union of the offsets of
 * the runs with a reading in the window, and each run is read at them (`resample`). A run without
 * readings keeps an all-null series, which draws nothing: dropping it would shift the colours of
 * the runs after it away from their chips. Null when the runs cannot share the series or none
 * spans any time.
 */
export function compareOverlay(runs: readonly SavedRun[], key: string): CompareOverlay | null {
  const option = availableSeries(runs).find((series) => series.key === key);
  if (!option) return null;
  const { lines, windowMs } = commonWindow(runs, key);
  if (windowMs === null) return null;
  const offsets = lines.flatMap((points) => {
    const inside = points.filter((point) => point.t <= windowMs);
    // A run with nothing to draw would only add points where the others interpolate.
    return inside.some((point) => isNumber(point.value)) ? inside.map((point) => point.t) : [];
  });
  const times = [...new Set(offsets)].sort((a, b) => a - b);
  const series = runs.map((run, index): NeatSeries => ({
    key: run.metadata.id,
    label: run.metadata.name,
    values: resample(lines[index], times),
  }));
  return {
    times,
    series,
    domain: fittedDomain(series.flatMap((entry) => entry.values)),
    unit: option.unit,
    windowMs,
  };
}

/** A run's figures for the shown series over the common window, as the summary table lists them. */
export interface CompareSummaryRow {
  id: string;
  name: string;
  baseline: boolean;
  /** Readings inside the window; 0 for a run without any, which the view lists as such. */
  samples: number;
  minimum: number | null;
  mean: number | null;
  median: number | null;
  p95: number | null;
  maximum: number | null;
  /** The mean's change against the baseline's, in percent; null for the baseline itself. */
  change: number | null;
  /** Joules of total power over the window, whichever series is shown. */
  energy: number | null;
}

/**
 * Joules of total power over the window: the trapezoids between consecutive readings, the last
 * one cut at the window's edge at the power interpolated there, as the run's line is drawn. A
 * missing reading leaves its intervals out rather than guessing them. Null without one interval.
 */
function windowEnergy(points: readonly Point[], windowMs: number): number | null {
  let joules: number | null = null;
  for (let index = 1; index < points.length; index++) {
    const before = points[index - 1];
    const after = points[index];
    if (before.t >= windowMs) break;
    if (!isNumber(before.value) || !isNumber(after.value) || after.t <= before.t) continue;
    const end = Math.min(after.t, windowMs);
    const atEnd =
      before.value + ((after.value - before.value) * (end - before.t)) / (after.t - before.t);
    joules = (joules ?? 0) + ((before.value + atEnd) / 2) * ((end - before.t) / 1000);
  }
  return joules;
}

/** The spread of ascending readings, with Sentinel's percentiles; nulls for none. */
function spread(
  sorted: readonly number[],
): Pick<CompareSummaryRow, 'samples' | 'minimum' | 'mean' | 'median' | 'p95' | 'maximum'> {
  let sum = 0;
  for (const value of sorted) sum += value;
  const count = sorted.length;
  return {
    samples: count,
    minimum: count ? sorted[0] : null,
    mean: count ? sum / count : null,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    maximum: count ? sorted[count - 1] : null,
  };
}

/**
 * A value's change against the baseline's (a mean's, a run total's), in percent; none from a
 * baseline of 0 or without both values.
 */
function changeOf(value: number | null, baseline: number | null): number | null {
  if (!isNumber(value) || !isNumber(baseline) || baseline === 0) return null;
  return ((value - baseline) / baseline) * 100;
}

/**
 * Each run's figures for a series over the common window, the same samples the overlay draws.
 * Sentinel's own summaries cover each whole run, and runs differ in length, so they are left to
 * the per-metric table.
 */
export function compareSummary(runs: readonly SavedRun[], key: string): CompareSummaryRow[] {
  const { lines, windowMs } = commonWindow(runs, key);
  const rows = runs.map((run, index) => {
    const inside =
      windowMs === null
        ? []
        : lines[index]
            .filter((point) => point.t <= windowMs)
            .map((point) => point.value)
            .filter(isNumber)
            .sort((a, b) => a - b);
    return {
      id: run.metadata.id,
      name: run.metadata.name,
      baseline: index === 0,
      ...spread(inside),
      energy: windowMs === null ? null : windowEnergy(timeline(run, POWER_KEY), windowMs),
    };
  });
  const baselineMean = rows[0]?.mean ?? null;
  return rows.map((row, index): CompareSummaryRow => ({
    ...row,
    change: index === 0 ? null : changeOf(row.mean, baselineMean),
  }));
}

/**
 * A run's cell in the per-metric table: Sentinel's mean (a run total's value) and its change
 * against the baseline's.
 */
export interface CompareCell {
  mean: number | null;
  /**
   * In percent; null for the baseline, for a run without a value, where Sentinel has none, and
   * for a total whose baseline has none or 0.
   */
  change: number | null;
}

/** A row of the per-metric table: a run total or a metric, with a cell per run in run order. */
export interface CompareTableRow {
  key: string;
  label: string;
  group: string;
  unit: string | null;
  /** The runs recorded the metric under different labels, units or groups. */
  definitionsDiffer: boolean;
  cells: CompareCell[];
}

/**
 * The totals Sentinel reports per run beside its metric summaries. It publishes no change for
 * them, so `compareTable` works it out against the baseline's total, as Sentinel does for a mean.
 * The duration comes in milliseconds and reads in seconds, as in the rest of the view; the keys
 * stay Sentinel's, as #170's CSV wrote them.
 */
const RUN_TOTALS: readonly {
  key: string;
  label: string;
  unit: string | null;
  value: (totals: RunTotals) => number | null;
}[] = [
  {
    key: 'duration_ms',
    label: 'Duration',
    unit: 's',
    value: (totals) => totals.duration_ms / 1000,
  },
  { key: 'energy_joules', label: 'Energy', unit: 'J', value: (totals) => totals.energy_joules },
  { key: 'samples', label: 'Samples', unit: null, value: (totals) => totals.samples },
];

/**
 * A metric's row. Its label, group and unit are the baseline's definition, else the first run's
 * that has one; where the runs disagree the label says so, and a unit they disagree on is dropped
 * rather than printed beside values in another.
 */
function metricRow(answer: CompareExport, key: string): CompareTableRow {
  const { runs, summaries, baseline_deltas_pct: deltas, baseline_id: baselineId } = answer;
  const recorded = runs.flatMap((run) => {
    const metric = run.metrics.find((entry) => entry.key === key);
    return metric ? [{ baseline: run.metadata.id === baselineId, metric }] : [];
  });
  const definition = (recorded.find((entry) => entry.baseline) ?? recorded[0])?.metric;
  const signatures = recorded.map(({ metric }) =>
    JSON.stringify([metric.label, metric.unit, metric.group]),
  );
  const differ = new Set(signatures).size > 1;
  const unitsDiffer = new Set(recorded.map(({ metric }) => metric.unit)).size > 1;
  const label = definition?.label || key;
  return {
    key,
    label: differ ? `${label} (recorded definitions differ)` : label,
    group: definition?.group || OTHER_GROUP,
    unit: unitsDiffer ? null : definition?.unit || null,
    definitionsDiffer: differ,
    cells: runs.map((run) => {
      const id = run.metadata.id;
      const mean = summaries[id]?.metrics[key]?.mean;
      const change = deltas[id]?.[key];
      return {
        mean: isNumber(mean) ? mean : null,
        // The baseline is what the changes are measured against, and a change beside no value
        // would describe a number that is not on the page: neither shows one.
        change: id !== baselineId && isNumber(mean) && isNumber(change) ? change : null,
      };
    }),
  };
}

/**
 * The per-metric table of a comparison, from Sentinel's summaries of the whole runs: the run
 * totals (Duration, Energy, Samples), then every metric any run summarised, by label.
 */
export function compareTable(answer: CompareExport): CompareTableRow[] {
  const { baseline_id: baselineId, summaries } = answer;
  const totals = RUN_TOTALS.map((total): CompareTableRow => {
    const valueOf = (id: string): number | null => {
      const summary = summaries[id] as RunTotals | undefined;
      const value = summary ? total.value(summary) : null;
      return isNumber(value) ? value : null;
    };
    const base = valueOf(baselineId);
    return {
      key: total.key,
      label: total.label,
      group: RUN_TOTALS_GROUP,
      unit: total.unit,
      definitionsDiffer: false,
      cells: answer.runs.map((run) => {
        const id = run.metadata.id;
        const value = valueOf(id);
        return { mean: value, change: id === baselineId ? null : changeOf(value, base) };
      }),
    };
  });
  const keys = new Set(
    answer.runs.flatMap((run) => Object.keys(answer.summaries[run.metadata.id]?.metrics ?? {})),
  );
  const metrics = [...keys]
    .map((key) => metricRow(answer, key))
    .sort((a, b) => compareText(a.label, b.label) || compareText(a.key, b.key));
  return [...totals, ...metrics];
}

/** The group filter's choices with their row counts: All, Run totals, groups A-Z, Other last. */
export function tableGroups(rows: readonly CompareTableRow[]): { group: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.group, (counts.get(row.group) ?? 0) + 1);
  const rank = (group: string) => (group === RUN_TOTALS_GROUP ? 0 : group === OTHER_GROUP ? 2 : 1);
  const groups = [...counts.keys()].sort((a, b) => rank(a) - rank(b) || compareText(a, b));
  return [
    { group: ALL_GROUPS, count: rows.length },
    ...groups.map((group) => ({ group, count: counts.get(group) ?? 0 })),
  ];
}

/**
 * The rows where some run differs from the baseline: a metric by the change Sentinel published, a
 * run total by its own (`compareTable`). The baseline's own cells carry none.
 */
export function changesOnly(rows: readonly CompareTableRow[]): CompareTableRow[] {
  return rows.filter((row) => row.cells.some((cell) => isNumber(cell.change) && cell.change !== 0));
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/**
 * What the group filter and Changes only leave out of the table, so a shorter table is never
 * read as the whole one; '' when every row is shown. `hidden` is how many Changes only hides.
 */
export function tableStatus(shown: number, all: number, hidden: number): string {
  if (shown >= all) return '';
  const parts = [`Showing ${shown} of ${count(all, 'row')}.`];
  if (hidden > 0) {
    parts.push(
      `Changes only hides ${count(hidden, 'row')} where no run differs from the baseline.`,
    );
  }
  parts.push(`Export CSV still writes all ${all}.`);
  return parts.join(' ');
}

/**
 * A change in percent, signed with a true minus (U+2212): "+3.2%", "−8.6%", "±0%", and
 * "+<0.01%" for one too small to round to a figure; '' for none.
 */
export function formatChange(change: number | null): string {
  if (!isNumber(change)) return '';
  if (change === 0) return '±0%';
  const sign = change > 0 ? '+' : '−';
  const size = Math.abs(change);
  return size < 0.01 ? `${sign}<0.01%` : `${sign}${formatNumber(size)}%`;
}

/** A run as a CSV column names it: "tes3 (baseline; before the NMS change)". */
function csvRunName(run: SavedRun, baseline: boolean): string {
  const marks = [baseline ? 'baseline' : '', (run.metadata.note ?? '').trim()].filter(Boolean);
  const name = run.metadata.name;
  return marks.length ? `${name} (${marks.join('; ')})` : name;
}

/**
 * The comparison as CSV (#170's columns): every row of the per-metric table, whatever filter is
 * on screen, with each run's mean and change, unformatted. A missing value is an empty field,
 * never a dash or a zero, which a spreadsheet would read as a value; units have their own column.
 */
export function compareCsv(answer: CompareExport): string {
  const header = ['metric_key', 'label', 'group', 'unit'];
  for (const run of answer.runs) {
    const name = csvRunName(run, run.metadata.id === answer.baseline_id);
    header.push(`${name} mean`, `${name} change vs baseline (%)`);
  }
  const rows = compareTable(answer).map((row) => [
    row.key,
    row.label,
    row.group,
    unitSuffix(row.unit),
    ...row.cells.flatMap((cell) => [cell.mean, cell.change]),
  ]);
  return [header, ...rows].map((line) => line.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/**
 * `sentinel-compare-<baseline>-<YYYY-MM-DD>.csv` in local time, safe on every filesystem: the
 * name keeps letters, digits, dots, dashes and underscores, at most 80 of them.
 */
export function compareCsvFilename(baselineName: string, date: Date): string {
  const name = baselineName
    // An accented letter keeps its letter: "résumé" is "resume", not "re-sume".
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
    .replace(/[-.]+$/, '');
  return `sentinel-compare-${name || 'runs'}-${localDay(date)}.csv`;
}
