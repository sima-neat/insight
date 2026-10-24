import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DOCUMENT,
  effect,
  inject,
  type Injector,
  signal,
  untracked,
} from '@angular/core';
import { NeatButton, NeatCode, NeatNote, NeatTooltip, type NeatButtonVariant } from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatCollapsible } from '@sima/neat-ui/collapsible';
import { NeatDetails } from '@sima/neat-ui/details';
import { NeatDialog, NeatDialogBody, type NeatDialogRef } from '@sima/neat-ui/dialog';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { NeatToasts } from '@sima/neat-ui/toast';
import { boardCameraSetup } from '../peripherals/devices';
import { PeripheralsService } from '../peripherals/peripherals.service';
import { LatestOnly } from '../polling';
import { formatRelativeTime } from '../relative-time';
import { ticking } from '../clock';
import { messageOf } from '../sources/stream-lines';
import type { ShellInfo } from './api';
import { problemOf, type BoardProblem } from './board-error';
import { BoardService } from './board.service';
import { boardFacts, boardStateChip, boardSummary } from './board-view';

/**
 * Opens the board dialog. `TopBarDialogs` calls it after importing this module on the first open,
 * so the dialog and the kit entries it uses stay out of the initial bundle.
 */
export function openBoardDialog(injector: Injector): NeatDialogRef<void> {
  return injector.get(NeatDialog).open<void>(BoardDialog, { title: 'Board', size: 'medium' });
}

/** #170's reason for a disabled Open shell (Inv-PB §1.5). */
const NO_WEBSSH = 'webssh is not installed in this Insight environment';
/** #170's error for a started shell without an address (Inv-PB §2.1). */
const NO_LAUNCH_URL = 'DevKit shell launch URL is unavailable.';

type BoardAction = 'shell' | 'check';

/**
 * The board dialog (spec, "Board connection"), opened by the top bar's pill from any page: the
 * board's state and when it was checked, the one action that fits it in front, and the board's
 * facts under a collapsed Details. Without a board it says how to get one.
 *
 * **Open shell** (webssh) shows whenever the shell can sign in by itself, whatever the connection
 * state: webssh logs in with a password, so it helps exactly when Insight's key is refused. It
 * leads only when the board is connected; otherwise Check again does. The shell details are read
 * when the dialog opens, never at app start (their launch URL carries the SDK's default password),
 * and again when the board changes while it is open, so that the action describes the board now
 * selected (Inv-PB §6.17).
 */
@Component({
  selector: 'app-board-dialog',
  imports: [
    NeatButton,
    NeatCallout,
    NeatCode,
    NeatCollapsible,
    NeatDetails,
    NeatDialogBody,
    NeatNote,
    NeatStatusChip,
    NeatTooltip,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './board-dialog.html',
  styleUrl: './board-dialog.css',
})
export class BoardDialog {
  protected readonly board = inject(BoardService);
  private readonly peripherals = inject(PeripheralsService);
  private readonly toasts = inject(NeatToasts);
  private readonly window = inject(DOCUMENT).defaultView;

  protected readonly noWebssh = NO_WEBSSH;

  /** The browser shell's details for the board selected; null until read, or when they could not be. */
  protected readonly shell = signal<ShellInfo | null>(null);
  /**
   * Whether a shell read has answered. The actions wait for it: shown before, a connected board's
   * row would be Check again alone, and Open shell would then be put before it under the pointer.
   */
  private readonly shellKnown = signal(false);
  private readonly shellReads = new LatestOnly();

  /** The action running; every action waits for it (#170 ran one at a time). */
  protected readonly busy = signal<BoardAction | null>(null);

  /**
   * Why the last action failed, for the problem notice (F21): set by a failed action, cleared by
   * the next one that succeeds and when the board changes. Until the notice shows it, a failed
   * Check again shows as the reloaded state ("Connection failed").
   */
  protected readonly actionError = signal<BoardProblem | null>(null);

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
    formatRelativeTime(this.board.state()?.status.checked_at ?? null, this.now()),
  );

  /** The actions with a target, the leading one first and primary. */
  protected readonly actions = computed<{ action: BoardAction; variant: NeatButtonVariant }[]>(
    () => {
      const state = this.board.state();
      if (!state?.target || !this.shellKnown()) return [];
      const shell = this.shell()?.launch_supported === true;
      if (shell && state.status.state === 'connected') {
        return [
          { action: 'shell', variant: 'primary' },
          { action: 'check', variant: 'outlined' },
        ];
      }
      return [
        { action: 'check', variant: 'primary' },
        ...(shell ? [{ action: 'shell' as const, variant: 'outlined' as const }] : []),
      ];
    },
  );
  protected readonly shellAvailable = computed(() => this.shell()?.available === true);

  /** The facts the board reported, and the camera setup of its last scan. */
  protected readonly facts = computed(() => {
    const state = this.board.state();
    if (!state?.target) return [];
    return boardFacts(state, boardCameraSetup(state, this.peripherals.snapshot()));
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
      this.board.generation();
      untracked(() => {
        this.actionError.set(null);
        void this.readShell();
      });
    });
  }

  protected async check(): Promise<void> {
    if (this.busy()) return;
    this.busy.set('check');
    try {
      const state = await this.board.test();
      this.actionError.set(null);
      const name = state.board?.hostname || state.target?.label || 'the board';
      this.toasts.status(`Connected to ${name}.`);
    } catch (failure) {
      // The service reloaded the state, which recorded the failure.
      this.actionError.set(problemOf(failure));
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * Inv-PB §1.5: the window opens inside the click, blank, so that popup blockers allow it; it is
   * sent to the shell once webssh runs, and closed again if it does not start.
   */
  protected async openShell(): Promise<void> {
    if (this.busy() || !this.shellAvailable()) return;
    this.busy.set('shell');
    const opened = this.window?.open('', '_blank') ?? null;
    try {
      const started = await this.board.startShell();
      if (!started.launch_url) throw new Error(NO_LAUNCH_URL);
      if (opened) opened.location.href = started.launch_url;
      else this.window?.open(started.launch_url, '_blank');
    } catch (failure) {
      opened?.close();
      this.toasts.error(messageOf(failure));
    } finally {
      this.busy.set(null);
    }
  }

  protected retry(): void {
    void this.board.reload();
  }

  /** Only the newest read is applied: one sent for an earlier board can answer last. */
  private async readShell(): Promise<void> {
    const request = this.shellReads.next();
    const info = await this.board.shellInfo();
    if (this.shellReads.accept(request)) {
      this.shell.set(info);
      this.shellKnown.set(true);
    }
  }
}
