import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatTimeChart } from '@sima/neat-ui/charts';
import type { SentinelMetric } from '../../stats/api';
import type { TelemetryWindow } from '../../stats/telemetry';
import { liveWindow, withExtra, without } from './area.testing';
import { StorageArea } from './storage-area';

const nvme: SentinelMetric = {
  key: 'nvme_used_pct',
  label: 'NVMe used',
  short: 'NVMe%',
  unit: '%',
  description: null,
  group: 'Storage',
  warn: 85,
  critical: 95,
  value: 41.5,
  status: 'ok',
};

describe('StorageArea', () => {
  let fixture: ComponentFixture<StorageArea>;

  async function show(window: TelemetryWindow = liveWindow(12)) {
    fixture = TestBed.createComponent(StorageArea);
    fixture.componentRef.setInput('window', window);
    await fixture.whenStable();
  }

  const root = (): HTMLElement => fixture.nativeElement;
  const charts = (): NeatTimeChart[] =>
    fixture.debugElement.queryAll(By.directive(NeatTimeChart)).map((c) => c.componentInstance);
  const chart = (label: string): NeatTimeChart | undefined =>
    charts().find((c) => c.label() === label);
  const tableRows = (): string[] =>
    [...root().querySelectorAll('tbody th')].map((cell) => cell.textContent!.trim());

  it('shows eMMC use, eMMC I/O and the network, then the storage and network metrics', async () => {
    await show();
    expect(charts().map((c) => c.label())).toEqual(['eMMC used', 'eMMC I/O', 'Network']);
    expect(chart('eMMC used')!.headline()).toBe('72.4%');
    expect(chart('eMMC used')!.domain()).toEqual([0, 100]);

    expect(
      chart('eMMC I/O')!
        .series()
        .map((s) => s.label),
    ).toEqual(['Read', 'Write']);
    expect(chart('eMMC I/O')!.headline()).toBe('0.01 MB/s');
    expect(
      chart('Network')!
        .series()
        .map((s) => s.label),
    ).toEqual(['Receive', 'Transmit']);
    expect(chart('Network')!.headline()).toBe('2.82 MB/s');

    const heading = root().querySelector('h3')!;
    expect(heading.textContent!.trim()).toBe('Storage and network metrics');
    expect(heading.hasAttribute('neatAsideHeading')).toBe(true);
    expect(root().querySelector('table')!.getAttribute('aria-label')).toBe(
      'Storage and network metrics',
    );
    // Sentinel's order: the disk, its I/O, then the network.
    expect(tableRows()).toEqual(['eMMC%', 'eMMCMB', 'eMMCR', 'eMMCW', 'NetRX', 'NetTX']);
  });

  it('shows NVMe use, after eMMC, when the board reports a drive in percent', async () => {
    await show(withExtra(liveWindow(12), nvme, Array<number>(12).fill(41.5)));
    expect(charts().map((c) => c.label())).toEqual([
      'eMMC used',
      'NVMe used',
      'eMMC I/O',
      'Network',
    ]);
    expect(
      chart('NVMe used')!
        .series()
        .map((s) => s.key),
    ).toEqual(['nvme_used_pct']);
    expect(chart('NVMe used')!.headline()).toBe('41.5%');
    expect(tableRows()).toContain('NVMe%');
  });

  it('does not take an NVMe reading that is not a percentage for the drive’s use', async () => {
    const size: SentinelMetric = {
      ...nvme,
      key: 'nvme_total_mb',
      short: 'NVMeMB',
      unit: 'MB',
      value: 512000,
    };
    await show(withExtra(liveWindow(12), size, Array<number>(12).fill(512000)));
    expect(chart('NVMe used')).toBeUndefined();
    // It is still a storage metric, so the table lists it.
    expect(tableRows()).toContain('NVMeMB');
  });

  it('leaves out a chart whose metrics the board does not report', async () => {
    await show(
      without(
        liveWindow(12),
        (m) =>
          m.key === 'disk_emmc_used_pct' ||
          m.key.startsWith('disk_emmc_re') ||
          m.group === 'Network',
      ),
    );
    expect(charts().map((c) => c.label())).toEqual(['eMMC I/O']);
    // One of its two series is enough for the chart, and it has no total.
    expect(
      chart('eMMC I/O')!
        .series()
        .map((s) => s.label),
    ).toEqual(['Write']);
    expect(chart('eMMC I/O')!.headline()).toBe('—');
  });

  it('shows nothing, not an empty table, when the board has no storage or network metrics', async () => {
    await show(without(liveWindow(12), (m) => ['Disk', 'DiskIO', 'Network'].includes(m.group)));
    expect(charts()).toHaveLength(0);
    expect(root().querySelector('h3, table')).toBeNull();
  });
});
