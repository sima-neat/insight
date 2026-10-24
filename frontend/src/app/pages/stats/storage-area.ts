import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NeatAsideHeading } from '@sima/neat-ui';
import {
  areaMetrics,
  metricChart,
  networkChart,
  pairChart,
  type TelemetryWindow,
} from '../../stats/telemetry';
import { MetricsTable } from './metrics-table';
import { StatsChart } from './stats-chart';

/**
 * The Storage & Network area: eMMC and NVMe use, eMMC reads and writes, network in and out, then a
 * table of every storage and network metric (Inv-S §2.9). Whatever the board does not report is
 * left out; the NVMe chart is the first percentage metric whose key names an NVMe drive, since
 * Sentinel's key for it depends on the board.
 */
@Component({
  selector: 'app-storage-area',
  imports: [MetricsTable, NeatAsideHeading, StatsChart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-stats-chart label="eMMC used" [chart]="emmc()" [times]="window().times" />
    <app-stats-chart label="NVMe used" [chart]="nvme()" [times]="window().times" />
    <app-stats-chart label="eMMC I/O" [chart]="emmcIo()" [times]="window().times" />
    <app-stats-chart label="Network" [chart]="network()" [times]="window().times" />
    @if (metrics().length) {
      <h3 neatAsideHeading>Storage and network metrics</h3>
      <app-metrics-table
        [metrics]="metrics()"
        [window]="window()"
        label="Storage and network metrics"
      />
    }
  `,
  styleUrl: './storage-area.css',
})
export class StorageArea {
  readonly window = input.required<TelemetryWindow>();

  protected readonly emmc = computed(() => metricChart(this.window(), 'disk_emmc_used_pct'));

  protected readonly nvme = computed(() => {
    const drive = this.window().metrics.find(
      (metric) => /nvme/i.test(metric.key) && metric.unit === '%',
    );
    return drive ? metricChart(this.window(), drive.key) : null;
  });

  protected readonly emmcIo = computed(() =>
    pairChart(this.window(), ['disk_emmc_read_mbps', 'disk_emmc_write_mbps'], ['Read', 'Write']),
  );

  protected readonly network = computed(() => networkChart(this.window()));

  protected readonly metrics = computed(() => areaMetrics(this.window(), 'storage'));
}
