import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { PanelTitle } from '../../panel-title';
import { alertLabel, metricAlert } from '../../stats/format';
import {
  AREA_LABELS,
  areaMetrics,
  type StatsArea,
  type TelemetryWindow,
} from '../../stats/telemetry';
import { PowerArea } from './power-area';
import { StorageArea } from './storage-area';
import { SystemArea } from './system-area';
import { ThermalArea } from './thermal-area';

/**
 * Stats' side panel: the area's name with how many of its metrics are past a threshold, and the
 * area itself (Thermal, Power, System or Storage & Network). The cards on the page open one each.
 */
@Component({
  selector: 'app-stats-area-panel',
  imports: [PanelTitle, PowerArea, StorageArea, SystemArea, ThermalArea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-panel-title [chip]="chip()">{{ title() }}</app-panel-title>
    @switch (area()) {
      @case ('thermal') {
        <app-thermal-area [window]="window()" />
      }
      @case ('power') {
        <app-power-area [window]="window()" />
      }
      @case ('system') {
        <app-system-area [window]="window()" />
      }
      @case ('storage') {
        <app-storage-area [window]="window()" />
      }
    }
  `,
  styleUrl: './stats-area-panel.css',
})
export class StatsAreaPanel {
  readonly area = input.required<StatsArea>();
  readonly window = input.required<TelemetryWindow>();

  protected readonly title = computed(() => AREA_LABELS[this.area()]);

  /** The worst alert in the area and how many metrics have it; none while every metric is within its levels. */
  protected readonly chip = computed(() => {
    const alert = metricAlert(areaMetrics(this.window(), this.area()));
    return alert ? alertLabel(alert) : null;
  });
}
