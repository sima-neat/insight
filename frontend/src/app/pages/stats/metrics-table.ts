import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NeatSparkline } from '@sima/neat-ui/charts';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { NeatNumeric, NeatTable } from '@sima/neat-ui/table';
import type { SentinelMetric } from '../../stats/api';
import { formatValue, lineTone, statusLabel, thresholdText } from '../../stats/format';
import type { TelemetryWindow } from '../../stats/telemetry';

/**
 * Metrics as a table, in the order given: name, group, value, a sparkline of the window and the
 * status. Stats' All metrics lists every metric with it, and the Storage &
 * Network area its own. Hovering a name tells what it is and where Sentinel warns.
 */
@Component({
  selector: 'app-metrics-table',
  imports: [NeatNumeric, NeatSparkline, NeatStatusChip, NeatTable],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <table neatTable [attr.aria-label]="label()">
      <thead>
        <tr>
          <th scope="col">Metric</th>
          <th scope="col" class="group">Group</th>
          <th scope="col" neatNumeric>Value</th>
          <th scope="col">Trend</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        @for (row of rows(); track row.key) {
          <tr>
            <th scope="row" [attr.title]="row.title">{{ row.name }}</th>
            <td class="group">{{ row.group }}</td>
            <td neatNumeric>{{ row.value }}</td>
            <td class="trend">
              <neat-sparkline
                [label]="row.name"
                [values]="row.values"
                [format]="row.format"
                [tone]="row.tone"
              />
            </td>
            <td>
              <neat-status-chip [tone]="row.status.tone">{{ row.status.label }}</neat-status-chip>
            </td>
          </tr>
        }
      </tbody>
    </table>
  `,
  styleUrl: './metrics-table.css',
})
export class MetricsTable {
  readonly metrics = input.required<readonly SentinelMetric[]>();
  readonly window = input.required<TelemetryWindow>();
  /** The table's name for assistive technology: what these metrics are. */
  readonly label = input.required<string>();

  protected readonly rows = computed(() => {
    const { series } = this.window();
    return this.metrics().map((metric) => ({
      key: metric.key,
      name: metric.short || metric.label,
      title: [metric.label, metric.description, thresholdText(metric)].filter(Boolean).join(' — '),
      group: metric.group,
      value: formatValue(metric.value, metric.unit),
      values: series[metric.key] ?? [],
      format: (value: number) => formatValue(value, metric.unit),
      tone: lineTone(metric.status),
      status: statusLabel(metric.status),
    }));
  });
}
