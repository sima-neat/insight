import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NeatPage } from '@sima/neat-ui';

/** Placeholder until plan 3 delivers the page. */
@Component({
  selector: 'app-streaming-page',
  imports: [NeatPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <neat-page>
      <p>Streaming arrives with plan 3.</p>
    </neat-page>
  `,
  styles: `
    p {
      margin: 0;
      padding: 1.5rem;
    }
  `,
})
export class StreamingPage {}
