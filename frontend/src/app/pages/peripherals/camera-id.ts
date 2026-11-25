import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NeatButton } from '@sima/neat-ui';
import { NeatCodeBlock } from '@sima/neat-ui/code-block';
import { NeatPopover, NeatPopoverContent, NeatPopoverTrigger } from '@sima/neat-ui/popover';

/**
 * A camera's ID, the one a Neat application opens it by (`CameraInput`'s name for a MIPI camera,
 * `UsbCameraInput`'s for a USB one): a button that opens a popover with the ID and a Copy button.
 */
@Component({
  selector: 'app-camera-id',
  imports: [NeatButton, NeatCodeBlock, NeatPopover, NeatPopoverContent, NeatPopoverTrigger],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <neat-popover label="Camera ID" align="start">
      <button neatButton neatPopoverTrigger type="button" variant="text" size="small">
        Camera ID
      </button>
      <ng-template neatPopoverContent>
        <div class="content">
          <p>The ID a Neat application opens this camera by.</p>
          <neat-code-block [code]="name()" copy="camera ID" />
        </div>
      </ng-template>
    </neat-popover>
  `,
  styleUrl: './camera-id.css',
})
export class CameraId {
  /** The ID: the camera's `device.camera_name`. */
  readonly name = input.required<string>();
}
