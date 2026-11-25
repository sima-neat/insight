import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  Injector,
  linkedSignal,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NeatButton, NeatNote } from '@sima/neat-ui';
import { NeatCollapsible } from '@sima/neat-ui/collapsible';
import { NeatErrorNote, NeatField } from '@sima/neat-ui/field';
import { NeatInput } from '@sima/neat-ui/input';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { BoardList } from './api';
import { problemOf } from './board-error';
import { BoardService } from './board.service';
import {
  type BoardFormValues,
  defaultTargetText,
  enteredBoard,
  initialBoardForm,
  validateBoardForm,
} from './board-form-values';

/** The board dialog's actions; one runs at a time. */
export type BoardAction = 'check' | 'select' | 'trust';

/** The words when there is nothing to fall back to. */
const NO_DEFAULT = 'none (Insight is not on a board and the SDK is not paired with a DevKit)';

/**
 * Change board: enter a board by host, SSH port and user, or go back to the default with Use
 * default, which forgets the board entered by hand. Insight connects with SSH keys only, so there
 * is no password. The section is closed while a board is in use and open while there is none; a
 * selection that goes through closes it, and the kit's collapsible then gives the focus to its
 * trigger. A refusal, the form's own or the server's, stays under the form.
 *
 * Save and Use default wait (`aria-disabled`, not `disabled`) while any board action runs: a
 * disabled button would drop the focus the section hands back to its trigger when it closes.
 *
 * The SSH port is plain text until Save: `validateBoardForm` reads it with its own message, which
 * a number field's silent revert would never show.
 */
@Component({
  selector: 'app-board-form',
  imports: [NeatButton, NeatCollapsible, NeatErrorNote, NeatField, NeatInput, NeatNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './board-form.html',
  styleUrl: './board-form.css',
})
export class BoardForm {
  /** The dialog's action running, this form's Save and Use default among them. */
  readonly busy = model<BoardAction | null>(null);
  /** A selection went through: the dialog clears the problem of an earlier action. */
  readonly selected = output<BoardList>();

  private readonly board = inject(BoardService);
  private readonly toasts = inject(NeatToasts);
  private readonly injector = inject(Injector);
  private readonly hostField = viewChild<ElementRef<HTMLInputElement>>('host');

  protected readonly hasTarget = computed(() => !!this.board.selected());
  /**
   * Open by default only without a board. It is reset only when a board comes or goes, not on
   * every read of the same one, so a section the user opened stays open.
   */
  protected readonly open = linkedSignal({
    source: this.hasTarget,
    computation: (hasTarget) => !hasTarget,
  });
  protected readonly saved = computed(() => !!enteredBoard(this.board.state()));
  protected readonly summary = computed(
    () => `Host, port, user${this.saved() ? ' · Use default' : ''}`,
  );
  protected readonly defaultText = computed(
    () => defaultTargetText(this.board.state()) || NO_DEFAULT,
  );

  /** What the user typed; null until then, while the fields follow the board state. */
  private readonly edited = signal<BoardFormValues | null>(null);
  protected readonly values = computed(() => this.edited() ?? initialBoardForm(this.board.state()));
  protected readonly error = signal('');

  constructor() {
    // A refusal is about the board it was typed for; once the board changes otherwise (another
    // tab, a terminal, Use default elsewhere) it says nothing more.
    effect(() => {
      this.board.id();
      untracked(() => this.error.set(''));
    });
  }

  protected set(field: keyof BoardFormValues, value: string): void {
    this.edited.set({ ...this.values(), [field]: value });
  }

  protected async save(): Promise<void> {
    if (this.busy()) return;
    const result = validateBoardForm(this.values());
    if ('error' in result) {
      this.error.set(result.error);
      return;
    }
    const body = result.body;
    const state = await this.run(() => this.board.select(body));
    if (state) {
      this.done(
        state,
        `Board set to ${state.selected?.label || body.host}. Check again to test the connection.`,
      );
    }
  }

  protected async useDefault(): Promise<void> {
    if (this.busy()) return;
    const state = await this.run(() => this.board.forget());
    if (state) {
      this.done(state, state.selected ? `Using ${state.selected.label}.` : 'Manual board cleared.');
    }
  }

  protected cancel(): void {
    // Not while a save runs: its refusal would arrive in a closed section, unseen.
    if (this.busy() === 'select') return;
    this.edited.set(null);
    this.error.set('');
    this.open.set(false);
  }

  /** Selects or forgets: the new boards, or null after a refusal, which then shows under the form. */
  private async run(action: () => Promise<BoardList>): Promise<BoardList | null> {
    this.busy.set('select');
    this.error.set('');
    try {
      return await action();
    } catch (failure) {
      const problem = problemOf(failure);
      this.error.set(problem.hint ? `${problem.message}\n${problem.hint}` : problem.message);
      return null;
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * With no board left to use (Use default without a default), the form stays open to enter one.
   * The section does not close then, so its trigger does not take the focus; Use default and
   * Cancel went with the entered board, so the focus goes to the host field, where the next step
   * is.
   */
  private done(state: BoardList, message: string): void {
    this.edited.set(null);
    this.open.set(!state.selected);
    if (!state.selected) {
      afterNextRender(() => this.hostField()?.nativeElement.focus(), { injector: this.injector });
    }
    this.selected.emit(state);
    this.toasts.status(message);
  }
}
