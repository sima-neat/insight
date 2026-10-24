import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { NeatNote } from '@sima/neat-ui';
import { NeatTab, NeatTabs } from '@sima/neat-ui/tabs';
import { alertLabel, formatValue } from '../../stats/format';
import { StatsSession } from '../../stats/stats-session';
import {
  metricChart,
  thermalGroups,
  thermalMax,
  thermalMaxChart,
  type TelemetryWindow,
} from '../../stats/telemetry';
import { StatsChart } from './stats-chart';

/**
 * The Thermal area: the hottest sensor's line over time, then Sentinel's sensor groups as tabs
 * (each with its sensor count and alerts), then the open group's sensors as compact lines with
 * their readings (Inv-S §2.6). The open group is kept in `StatsSession`, so it is still open when
 * the user comes back; until one is chosen, and when the remembered one is gone, the first opens.
 */
@Component({
  selector: 'app-thermal-area',
  imports: [NeatNote, NeatTab, NeatTabs, StatsChart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (chart(); as chart) {
      <p neatNote>{{ note() }}</p>
      <app-stats-chart
        label="Thermal max"
        size="large"
        headless
        [chart]="chart"
        [times]="window().times"
      />
      <neat-tabs
        label="Thermal sensor groups"
        [value]="session.thermalGroup() ?? undefined"
        (valueChange)="session.thermalGroup.set($event ?? null)"
      >
        @for (group of groups(); track group.name) {
          <neat-tab [label]="group.label" [value]="group.name">
            <ng-template>
              <ul class="sensors">
                @for (sensor of group.sensors; track sensor.key) {
                  <li class="sensor">
                    <span>{{ sensor.name }}</span>
                    <app-stats-chart
                      size="compact"
                      headless
                      [label]="sensor.name"
                      [chart]="sensor.chart"
                      [times]="window().times"
                    />
                    <span class="value">{{ sensor.value }}</span>
                  </li>
                }
              </ul>
            </ng-template>
          </neat-tab>
        }
      </neat-tabs>
    } @else {
      <p neatNote>Sentinel reported no temperatures on this board.</p>
    }
  `,
  styleUrl: './thermal-area.css',
})
export class ThermalArea {
  readonly window = input.required<TelemetryWindow>();

  protected readonly session = inject(StatsSession);

  protected readonly chart = computed(() => thermalMaxChart(this.window()));

  /** What the chart is of, since it has no title row of its own: "Thermal max · hottest sensor MLA MLA-3". */
  protected readonly note = computed(() => {
    const hottest = thermalMax(this.window())?.hottest;
    return hottest
      ? `Thermal max · hottest sensor ${hottest.group} ${hottest.short || hottest.label}`
      : 'Thermal max';
  });

  protected readonly groups = computed(() => {
    const window = this.window();
    return thermalGroups(window).map(({ name, metrics, alert }) => {
      const count = `${metrics.length} ${metrics.length === 1 ? 'sensor' : 'sensors'}`;
      return {
        name,
        label: [name, count, ...(alert ? [alertLabel(alert).label] : [])].join(' · '),
        sensors: metrics.map((metric) => ({
          key: metric.key,
          name: metric.short || metric.label,
          value: formatValue(metric.value, metric.unit),
          chart: metricChart(window, metric.key),
        })),
      };
    });
  });
}
