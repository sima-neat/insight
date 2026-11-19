import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NeatCallout } from '@sima/neat-ui/callout';
import type { DeviceError } from '../../peripherals/api';

/**
 * The problems the backend reports with a device (its `errors`), each a danger callout with the
 * hint as its body. The camera and microphone panels show
 * them under their title.
 */
@Component({
  selector: 'app-device-errors',
  imports: [NeatCallout],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (problem of errors(); track $index) {
      <neat-callout tone="danger" [heading]="problem.message">
        <p>{{ problem.hint }}</p>
      </neat-callout>
    }
  `,
  styleUrl: './device-errors.css',
})
export class DeviceErrors {
  readonly errors = input.required<readonly DeviceError[]>();
}
