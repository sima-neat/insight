import type { MetricStatus, SentinelMetric } from './api';
import {
  alertLabel,
  fixedValue,
  formatDuration,
  formatElapsed,
  formatEnergy,
  formatNumber,
  formatValue,
  isTemperatureUnit,
  isThermalMetric,
  lineTone,
  metricAlert,
  metricSection,
  statusLabel,
  thresholdText,
  thresholdsOf,
  unitAfter,
  unitSuffix,
} from './format';
import { joinMetric } from './metrics';
import { LIVE_METRICS } from './stats.testing';

const metric = (extra: Partial<SentinelMetric>): SentinelMetric => ({
  key: 'rtsn_0',
  label: 'MLA RTSN-0',
  short: 'MLA-0',
  unit: 'C',
  description: null,
  group: 'MLA',
  warn: 70,
  critical: 85,
  value: 72,
  status: 'warn',
  ...extra,
});

describe('what a metric is', () => {
  // #170's "a temperature is told by its unit first, and by its name only when it has no unit".
  it('a temperature is told by its unit first, and by its name only when it has no unit', () => {
    const thermal = [
      { key: 'rtsn_0', unit: 'C' },
      { key: 'x', unit: '°C' },
      { key: 'x', unit: ' celsius ' },
      { key: 'soc_temp', label: 'SoC temp' },
      { key: 'rtsn_3', unit: '' },
    ];
    for (const m of thermal) expect(isThermalMetric(m), JSON.stringify(m)).toBe(true);
    for (const m of [
      { key: 'disk_tempfs_used_pct', label: 'Tempfs used', unit: '%' },
      { key: 'cpu_usage_pct', unit: '%' },
      null,
    ]) {
      expect(isThermalMetric(m), JSON.stringify(m)).toBe(false);
    }
    expect(['C', '°C', 'degC', 'deg C', 'Celsius'].every(isTemperatureUnit)).toBe(true);
    expect([isTemperatureUnit('%'), isTemperatureUnit(null)]).toEqual([false, false]);

    const sections: [Parameters<typeof metricSection>[0], string | undefined][] = [
      [{ key: 'pmic_temp', unit: 'C' }, 'Power'],
      [{ key: 'usb_watts', unit: 'W' }, 'Board'],
      [{ key: 'rail', unit: 'A' }, 'Power Rail'],
      [{ key: 'net_rx_mbps', unit: 'MB/s' }, 'Network'],
      [{ key: 'mystery' }, undefined],
    ];
    expect(sections.map(([m, group]) => metricSection(m, group))).toEqual([
      'thermal',
      'power',
      'power',
      'system',
      'system',
    ]);
  });

  it('every live metric lands in exactly one section, and the board has all three', () => {
    const sections = new Set(LIVE_METRICS.map((metric) => metricSection(joinMetric(metric, null))));
    expect([...sections].sort()).toEqual(['power', 'system', 'thermal']);
  });

  it('metricAlert is the worst tone among the metrics and how many have it', () => {
    const at = (...statuses: MetricStatus[]) => statuses.map((status) => ({ status }));
    expect(metricAlert(at('ok', 'unavailable'))).toBeNull();
    expect(metricAlert(at('ok', 'warn', 'warn'))).toEqual({ tone: 'warn', count: 2 });
    expect(metricAlert(at('warn', 'critical', 'warn'))).toEqual({ tone: 'critical', count: 1 });
    expect(metricAlert([])).toBeNull();
  });
});

describe('values and units', () => {
  // The value and size assertions of #170's "values, changes, durations, sizes, time ranges and
  // statuses read as a developer expects".
  it('values read with their unit, and an unmeasured one is an em dash, never zero', () => {
    const cases: [number | null | undefined, string | null][] = [
      [72, 'C'],
      [95.456, '%'],
      [7.126, 'W'],
      [1234.5, 'MB'],
      [null, 'W'],
      [undefined, 'W'],
      [Number.NaN, 'C'],
      [800, null],
      [6.012, 'load'],
    ];
    expect(cases.map(([value, unit]) => formatValue(value, unit))).toEqual([
      '72 °C',
      '95.5%',
      '7.13 W',
      '1235 MB',
      '—',
      '—',
      '—',
      '800',
      '6.01',
    ]);
  });

  it('numbers keep two digits below 10, one below 100 and none above', () => {
    expect([0, 1.005, 9.994, 10.04, 99.95, 100.4, -12.34, null].map(formatNumber)).toEqual([
      '0',
      '1',
      '9.99',
      '10',
      '100',
      '100',
      '-12.3',
      '',
    ]);
    expect([' C ', 'celsius', 'load', '', null, 'MB/s'].map(unitSuffix)).toEqual([
      '°C',
      '°C',
      '',
      '',
      '',
      'MB/s',
    ]);
  });

  // The `fixedValue` half of #170's "time labels use board timestamps only, in whole words;
  // figures in a row share their decimals".
  it('figures in a row share their decimals', () => {
    expect([
      fixedValue(12, 'W', 1),
      fixedValue(13.66, 'W', 1),
      fixedValue(0.5625, 'W', 2),
      fixedValue(null, 'W', 1),
      fixedValue(55.12, 'C', 1),
      fixedValue(41.234, '%', 0),
    ]).toEqual(['12.0 W', '13.7 W', '0.56 W', '—', '55.1 °C', '41%']);
    expect(['C', '%', 'W', 'load', null].map(unitAfter)).toEqual([' °C', '%', ' W', '', '']);
  });

  it('thresholds read as a sentence, and a metric without any says nothing', () => {
    expect(thresholdText({ warn: 70, critical: 85, unit: 'C' })).toBe(
      'warn at 70 °C, critical at 85 °C',
    );
    expect(thresholdText({ warn: 80, critical: null, unit: '%' })).toBe('warn at 80%');
    expect(thresholdText({ warn: null, critical: null, unit: null })).toBe('');
  });
});

describe('how a status is worded and drawn', () => {
  it('alertLabel counts warnings and criticals; statusLabel reads Normal, Warning, Critical, Not measured', () => {
    expect(alertLabel({ tone: 'warn', count: 1 })).toEqual({
      label: '1 warning',
      tone: 'warning',
    });
    expect(alertLabel({ tone: 'warn', count: 2 })).toEqual({
      label: '2 warnings',
      tone: 'warning',
    });
    expect(alertLabel({ tone: 'critical', count: 1 })).toEqual({
      label: '1 critical',
      tone: 'danger',
    });
    expect(alertLabel({ tone: 'critical', count: 3 }).label).toBe('3 critical');

    const statuses: MetricStatus[] = ['ok', 'warn', 'critical', 'unavailable'];
    expect(statuses.map(statusLabel)).toEqual([
      { label: 'Normal', tone: 'neutral' },
      { label: 'Warning', tone: 'warning' },
      { label: 'Critical', tone: 'danger' },
      { label: 'Not measured', tone: 'neutral' },
    ]);
    // A status Insight does not know reads as not measured, as #170's did.
    expect(statusLabel('nonsense' as MetricStatus).label).toBe('Not measured');
  });

  it('a line is drawn in the tone of its status', () => {
    expect(lineTone('warn')).toBe('warning');
    expect(lineTone('critical')).toBe('danger');
    expect(lineTone('ok')).toBe('default');
    expect(lineTone('unavailable')).toBe('default');
  });

  it('thresholdsOf labels Warning 70 °C and Critical 85 °C and skips null thresholds', () => {
    expect(thresholdsOf(metric({}))).toEqual([
      { value: 70, tone: 'warning', label: 'Warning 70 °C' },
      { value: 85, tone: 'danger', label: 'Critical 85 °C' },
    ]);
    expect(thresholdsOf(metric({ warn: null, critical: 90, unit: '%' }))).toEqual([
      { value: 90, tone: 'danger', label: 'Critical 90%' },
    ]);
    expect(thresholdsOf(metric({ warn: null, critical: null, unit: 'W' }))).toEqual([]);
  });

  it('formatDuration reads tenths under a minute, whole seconds to the hour, then hours', () => {
    expect(formatDuration(34_379)).toBe('34.4 s');
    expect(formatDuration(0)).toBe('0.0 s');
    expect(formatDuration(59_940)).toBe('59.9 s');
    expect(formatDuration(59_960)).toBe('1 min 0 s');
    expect(formatDuration(120_000)).toBe('2 min 0 s');
    expect(formatDuration(1_205_000)).toBe('20 min 5 s');
    expect(formatDuration(3_599_600)).toBe('1 h 0 min');
    expect(formatDuration(3_720_000)).toBe('1 h 2 min');
    expect(formatDuration(3_600_000)).toBe('1 h 0 min');
  });

  it('formatEnergy words joules, kilojoules from 1000 J and an unmeasured run as a dash', () => {
    expect(formatEnergy(274.9)).toBe('275 J');
    expect(formatEnergy(1024)).toBe('1.02 kJ');
    expect(formatEnergy(999.6)).toBe('1.00 kJ');
    expect(formatEnergy(null)).toBe('—');
  });

  it('formatElapsed is a clock: m:ss, and h:mm:ss from an hour', () => {
    expect(formatElapsed(34_000)).toBe('0:34');
    expect(formatElapsed(725_900)).toBe('12:05');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
  });
});
