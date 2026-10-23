import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { SlotStateView } from './slot-row';

/**
 * A slot's state as a chip in the theme's status colours: Live, Idle, External, Pulled and the
 * rest (`slotState`). In the slot list and over the slot's panel.
 */
@Component({
  selector: 'app-slot-state-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-tone]': 'state().tone' },
  template: '{{ state().label }}',
  styleUrl: './slot-state-chip.css',
})
export class SlotStateChip {
  readonly state = input.required<SlotStateView>();
}
