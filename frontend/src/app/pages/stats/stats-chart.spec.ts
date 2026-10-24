import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatTimeChart } from '@sima/neat-ui/charts';
import { metricChart, pairChart, boardPowerChart } from '../../stats/telemetry';
import { liveWindow, without } from './area.testing';
import { StatsChart } from './stats-chart';

describe('StatsChart', () => {
  let fixture: ComponentFixture<StatsChart>;
  const window = liveWindow(12);

  const chart = (): NeatTimeChart | undefined =>
    fixture.debugElement.query(By.directive(NeatTimeChart))?.componentInstance;

  async function show(inputs: Record<string, unknown>) {
    fixture = TestBed.createComponent(StatsChart);
    fixture.componentRef.setInput('times', window.times);
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    await fixture.whenStable();
  }

  it('draws the builder’s inputs on a time chart, with the window’s times and the values worded in the chart’s unit', async () => {
    const inputs = metricChart(window, 'mla_mem_allocated_mb');
    await show({ chart: inputs, label: 'MLA memory' });

    expect(chart()!.label()).toBe('MLA memory');
    expect(chart()!.headline()).toBe('742 MB');
    expect(chart()!.series()).toBe(inputs!.series);
    expect(chart()!.times()).toBe(window.times);
    expect(chart()!.domain()).toEqual(inputs!.domain);
    expect(chart()!.thresholds()).toEqual([]);
    expect(chart()!.reference()).toBeNull();
    expect(chart()!.size()).toBe('medium');
    expect(chart()!.headless()).toBe(false);
    expect(chart()!.format()(1234.5)).toBe('1235 MB');
  });

  it('takes the size and headlessness it is asked for, and the reference line a chart carries', async () => {
    await show({
      chart: boardPowerChart(window),
      label: 'Board power',
      size: 'large',
      headless: '',
    });
    expect(chart()!.size()).toBe('large');
    expect(chart()!.headless()).toBe(true);
    expect(chart()!.reference()?.label).toBe('Session average 11.2 W');
  });

  it('words a pair’s values in its unit, and a percentage with no space before the sign', async () => {
    await show({
      chart: pairChart(window, ['net_rx_mbps', 'net_tx_mbps'], ['Receive', 'Transmit']),
      label: 'Network',
    });
    expect(chart()!.format()(2.5)).toBe('2.5 MB/s');

    fixture.componentRef.setInput('chart', metricChart(window, 'cpu_usage_pct'));
    await fixture.whenStable();
    expect(chart()!.format()(37.5)).toBe('37.5%');
  });

  it('draws nothing for a metric the board does not report', async () => {
    const bare = without(window, (metric) => metric.key === 'cpu_usage_pct');
    await show({ chart: metricChart(bare, 'cpu_usage_pct'), label: 'CPU usage' });
    expect(chart()).toBeUndefined();
    expect(fixture.nativeElement.children).toHaveLength(0);
  });
});
