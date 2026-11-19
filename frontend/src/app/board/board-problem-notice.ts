import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NeatButton, NeatNote } from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatConfirm } from '@sima/neat-ui/confirm';
import { NeatDetails } from '@sima/neat-ui/details';
import { CopyCommand } from '../copy-command';
import type { BoardProblem } from './board-error';

/**
 * Why the board cannot be used, and the way out where there is one: a refused key gets the
 * command that authorizes Insight's key (`command`), with Copy; a changed host key gets both
 * fingerprints (`hostKey`) and Trust new key…, which asks first. Any other problem is its message
 * and hint. Every problem carries the actions the caller projects (`neatCalloutActions`) after
 * its own: the dialog's failed board read is one, with its Retry. The dialog decides which problem
 * shows (an action's own, else the one the board's status records) and runs the trust itself, so
 * that it waits for any other board action.
 */
@Component({
  selector: 'app-board-problem-notice',
  imports: [CopyCommand, NeatButton, NeatCallout, NeatDetails, NeatNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // One callout for every problem, so that the caller's actions have one place to project into
  // (a second `ng-content` with the same selector would never receive them).
  template: `
    @let shown = problem();
    <neat-callout
      [tone]="keyChanged() ? 'warning' : 'danger'"
      [announce]="announce() ? 'alert' : null"
    >
      <div class="body">
        <p>{{ shown.message }}</p>
        @if (shown.hint) {
          <p neatNote>{{ shown.hint }}</p>
        }
        @if (keyChanged()) {
          <dl neatDetails>
            <dt>Expected</dt>
            <dd>{{ shown.hostKey?.expected || 'unknown' }}</dd>
            <dt>Presented</dt>
            <dd>{{ presented() || 'unknown' }}</dd>
          </dl>
        } @else if (command(); as command) {
          <app-copy-command [command]="command" label="command that authorizes the key" />
        }
      </div>
      @if (keyChanged()) {
        <button
          neatButton
          neatCalloutActions
          type="button"
          size="small"
          variant="outlined"
          [disabled]="!presented()"
          [attr.aria-disabled]="busy() ? true : null"
          (click)="askTrust()"
        >
          Trust new key…
        </button>
      }
      <ng-content select="[neatCalloutActions]" ngProjectAs="[neatCalloutActions]" />
    </neat-callout>
  `,
  styleUrl: './board-problem-notice.css',
})
export class BoardProblemNotice {
  readonly problem = input.required<BoardProblem>();
  /** Another board action runs: Trust waits for it. */
  readonly busy = input(false);
  /**
   * Say the problem as it appears (`role="alert"`): for an action that just failed, which has no
   * toast. Not for one already there when the dialog opens.
   */
  readonly announce = input(false, { transform: booleanAttribute });
  /** The presented fingerprint the user confirmed trusting. */
  readonly trust = output<string>();

  private readonly confirm = inject(NeatConfirm);

  protected readonly keyChanged = computed(() => this.problem().code === 'host_key_changed');
  /** `auth_failed`'s command that authorizes Insight's key on the board (`ssh-copy-id …`). */
  protected readonly command = computed(() =>
    this.problem().code === 'auth_failed' ? this.problem().command : '',
  );
  protected readonly presented = computed(() => this.problem().hostKey?.presented ?? '');

  protected async askTrust(): Promise<void> {
    const presented = this.presented();
    if (!presented || this.busy()) return;
    const host = this.problem().hostKey?.host || 'this board';
    const confirmed = await this.confirm.ask({
      title: 'Trust the new host key?',
      message: `Trust the new key only if ${host} was reflashed or replaced. Otherwise a different device may be answering at this address.`,
      confirmLabel: 'Trust new key',
      tone: 'danger',
    });
    // The board may present another key by now (a re-read while the user compared fingerprints):
    // what was confirmed is not that one.
    if (confirmed && this.presented() === presented) this.trust.emit(presented);
  }
}
