import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NeatShell } from '@sima/neat-ui';
import { APP_NAME } from './app-name';
import { INSIGHT_NAV } from './navigation';

@Component({
  selector: 'app-root',
  imports: [NeatShell, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <neat-shell [appName]="appName" [navItems]="nav">
      <router-outlet />
    </neat-shell>
  `,
})
export class App {
  protected readonly appName = APP_NAME;
  protected readonly nav = INSIGHT_NAV;
}
