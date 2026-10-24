import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { ImportSummary } from './import-summary';
import { type FilePreview, PreviewFrame } from './preview-frame';

/**
 * What an import would bring in, shown before it: the preview box, with what the caller projects
 * over it (a player, or why there is no preview), and its summary beside it once there is one.
 */
@Component({
  selector: 'app-import-preview',
  imports: [ImportSummary, PreviewFrame],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-preview-frame [file]="file()"><ng-content /></app-preview-frame>
    @if (heading(); as heading) {
      <app-import-summary [heading]="heading" [notes]="notes()" />
    }
  `,
  styleUrl: './import-preview.css',
})
export class ImportPreview {
  readonly file = input<FilePreview | null>(null);
  /** The summary's heading; none shows the box alone. */
  readonly heading = input<string | null>(null);
  readonly notes = input<readonly string[]>([]);
}
