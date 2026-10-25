import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
} from '@angular/core';
import { type NeatChartAxis, NeatTimeChart, type NeatReference } from '@sima/neat-ui/charts';
import { formatValue } from '../../stats/format';
import type { ChartInputs } from '../../stats/telemetry';

/** A chart's inputs as `telemetry.ts` builds them; Board power's also carry its reference line. */
export type StatsChartInputs = ChartInputs & { readonly reference?: NeatReference | null };

/**
 * One metric's time chart: the inputs a builder made (in `telemetry.ts`: `metricChart`,
 * `pairChart`, `thermalMaxChart`, `boardPowerChart`; the comparison's overlay from `compare.ts`) on
 * the kit's `neat-time-chart`, its values worded in the chart's unit. A null chart, a metric the
 * board does not report, draws nothing (#170). Every Stats time chart is this, so none of them
 * words a value or sets a scale of its own.
 */
@Component({
  selector: 'app-stats-chart',
  imports: [NeatTimeChart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (chart(); as inputs) {
      <neat-time-chart
        [label]="label()"
        [headline]="inputs.headline"
        [series]="inputs.series"
        [times]="times()"
        [domain]="inputs.domain"
        [thresholds]="inputs.thresholds"
        [reference]="inputs.reference ?? null"
        [tone]="inputs.tone"
        [size]="size()"
        [headless]="headless()"
        [valueLabels]="valueLabels()"
        [axis]="axis()"
        [format]="format()"
      />
    }
  `,
  styleUrl: './stats-chart.css',
})
export class StatsChart {
  readonly chart = input.required<StatsChartInputs | null>();
  readonly label = input.required<string>();
  /** The window's `times`, which place the samples. */
  readonly times = input.required<readonly (number | null)[]>();
  readonly size = input<'compact' | 'medium' | 'large'>('medium');
  /** Leaves out the title row, for a chart under a heading of its own. */
  readonly headless = input(false, { transform: booleanAttribute });
  /** Whether the grid and the levels carry their values; a card's small plot leaves them out. */
  readonly valueLabels = input(true, { transform: booleanAttribute });
  /**
   * What the time axis counts: back from the newest sample for a live window, forward from the
   * first for runs read from their start.
   */
  readonly axis = input<NeatChartAxis>('recent');

  private readonly unit = computed(() => this.chart()?.unit ?? null);
  /** One function per unit, so the chart does not re-word its values on every poll. */
  protected readonly format = computed(() => {
    const unit = this.unit();
    return (value: number) => formatValue(value, unit);
  });
}
