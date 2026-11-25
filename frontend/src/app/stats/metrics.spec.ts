import { definitionsOf, joinMetric, joinMetrics, metricStatus, OTHER_GROUP } from './metrics';
import { LIVE_METRICS, LIVE_VALUES } from './stats.testing';

describe('metricStatus', () => {
  it('ranks a reading against its thresholds, critical first', () => {
    expect(metricStatus(50, 80, 95)).toBe('ok');
    expect(metricStatus(80, 80, 95)).toBe('warn');
    expect(metricStatus(95, 80, 95)).toBe('critical');
    expect(metricStatus(99, null, null)).toBe('ok');
    expect(metricStatus(99, undefined, 90)).toBe('critical');
  });

  it('an unmeasured reading is unavailable, never ok', () => {
    for (const value of [null, undefined, Number.NaN]) {
      expect(metricStatus(value, 80, 95), String(value)).toBe('unavailable');
    }
  });
});

describe('joinMetric', () => {
  it('joins a definition with its reading', () => {
    const cpu = LIVE_METRICS.find((definition) => definition.key === 'cpu_usage_pct')!;
    expect(joinMetric(cpu, 37.5)).toEqual({
      key: 'cpu_usage_pct',
      label: 'CPU usage',
      short: 'CPU%',
      unit: '%',
      description: null,
      group: 'CPU',
      warn: 80,
      critical: 95,
      value: 37.5,
      status: 'ok',
    });
  });

  it('fills in what a definition lacks, so nothing is shown as a bare key', () => {
    expect(joinMetric({ key: 'npu_temp_c' }, null)).toEqual({
      key: 'npu_temp_c',
      label: 'Npu temp c',
      short: 'Npu temp c',
      unit: null,
      description: null,
      group: OTHER_GROUP,
      warn: null,
      critical: null,
      value: null,
      status: 'unavailable',
    });
    // The short name falls back to the label; empty strings count as missing.
    expect(
      joinMetric({ key: 'a', label: 'Alpha', short: '', unit: '', group: '' }, 1),
    ).toMatchObject({ label: 'Alpha', short: 'Alpha', unit: null, group: OTHER_GROUP });
  });
});

describe('definitionsOf', () => {
  it('keeps the definitions that name a key and leaves out anything else', () => {
    expect(
      definitionsOf([{ key: 'a' }, { key: '' }, { label: 'b' }, null, 3, { key: 'c' }]),
    ).toEqual([{ key: 'a' }, { key: 'c' }]);
    expect(definitionsOf(undefined)).toEqual([]);
    expect(definitionsOf({ key: 'a' })).toEqual([]);
  });
});

describe('joinMetrics', () => {
  it('lists the definitions in Sentinel’s order with their readings', () => {
    const metrics = joinMetrics(LIVE_METRICS, Object.keys(LIVE_VALUES), (key) => LIVE_VALUES[key]);
    expect(metrics.map((metric) => metric.key)).toEqual(LIVE_METRICS.map(({ key }) => key));
    expect(metrics.every((metric) => metric.status === 'ok')).toBe(true);
  });

  it('adds the sampled keys without a definition after them, sorted, and lists a key once', () => {
    const metrics = joinMetrics(
      [{ key: 'b' }, { key: 'a' }, { key: 'b', label: 'Again' }],
      ['z', 'a', 'y', 'z'],
      () => null,
    );
    expect(metrics.map((metric) => metric.key)).toEqual(['b', 'a', 'y', 'z']);
    expect(metrics[0].label).toBe('B');
  });
});
