import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NeatButton, NeatIcon, NeatTooltip, NeatViewport } from '@sima/neat-ui';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { TopBarDialogs } from '../top-bar-dialogs';
import { BoardService } from './board.service';
import { boardIndicator } from './board-view';

/**
 * The top bar's board pill: which board Insight uses and its state, from any page; a click opens
 * the board dialog. The chip is the kit's status chip, the one kit entry the top bar adds to the
 * initial bundle; the dialog loads on its first open (`TopBarDialogs`). On a narrow screen the
 * label is hidden from the eye (the global `visually-hidden` class) and stays in the button's name
 * (`board-pill.css` says why).
 */
@Component({
  selector: 'app-board-pill',
  imports: [NeatButton, NeatIcon, NeatStatusChip, NeatTooltip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let pill = indicator();
    <button
      neatButton
      type="button"
      variant="outlined"
      size="small"
      rounded
      aria-haspopup="dialog"
      [neatTooltip]="pill.tooltip"
      neatTooltipPosition="bottom"
      (click)="open()"
    >
      <neat-icon name="board" />
      <span [class.label]="!narrow()" [class.visually-hidden]="narrow()">{{ pill.label }}</span>
      <neat-status-chip [tone]="pill.chip.tone">{{ pill.chip.label }}</neat-status-chip>
    </button>
  `,
  styleUrl: './board-pill.css',
})
export class BoardPill {
  private readonly board = inject(BoardService);
  private readonly dialogs = inject(TopBarDialogs);

  protected readonly narrow = inject(NeatViewport).narrow;
  protected readonly indicator = computed(() =>
    boardIndicator(this.board.state(), this.board.error()),
  );

  protected open(): void {
    void this.dialogs.openBoard();
  }
}
