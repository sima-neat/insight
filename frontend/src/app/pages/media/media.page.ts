import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NeatPage } from '@sima/neat-ui';

/** Placeholder until plan 3 delivers the page. */
@Component({
  selector: 'app-media-page',
  imports: [NeatPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <neat-page>
      <p>Media arrives with plan 3.</p>
    </neat-page>
  `,
  styleUrl: './media.page.css',
})
export class MediaPage {}
