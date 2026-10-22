import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NeatPage } from '@sima/neat-ui';

/** Placeholder until plan 4 delivers the page. */
@Component({
  selector: 'app-peripherals-page',
  imports: [NeatPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <neat-page>
      <p>Peripherals arrive with plan 4.</p>
    </neat-page>
  `,
  styles: `
    p {
      margin: 0;
      padding: 1.5rem;
    }
  `,
})
export class PeripheralsPage {}
