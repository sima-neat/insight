import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
} from '@angular/core';
import { NeatTimeChart, type NeatReference } from '@sima/neat-ui/charts';
import { formatValue } from '../../stats/format';
import type { ChartInputs } from '../../stats/telemetry';

/** A chart's inputs as `telemetry.ts` builds them; Board power's also carry its reference line. */
export type StatsChartInputs = ChartInputs & { readonly reference?: NeatReference | null };

/**
 * One metric's time chart in the side panel: the inputs a builder in `telemetry.ts` made
 * (`metricChart`, `pairChart`, `thermalMaxChart`, `boardPowerChart`) on the kit's `neat-time-chart`,
 * its values worded in the chart's unit. A null chart, a metric the board does not report, draws
 * nothing (#170). Every area's charts are this, so none of them words a value or sets a scale of
 * its own.
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

  private readonly unit = computed(() => this.chart()?.unit ?? null);
  /** One function per unit, so the chart does not re-word its values on every poll. */
  protected readonly format = computed(() => {
    const unit = this.unit();
    return (value: number) => formatValue(value, unit);
  });
}
