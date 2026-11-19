import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NeatButton, NeatCode, NeatNote } from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatCollapsible } from '@sima/neat-ui/collapsible';
import { NeatDetails } from '@sima/neat-ui/details';
import { NeatDialog, NeatDialogBody, type NeatDialogRef } from '@sima/neat-ui/dialog';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { NeatToasts } from '@sima/neat-ui/toast';
import { CopyCommand } from '../copy-command';
import { boardCameraSetup } from '../peripherals/devices';
import { PeripheralsService } from '../peripherals/peripherals.service';
import { formatRelativeTime } from '../relative-time';
import { ticking } from '../clock';
import { problemOf, recordedProblem, type BoardProblem } from './board-error';
import { BoardService } from './board.service';
import { type BoardAction, BoardForm } from './board-form';
import { BoardProblemNotice } from './board-problem-notice';
import { boardFacts, boardStateChip, boardSummary } from './board-view';

/**
 * Opens the board dialog. `AppDialogs` calls it after importing this module on the first open,
 * so the dialog and the kit entries it uses stay out of the initial bundle.
 */
export function openBoardDialog(injector: Injector): NeatDialogRef<void> {
  return injector.get(NeatDialog).open<void>(BoardDialog, { title: 'Board', size: 'medium' });
}

/**
 * The board dialog, opened by the rail's board block from any page: the board's state and when
 * it was checked, Check again, the `ssh` command that opens a shell on an SSH board (with Copy),
 * why the board cannot be used with the way out (`BoardProblemNotice`: the key command, the
 * host-key trust), the board's facts under a collapsed Details, and Change board (`BoardForm`).
 * Without a board it says how to get one, and Change board is open under that. Its actions run one
 * at a time.
 *
 * Insight opens no shell itself: the `ssh` command is the one the boards answer carries, for a
 * terminal of the user's own, signed in with the user's own keys.
 */
@Component({
  selector: 'app-board-dialog',
  imports: [
    BoardForm,
    BoardProblemNotice,
    CopyCommand,
    NeatButton,
    NeatCallout,
    NeatCode,
    NeatCollapsible,
    NeatDetails,
    NeatDialogBody,
    NeatNote,
    NeatStatusChip,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './board-dialog.html',
  styleUrl: './board-dialog.css',
})
export class BoardDialog {
  protected readonly board = inject(BoardService);
  private readonly peripherals = inject(PeripheralsService);
  private readonly toasts = inject(NeatToasts);

  /** The action running; every action waits for it. */
  protected readonly busy = signal<BoardAction | null>(null);

  /**
   * Why the last action failed, for the problem notice: set by a failed Check again or trust,
   * cleared by the next action that succeeds and when the board changes. A refused selection
   * stays under the form instead, where it was typed.
   */
  protected readonly actionError = signal<BoardProblem | null>(null);
  /**
   * The connection error the board's status records, for the notice while a board is in use and
   * no action of this dialog failed (an action's own problem wins over it).
   */
  protected readonly recordedProblem = computed(() => {
    const selected = this.board.selected();
    return selected ? recordedProblem(selected.status) : null;
  });

  private readonly injector = inject(Injector);
  private readonly checkButton = viewChild<ElementRef<HTMLButtonElement>>('checkButton');

  private readonly now = ticking(1000);

  protected readonly chip = computed(() => {
    const state = this.board.state();
    return state && boardStateChip(state);
  });
  protected readonly summary = computed(() => {
    const state = this.board.state();
    return state ? boardSummary(state) : '';
  });
  /** "5 s ago", ticking; '' until the board was checked. */
  protected readonly checked = computed(() =>
    formatRelativeTime(this.board.selected()?.status.checked_at ?? null, this.now()),
  );

  /** The facts the board reported, and the camera setup of its last scan. */
  protected readonly facts = computed(() => {
    const state = this.board.state();
    if (!state?.selected) return [];
    return boardFacts(state, boardCameraSetup(this.board.id(), this.peripherals.snapshot()));
  });
  /** The collapsed Details' hint: the terms it holds. */
  protected readonly factTerms = computed(() =>
    this.facts()
      .map(([term]) => term)
      .join(', '),
  );

  constructor() {
    // The camera setup comes from the last scan; reading it never contacts the board, and without
    // it Details simply lists less.
    this.peripherals.load().catch(() => undefined);
    effect(() => {
      this.board.id();
      untracked(() => this.actionError.set(null));
    });
  }

  protected async check(): Promise<void> {
    if (this.busy()) return;
    this.busy.set('check');
    try {
      const state = await this.board.check();
      this.actionError.set(null);
      const name = state.selected?.identity?.hostname || state.selected?.label || 'the board';
      this.toasts.status(`Connected to ${name}.`);
    } catch (failure) {
      // The service reloaded the state, which recorded the failure.
      this.actionError.set(problemOf(failure));
    } finally {
      this.busy.set(null);
    }
  }

  /** Trusts the presented host key the notice's user confirmed. */
  protected async trust(fingerprint: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set('trust');
    try {
      await this.board.trustHostKey(fingerprint);
      this.actionError.set(null);
      this.toasts.status('Host key updated. Check again to connect.');
    } catch (failure) {
      this.actionError.set(problemOf(failure));
    } finally {
      this.busy.set(null);
    }
    // Trust new key… goes with the warning either way. The next step is Check again: to connect
    // after a trust, and to read the key afresh after a refusal, as the server's hint asks.
    afterNextRender(() => this.checkButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected retry(): void {
    void this.board.reload();
  }
}
