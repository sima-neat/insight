import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NeatButton } from '@sima/neat-ui';
import type { NeatLateNoticeBlocker, NeatLateNoticeDetails } from '@sima/neat-ui/video';

/** Which of the notice's actions was taken: this channel's own buffer, or the global one. */
export type RaiseTarget = 'channel' | 'global';

/** Why nothing can be offered, word for word as in 829ec7c's `MetadataLateNotice.jsx`. */
const BLOCKED_TEXT: Readonly<Record<NeatLateNoticeBlocker, string>> = {
  maximum:
    'The buffer needed exceeds the 4000 ms maximum. The application must send metadata sooner.',
  unsupported: 'This browser cannot delay video; overlays cannot be synchronized.',
  unmeasured:
    'Lateness could not be measured. The metadata does not belong to the frames that were shown.',
};

/**
 * The "raise the buffer" notice (Inv §4g), ported from 829ec7c's `MetadataLateNotice.jsx`: what
 * was measured, and either why nothing can be done or the two ways to raise the video sync
 * buffer. The original opened from the tile's chip as a popover; here it sits in the inspector's
 * General tab, so it has no open state of its own and the inspector decides when it shows. The
 * original's two-line action buttons are kit buttons here, each described by the line below it.
 *
 * Both actions carry the suggestion as the original's did: what the global one writes (a raise, or
 * only following a global value that already covers it) is the settings store's decision.
 */
@Component({
  selector: 'app-late-notice',
  imports: [NeatButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'region', 'aria-labelledby': 'late-notice-title' },
  template: `
    @let notice = details();
    <h3 id="late-notice-title" class="title">Overlays are being dropped</h3>
    <p class="text">Metadata arrives after its video frame was already shown.</p>
    <dl class="values">
      <dt>Arrives after its frame</dt>
      <dd>{{ notice.latenessMs === null ? 'not measured' : '~' + notice.latenessMs + ' ms' }}</dd>
      <dt>Video sync buffer</dt>
      <dd>{{ notice.bufferMs }} ms</dd>
      <dt>Late messages</dt>
      <dd>{{ notice.latePercent === null ? '—' : notice.latePercent + ' %' }}</dd>
    </dl>
    @if (notice.blockedBy !== null) {
      <p class="text">{{ blockedText[notice.blockedBy] }}</p>
    } @else {
      <div class="actions">
        <button
          neatButton
          type="button"
          size="small"
          aria-describedby="late-notice-channel"
          (click)="raise.emit('channel')"
        >
          Raise for this channel to {{ notice.suggestedBufferMs }} ms
        </button>
        <p id="late-notice-channel" class="sub">Other channels keep their setting.</p>
        @if (notice.globalAction; as action) {
          <button
            neatButton
            type="button"
            variant="outlined"
            size="small"
            aria-describedby="late-notice-global"
            (click)="raise.emit('global')"
          >
            @if (action.kind === 'follow') {
              Use global value ({{ action.valueMs }} ms)
            } @else {
              Raise globally to {{ action.valueMs }} ms
            }
          </button>
          <p id="late-notice-global" class="sub">
            @if (action.kind === 'follow') {
              Removes this channel's own value.
            } @else {
              Applies to every channel without its own value.
            }
          </p>
        }
      </div>
    }
  `,
  styleUrl: './late-notice.css',
})
export class LateNotice {
  readonly details = input.required<NeatLateNoticeDetails>();
  readonly raise = output<RaiseTarget>();

  protected readonly blockedText = BLOCKED_TEXT;
}
