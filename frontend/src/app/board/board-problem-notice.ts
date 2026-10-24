import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NeatButton, NeatCode, NeatNote } from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatConfirm } from '@sima/neat-ui/confirm';
import { NeatDetails } from '@sima/neat-ui/details';
import { NeatToasts } from '@sima/neat-ui/toast';
import { copyText } from '../clipboard';
import type { BoardProblem } from './board-error';

/** #170's words for a refused clipboard (Inv-PB §2.5, api.js). */
const COPY_REFUSED =
  'Could not copy: the browser only allows clipboard access over HTTPS or localhost. Select the text and copy it instead.';

/**
 * Why the board cannot be used, and the way out where there is one (Inv-PB §1.4, problem notice):
 * a refused key gets the `ssh-copy-id` command that authorizes Insight's key, with Copy; a changed
 * host key gets both fingerprints and Trust new key…, which asks first. Any other problem is its
 * message and hint, with the actions the caller projects (`neatCalloutActions`): the dialog's
 * failed board read is one too, with its Retry. The dialog decides which problem shows (an
 * action's own, else the one the board state repeats) and runs the trust itself, so that it waits
 * for any other board action.
 */
@Component({
  selector: 'app-board-problem-notice',
  imports: [NeatButton, NeatCallout, NeatCode, NeatDetails, NeatNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let shown = problem();
    @if (shown.code === 'host_key_changed') {
      <neat-callout tone="warning" [announce]="announce() ? 'alert' : null">
        <div class="body">
          <p>{{ shown.message }}</p>
          @if (shown.hint) {
            <p neatNote>{{ shown.hint }}</p>
          }
          <dl neatDetails>
            <dt>Expected</dt>
            <dd>{{ expected() || 'unknown' }}</dd>
            <dt>Presented</dt>
            <dd>{{ presented() || 'unknown' }}</dd>
          </dl>
        </div>
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
      </neat-callout>
    } @else {
      <neat-callout tone="danger" [announce]="announce() ? 'alert' : null">
        <div class="body">
          <p>{{ shown.message }}</p>
          @if (shown.hint) {
            <p neatNote>{{ shown.hint }}</p>
          }
          @if (command(); as command) {
            <code neatCode class="command">{{ command }}</code>
          }
        </div>
        @if (command(); as command) {
          <button
            neatButton
            neatCalloutActions
            type="button"
            size="small"
            variant="outlined"
            (click)="copy(command)"
          >
            Copy command
          </button>
        }
        <ng-content select="[neatCalloutActions]" ngProjectAs="[neatCalloutActions]" />
      </neat-callout>
    }
  `,
  styleUrl: './board-problem-notice.css',
})
export class BoardProblemNotice {
  readonly problem = input.required<BoardProblem>();
  /** Another board action runs: Trust waits for it. */
  readonly busy = input(false);
  /**
   * Say the problem as it appears (`role="alert"`, as #170's notice): for an action that just
   * failed, which has no toast. Not for one already there when the dialog opens.
   */
  readonly announce = input(false, { transform: booleanAttribute });
  /** The presented fingerprint the user confirmed trusting. */
  readonly trust = output<string>();

  private readonly confirm = inject(NeatConfirm);
  private readonly toasts = inject(NeatToasts);

  /** `auth_failed`'s command that authorizes Insight's key on the board (`ssh-copy-id …`). */
  protected readonly command = computed(() =>
    this.problem().code === 'auth_failed' ? detail(this.problem(), 'command') : '',
  );
  protected readonly expected = computed(() => detail(this.problem(), 'expected_fingerprint'));
  protected readonly presented = computed(() => detail(this.problem(), 'presented_fingerprint'));

  protected async copy(command: string): Promise<void> {
    try {
      await copyText(command);
      this.toasts.status(`Copied: ${command}`);
    } catch {
      this.toasts.error(COPY_REFUSED);
    }
  }

  protected async askTrust(): Promise<void> {
    const presented = this.presented();
    if (!presented || this.busy()) return;
    const host = detail(this.problem(), 'host') || 'this board';
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

/** A string extra of the problem's error body; '' when absent. */
function detail(problem: BoardProblem, key: string): string {
  const value = problem.details[key];
  return typeof value === 'string' ? value : '';
}
