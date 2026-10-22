import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NeatPage } from '@sima/neat-ui';

/** Placeholder until plan 5 delivers the page. */
@Component({
  selector: 'app-stats-page',
  imports: [NeatPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <neat-page>
      <p>Stats arrive with plan 5.</p>
    </neat-page>
  `,
  styleUrl: './stats.page.css',
})
export class StatsPage {}
