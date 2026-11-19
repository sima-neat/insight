import type { SentinelCache, SentinelMetric } from './api';
import { cacheWith, LIVE_METRICS, LIVE_VALUES } from './stats.testing';
import {
  AREA_LABELS,
  HISTORY_SAMPLES,
  OVERVIEW_CARDS,
  areaMetrics,
  boardPowerChart,
  cacheAfter,
  cardReported,
  cardShown,
  coreSummary,
  csvField,
  currentTotal,
  currentValue,
  mergeTelemetry,
  metricByKey,
  metricChart,
  metricsMatching,
  networkChart,
  pairChart,
  powerRailsChart,
  sessionCsv,
  sessionCsvFilename,
  thermalGroups,
  thermalMax,
  thermalMaxChart,
  type StatsArea,
  type TelemetryWindow,
} from './telemetry';

const START = Date.parse('2026-10-24T10:00:00Z');
const AREAS = Object.keys(AREA_LABELS) as StatsArea[];

const BOARD = 'local';

/** The live board's cache answer with `samples` samples whose reading is its own index plus `after`. */
function answer(samples: number, options: { after?: number; full?: boolean } = {}): SentinelCache {
  const { after = 0, full = true } = options;
  return cacheWith(samples, {
    start: new Date(START + after * 2000).toISOString(),
    full,
    values: (_key, i) => after + i,
  });
}

/**
 * The live board's window of `samples` samples: each reads its own index, but for the newest,
 * which holds the capture's readings, so every metric's value is the captured one.
 */
const live = (samples = 20) =>
  mergeTelemetry(
    null,
    cacheWith(samples, {
      start: new Date(START).toISOString(),
      values: (key, i) => (i === samples - 1 ? (LIVE_VALUES[key] ?? null) : i),
    }),
    BOARD,
  );

const metric = (extra: Partial<SentinelMetric>): SentinelMetric => ({
  key: 'rtsn_0',
  label: 'MLA RTSN-0',
  short: 'MLA-0',
  unit: 'C',
  description: null,
  group: 'MLA',
  warn: 70,
  critical: 85,
  value: 60,
  status: 'ok',
  ...extra,
});

/** A window written by hand, aligned as a merge leaves it; a null timestamp cannot be read. */
function windowOf(
  metrics: readonly SentinelMetric[],
  series: Record<string, (number | null)[]>,
  timestamps: (string | null)[] = Object.values(series)[0].map((_, i) =>
    new Date(START + i * 2000).toISOString(),
  ),
): TelemetryWindow {
  return {
    board: BOARD,
    metrics,
    sampled: [],
    timestamps: timestamps.map((stamp) => stamp ?? 'not a time'),
    times: timestamps.map((stamp) => (stamp === null ? null : Date.parse(stamp))),
    series,
  };
}

/** Timestamps at these offsets, in seconds, from the start. */
const stamps = (offsets: number[]) =>
  offsets.map((second) => new Date(START + second * 1000).toISOString());

/** The live window with some metrics left out of what the board reports. */
function without(window: TelemetryWindow, drop: (m: SentinelMetric) => boolean): TelemetryWindow {
  const metrics = window.metrics.filter((m) => !drop(m));
  return {
    ...window,
    metrics,
    series: Object.fromEntries(metrics.map((m) => [m.key, window.series[m.key]])),
  };
}

describe('cacheAfter', () => {
  it('asks for the whole cache first, then for the samples after the newest held one', () => {
    expect(cacheAfter(null, BOARD)).toBeNull();
    const held = live(10);
    expect(cacheAfter(held, BOARD)).toBe(held.timestamps[9]);
  });

  it('asks for the whole cache again for another board, or with nothing held', () => {
    const held = live(10);
    expect(cacheAfter(held, 'ssh:sima@192.168.1.20:22')).toBeNull();
    expect(cacheAfter({ ...held, timestamps: [] }, BOARD)).toBeNull();
  });
});

describe('mergeTelemetry', () => {
  it('a full answer replaces the window; an incremental one appends and trims to 240', () => {
    const first = mergeTelemetry(null, answer(200), BOARD);
    expect(first.timestamps).toHaveLength(200);
    expect(first.board).toBe(BOARD);

    // 60 newer samples after the 200 held: 260 in all, of which the newest 240 stay.
    const merged = mergeTelemetry(first, answer(60, { after: 200, full: false }), BOARD);
    expect(merged.timestamps).toHaveLength(240);
    expect(merged.timestamps[0]).toBe(new Date(START + 20 * 2000).toISOString());
    expect(merged.timestamps.at(-1)).toBe(new Date(START + 259 * 2000).toISOString());
    expect(merged.series['cpu_usage_pct'].slice(0, 2)).toEqual([20, 21]);
    expect(merged.series['cpu_usage_pct'].at(-1)).toBe(259);

    const replaced = mergeTelemetry(merged, answer(5, { after: 300, full: true }), BOARD);
    expect(replaced.timestamps).toHaveLength(5);
    expect(replaced.series['cpu_usage_pct']).toEqual([300, 301, 302, 303, 304]);
  });

  it('a metric’s value is the newest sample’s reading, with its status against its thresholds', () => {
    const merged = mergeTelemetry(null, answer(90), BOARD);
    const cpu = metricByKey(merged, 'cpu_usage_pct')!;
    // 89 is past the CPU's warn level (80) and short of its critical one (95).
    expect([cpu.value, cpu.warn, cpu.critical, cpu.status]).toEqual([89, 80, 95, 'warn']);
    // An incremental answer with no new sample keeps the newest held reading.
    const quiet = mergeTelemetry(merged, answer(0, { after: 90, full: false }), BOARD);
    expect(metricByKey(quiet, 'cpu_usage_pct')?.value).toBe(89);
    expect(quiet.timestamps).toHaveLength(90);
  });

  it('a full answer longer than the window keeps the newest 240', () => {
    const merged = mergeTelemetry(null, answer(300), BOARD);
    expect(merged.timestamps).toHaveLength(HISTORY_SAMPLES);
    expect(merged.series['cpu_usage_pct'][0]).toBe(60);
  });

  it('what is held of another board is replaced whatever full says', () => {
    const held = live(30);
    const other = mergeTelemetry(held, answer(4, { after: 30, full: false }), 'other');
    expect(other.board).toBe('other');
    expect(other.timestamps).toHaveLength(4);
    expect(other.series['cpu_usage_pct']).toEqual([30, 31, 32, 33]);
  });

  it('a metric new in an incremental answer gets nulls before it; one a sample leaves out gets null; a dropped one leaves', () => {
    const held = mergeTelemetry(null, answer(5), BOARD);
    const definitions = [
      ...LIVE_METRICS.filter((m) => m.key !== 'net_rx_mbps'),
      { key: 'extra_metric', group: 'Extra', unit: 'W' },
    ];
    // net_rx_mbps is no longer defined or sampled, cpu_usage_pct is defined but not sampled and
    // extra_metric is new.
    const next = cacheWith(3, {
      start: new Date(START + 5 * 2000).toISOString(),
      full: false,
      metrics: definitions,
      values: (key, i) =>
        key === 'cpu_usage_pct' ? undefined : key === 'extra_metric' ? i + 1 : 0,
    });

    const merged = mergeTelemetry(held, next, BOARD);
    expect(merged.timestamps).toHaveLength(8);
    expect(merged.series['extra_metric']).toEqual([null, null, null, null, null, 1, 2, 3]);
    expect(merged.series['cpu_usage_pct']).toEqual([0, 1, 2, 3, 4, null, null, null]);
    expect(metricByKey(merged, 'cpu_usage_pct')?.status).toBe('unavailable');
    expect('net_rx_mbps' in merged.series).toBe(false);
    expect(merged.metrics.some((m) => m.key === 'net_rx_mbps')).toBe(false);
    expect(merged.metrics.at(-1)).toMatchObject({ key: 'extra_metric', value: 3, group: 'Extra' });
  });

  it('a sampled key without a definition is shown after the defined ones, under Other', () => {
    const base = answer(2);
    const merged = mergeTelemetry(
      null,
      {
        ...base,
        samples: base.samples.map((sample) => ({
          ...sample,
          values: { ...sample.values, zeta_unknown: 7, alpha_unknown: null },
        })),
      },
      BOARD,
    );
    expect(merged.metrics).toHaveLength(61);
    expect(merged.metrics.slice(-2)).toEqual([
      expect.objectContaining({ key: 'alpha_unknown', label: 'Alpha unknown', group: 'Other' }),
      expect.objectContaining({ key: 'zeta_unknown', value: 7, status: 'ok', unit: null }),
    ]);
    expect(merged.metrics[59].status).toBe('unavailable');
  });

  it('every series stays as long as the timestamps after any merge', () => {
    let held: TelemetryWindow | null = null;
    const steps: SentinelCache[] = [
      answer(100),
      answer(100, { after: 100, full: false }),
      answer(100, { after: 200, full: false }),
      answer(3, { after: 300 }),
      answer(2, { after: 303, full: false }),
    ];
    for (const step of steps) {
      held = mergeTelemetry(held, step, BOARD);
      for (const key of held.metrics.map((m) => m.key)) {
        expect(held.series[key], key).toHaveLength(held.timestamps.length);
      }
      expect(held.times).toHaveLength(held.timestamps.length);
      expect(Object.keys(held.series).sort()).toEqual(held.metrics.map((m) => m.key).sort());
    }
  });

  it('lists the metrics in Sentinel’s order', () => {
    const reversed = [...LIVE_METRICS].reverse();
    const merged = mergeTelemetry(null, cacheWith(2, { metrics: reversed }), BOARD);
    expect(merged.metrics.map((m) => m.key)).toEqual(reversed.map((m) => m.key));
  });

  it('reads each timestamp as a time, null where it cannot be read, and leaves out a sample without one', () => {
    const base = answer(3);
    const merged = mergeTelemetry(
      null,
      {
        ...base,
        samples: [
          base.samples[0],
          { ...base.samples[1], timestamp: 'not a time' },
          { values: {} } as never,
        ],
      },
      BOARD,
    );
    expect(merged.times).toEqual([START, null]);
    expect(merged.timestamps).toEqual([base.samples[0].timestamp, 'not a time']);
  });
});

describe('what the page derives from the window', () => {
  // #170's "every live metric lands in exactly one of Power, Thermal and System, by the
  // dashboard's rules", with the four areas of the side panel.
  it('every live metric lands in exactly one area, by the dashboard’s rules', () => {
    const window = live(2);
    const byArea = Object.fromEntries(AREAS.map((area) => [area, areaMetrics(window, area)]));
    const all = window.metrics.map((m) => m.key);
    expect(all).toHaveLength(59);
    const placed = AREAS.flatMap((area) => byArea[area].map((m) => m.key));
    expect([...placed].sort()).toEqual([...all].sort());
    expect(new Set(placed).size).toBe(placed.length);
    expect(AREAS.map((area) => byArea[area].length)).toEqual([17, 11, 25, 6]);

    const groupsOf = (metrics: readonly SentinelMetric[]) =>
      [...new Set(metrics.map((m) => m.group))].sort();
    expect(groupsOf(byArea['thermal'])).toEqual(['APU', 'Board', 'CVU', 'MLA', 'TOP']);
    expect(byArea['thermal'].every((m) => m.unit === 'C')).toBe(true);
    expect(groupsOf(byArea['power'])).toEqual(['Power', 'PowerRail']);
    expect(byArea['system'].some((m) => m.key === 'mla_mem_allocated_mb')).toBe(true);
    expect(groupsOf(byArea['storage'])).toEqual(['Disk', 'DiskIO', 'Network']);
    expect(Object.values(AREA_LABELS)).toEqual(['Thermal', 'Power', 'System', 'Storage & Network']);
  });

  it('storage takes the disk, network and nvme groups and any disk_, net_ or nvme key', () => {
    const window = windowOf(
      [
        metric({ key: 'a', unit: '%', group: 'NVMe' }),
        metric({ key: 'disk_x', unit: 'MB', group: 'Misc' }),
        metric({ key: 'net_x', unit: 'MB/s', group: 'Misc' }),
        metric({ key: 'nvme_used_pct', unit: '%', group: 'Misc' }),
        metric({ key: 'cpu_x', unit: '%', group: 'Network' }),
        metric({ key: 'other', unit: 'MB', group: 'Misc' }),
      ],
      { a: [1], disk_x: [1], net_x: [1], nvme_used_pct: [1], cpu_x: [1], other: [1] },
    );
    expect(areaMetrics(window, 'storage').map((m) => m.key)).toEqual([
      'a',
      'disk_x',
      'net_x',
      'nvme_used_pct',
      'cpu_x',
    ]);
  });

  // #170's "the live board: thermal groups in Sentinel order, cores and rails by key".
  it('the live board: thermal groups in Sentinel order, cores and rails by key', () => {
    const window = live(2);
    expect(thermalGroups(window).map((group) => [group.name, group.metrics.length])).toEqual([
      ['APU', 2],
      ['Board', 3],
      ['CVU', 2],
      ['MLA', 8],
      ['TOP', 2],
    ]);
    expect(metricsMatching(window, /^cpu_core_\d+_usage_pct$/)).toHaveLength(16);
    expect(metricsMatching(window, /^power_rail_/)).toHaveLength(8);
    expect(thermalGroups(windowOf([], {}, []))).toEqual([]);
  });

  it('a thermal group carries the alert of its sensors', () => {
    const window = windowOf(
      [
        metric({ key: 'a', group: 'MLA', status: 'warn' }),
        metric({ key: 'b', group: 'MLA', status: 'critical' }),
        metric({ key: 'c', group: 'MLA', status: 'warn' }),
        metric({ key: 'd', group: 'Board', status: 'ok' }),
      ],
      { a: [1], b: [1], c: [1], d: [1] },
    );
    expect(thermalGroups(window).map((group) => [group.name, group.alert])).toEqual([
      ['MLA', { tone: 'critical', count: 1 }],
      ['Board', null],
    ]);
  });

  // The derived-series half of #170's "a missing sample breaks the line instead of dropping to
  // zero; stacked areas and derived series".
  it('a missing sample breaks the line instead of dropping to zero in the derived series', () => {
    const window = windowOf(
      [
        metric({ key: 'a', group: 'MLA' }),
        metric({ key: 'b', group: 'Board' }),
        metric({ key: 'rx', unit: 'MB/s', group: 'Network' }),
      ],
      { a: [60, null, 70], b: [65, null, 62], rx: [1, 2, null] },
    );
    expect(thermalMax(window)?.values).toEqual([65, null, 70]);
    expect([currentTotal([1, 2]), currentTotal([1, null]), currentTotal([])]).toEqual([
      3,
      null,
      null,
    ]);
    expect([currentValue([1, 2]), currentValue([1, 2, null]), currentValue([])]).toEqual([
      2,
      null,
      null,
    ]);
    expect(thermalMax(windowOf([metric({ key: 'rx', unit: 'MB/s' })], { rx: [1] }))).toBeNull();
  });

  it('thermalMax names the hottest sensor now and shares thresholds only when every sensor has the same', () => {
    const sensors = [
      metric({ key: 'a', short: 'A', value: 60 }),
      metric({ key: 'b', short: 'B', value: 78, status: 'warn' }),
      metric({ key: 'c', short: 'C', value: null, status: 'unavailable' }),
    ];
    const series = { a: [60], b: [78], c: [null] };
    const same = thermalMax(windowOf(sensors, series));
    expect(same?.hottest?.key).toBe('b');
    expect(same?.thresholds).toEqual([
      { value: 70, tone: 'warning', label: 'Warning 70 °C' },
      { value: 85, tone: 'danger', label: 'Critical 85 °C' },
    ]);

    const differing = thermalMax(
      windowOf([...sensors.slice(0, 2), metric({ key: 'c', warn: 80, critical: 95 })], series),
    );
    expect(differing?.thresholds).toEqual([]);

    const unmeasured = thermalMax(windowOf([metric({ key: 'a', value: null })], { a: [null] }));
    expect(unmeasured?.hottest).toBeNull();
    expect(unmeasured?.values).toEqual([null]);
  });

  // The one-minute half of #170's "the per-core minute and heatmap columns follow board time
  // when polling is uneven".
  it('the per-core minute follows board time when polling is uneven', () => {
    const core = metric({
      key: 'cpu_core_0_usage_pct',
      short: 'c0',
      label: 'CPU core 0 usage',
      unit: '%',
      warn: 80,
      critical: 95,
    });
    // 40 samples two seconds apart at 100%, then a back-off: 20 samples at 10% within the
    // final 30 seconds, ten minutes on.
    const offsets = [
      ...Array.from({ length: 40 }, (_, i) => i * 2),
      ...Array.from({ length: 20 }, (_, i) => 600 + i * 1.5),
    ];
    const values = [...new Array(40).fill(100), ...new Array(20).fill(10)];
    const timed = coreSummary(windowOf([core], { [core.key]: values }, stamps(offsets)));
    expect(timed.average).toBe(10);
    expect(timed.rows[0].recent).toBe(10);
    // Without times the last 30 samples stand in: ten at 100% and twenty at 10%.
    const untimed = coreSummary(windowOf([core], { [core.key]: values }, new Array(60).fill(null)));
    expect(untimed.average).toBe(40);
  });

  it('per-core summary: a one-minute average per core, a tone, the busiest and the average', () => {
    const cores = [0, 1, 2].map((n) =>
      metric({
        key: `cpu_core_${n}_usage_pct`,
        short: `c${n}`,
        label: `CPU core ${n} usage`,
        unit: '%',
        warn: 80,
        critical: 95,
      }),
    );
    const summary = coreSummary(
      windowOf(
        [...cores, metric({ key: 'cpu_usage_pct', unit: '%' })],
        {
          cpu_core_0_usage_pct: [10, 30, 50, 70],
          cpu_core_1_usage_pct: [90, 90, 90, 98],
          cpu_core_2_usage_pct: [null, null, null, null],
          cpu_usage_pct: [1, 1, 1, 1],
        },
        new Array(4).fill(null),
      ),
    );
    expect(summary.rows.map((row) => [row.key, row.label, row.recent, row.tone])).toEqual([
      ['cpu_core_0_usage_pct', 'c0', 40, 'default'],
      ['cpu_core_1_usage_pct', 'c1', 92, 'warning'],
      ['cpu_core_2_usage_pct', 'c2', null, 'default'],
    ]);
    expect(summary.rows[0].values).toEqual([10, 30, 50, 70]);
    // A core that did not report is left out of the average.
    expect(summary.average).toBe(66);
    expect(summary.busiest).toEqual({ label: 'c1', recent: 92 });

    const critical = coreSummary(
      windowOf([cores[0]], { cpu_core_0_usage_pct: [96, 97] }, new Array(2).fill(null)),
    );
    expect(critical.rows[0].tone).toBe('danger');
    expect(coreSummary(windowOf([], {}, []))).toEqual({ rows: [], average: null, busiest: null });
  });

  it('the live board has sixteen cores', () => {
    expect(coreSummary(live(10)).rows).toHaveLength(16);
  });
});

describe('the overview cards', () => {
  it('lists the six cards in #170’s order with their areas and keys', () => {
    expect(OVERVIEW_CARDS.map((card) => [card.id, card.heading, card.area, card.keys])).toEqual([
      ['thermal-max', 'Thermal max', 'thermal', []],
      ['board-power', 'Board power', 'power', ['power_current_watts']],
      ['cpu', 'CPU usage', 'system', ['cpu_usage_pct']],
      ['linux-memory', 'Linux memory', 'system', ['linux_mem_used_pct']],
      ['mla-memory', 'MLA memory', 'system', ['mla_mem_allocated_mb']],
      ['network', 'Network', 'storage', ['net_rx_mbps', 'net_tx_mbps']],
    ]);
  });

  it('a card is shown while its area has metrics and reports Not reported when its own keys are missing', () => {
    const window = live(3);
    expect(
      OVERVIEW_CARDS.every((card) => cardShown(window, card) && cardReported(window, card)),
    ).toBe(true);

    const card = (id: string) => OVERVIEW_CARDS.find((c) => c.id === id)!;

    // Network's keys are gone but the area still has the disk metrics: shown, not reported.
    const noNetwork = without(window, (m) => m.key.startsWith('net_'));
    expect([
      cardShown(noNetwork, card('network')),
      cardReported(noNetwork, card('network')),
    ]).toEqual([true, false]);
    // One of two keys is enough.
    const noReceive = without(window, (m) => m.key === 'net_rx_mbps');
    expect(cardReported(noReceive, card('network'))).toBe(true);

    // With nothing left in the storage area the card is hidden.
    const noStorage = without(window, (m) => areaMetrics(window, 'storage').includes(m));
    expect([
      cardShown(noStorage, card('network')),
      cardReported(noStorage, card('network')),
    ]).toEqual([false, false]);

    // Thermal max is reported while any temperature is.
    const noThermal = without(window, (m) => areaMetrics(window, 'thermal').includes(m));
    expect([
      cardShown(noThermal, card('thermal-max')),
      cardReported(noThermal, card('thermal-max')),
    ]).toEqual([false, false]);
    const oneSensor = without(
      window,
      (m) => m.key !== 'rtsn_0' && areaMetrics(window, 'thermal').includes(m),
    );
    expect(cardReported(oneSensor, card('thermal-max'))).toBe(true);
  });
});

describe('the chart inputs', () => {
  it('metricChart: the metric’s series on the scale of its unit, its thresholds, its status’s tone and its value', () => {
    const window = live(5);
    const cpu = metricChart(window, 'cpu_usage_pct');
    const short = window.metrics.find((m) => m.key === 'cpu_usage_pct')?.short;
    expect(cpu?.series).toEqual([
      { key: 'cpu_usage_pct', label: short, values: [0, 1, 2, 3, LIVE_VALUES['cpu_usage_pct']] },
    ]);
    expect(cpu?.domain).toEqual([0, 100]);
    expect(cpu?.thresholds.map((t) => t.label)).toEqual(['Warning 80%', 'Critical 95%']);
    expect(cpu?.tone).toBe('default');
    expect(cpu?.headline).toBe('37.5%');

    const hot: TelemetryWindow = {
      ...window,
      metrics: window.metrics.map((m) =>
        m.key === 'cpu_usage_pct' ? { ...m, value: 97, status: 'critical' } : m,
      ),
    };
    expect(metricChart(hot, 'cpu_usage_pct')?.tone).toBe('danger');
    expect(metricChart(window, 'no_such_metric')).toBeNull();
  });

  it('metricChart takes a known capacity as its ceiling and keeps the current value in its scale', () => {
    const window = live(5);
    expect(metricChart(window, 'ev74_cma_used_mb', 1788)?.domain).toEqual([0, 1788]);
    // MLA memory reads 742 MB now: the scale is a round number above it, not above the samples.
    expect(metricChart(window, 'mla_mem_allocated_mb')?.domain).toEqual([0, 1000]);
  });

  it('pairChart: both series, one scale, labels by position, the current total as its headline', () => {
    const window = live(5);
    const network = pairChart(window, ['net_rx_mbps', 'net_tx_mbps'], ['Receive', 'Transmit']);
    expect(network?.series.map((s) => [s.key, s.label])).toEqual([
      ['net_rx_mbps', 'Receive'],
      ['net_tx_mbps', 'Transmit'],
    ]);
    expect(network?.headline).toBe('2.82 MB/s');
    // The history reads 0 to 3 MB/s on each before the newest: the scale is a round number above.
    expect(network?.domain).toEqual([0, 4]);
    expect(network?.thresholds).toEqual([]);
    expect(network?.tone).toBe('default');
  });

  it('pairChart keeps the label of a metric by its place in the request, and has no total when one is missing', () => {
    const window = without(live(5), (m) => m.key === 'net_rx_mbps');
    const network = pairChart(window, ['net_rx_mbps', 'net_tx_mbps'], ['Receive', 'Transmit']);
    expect(network?.series.map((s) => s.label)).toEqual(['Transmit']);
    expect(network?.headline).toBe('—');
    expect(pairChart(window, ['net_rx_mbps', 'nothing'], ['Receive', 'Other'])).toBeNull();
  });

  it('networkChart is the pair chart of receive and transmit that the Network card and its area share', () => {
    const window = live(5);
    expect(networkChart(window)).toEqual(
      pairChart(window, ['net_rx_mbps', 'net_tx_mbps'], ['Receive', 'Transmit']),
    );
    expect(OVERVIEW_CARDS.find((card) => card.id === 'network')?.keys).toEqual([
      'net_rx_mbps',
      'net_tx_mbps',
    ]);
    expect(networkChart(without(window, (m) => m.key.startsWith('net_')))).toBeNull();
  });

  it('thermalMaxChart draws the hottest reading per sample with the shared thresholds and the hottest sensor’s tone', () => {
    const sensors = [
      metric({ key: 'a', short: 'A', group: 'Board', value: 60 }),
      metric({ key: 'b', short: 'B', group: 'MLA', value: 78, status: 'warn' }),
    ];
    const chart = thermalMaxChart(windowOf(sensors, { a: [60, 61], b: [55, 78] }));
    expect(chart?.series).toEqual([
      { key: 'thermal-max', label: 'Hottest sensor', values: [60, 78] },
    ]);
    expect(chart?.domain).toEqual([40, 90]);
    expect(chart?.thresholds.map((t) => t.value)).toEqual([70, 85]);
    expect(chart?.tone).toBe('warning');
    expect(chart?.headline).toBe('78 °C (B)');

    const none = thermalMaxChart(windowOf([metric({ key: 'a', value: null })], { a: [null] }));
    expect([none?.tone, none?.headline]).toEqual(['default', '—']);
    expect(thermalMaxChart(without(live(2), (m) => m.unit === 'C'))).toBeNull();
  });

  it('boardPowerChart: one ceiling over the current, average and peak, with the session average as its reference', () => {
    const window = live(5);
    const power = boardPowerChart(window);
    expect(power?.series.map((s) => s.key)).toEqual(['power_current_watts']);
    // The live board's peak is 16.1 W: a round number a tenth above it.
    expect(power?.domain).toEqual([0, 20]);
    expect(power?.reference).toEqual({
      value: 11.154253915959291,
      label: 'Session average 11.2 W',
    });
    expect(power?.headline).toBe('11.6 W');
    expect(power?.tone).toBe('default');

    // The peak sets the ceiling even when the plotted series is far below it.
    const high: TelemetryWindow = {
      ...window,
      series: { ...window.series, power_peak_watts: [118, 118, 118, 118, 118] },
      metrics: window.metrics.map((m) => (m.key === 'power_peak_watts' ? { ...m, value: 118 } : m)),
    };
    expect(boardPowerChart(high)?.domain).toEqual([0, 150]);

    const noAverage = without(window, (m) => m.key === 'power_average_watts');
    expect(boardPowerChart(noAverage)?.reference).toBeNull();
    expect(boardPowerChart(without(window, (m) => m.key === 'power_current_watts'))).toBeNull();
  });
});

describe('the chart inputs, continued', () => {
  it('metricByKey finds a metric by its key, and says nothing for one the board does not report', () => {
    const window = live(2);
    expect(metricByKey(window, 'cpu_usage_pct')?.label).toBe('CPU usage');
    expect(metricByKey(window, 'no_such_metric')).toBeUndefined();
  });

  it('every chart names the unit its values are worded in', () => {
    const window = live(5);
    expect(metricChart(window, 'cpu_usage_pct')?.unit).toBe('%');
    expect(metricChart(window, 'mla_mem_allocated_mb')?.unit).toBe('MB');
    expect(pairChart(window, ['net_rx_mbps', 'net_tx_mbps'], ['Receive', 'Transmit'])?.unit).toBe(
      'MB/s',
    );
    expect(thermalMaxChart(window)?.unit).toBe('C');
    expect(boardPowerChart(window)?.unit).toBe('W');
  });

  it('powerRailsChart: a band per rail in Sentinel’s order, the total as its headline, a scale that holds the stack', () => {
    const window = live(5);
    const rails = powerRailsChart(window);
    expect(rails?.series.map((s) => s.label)).toEqual([
      'SoC and DDR VDD',
      'HDMI 1.2V',
      'SoC and DDR VDDQ',
      'SoC and DDR VDD2H',
      'MLA 0.68V',
      'PCIe and ETH VP',
      'SOM Platform 1.8V',
      'SOM Platform 3.3V',
    ]);
    // The rails sum to 11.625 W now. Before that the history reads 0 to 3 W on each of the eight
    // rails, so its largest total is 24 W and the scale is a round number a tenth above that.
    expect(rails?.headline).toBe('11.63 W across 8 rails');
    expect(rails?.domain).toEqual([0, 30]);
  });

  it('powerRailsChart: the scale follows the largest total over the window, and a missing rail leaves no total now', () => {
    const rails = [
      metric({ key: 'power_rail_a_watts', short: 'A', unit: 'W', value: 1, group: 'PowerRail' }),
      metric({ key: 'power_rail_b_watts', short: 'B', unit: 'W', value: null, group: 'PowerRail' }),
    ];
    const chart = powerRailsChart(
      windowOf(rails, { power_rail_a_watts: [4, 1, 1], power_rail_b_watts: [3, null, 1] }),
    );
    // Only the first sample is complete: 4 + 3 = 7 W, so the scale reaches past 7.
    expect(chart?.domain).toEqual([0, 8]);
    expect(chart?.headline).toBe('— across 2 rails');
    expect(
      powerRailsChart(windowOf(rails.slice(0, 1), { power_rail_a_watts: [1] }))?.headline,
    ).toBe('1.00 W across 1 rail');
    expect(powerRailsChart(without(live(2), (m) => m.key.startsWith('power_rail_')))).toBeNull();
  });
});

describe('the session as CSV', () => {
  // #170's "a CSV field is quoted and escaped only when it has to be".
  it('a CSV field is quoted and escaped only when it has to be', () => {
    const cases: [string | number | null, string][] = [
      ['plain', 'plain'],
      ['before, after', '"before, after"'],
      ['say "hi"', '"say ""hi"""'],
      ['two\nlines', '"two\nlines"'],
      [' padded', '" padded"'],
      [-0.35731427657192105, '-0.35731427657192105'],
      [0, '0'],
      [null, ''],
      [Number.NaN, ''],
      ['=HYPERLINK("x")', '"\'=HYPERLINK(""x"")"'],
      ['@sum', "'@sum"],
    ];
    for (const [value, field] of cases) expect(csvField(value), String(value)).toBe(field);
  });

  // #170's "the session exports as CSV: a row per sample, a column per metric, empty where the
  // board took no reading".
  it('the session exports as CSV: a row per sample, a column per metric, empty where the board took no reading', () => {
    const window = windowOf(
      [
        metric({ key: 'power', label: 'Current board power', unit: 'W' }),
        metric({ key: 'rtsn_0', label: 'MLA RTSN-0', unit: 'C' }),
        metric({ key: 'load', label: 'CPU load 1m', unit: 'load' }),
      ],
      { power: [12.5, 13], rtsn_0: [55.1, null], load: [6.01, 6.2] },
      ['2026-09-25T18:40:00Z', '2026-09-25T18:40:02Z'],
    );
    expect(sessionCsv(window)).toBe(
      [
        'timestamp,Current board power (W),MLA RTSN-0 (°C),CPU load 1m',
        '2026-09-25T18:40:00Z,12.5,55.1,6.01',
        '2026-09-25T18:40:02Z,13,,6.2',
        '',
      ].join('\r\n'),
    );
    expect(sessionCsv(windowOf([], {}, []))).toBe('');
    expect(sessionCsv(windowOf([metric({ key: 'a' })], { a: [] }, []))).toBe('');
  });

  it('exports the live window with a column for every metric in Sentinel order', () => {
    const window = live(3);
    const lines = sessionCsv(window).split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[0].split(',')).toHaveLength(60);
    expect(lines[1].startsWith(window.timestamps[0] as string)).toBe(true);
  });

  it('names the file by local time, safe on every filesystem', () => {
    expect(sessionCsvFilename(new Date(2026, 8, 25, 18, 4, 5))).toBe(
      'sentinel-session-2026-09-25-180405.csv',
    );
  });
});
