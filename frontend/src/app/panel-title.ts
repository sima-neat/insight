import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NeatAsideTitle, type NeatTone } from '@sima/neat-ui';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';

/** A state as a chip shows it: its words and the theme's status colour. */
export interface PanelChip {
  readonly label: string;
  readonly tone: NeatTone;
}

/**
 * A side panel's first line: what the panel is about, as its heading (`neatAsideTitle`), with its
 * state as a chip beside it: `<app-panel-title [chip]="row.state">src3</app-panel-title>`. The
 * chip sits outside the heading, so the heading names the subject only. Streaming's slot panel and
 * Peripherals' device panels open with it.
 */
@Component({
  selector: 'app-panel-title',
  imports: [NeatAsideTitle, NeatStatusChip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 neatAsideTitle><ng-content /></h2>
    <neat-status-chip [tone]="chip().tone">{{ chip().label }}</neat-status-chip>
  `,
  styleUrl: './panel-title.css',
})
export class PanelTitle {
  readonly chip = input.required<PanelChip>();
}
