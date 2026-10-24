import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NeatAsideHeading } from '@sima/neat-ui';
import { NeatCollapsible } from '@sima/neat-ui/collapsible';
import { NeatDetails } from '@sima/neat-ui/details';
import type { PeripheralItem } from '../../peripherals/api';
import { deviceFacts } from '../../peripherals/devices';

/**
 * A device panel's last part: the facts and notes the backend reports for the device and #170
 * never showed (spec, "Details, collapsed by default"), in a section closed until opened. The
 * facts are `deviceFacts`, a key/value list; the notes follow under their own heading. A device
 * with neither shows nothing. The camera and microphone panels end with it, and so does the panel
 * of a kind Insight has no view for.
 */
@Component({
  selector: 'app-device-details',
  imports: [NeatAsideHeading, NeatCollapsible, NeatDetails],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (facts().length || notes().length) {
      <neat-collapsible label="Details">
        @if (facts().length) {
          <dl neatDetails>
            @for (fact of facts(); track fact.term) {
              <dt>{{ fact.term }}</dt>
              <dd>{{ fact.value }}</dd>
            }
          </dl>
        }
        @if (notes().length) {
          <h3 neatAsideHeading>Notes</h3>
          <ul class="notes">
            @for (note of notes(); track $index) {
              <li>{{ note }}</li>
            }
          </ul>
        }
      </neat-collapsible>
    }
  `,
  styleUrl: './device-details.css',
})
export class DeviceDetails {
  readonly item = input.required<PeripheralItem>();

  protected readonly facts = computed(() => deviceFacts(this.item()));
  protected readonly notes = computed(() => this.item().notes);
}
