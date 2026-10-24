import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NeatShell } from '@sima/neat-ui';
import { NeatToastHost } from '@sima/neat-ui/toast';
import { APP_NAME } from './app-name';
import { BoardPill } from './board/board-pill';
import { INSIGHT_NAV } from './navigation';

@Component({
  selector: 'app-root',
  imports: [BoardPill, NeatShell, NeatToastHost, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <neat-shell [appName]="appName" [navItems]="nav">
      <app-board-pill neatTopbarEnd />
      <router-outlet />
    </neat-shell>
    <neat-toast-host />
  `,
})
export class App {
  protected readonly appName = APP_NAME;
  protected readonly nav = INSIGHT_NAV;
}
