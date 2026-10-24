import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import type { StatsArea, TelemetryWindow } from '../../stats/telemetry';
import { liveWindow, withMetrics } from './area.testing';
import { StatsAreaPanel } from './stats-area-panel';

describe('StatsAreaPanel', () => {
  let fixture: ComponentFixture<StatsAreaPanel>;

  async function show(area: StatsArea, window: TelemetryWindow = liveWindow(8)) {
    fixture = TestBed.createComponent(StatsAreaPanel);
    fixture.componentRef.setInput('area', area);
    fixture.componentRef.setInput('window', window);
    await fixture.whenStable();
  }

  const root = (): HTMLElement => fixture.nativeElement;
  const title = (): string => root().querySelector('h2')!.textContent!.trim();
  const chip = (): NeatStatusChip | undefined =>
    fixture.debugElement.query(By.directive(NeatStatusChip))?.componentInstance;

  it('opens with the area’s name and the area itself', async () => {
    const areas: [StatsArea, string, string][] = [
      ['thermal', 'Thermal', 'app-thermal-area'],
      ['power', 'Power', 'app-power-area'],
      ['system', 'System', 'app-system-area'],
      ['storage', 'Storage & Network', 'app-storage-area'],
    ];
    for (const [area, name, selector] of areas) {
      await show(area);
      expect(title(), area).toBe(name);
      expect(root().querySelector(selector), area).not.toBeNull();
    }
  });

  it('carries no chip while every metric of the area is within its levels', async () => {
    await show('thermal');
    expect(root().querySelector('neat-status-chip')).toBeNull();
  });

  it('counts the warnings of the area, and says critical alone when one is', async () => {
    const warm = withMetrics(liveWindow(8), (metric) =>
      metric.key === 'rtsn_0' || metric.key === 'rtsn_4' ? { status: 'warn' } : undefined,
    );
    await show('thermal', warm);
    expect(root().querySelector('neat-status-chip')!.textContent!.trim()).toBe('2 warnings');
    expect(chip()!.tone()).toBe('warning');

    // A critical sensor outranks the warnings, and its count is the chip's.
    const hot = withMetrics(warm, (metric) =>
      metric.key === 'rtsn_1' ? { status: 'critical' } : undefined,
    );
    fixture.componentRef.setInput('window', hot);
    await fixture.whenStable();
    expect(root().querySelector('neat-status-chip')!.textContent!.trim()).toBe('1 critical');
    expect(chip()!.tone()).toBe('danger');

    fixture.componentRef.setInput('window', liveWindow(8));
    await fixture.whenStable();
    expect(root().querySelector('neat-status-chip')).toBeNull();
  });

  it('counts only the metrics of its own area', async () => {
    const full = withMetrics(liveWindow(8), (metric) =>
      metric.key === 'disk_emmc_used_pct' ? { status: 'warn' } : undefined,
    );
    await show('storage', full);
    expect(root().querySelector('neat-status-chip')!.textContent!.trim()).toBe('1 warning');

    fixture.componentRef.setInput('area', 'thermal');
    await fixture.whenStable();
    expect(title()).toBe('Thermal');
    expect(root().querySelector('app-thermal-area')).not.toBeNull();
    expect(root().querySelector('app-storage-area')).toBeNull();
    expect(root().querySelector('neat-status-chip')).toBeNull();
  });
});
