import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NeatButton } from '@sima/neat-ui';
import { TopBarDialogs } from '../top-bar-dialogs';

/**
 * Open board settings, as a callout's action for a problem the board's settings fix (no board, or
 * a connection failure): `<app-board-settings-action neatCalloutActions />`. It opens the board
 * dialog through `TopBarDialogs`. One place for the button and its words, which Peripherals'
 * notices share.
 */
@Component({
  selector: 'app-board-settings-action',
  imports: [NeatButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button neatButton type="button" size="small" variant="outlined" (click)="open()">
      Open board settings
    </button>
  `,
})
export class BoardSettingsAction {
  private readonly dialogs = inject(TopBarDialogs);

  protected open(): void {
    void this.dialogs.openBoard();
  }
}
