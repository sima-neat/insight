import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NeatNote } from '@sima/neat-ui';
import { NeatDropZone } from '@sima/neat-ui/drop-zone';
import { NeatToasts } from '@sima/neat-ui/toast';
import { ImportRunner } from './import-runner';
import { ImportSession } from './import-session';

/**
 * What the drop zone takes: the files Insight streams, and the archives the server extracts
 * (the server's `streamableExtensions` in `internal/media` and `archiveSuffixes` in
 * `internal/library`). #170 took any file; a file Insight cannot stream would only sit in the
 * library greyed out.
 */
const ACCEPT = '.mp4,.mov,.avi,.mkv,.webm,.mjpeg,.mjpg,.jpg,.jpeg,.zip,.tar,.gz';

/**
 * The import dialog's Local files tab: a drop zone whose files upload one after the other
 * (`ImportRunner.upload`); the progress and any name clash show under the tabs.
 */
@Component({
  selector: 'app-import-local',
  imports: [NeatDropZone, NeatNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p neatNote>
      Local MP4 uploads are normalized for low-latency playback with B-frames disabled while
      preserving the source frame rate.
    </p>
    <neat-drop-zone
      label="Choose or drop local media files"
      multiple
      [accept]="accept"
      [disabled]="runner.busy()"
      (files)="upload($event)"
      (rejected)="reject($event)"
    />
    <p neatNote>
      MP4, MOV, AVI, MKV or WebM with H.264, H.265 or MJPEG video, or a .zip / .tar.gz of them.
    </p>
  `,
  styleUrl: './import-local.css',
})
export class ImportLocal {
  protected readonly runner = inject(ImportRunner);
  private readonly session = inject(ImportSession);
  private readonly toasts = inject(NeatToasts);

  protected readonly accept = ACCEPT;

  protected upload(files: File[]): void {
    void this.session.run(() => this.runner.upload(files));
  }

  /** A drop holding other files: the rest upload, and these are named. */
  protected reject(files: File[]): void {
    const names = files.map((file) => file.name).join(', ');
    this.toasts.error(`Not uploaded: ${names} (not a supported video or archive).`);
  }
}
