import { booleanAttribute, ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NeatButton, NeatNote } from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import type { SentinelFailure } from '../../stats/sentinel-failure';

/**
 * Why a Sentinel request failed, in a danger callout: `failureOf`'s title as its heading, the
 * backend's message where the title is not it, and the hint where there is one. Retry is offered
 * only where asking again can help (`retryable`) and says so with `retry`; while the caller asks
 * again (`busy`) it reads "Retrying…" and waits with `aria-disabled` rather than `disabled`, so
 * the focus stays on it. It is an alert (the kit's `announce`), so a screen reader says the
 * failure as it appears: a read failing is news, and nothing else on the screen says it. Stats'
 * views and the run panel show their failed reads with it; a board-coded failure has
 * `app-board-problem-notice` instead, which the caller chooses.
 */
@Component({
  selector: 'app-sentinel-failure',
  imports: [NeatButton, NeatCallout, NeatNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let shown = failure();
    <neat-callout
      tone="danger"
      announce="alert"
      [heading]="shown.title"
      [headingLevel]="headingLevel()"
      [attr.aria-busy]="busy() || null"
    >
      @if (shown.detail) {
        <p>{{ shown.detail }}</p>
      }
      @if (shown.hint) {
        <p neatNote>{{ shown.hint }}</p>
      }
      @if (shown.retryable) {
        <button
          neatButton
          neatCalloutActions
          type="button"
          size="small"
          variant="outlined"
          [attr.aria-disabled]="busy() || null"
          (click)="ask()"
        >
          {{ busy() ? 'Retrying…' : 'Retry' }}
        </button>
      }
    </neat-callout>
  `,
  styleUrl: './sentinel-failure-callout.css',
})
export class SentinelFailureCallout {
  readonly failure = input.required<SentinelFailure>();
  readonly headingLevel = input<2 | 3 | 4 | 5 | 6>(3);
  /** The caller is asking again: Retry waits, and says so. */
  readonly busy = input(false, { transform: booleanAttribute });
  readonly retry = output<void>();

  protected ask(): void {
    if (!this.busy()) this.retry.emit();
  }
}
