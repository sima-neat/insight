import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatTimeChart } from '@sima/neat-ui/charts';
import { StatsSession } from '../../stats/stats-session';
import type { TelemetryWindow } from '../../stats/telemetry';
import { liveWindow, withMetrics, without } from './area.testing';
import { ThermalArea } from './thermal-area';

describe('ThermalArea', () => {
  let fixture: ComponentFixture<ThermalArea>;

  async function show(window: TelemetryWindow = liveWindow(12)) {
    fixture = TestBed.createComponent(ThermalArea);
    fixture.componentRef.setInput('window', window);
    await settle();
  }

  /** The tabs take their open one a render after the first, so a spec waits for it. */
  async function settle() {
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  const root = (): HTMLElement => fixture.nativeElement;
  const charts = (): NeatTimeChart[] =>
    fixture.debugElement.queryAll(By.directive(NeatTimeChart)).map((c) => c.componentInstance);
  const tabs = (): HTMLButtonElement[] => [
    ...root().querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ];
  const tabLabels = (): string[] =>
    tabs().map((tab) => tab.textContent!.trim().replace(/\s+/g, ' '));
  const sensors = (): string[][] =>
    [...root().querySelectorAll('li.sensor')].map((row) => [
      row.children[0].textContent!.trim(),
      row.children[2].textContent!.trim(),
    ]);

  it('shows the hottest sensor’s line with the sensors’ thresholds, a tab per group with its count, and the first group’s sensors', async () => {
    await show();

    // LM96-2, at 66.25 °C, is the hottest of the live board's sensors.
    expect(root().querySelector('p')!.textContent!.trim()).toBe(
      'Thermal max · hottest sensor Board LM96-2',
    );
    const max = charts()[0];
    expect(max.label()).toBe('Thermal max');
    expect(max.size()).toBe('large');
    expect(max.headless()).toBe(true);
    expect(max.headline()).toBe('66.3 °C (LM96-2)');
    expect(max.domain()).toEqual([40, 90]);
    expect(max.thresholds().map((line) => line.value)).toEqual([70, 85]);
    expect(max.tone()).toBe('default');
    expect(max.times()).toBe(fixture.componentRef.instance.window().times);

    expect(root().querySelector('neat-tabs [role="tablist"]')!.getAttribute('aria-label')).toBe(
      'Thermal sensor groups',
    );
    expect(tabLabels()).toEqual([
      'APU · 2 sensors',
      'Board · 3 sensors',
      'CVU · 2 sensors',
      'MLA · 8 sensors',
      'TOP · 2 sensors',
    ]);
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    expect(sensors()).toEqual([
      ['APU-4', '65.3 °C'],
      ['APU-11', '64.6 °C'],
    ]);
  });

  it('draws each sensor as a compact line on the thermal scale with its own thresholds and tone', async () => {
    const hot = withMetrics(liveWindow(12), (metric) =>
      metric.key === 'rtsn_4' ? { value: 88, status: 'critical' } : undefined,
    );
    await show(hot);
    const [, apu4, apu11] = charts();
    expect([apu4.label(), apu4.size(), apu4.headless(), apu4.tone()]).toEqual([
      'APU-4',
      'compact',
      true,
      'danger',
    ]);
    expect(apu4.domain()).toEqual([40, 90]);
    expect(apu4.thresholds().map((line) => line.label)).toEqual([
      'Warning 70 °C',
      'Critical 85 °C',
    ]);
    expect(apu4.headline()).toBe('88 °C');
    expect(apu11.tone()).toBe('default');
  });

  it('names a group’s alerts on its tab, and the hottest sensor’s tone on the max chart', async () => {
    const warm = withMetrics(liveWindow(12), (metric) => {
      if (metric.key === 'rtsn_0') return { value: 74, status: 'warn' };
      if (metric.key === 'rtsn_1') return { value: 72, status: 'warn' };
      if (metric.key === 'rtsn_6') return { value: 90, status: 'critical' };
      return undefined;
    });
    await show(warm);
    expect(tabLabels()).toEqual([
      'APU · 2 sensors',
      'Board · 3 sensors',
      'CVU · 2 sensors',
      'MLA · 8 sensors · 2 warnings',
      'TOP · 2 sensors · 1 critical',
    ]);
    expect(root().querySelector('p')!.textContent!.trim()).toBe(
      'Thermal max · hottest sensor TOP TOP-6',
    );
    expect(charts()[0].tone()).toBe('danger');
  });

  it('says a lone sensor is one sensor', async () => {
    await show(
      without(liveWindow(12), (m) => (m.unit === 'C' && m.group !== 'TOP') || m.key === 'rtsn_13'),
    );
    expect(tabLabels()).toEqual(['TOP · 1 sensor']);
  });

  it('opens the group the user chose and keeps the choice in StatsSession', async () => {
    const session = TestBed.inject(StatsSession);
    await show();
    expect(session.thermalGroup()).toBeNull();

    tabs()[3].click();
    await settle();
    expect(session.thermalGroup()).toBe('MLA');
    expect(tabs()[3].getAttribute('aria-selected')).toBe('true');
    expect(sensors().map(([name]) => name)).toEqual([
      'MLA-0',
      'MLA-1',
      'MLA-2',
      'MLA-3',
      'MLA-7',
      'MLA-8',
      'MLA-9',
      'MLA-10',
    ]);
  });

  it('opens again on the group chosen before, and on the first when that group is gone', async () => {
    const session = TestBed.inject(StatsSession);
    session.thermalGroup.set('TOP');
    await show();
    expect(tabs()[4].getAttribute('aria-selected')).toBe('true');
    expect(sensors().map(([name]) => name)).toEqual(['TOP-6', 'TOP-13']);

    // Another board without a TOP group: the choice cannot apply, so the first group opens.
    fixture.componentRef.setInput(
      'window',
      without(liveWindow(12), (m) => m.group === 'TOP'),
    );
    await settle();
    expect(tabLabels()).toHaveLength(4);
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    expect(sensors()[0][0]).toBe('APU-4');
  });

  it('keeps the open group open while the readings and alerts change under it', async () => {
    await show();
    tabs()[3].click();
    await settle();

    fixture.componentRef.setInput(
      'window',
      withMetrics(liveWindow(14), (metric) =>
        metric.key === 'rtsn_2' ? { value: 71, status: 'warn' } : undefined,
      ),
    );
    await settle();
    expect(tabLabels()[3]).toBe('MLA · 8 sensors · 1 warning');
    expect(tabs()[3].getAttribute('aria-selected')).toBe('true');
    expect(sensors()[2]).toEqual(['MLA-2', '71 °C']);
  });

  it('says so when the board reports no temperatures', async () => {
    await show(without(liveWindow(12), (metric) => metric.unit === 'C'));
    expect(root().textContent!.trim()).toBe('Sentinel reported no temperatures on this board.');
    expect(charts()).toHaveLength(0);
    expect(root().querySelector('neat-tabs')).toBeNull();
  });
});
