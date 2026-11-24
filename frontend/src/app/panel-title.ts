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
 * chip sits outside the heading, so the heading names the subject only, and is left out while
 * null; an element marked `panelTitleEnd` follows it. Streaming's slot panel, Peripherals' device
 * panels and Stats' areas open with it.
 */
@Component({
  selector: 'app-panel-title',
  imports: [NeatAsideTitle, NeatStatusChip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 neatAsideTitle><ng-content /></h2>
    @if (chip(); as chip) {
      <neat-status-chip [tone]="chip.tone">{{ chip.label }}</neat-status-chip>
    }
    <span class="end"><ng-content select="[panelTitleEnd]" /></span>
  `,
  styleUrl: './panel-title.css',
})
export class PanelTitle {
  /** The state beside the heading; null while the subject has none to show (Stats' areas with no alerts). */
  readonly chip = input<PanelChip | null>(null);
}
