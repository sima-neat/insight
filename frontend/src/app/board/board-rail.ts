import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NeatIcon, NeatRailItem } from '@sima/neat-ui';
import { TopBarDialogs } from '../top-bar-dialogs';
import { BoardService } from './board.service';
import { boardRailView } from './board-view';

/**
 * The rail's board block: which board Insight uses and its state, from any page; a click opens
 * the board dialog. It goes in the shell's rail end (`<app-board-rail neatRailEnd />`), where the
 * kit's rail item gives it the look of the rail's other items, and a collapsed rail the label as a
 * tooltip. The item's name is the whole "name — address — state" (`boardRailView`), so the state
 * is told in words and not only by the dot's colour; the dialog loads on its first open
 * (`TopBarDialogs`).
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
      [attr.aria-label]="view.summary"
      [attr.data-tone]="view.tone"
      (click)="open()"
    >
      <span class="mark">
        <neat-icon name="board" />
        <span class="dot" aria-hidden="true"></span>
      </span>
      <span neatRailItemLabel class="lines">
        <span class="name">{{ view.name }}</span>
        <span class="detail">{{ view.detail }}</span>
      </span>
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
