import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatSparkline } from '@sima/neat-ui/charts';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { liveWindow, withMetrics } from './area.testing';
import { MetricsTable } from './metrics-table';
import type { SentinelMetric } from '../../stats/api';
import { LIVE_VALUES } from '../../stats/stats.testing';
import type { TelemetryWindow } from '../../stats/telemetry';

describe('MetricsTable', () => {
  let fixture: ComponentFixture<MetricsTable>;
  let window: TelemetryWindow;

  const pick = (...keys: string[]): SentinelMetric[] =>
    keys.map((key) => window.metrics.find((metric) => metric.key === key)!);

  async function show(metrics: readonly SentinelMetric[], label = 'Test metrics') {
    fixture = TestBed.createComponent(MetricsTable);
    fixture.componentRef.setInput('metrics', metrics);
    fixture.componentRef.setInput('window', window);
    fixture.componentRef.setInput('label', label);
    await fixture.whenStable();
  }

  const root = (): HTMLElement => fixture.nativeElement;
  const cells = (row: Element): string[] =>
    [...row.children].map((cell) => cell.textContent!.trim());
  const rows = (): HTMLTableRowElement[] => [...root().querySelectorAll('tbody tr')] as never;

  it('lists name, group, value, sparkline and status, in the order given', async () => {
    // A history of its own index, up to the captured reading, which is the value.
    window = liveWindow(10, { values: (key, i) => (i === 9 ? (LIVE_VALUES[key] ?? null) : i) });
    await show(pick('net_tx_mbps', 'disk_emmc_used_pct', 'rtsn_0'));

    const table = root().querySelector('table')!;
    expect(table.getAttribute('aria-label')).toBe('Test metrics');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent!.trim())).toEqual([
      'Metric',
      'Group',
      'Value',
      'Trend',
      'Status',
    ]);
    // A table of rows, each named by its first cell.
    expect(rows().map((row) => row.querySelector('th')!.getAttribute('scope'))).toEqual([
      'row',
      'row',
      'row',
    ]);
    expect(rows().map(cells)).toEqual([
      ['NetTX', 'Network', '1.68 MB/s', '', 'Normal'],
      ['eMMC%', 'Disk', '72.4%', '', 'Normal'],
      ['MLA-0', 'MLA', '65.3 °C', '', 'Normal'],
    ]);

    // The trend is the metric's own history.
    const trends = fixture.debugElement
      .queryAll(By.directive(NeatSparkline))
      .map((spark) => spark.componentInstance as NeatSparkline);
    expect(trends.map((spark) => spark.label())).toEqual(['NetTX', 'eMMC%', 'MLA-0']);
    expect(trends[2].values()).toEqual(window.series['rtsn_0']);
    expect(trends[2].format()(65.25)).toBe('65.3 °C');
  });

  it('draws a metric past a threshold in its colour, and says its status in words', async () => {
    window = withMetrics(liveWindow(10), (metric) => {
      if (metric.key === 'rtsn_0') return { status: 'warn' };
      if (metric.key === 'rtsn_1') return { status: 'critical' };
      if (metric.key === 'rtsn_2') return { status: 'unavailable', value: null };
      return undefined;
    });
    await show(pick('rtsn_0', 'rtsn_1', 'rtsn_2', 'rtsn_3'));

    const trends = fixture.debugElement
      .queryAll(By.directive(NeatSparkline))
      .map((spark) => (spark.componentInstance as NeatSparkline).tone());
    expect(trends).toEqual(['warning', 'danger', 'default', 'default']);
    const chips = fixture.debugElement
      .queryAll(By.directive(NeatStatusChip))
      .map((chip) => [
        chip.nativeElement.textContent.trim(),
        (chip.componentInstance as NeatStatusChip).tone(),
      ]);
    expect(chips).toEqual([
      ['Warning', 'warning'],
      ['Critical', 'danger'],
      ['Not measured', 'neutral'],
      ['Normal', 'neutral'],
    ]);
    // A reading the board did not take is a dash, never zero.
    expect(rows()[2].children[2].textContent!.trim()).toBe('—');
  });

  it('names a metric by its short name, and says what it is and where it warns when hovered', async () => {
    window = withMetrics(liveWindow(3), (metric) =>
      metric.key === 'rtsn_0' ? { description: 'MLA die temperature' } : undefined,
    );
    await show(pick('rtsn_0', 'cpu_load_1'));

    const [hot, load] = rows().map((row) => row.querySelector('th')!);
    expect(hot.textContent!.trim()).toBe('MLA-0');
    expect(hot.getAttribute('title')).toBe(
      'MLA RTSN-0 — MLA die temperature — warn at 70 °C, critical at 85 °C',
    );
    // No description and no thresholds: the label alone.
    expect(load.getAttribute('title')).toBe(
      window.metrics.find((m) => m.key === 'cpu_load_1')!.label,
    );
  });

  it('shows the reading of the metrics it is given again when they change', async () => {
    window = liveWindow(4);
    await show(pick('cpu_usage_pct'));
    expect(rows()[0].children[2].textContent!.trim()).toBe('37.5%');

    window = withMetrics(window, (metric) =>
      metric.key === 'cpu_usage_pct' ? { value: 41 } : undefined,
    );
    fixture.componentRef.setInput('metrics', pick('cpu_usage_pct'));
    fixture.componentRef.setInput('window', window);
    await fixture.whenStable();
    expect(rows()[0].children[2].textContent!.trim()).toBe('41%');
  });
});
