import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NeatHeatmap, type NeatHeatmapRow } from '@sima/neat-ui/charts';
import { formatValue } from '../../stats/format';
import { coreSummary, metricByKey, metricChart, type TelemetryWindow } from '../../stats/telemetry';
import { StatsChart } from './stats-chart';

const percent = (value: number): string => formatValue(value, '%');

/**
 * The System area: CPU usage, the one-minute load average, Linux memory, MLA memory and the EV74's
 * CMA, then every CPU core's load as a heatmap with its one-minute average. A
 * percentage chart widens past 100 when a reading does (`scaleFor`), and whatever
 * the board does not report is left out.
 */
@Component({
  selector: 'app-system-area',
  imports: [NeatHeatmap, StatsChart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-stats-chart label="CPU usage" [chart]="cpu()" [times]="window().times" />
    <app-stats-chart label="Load average (1 minute)" [chart]="load()" [times]="window().times" />
    <app-stats-chart label="Linux memory" [chart]="linuxMemory()" [times]="window().times" />
    <app-stats-chart label="MLA memory" [chart]="mlaMemory()" [times]="window().times" />
    <app-stats-chart label="EV74 CMA used" [chart]="ev74Cma()" [times]="window().times" />
    @if (cores(); as cores) {
      <neat-heatmap
        label="Per-core CPU"
        [headline]="cores.headline"
        [rows]="cores.rows"
        [times]="window().times"
        [format]="percent"
      />
    }
  `,
  styleUrl: './system-area.css',
})
export class SystemArea {
  readonly window = input.required<TelemetryWindow>();

  protected readonly percent = percent;

  protected readonly cpu = computed(() => metricChart(this.window(), 'cpu_usage_pct'));

  /** Plots the load as a share of the cores, and says it in both: "6 (37.5%)". */
  protected readonly load = computed(() => {
    const window = this.window();
    const chart = metricChart(window, 'cpu_load_1_pct');
    const load = metricByKey(window, 'cpu_load_1');
    const share = metricByKey(window, 'cpu_load_1_pct');
    return load && share && chart
      ? {
          ...chart,
          headline: `${formatValue(load.value, load.unit)} (${formatValue(share.value, share.unit)})`,
        }
      : chart;
  });

  /** The share and the size together: "21% (1256 MB)". */
  protected readonly linuxMemory = computed(() => {
    const window = this.window();
    const chart = metricChart(window, 'linux_mem_used_pct');
    const used = metricByKey(window, 'linux_mem_used_mb');
    const share = metricByKey(window, 'linux_mem_used_pct');
    return used && share && chart
      ? {
          ...chart,
          headline: `${formatValue(share.value, share.unit)} (${formatValue(used.value, used.unit)})`,
        }
      : chart;
  });

  protected readonly mlaMemory = computed(() => metricChart(this.window(), 'mla_mem_allocated_mb'));

  /** On the CMA's own size, so the line shows how full it is. */
  protected readonly ev74Cma = computed(() =>
    metricChart(
      this.window(),
      'ev74_cma_used_mb',
      metricByKey(this.window(), 'ev74_cma_total_mb')?.value ?? null,
    ),
  );

  /** The heatmap's rows and its headline, which leads with the cores' average; null without cores. */
  protected readonly cores = computed(() => {
    const { rows, average, busiest } = coreSummary(this.window());
    if (!rows.length) return null;
    const summary = `1-minute average of ${rows.length} ${rows.length === 1 ? 'core' : 'cores'}`;
    const top = busiest ? ` · busiest ${busiest.label} at ${percent(busiest.recent)}` : '';
    return {
      headline: `${formatValue(average, '%')} · ${summary}${top}`,
      rows: rows.map((row): NeatHeatmapRow => ({
        key: row.key,
        label: row.label,
        values: row.values,
        end: formatValue(row.recent, '%'),
        endTone: row.tone,
      })),
    };
  });
}
