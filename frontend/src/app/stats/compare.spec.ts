import { convertToParamMap } from '@angular/router';
import type { CompareExport, RunMetricDefinition, SavedRun } from './api';
import {
  COMPARE_SERIES,
  availableSeries,
  changesOnly,
  compareCsv,
  compareCsvFilename,
  compareOverlay,
  compareSummary,
  compareTable,
  formatChange,
  orderedIds,
  readCompareParams,
  tableGroups,
  tableStatus,
} from './compare';
import { COMPARE_RAW, SAVED_RUN } from './runs.testing';

const [BASELINE, OTHER] = COMPARE_RAW.runs;
const BASELINE_ID = BASELINE.metadata.id;
const OTHER_ID = OTHER.metadata.id;

const START = Date.UTC(2026, 9, 25, 8, 0, 0);

function definition(key: string, label: string, group: string, unit: string): RunMetricDefinition {
  return { key, label, short: label, description: '', group, unit, warn: null, critical: null };
}

const DEFINITIONS: RunMetricDefinition[] = [
  definition('power_current_watts', 'Current board power', 'Power', 'W'),
  definition('cpu_usage_pct', 'CPU usage', 'CPU', '%'),
  definition('rtsn_0', 'MLA RTSN-0', 'MLA', 'C'),
];

/** A run with a sample at each of `seconds` after a common start, holding those values. */
function run(
  id: string,
  samples: [seconds: number, values: Record<string, number | null>][],
  metrics: RunMetricDefinition[] = DEFINITIONS,
): SavedRun {
  return {
    metadata: { ...SAVED_RUN.metadata, id, name: `run ${id}`, note: null },
    metrics,
    samples: samples.map(([seconds, values]) => ({
      timestamp: new Date(START + seconds * 1000).toISOString(),
      values,
    })),
  };
}

/** A run reading `key` as `value(t)` at each of `seconds`. */
function steady(
  id: string,
  seconds: number[],
  value: (t: number) => number | null,
  key = 'power_current_watts',
): SavedRun {
  return run(
    id,
    seconds.map((t) => [t, { [key]: value(t) }]),
  );
}

const range = (from: number, to: number, step: number): number[] =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

describe('compare address', () => {
  const read = (query: Record<string, string>) => readCompareParams(convertToParamMap(query));

  it('reads the ids trimmed, without empties or repeats, and a baseline among them', () => {
    expect(read({ runs: ' a, b,,a ', baseline: 'b' })).toEqual({ ids: ['a', 'b'], baseline: 'b' });
  });

  it('drops a baseline that is not one of the ids', () => {
    expect(read({ runs: 'a,b', baseline: 'c' })).toEqual({ ids: ['a', 'b'], baseline: null });
  });

  it('reads no ids from an address without runs', () => {
    expect(read({})).toEqual({ ids: [], baseline: null });
  });

  it('orders the baseline first, the others as they were', () => {
    expect(orderedIds(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(orderedIds(['a', 'b', 'c'], null)).toEqual(['a', 'b', 'c']);
  });
});

describe('compare series', () => {
  it('offers #170 seven series in order', () => {
    expect(COMPARE_SERIES.map((series) => series.key)).toEqual([
      'power_current_watts',
      'thermal_max',
      'cpu_usage_pct',
      'cpu_load_1',
      'linux_mem_used_mb',
      'mla_mem_allocated_mb',
      'ev74_cma_used_mb',
    ]);
    expect(COMPARE_SERIES[1].label).toBe('Thermal max');
  });

  it('keeps the series every run defines with one unit, thermal max in degrees', () => {
    expect(availableSeries(COMPARE_RAW.runs)).toEqual([
      { key: 'power_current_watts', label: 'Total power', unit: 'W' },
      { key: 'thermal_max', label: 'Thermal max', unit: 'C' },
      { key: 'cpu_usage_pct', label: 'CPU usage', unit: '%' },
    ]);
  });

  it('drops a series a run lacks or names in another unit, and thermal without sensors', () => {
    const watts = run('a', [], [definition('power_current_watts', 'Power', 'Power', 'W')]);
    const milliwatts = run('b', [], [definition('power_current_watts', 'Power', 'Power', 'mW')]);
    expect(availableSeries([watts, milliwatts])).toEqual([]);
    expect(availableSeries([watts, run('c', [])]).map((series) => series.key)).toEqual([
      'power_current_watts',
    ]);
  });
});

describe('compare overlay', () => {
  it('draws runs of 10 s and 20 s over the 10 s common window, both to its end', () => {
    const short = steady('short', range(0, 10, 2), (t) => t);
    const long = steady('long', range(0, 20, 4), (t) => 2 * t);
    const overlay = compareOverlay([short, long], 'power_current_watts')!;
    expect(overlay.windowMs).toBe(10_000);
    expect(overlay.times).toEqual([0, 2000, 4000, 6000, 8000, 10_000]);
    expect(overlay.series.map((series) => series.values.at(-1))).toEqual([10, 20]);
    expect(overlay.series.map((series) => [series.key, series.label])).toEqual([
      ['short', 'run short'],
      ['long', 'run long'],
    ]);
    expect(overlay.unit).toBe('W');
  });

  it('interpolates a run between its own neighbouring samples at the others offsets', () => {
    const a = steady('a', [0, 10], (t) => t + 1);
    const b = steady('b', [0, 4, 10], () => 3);
    const overlay = compareOverlay([a, b], 'power_current_watts')!;
    expect(overlay.times).toEqual([0, 4000, 10_000]);
    expect(overlay.series[0].values).toEqual([1, 5, 11]);
    expect(overlay.series[1].values).toEqual([3, 3, 3]);
  });

  it('keeps a missing reading a break in the line, never bridged', () => {
    const gappy = steady('gap', [0, 2, 4], (t) => (t === 2 ? null : t));
    const overlay = compareOverlay(
      [gappy, steady('b', [0, 3, 4], () => 1)],
      'power_current_watts',
    )!;
    expect(overlay.times).toEqual([0, 2000, 3000, 4000]);
    expect(overlay.series[0].values).toEqual([0, null, null, 4]);
  });

  it('draws no line for a run without samples and keeps the others over their window', () => {
    // Inv-S §13.28: an empty run used to make the window 0 and collapse every line.
    const a = steady('a', range(0, 10, 2), () => 8);
    const empty = steady('empty', range(0, 4, 2), () => null);
    const b = steady('b', range(0, 12, 2), () => 9);
    const overlay = compareOverlay([a, empty, b], 'power_current_watts')!;
    expect(overlay.windowMs).toBe(10_000);
    // Its series stays, all null, so every run keeps the colour of its place.
    expect(overlay.series.map((series) => series.key)).toEqual(['a', 'empty', 'b']);
    expect(overlay.series[1].values.every((value) => value === null)).toBe(true);
    expect(overlay.series[0].values.every((value) => value === 8)).toBe(true);
    expect(overlay.series[2].values.every((value) => value === 9)).toBe(true);
  });

  it('fits the domain to the windowed values, padded by a sixth of their spread', () => {
    const a = steady('a', range(0, 10, 5), () => 8);
    const b = steady('b', range(0, 20, 5), (t) => (t > 10 ? 50 : 10));
    const overlay = compareOverlay([a, b], 'power_current_watts')!;
    expect(overlay.domain[0]).toBeCloseTo(8 - 1 / 3);
    expect(overlay.domain[1]).toBeCloseTo(10 + 1 / 3);
  });

  it('gives a flat line a unit either side', () => {
    const overlay = compareOverlay(
      [steady('a', [0, 5], () => 8), steady('b', [0, 5], () => 8)],
      'power_current_watts',
    )!;
    expect(overlay.domain).toEqual([7, 9]);
  });

  it('is null when no run has samples for the series, or the runs cannot share it', () => {
    expect(compareOverlay(COMPARE_RAW.runs, 'cpu_usage_pct')).toBeNull();
    expect(compareOverlay(COMPARE_RAW.runs, 'cpu_load_1')).toBeNull();
  });

  it('derives thermal max per sample from each run own sensors, in degrees', () => {
    const overlay = compareOverlay(COMPARE_RAW.runs, 'thermal_max')!;
    expect(overlay.unit).toBe('C');
    expect(overlay.series[0].values[0]).toBe(55);
    expect(overlay.series[1].values[0]).toBe(40.75);
  });
});

describe('compare summary', () => {
  it('summarises each run inside the common window with Sentinel percentiles', () => {
    const a = steady('a', [0, 1, 2, 3], (t) => [4, 1, 3, 2][t]);
    const b = steady('b', [0, 1, 2, 3, 4, 5], () => 2);
    const [first, second] = compareSummary([a, b], 'power_current_watts');
    expect(first).toEqual({
      id: 'a',
      name: 'run a',
      baseline: true,
      samples: 4,
      minimum: 1,
      mean: 2.5,
      // sorted[round(3 * 0.5)] and sorted[round(3 * 0.95)], not the mean of the middle two.
      median: 3,
      p95: 4,
      maximum: 4,
      change: null,
      energy: expect.any(Number),
    });
    expect(second.baseline).toBe(false);
    expect(second.samples).toBe(4);
    expect(second.change).toBeCloseTo(-20);
  });

  it('integrates total power over the window into joules', () => {
    const constant = steady('a', range(0, 10, 1), () => 8);
    const longer = steady('b', range(0, 20, 3), () => 8);
    const rows = compareSummary([constant, longer], 'power_current_watts');
    expect(rows[0].energy).toBeCloseTo(80);
    // Cut at the window's edge, between its samples at 9 s and 12 s.
    expect(rows[1].energy).toBeCloseTo(80);
  });

  it('integrates power whichever series is shown', () => {
    const a = run(
      'a',
      range(0, 10, 5).map((t) => [t, { power_current_watts: 8, cpu_usage_pct: 50 }]),
    );
    expect(compareSummary([a, a], 'cpu_usage_pct')[0].energy).toBeCloseTo(80);
  });

  it('lists a run without samples with none, beside the others', () => {
    const a = steady('a', range(0, 10, 2), () => 8);
    const empty = steady('empty', range(0, 10, 2), () => null);
    const rows = compareSummary([a, empty], 'power_current_watts');
    expect(rows[1]).toEqual({
      id: 'empty',
      name: 'run empty',
      baseline: false,
      samples: 0,
      minimum: null,
      mean: null,
      median: null,
      p95: null,
      maximum: null,
      change: null,
      energy: null,
    });
    expect(rows[0].samples).toBe(6);
  });

  it('gives no change against a baseline whose mean is 0', () => {
    const zero = steady('a', [0, 5], () => 0);
    expect(
      compareSummary([zero, steady('b', [0, 5], () => 3)], 'power_current_watts')[1].change,
    ).toBeNull();
  });
});

describe('compare table', () => {
  const rows = compareTable(COMPARE_RAW);

  it('starts with the run totals, then the metrics by label', () => {
    expect(rows.map((row) => [row.label, row.group, row.unit])).toEqual([
      ['Duration', 'Run totals', 's'],
      ['Energy', 'Run totals', 'J'],
      ['Samples', 'Run totals', null],
      ['CPU usage', 'CPU', '%'],
      ['Current board power', 'Power', 'W'],
      ['LM96163 temp2', 'Board', 'C'],
      ['MLA RTSN-0', 'MLA', 'C'],
    ]);
    expect(rows[0].cells.map((cell) => cell.mean)).toEqual([8.129, 6.667]);
    expect(rows[1].cells.map((cell) => cell.mean)).toEqual([54.1891436875, 51.533604984375]);
    expect(rows[2].cells.map((cell) => cell.change)).toEqual([null, null]);
  });

  it('carries each run mean and Sentinel change, none for the baseline', () => {
    const power = rows.find((row) => row.key === 'power_current_watts')!;
    expect(power.cells).toEqual([
      { mean: 9.03125, change: null },
      { mean: 8.6171875, change: -4.58477508650519 },
    ]);
    const cpu = rows.find((row) => row.key === 'cpu_usage_pct')!;
    expect(cpu.cells).toEqual([
      { mean: null, change: null },
      { mean: null, change: null },
    ]);
    expect(power.definitionsDiffer).toBe(false);
  });

  it('marks a metric the runs defined differently and drops a unit they disagree on', () => {
    const relabelled: SavedRun = {
      ...OTHER,
      metrics: OTHER.metrics.map((metric) =>
        metric.key === 'power_current_watts' ? { ...metric, unit: 'mW' } : metric,
      ),
    };
    const answer: CompareExport = { ...COMPARE_RAW, runs: [BASELINE, relabelled] };
    const power = compareTable(answer).find((row) => row.key === 'power_current_watts')!;
    expect(power.label).toBe('Current board power (recorded definitions differ)');
    expect(power.definitionsDiffer).toBe(true);
    expect(power.unit).toBeNull();
  });

  it('groups the rows: All, Run totals, groups by name, Other last', () => {
    const undefinedKey: CompareExport = {
      ...COMPARE_RAW,
      summaries: {
        ...COMPARE_RAW.summaries,
        [BASELINE_ID]: {
          ...COMPARE_RAW.summaries[BASELINE_ID],
          metrics: {
            ...COMPARE_RAW.summaries[BASELINE_ID].metrics,
            mystery: { count: 1, minimum: 1, maximum: 1, mean: 1, median: 1, p95: 1 },
          },
        },
      },
    };
    expect(tableGroups(compareTable(undefinedKey))).toEqual([
      { group: 'All', count: 8 },
      { group: 'Run totals', count: 3 },
      { group: 'Board', count: 1 },
      { group: 'CPU', count: 1 },
      { group: 'MLA', count: 1 },
      { group: 'Power', count: 1 },
      { group: 'Other', count: 1 },
    ]);
  });

  it('keeps for Changes only the rows where some run changed', () => {
    expect(changesOnly(rows).map((row) => row.key)).toEqual([
      'power_current_watts',
      'lm96163_temp2',
      'rtsn_0',
    ]);
    const flat: CompareExport = {
      ...COMPARE_RAW,
      baseline_deltas_pct: {
        ...COMPARE_RAW.baseline_deltas_pct,
        [OTHER_ID]: { ...COMPARE_RAW.baseline_deltas_pct[OTHER_ID], rtsn_0: 0 },
      },
    };
    expect(changesOnly(compareTable(flat)).map((row) => row.key)).not.toContain('rtsn_0');
  });

  it('says what the filters leave out', () => {
    expect(tableStatus(12, 62, 50)).toBe(
      'Showing 12 of 62 rows. Changes only hides 50 rows where no run differs from the ' +
        'baseline. Export CSV still writes all 62.',
    );
    expect(tableStatus(3, 7, 1)).toBe(
      'Showing 3 of 7 rows. Changes only hides 1 row where no run differs from the baseline. ' +
        'Export CSV still writes all 7.',
    );
    expect(tableStatus(3, 7, 0)).toBe('Showing 3 of 7 rows. Export CSV still writes all 7.');
    expect(tableStatus(7, 7, 0)).toBe('');
  });
});

describe('change wording', () => {
  it('signs a change with a true minus and says when it is tiny or none', () => {
    expect(formatChange(-8.6)).toBe('−8.6%');
    expect(formatChange(3.2)).toBe('+3.2%');
    expect(formatChange(0)).toBe('±0%');
    expect(formatChange(0.004)).toBe('+<0.01%');
    expect(formatChange(-0.004)).toBe('−<0.01%');
    expect(formatChange(-25.811965811965816)).toBe('−25.8%');
    expect(formatChange(null)).toBe('');
  });
});

describe('compare CSV', () => {
  it('writes a header naming each run, baseline and note, and a row per table row', () => {
    const lines = compareCsv(COMPARE_RAW).split('\r\n');
    expect(lines[0]).toBe(
      'metric_key,label,group,unit,' +
        'tes3 (baseline) mean,tes3 (baseline) change vs baseline (%),' +
        'insight-hw-1790177227 (Insight hardware validation) mean,' +
        'insight-hw-1790177227 (Insight hardware validation) change vs baseline (%)',
    );
    expect(lines[1]).toBe('duration_ms,Duration,Run totals,s,8.129,,6.667,');
    expect(lines).toContain(
      'power_current_watts,Current board power,Power,W,9.03125,,8.6171875,-4.58477508650519',
    );
    expect(lines).toContain('cpu_usage_pct,CPU usage,CPU,%,,,,');
    expect(lines).toContain(
      'rtsn_0,MLA RTSN-0,MLA,°C,52.24506225585937,,38.5093566894531,-26.29091625757568',
    );
    expect(lines.at(-1)).toBe('');
    expect(lines).toHaveLength(9);
  });

  it('guards a label a spreadsheet would run as a formula', () => {
    const formula = (entry: SavedRun): SavedRun => ({
      ...entry,
      metrics: entry.metrics.map((metric) =>
        metric.key === 'rtsn_0' ? { ...metric, label: '=1+1' } : metric,
      ),
    });
    const answer: CompareExport = { ...COMPARE_RAW, runs: COMPARE_RAW.runs.map(formula) };
    expect(compareCsv(answer).split('\r\n')).toContain(
      "rtsn_0,'=1+1,MLA,°C,52.24506225585937,,38.5093566894531,-26.29091625757568",
    );
  });

  it('names the file after the baseline, sanitised, and the local day', () => {
    expect(compareCsvFilename('yolo/26 base', new Date(2026, 9, 25))).toBe(
      'sentinel-compare-yolo-26-base-2026-10-25.csv',
    );
    expect(compareCsvFilename('résumé v2', new Date(2026, 0, 2))).toBe(
      'sentinel-compare-resume-v2-2026-01-02.csv',
    );
    expect(compareCsvFilename('///', new Date(2026, 0, 2))).toBe(
      'sentinel-compare-runs-2026-01-02.csv',
    );
    expect(compareCsvFilename('x'.repeat(100), new Date(2026, 0, 2))).toBe(
      `sentinel-compare-${'x'.repeat(80)}-2026-01-02.csv`,
    );
  });
});
