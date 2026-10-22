import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NeatPage } from '@sima/neat-ui';

/** Placeholder until plan 2 delivers the page. */
@Component({
  selector: 'app-viewer-page',
  imports: [NeatPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <neat-page>
      <p>The Viewer arrives with plan 2.</p>
    </neat-page>
  `,
  styleUrl: './viewer.page.css',
})
export class ViewerPage {}
