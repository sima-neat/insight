import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NeatButton, NeatIcon, NeatShell, NeatTooltip } from '@sima/neat-ui';
import { NeatToastHost } from '@sima/neat-ui/toast';
import { APP_NAME } from './app-name';
import { BoardPill } from './board/board-pill';
import { INSIGHT_NAV } from './navigation';
import { TopBarDialogs } from './top-bar-dialogs';

@Component({
  selector: 'app-root',
  imports: [BoardPill, NeatButton, NeatIcon, NeatShell, NeatToastHost, NeatTooltip, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <neat-shell [appName]="appName" [navItems]="nav">
      <app-board-pill neatTopbarEnd />
      <button
        neatTopbarEnd
        neatButton
        type="button"
        variant="text"
        size="large"
        iconOnly
        rounded
        aria-label="System information"
        aria-haspopup="dialog"
        neatTooltip="System information"
        neatTooltipPosition="bottom"
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
