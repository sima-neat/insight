import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { NeatButton, NeatCode } from '@sima/neat-ui';
import { NeatToasts } from '@sima/neat-ui/toast';
import { copyText } from './clipboard';

/** What a refused clipboard is told. */
const COPY_REFUSED =
  'Could not copy: the browser only allows clipboard access over HTTPS or localhost. Select the text and copy it instead.';

/**
 * A shell command for the user to run elsewhere, with Copy beside it: the command that authorizes
 * Insight's key on the board, the `ssh` command that opens a shell on it, the one that installs
 * Sentinel. The command is copied as a whole and wraps rather than widening its container; Copy
 * says what it copied in a toast, or that the browser refused.
 */
@Component({
  selector: 'app-copy-command',
  imports: [NeatButton, NeatCode],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <code neatCode class="command">{{ command() }}</code>
    <button
      neatButton
      type="button"
      size="small"
      variant="outlined"
      [attr.aria-label]="name()"
      (click)="copy()"
    >
      Copy
    </button>
  `,
  styleUrl: './copy-command.css',
})
export class CopyCommand {
  readonly command = input.required<string>();
  /** What the command is, for Copy's accessible name: "Copy the ssh command". */
  readonly label = input('command');

  private readonly toasts = inject(NeatToasts);

  protected readonly name = computed(() => `Copy the ${this.label()}`);

  protected async copy(): Promise<void> {
    const command = this.command();
    try {
      await copyText(command);
      this.toasts.status(`Copied: ${command}`);
    } catch {
      this.toasts.error(COPY_REFUSED);
    }
  }
}
