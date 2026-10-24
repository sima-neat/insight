import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NeatNote } from '@sima/neat-ui';

/**
 * A heading with notes under it and, projected, the actions at its end: the foot of the import
 * dialog's Catalog and YouTube panels ("1 asset(s) selected", the filter, Import), and the words
 * beside a preview (`ImportPreview`). A note may be a path or a link, so it breaks anywhere.
 */
@Component({
  selector: 'app-import-summary',
  imports: [NeatNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="text">
      <strong>{{ heading() }}</strong>
      @for (note of notes(); track $index) {
        <p neatNote>{{ note }}</p>
      }
    </div>
    <div class="actions"><ng-content /></div>
  `,
  styleUrl: './import-summary.css',
})
export class ImportSummary {
  readonly heading = input.required<string>();
  readonly notes = input<readonly string[]>([]);
}
