import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NeatIcon, NeatRailItem } from '@sima/neat-ui';
import { TopBarDialogs } from '../top-bar-dialogs';
import { BoardService } from './board.service';
import { boardRailView } from './board-view';

/**
 * The rail's board block: which board Insight uses and its state, from any page; a click opens
 * the board dialog. It goes in the shell's rail end (`<app-board-rail neatRailEnd />`), where the
 * kit's rail item gives it the look of the rail's other items. The item's label is the whole
 * "name — address — state" (`boardRailView`): its name and, in a collapsed rail, its tooltip, so
 * the state is told in words and not only by the dot's colour. The kit draws the dot (`tone`) and
 * the two lines (`text`, `detail`); the dialog loads on its first open (`TopBarDialogs`).
 */
@Component({
  selector: 'app-board-rail',
  imports: [NeatIcon, NeatRailItem],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let view = board();
    <button
      neatRailItem
      type="button"
      aria-haspopup="dialog"
      [label]="view.summary"
      [text]="view.name"
      [detail]="view.detail"
      [tone]="view.tone"
      (click)="open()"
    >
      <neat-icon name="board" />
    </button>
  `,
  styleUrl: './board-rail.css',
})
export class BoardRail {
  private readonly service = inject(BoardService);
  private readonly dialogs = inject(TopBarDialogs);

  protected readonly board = computed(() =>
    boardRailView(this.service.state(), this.service.error(), this.service.checking()),
  );

  protected open(): void {
    void this.dialogs.openBoard();
  }
}
