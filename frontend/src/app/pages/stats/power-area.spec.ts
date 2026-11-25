import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatChartCard, NeatStackedChart, NeatTimeChart } from '@sima/neat-ui/charts';
import type { TelemetryWindow } from '../../stats/telemetry';
import { liveWindow, withMetrics, without } from './area.testing';
import { PowerArea } from './power-area';

describe('PowerArea', () => {
  let fixture: ComponentFixture<PowerArea>;

  async function show(window: TelemetryWindow = liveWindow(12)) {
    fixture = TestBed.createComponent(PowerArea);
    fixture.componentRef.setInput('window', window);
    await fixture.whenStable();
  }

  const root = (): HTMLElement => fixture.nativeElement;
  const tiles = (): NeatChartCard[] =>
    fixture.debugElement.queryAll(By.directive(NeatChartCard)).map((c) => c.componentInstance);
  const board = (): NeatTimeChart | undefined =>
    fixture.debugElement.query(By.directive(NeatTimeChart))?.componentInstance;
  const rails = (): NeatStackedChart | undefined =>
    fixture.debugElement.query(By.directive(NeatStackedChart))?.componentInstance;

  it('shows Current, Session average and Session peak as tiles that are not choices', async () => {
    await show();
    expect(tiles().map((tile) => [tile.heading(), tile.value(), tile.unit()])).toEqual([
      ['Current', '11.6', 'W'],
      ['Session average', '11.2', 'W'],
      ['Session peak', '16.1', 'W'],
    ]);
    expect(tiles().every((tile) => !tile.selectable())).toBe(true);
    // The value is text, not only a drawing.
    expect(root().querySelector('neat-chart-card')!.textContent).toContain('11.6');
  });

  it('draws board power large on one ceiling, with the session average as its line and no headline', async () => {
    await show();
    expect(board()!.label()).toBe('Board power (Estimated)');
    expect(board()!.size()).toBe('large');
    expect(board()!.headless()).toBe(false);
    expect(board()!.headline()).toBe('');
    expect(
      board()!
        .series()
        .map((s) => s.key),
    ).toEqual(['power_current_watts']);
    // A round number a tenth above the session peak of 16.1 W.
    expect(board()!.domain()).toEqual([0, 20]);
    expect(board()!.reference()).toEqual({
      value: 11.154253915959291,
      label: 'Session average 11.2 W',
    });
  });

  it('stacks the power rails under their short names, with the total, each rail’s watts and its share', async () => {
    await show();
    expect(rails()!.label()).toBe('Power rails');
    expect(rails()!.headline()).toBe('11.63 W across 8 rails');
    expect(
      rails()!
        .series()
        .map((s) => s.label),
    ).toEqual([
      'SoC and DDR VDD',
      'HDMI 1.2V',
      'SoC and DDR VDDQ',
      'SoC and DDR VDD2H',
      'MLA 0.68V',
      'PCIe and ETH VP',
      'SOM Platform 1.8V',
      'SOM Platform 3.3V',
    ]);
    expect(rails()!.format()(4.75)).toBe('4.75 W');
    expect(rails()!.format()(0.09375)).toBe('0.09 W');
    // The legend: the first rail is 4.75 of 11.625 W, which is 41%.
    const legend = root().querySelector('neat-stacked-chart')!.textContent!;
    expect(legend).toContain('SoC and DDR VDD');
    expect(legend).toContain('4.75 W');
    expect(legend).toContain('41%');
  });

  it('leaves out what the board does not report, and keeps a tile whose reading was not taken', async () => {
    const bare = without(
      liveWindow(12),
      (m) => m.key.startsWith('power_rail_') || m.key === 'power_peak_watts',
    );
    await show(bare);
    expect(rails()).toBeUndefined();
    expect(tiles().map((tile) => tile.heading())).toEqual(['Current', 'Session average']);
    expect(board()).toBeDefined();

    await show(without(liveWindow(12), (m) => m.key === 'power_current_watts'));
    expect(board()).toBeUndefined();
    expect(tiles().map((tile) => tile.heading())).toEqual(['Session average', 'Session peak']);

    await show(
      withMetrics(liveWindow(12), (m) =>
        m.key === 'power_peak_watts' ? { value: null } : undefined,
      ),
    );
    expect(tiles().map((tile) => [tile.heading(), tile.value(), tile.unit()])[2]).toEqual([
      'Session peak',
      '–',
      '',
    ]);

    await show(without(liveWindow(12), (m) => m.group === 'Power' || m.group === 'PowerRail'));
    expect(root().querySelector('neat-chart-card, neat-time-chart, neat-stacked-chart')).toBeNull();
  });
});
