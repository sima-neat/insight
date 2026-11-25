import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NeatChartCard, NeatStackedChart } from '@sima/neat-ui/charts';
import { NO_VALUE } from '../../no-value';
import { fixedValue, isNumber } from '../../stats/format';
import {
  BOARD_POWER_LABEL,
  boardPowerChart,
  metricByKey,
  powerRailsChart,
  type TelemetryWindow,
} from '../../stats/telemetry';
import { StatsChart } from './stats-chart';

/** The tiles, with the metric each reads. */
const TILES = [
  { key: 'power_current_watts', heading: 'Current' },
  { key: 'power_average_watts', heading: 'Session average' },
  { key: 'power_peak_watts', heading: 'Session peak' },
] as const;

/**
 * The Power area: Current, Session average and Session peak as tiles, the board power chart with
 * the session average as its reference line, and the power rails as one stack with a legend of
 * each rail's watts and share. Whatever the board does not report is left out.
 */
@Component({
  selector: 'app-power-area',
  imports: [NeatChartCard, NeatStackedChart, StatsChart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tiles().length) {
      <div class="tiles">
        @for (tile of tiles(); track tile.heading) {
          <neat-chart-card [heading]="tile.heading" [value]="tile.value" [unit]="tile.unit" />
        }
      </div>
    }
    <app-stats-chart
      [label]="boardPowerLabel"
      size="large"
      [chart]="boardPower()"
      [times]="window().times"
    />
    @if (rails(); as rails) {
      <neat-stacked-chart
        label="Power rails"
        [headline]="rails.headline"
        [series]="rails.series"
        [times]="window().times"
        [domain]="rails.domain"
        [format]="watts"
      />
    }
  `,
  styleUrl: './power-area.css',
})
export class PowerArea {
  readonly window = input.required<TelemetryWindow>();

  /** Rails are small figures: two decimals tell a 0.09 W rail from a 0.59 W one. */
  protected readonly watts = (value: number): string => fixedValue(value, 'W', 2);

  protected readonly boardPowerLabel = BOARD_POWER_LABEL;

  protected readonly tiles = computed(() =>
    TILES.flatMap(({ key, heading }) => {
      const metric = metricByKey(this.window(), key);
      if (!metric) return [];
      return isNumber(metric.value)
        ? [{ heading, value: metric.value.toFixed(1), unit: 'W' }]
        : [{ heading, value: NO_VALUE, unit: '' }];
    }),
  );

  /** Board power shows no headline of its own: the Current tile above it says the value. */
  protected readonly boardPower = computed(() => {
    const chart = boardPowerChart(this.window());
    return chart && { ...chart, headline: '' };
  });

  protected readonly rails = computed(() => powerRailsChart(this.window()));
}
