import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatHeatmap, NeatTimeChart } from '@sima/neat-ui/charts';
import type { TelemetryWindow } from '../../stats/telemetry';
import { liveWindow, withEv74Memory, withMetrics, withSeries, without } from './area.testing';
import { SystemArea } from './system-area';

describe('SystemArea', () => {
  let fixture: ComponentFixture<SystemArea>;

  async function show(window: TelemetryWindow = withEv74Memory(liveWindow(12))) {
    fixture = TestBed.createComponent(SystemArea);
    fixture.componentRef.setInput('window', window);
    await fixture.whenStable();
  }

  const charts = (): NeatTimeChart[] =>
    fixture.debugElement.queryAll(By.directive(NeatTimeChart)).map((c) => c.componentInstance);
  const chart = (label: string): NeatTimeChart | undefined =>
    charts().find((c) => c.label() === label);
  const heatmap = (): NeatHeatmap | undefined =>
    fixture.debugElement.query(By.directive(NeatHeatmap))?.componentInstance;

  it('shows CPU usage, the load average, Linux memory, MLA memory and the EV74’s memory, each with its reading', async () => {
    await show();
    expect(charts().map((c) => [c.label(), c.headline()])).toEqual([
      ['CPU usage', '37.5%'],
      ['Load average (1 minute)', '6 (37.5%)'],
      ['Linux memory', '21.3% (1256 MB)'],
      ['MLA memory', '742 MB'],
      ['EV74 memory', '96 MB'],
    ]);
    expect(
      chart('Load average (1 minute)')!
        .series()
        .map((s) => s.key),
    ).toEqual(['cpu_load_1_pct']);
    expect(
      chart('CPU usage')!
        .thresholds()
        .map((line) => line.label),
    ).toEqual(['Warning 80%', 'Critical 95%']);
  });

  it('draws the cores as a heatmap with each one’s one-minute average, and the cores’ average first in its headline', async () => {
    await show();
    const cores = heatmap()!;
    expect(cores.label()).toBe('Per-core CPU');
    expect(cores.headline()).toBe('37.7% · 1-minute average of 16 cores · busiest c2 at 60%');
    expect(cores.rows()).toHaveLength(16);
    expect(cores.rows()[0]).toMatchObject({
      key: 'cpu_core_0_usage_pct',
      label: 'c0',
      end: '33.3%',
      endTone: 'default',
    });
    expect(cores.rows()[2].end).toBe('60%');
    expect(cores.times()).toBe(fixture.componentRef.instance.window().times);
    expect(cores.format()(50)).toBe('50%');
    expect(fixture.nativeElement.querySelector('neat-heatmap')!.textContent).toContain('c15');
  });

  it('tones a core’s average by that core’s own thresholds', async () => {
    const busy = withSeries(liveWindow(12), {
      cpu_core_3_usage_pct: Array<number>(12).fill(85),
      cpu_core_4_usage_pct: Array<number>(12).fill(97),
    });
    await show(busy);
    const tones = Object.fromEntries(
      heatmap()!
        .rows()
        .map((row) => [row.label, row.endTone]),
    );
    expect([tones['c2'], tones['c3'], tones['c4']]).toEqual(['default', 'warning', 'danger']);
  });

  it('a load of 130% widens the load chart’s scale to 150, and the others stay at 100', async () => {
    const overloaded = withMetrics(
      withSeries(liveWindow(12), { cpu_load_1_pct: Array<number>(12).fill(130) }),
      (metric) =>
        metric.key === 'cpu_load_1_pct'
          ? { value: 130, status: 'critical' }
          : metric.key === 'cpu_load_1'
            ? { value: 20.8 }
            : undefined,
    );
    await show(overloaded);
    expect(chart('Load average (1 minute)')!.domain()).toEqual([0, 150]);
    expect(chart('Load average (1 minute)')!.headline()).toBe('20.8 (130%)');
    expect(chart('Load average (1 minute)')!.tone()).toBe('danger');
    expect(chart('CPU usage')!.domain()).toEqual([0, 100]);
    expect(chart('Linux memory')!.domain()).toEqual([0, 100]);
  });

  it('leaves out a chart whose metric the board does not report, and the heatmap without cores', async () => {
    await show(without(liveWindow(12), (m) => /^cpu_core_/.test(m.key)));
    expect(charts().map((c) => c.label())).toEqual([
      'CPU usage',
      'Load average (1 minute)',
      'Linux memory',
      'MLA memory',
    ]);
    expect(heatmap()).toBeUndefined();
  });

  it('shows no EV74 chart for a Sentinel that predates the field, and never the CMA pool in its place', async () => {
    await show(liveWindow(12));
    expect(chart('EV74 memory')).toBeUndefined();
    expect(charts().flatMap((c) => c.series().map((series) => series.key))).not.toContain(
      'ev74_cma_used_mb',
    );
  });

  it('falls back to the plain value when the load or the memory has only one of its two readings', async () => {
    await show(
      without(liveWindow(12), (m) => m.key === 'cpu_load_1' || m.key === 'linux_mem_used_mb'),
    );
    expect(chart('Load average (1 minute)')!.headline()).toBe('37.5%');
    expect(chart('Linux memory')!.headline()).toBe('21.3%');
  });
});
