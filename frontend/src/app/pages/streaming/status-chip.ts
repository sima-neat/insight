import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { SlotTone } from '../../sources/slot-row';

/**
 * A short label on one of the theme's status fills: a slot's state (Live, Idle, External, …) in
 * the slot list and over the slot's panel, and a codec Neat cannot decode. The label is the
 * content: `<app-status-chip [tone]="state.tone">{{ state.label }}</app-status-chip>`.
 */
@Component({
  selector: 'app-status-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-tone]': 'tone()' },
  template: '<ng-content />',
  styleUrl: './status-chip.css',
})
export class StatusChip {
  readonly tone = input.required<SlotTone>();
}
