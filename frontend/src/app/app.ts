import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NeatIcon, NeatRailDivider, NeatRailItem, NeatShell } from '@sima/neat-ui';
import { NeatToastHost } from '@sima/neat-ui/toast';
import { APP_NAME } from './app-name';
import { BoardRail } from './board/board-rail';
import { INSIGHT_NAV } from './navigation';
import { TopBarDialogs } from './top-bar-dialogs';

/**
 * The shell: the rail is the app's (the pages, then at its bottom the board, System information
 * and the kit's theme item), the top bar the page's (its title and tools, the kiosk button and
 * the page's side-panel toggle, all the kit's).
 */
@Component({
  selector: 'app-root',
  imports: [
    BoardRail,
    NeatIcon,
    NeatRailDivider,
    NeatRailItem,
    NeatShell,
    NeatToastHost,
    RouterOutlet,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <neat-shell [appName]="appName" [navItems]="nav">
      <app-board-rail neatRailEnd />
      <hr neatRailEnd neatRailDivider />
      <button
        neatRailEnd
        neatRailItem
        type="button"
        label="System information"
        aria-haspopup="dialog"
        (click)="openSystemInfo()"
      >
        <neat-icon name="info" />
      </button>
      <router-outlet />
    </neat-shell>
    <neat-toast-host />
  `,
})
export class App {
  protected readonly appName = APP_NAME;
  protected readonly nav = INSIGHT_NAV;
  private readonly dialogs = inject(TopBarDialogs);

  protected openSystemInfo(): void {
    void this.dialogs.openSystemInfo();
  }
}
