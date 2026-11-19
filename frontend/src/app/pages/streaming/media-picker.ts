import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { NeatButton, NeatInlineButton, NeatNote } from '@sima/neat-ui';
import { NeatDialogActions, NeatDialogBody } from '@sima/neat-ui/dialog';
import { NeatFileBrowser } from '@sima/neat-ui/file-browser';
import { NeatToasts } from '@sima/neat-ui/toast';
import {
  hiddenFileCount,
  hiddenFilesNote,
  MEDIA_BROWSER_LABELS,
  MEDIA_ROOT_LABEL,
  mediaCountLabel,
  mediaFilterPlaceholder,
  parentFolder,
  revealIn,
} from '../../sources/media-browser';
import { MediaLibraryService, toFileNodes } from '../../sources/media-library.service';
import { messageOf } from '../../sources/api-errors';

/**
 * The content of the "Source for srcN" dialog that the side panel's Change… opens: the media
 * library in a `neat-file-browser` (pick mode, so only files Insight can stream), opened in the
 * folder of the slot's file with that file selected. Assign tells the panel the file picked;
 * the panel assigns it and closes the dialog, or keeps it open on a refusal.
 *
 * The library is fetched as the picker opens: files may have arrived since (another tab, the API).
 *
 * "Import…" asks for the import dialog (`importRequested`); once an import has saved a file,
 * `reveal` shows it here, picked (ruling Q1: the slot panel wires the two).
 *
 * Its host takes no box of its own: the dialog's body and actions must be the dialog panel's own
 * items, so the body scrolls and the actions stay in view.
 */
@Component({
  selector: 'app-media-picker',
  imports: [
    NeatButton,
    NeatDialogActions,
    NeatDialogBody,
    NeatFileBrowser,
    NeatInlineButton,
    NeatNote,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-picker.html',
  styleUrl: './media-picker.css',
})
export class MediaPicker {
  /** The file the slot is assigned now; '' for none. */
  readonly current = input('');
  /** An assignment of the pick is in flight: nothing else may be sent until it settles. */
  readonly busy = input(false);

  /** The file picked, to assign. */
  readonly assign = output<string>();
  readonly cancelled = output<void>();
  readonly importRequested = output<void>();

  private readonly library = inject(MediaLibraryService);
  private readonly toasts = inject(NeatToasts);

  protected readonly rootLabel = MEDIA_ROOT_LABEL;
  protected readonly countLabel = mediaCountLabel;
  protected readonly labels = MEDIA_BROWSER_LABELS;
  protected readonly nodes = computed(() => toFileNodes(this.library.tree() ?? [], 'pick'));
  /** Opens in the folder of the slot's file; the browser falls back to the nearest that exists. */
  protected readonly folder = linkedSignal(() => parentFolder(this.current()));
  protected readonly picked = linkedSignal<string | null>(() => this.current() || null);
  protected readonly filter = signal('');

  protected readonly placeholder = computed(() => mediaFilterPlaceholder(this.folder()));
  /** The note is about the folder's listing, so it shows only while no filter replaces that. */
  protected readonly hiddenNote = computed(() =>
    this.filter().trim()
      ? null
      : hiddenFilesNote(hiddenFileCount(this.library.tree() ?? [], this.folder())),
  );
  protected readonly canAssign = computed(() => {
    const picked = this.picked();
    return !this.busy() && !!picked && picked !== this.current();
  });

  constructor() {
    this.library.refresh().catch((failure: unknown) => {
      this.toasts.error(messageOf(failure));
    });
  }

  /**
   * Fetches the library and shows what an import just saved, which the tree may not hold yet: a
   * file in its folder, picked; an archive's folder opened, for a file in it to be picked.
   */
  async reveal(path: string): Promise<void> {
    await this.library.refresh();
    const target = revealIn(this.library.tree() ?? [], path);
    this.folder.set(target.folder);
    if (target.file) this.picked.set(target.file);
  }

  protected assignPicked(): void {
    const picked = this.picked();
    if (picked && this.canAssign()) this.assign.emit(picked);
  }
}
