import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NeatNote } from '@sima/neat-ui';
import { SlotsService } from './slots.service';

/**
 * What a page that shows the slots says while their status could not be refreshed (ruling Q8):
 * the page then shows the last answer, which may be out of date. Streaming and Media put it above
 * their lists. The paragraph is always in the DOM, so a screen reader hears the text appear.
 */
@Component({
  selector: 'app-slots-notice',
  imports: [NeatNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p neatNote role="status">
    @if (slots.unavailable()) {
      Slot status could not be refreshed. Showing the last known state.
    }
  </p>`,
  styleUrl: './slots-notice.css',
})
export class SlotsNotice {
  protected readonly slots = inject(SlotsService);
}
