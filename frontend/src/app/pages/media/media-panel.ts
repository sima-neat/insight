import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DOCUMENT,
  ElementRef,
  inject,
  Injector,
  model,
  resource,
  signal,
  viewChild,
} from '@angular/core';
import {
  NeatAsideActions,
  NeatAsidePanel,
  NeatAsideTitle,
  NeatButton,
  NeatCode,
  NeatNote,
} from '@sima/neat-ui';
import { NeatConfirm, type NeatConfirmOptions } from '@sima/neat-ui/confirm';
import { NeatDetails } from '@sima/neat-ui/details';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { Slot } from '../../sources/api';
import { MediaLibraryService } from '../../sources/media-library.service';
import { filePreview, PreviewFrame } from '../../sources/preview-frame';
import { SlotsService } from '../../sources/slots.service';
import { slotName, SLOTS_NOT_CHECKED } from '../../sources/slot-row';
import { mediaInfoRows } from './media-info';

/**
 * #170's delete confirmation, naming the files, plus the slots that use them (spec, "In use"):
 * deleting a file clears and stops every slot assigned to it.
 */
export function deleteQuestion(
  paths: readonly string[],
  inUse: readonly Slot[],
  checked: boolean,
): NeatConfirmOptions {
  const several = paths.length > 1;
  const files = several
    ? `${paths.length} media files: ${paths.join(', ')}`
    : `this media file ${paths[0]}`;
  const slots =
    inUse.length > 0
      ? ` In use on ${inUse.map(slotName).join(', ')}; those slots are cleared.`
      : '';
  const unchecked = checked ? '' : ` ${SLOTS_NOT_CHECKED}`;
  return {
    title: several ? 'Delete Files' : 'Delete File',
    message: `Delete ${files}?${slots}${unchecked}`,
    confirmLabel: 'Delete',
    tone: 'danger',
  };
}

/**
 * Media's side panel (Inv-SM §1.1, "Selected Media"). For the selected file: its preview, what
 * the server knows about it (`/api/media-info`, in readable values) and Delete…. With files
 * ticked: "N selected", their paths and Delete…, which then acts on them rather than on the
 * selected file, as #170's did.
 *
 * Delete asks first, with the slots each file is assigned to as the server holds them now (they
 * are fetched again before asking), then deletes the files one after the other and reports the
 * first failure. The ticks go afterwards, whatever the outcome (#170); the selection goes when its
 * file was deleted.
 *
 * When a delete or Clear removed the button that had the focus, the focus goes to what the panel
 * shows now, its heading or its note, so the keyboard stays in the panel rather than falling to
 * the page's body, and a screen reader says where it is. A focus the user has moved elsewhere
 * meanwhile (a delete takes a request per file) is left where it is.
 */
@Component({
  selector: 'app-media-panel',
  imports: [
    NeatAsideActions,
    NeatAsideTitle,
    NeatButton,
    NeatCode,
    NeatDetails,
    NeatNote,
    PreviewFrame,
  ],
  hostDirectives: [NeatAsidePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-panel.html',
  styleUrl: './media-panel.css',
})
export class MediaPanel {
  /** The file the list has selected. */
  readonly selected = model<string | null>(null);
  /** The files ticked in the list. */
  readonly checked = model<readonly string[]>([]);

  private readonly library = inject(MediaLibraryService);
  private readonly slots = inject(SlotsService);
  private readonly confirm = inject(NeatConfirm);
  private readonly toasts = inject(NeatToasts);
  private readonly lead = viewChild.required<ElementRef<HTMLElement>>('lead');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  /** A delete is under way: Delete… waits until it has finished. */
  protected readonly deleting = signal(false);
  /** Delete… is asking (fetching the slots, then the confirmation). */
  private asking = false;

  protected readonly view = computed(() =>
    this.checked().length > 0 ? 'several' : this.selected() !== null ? 'one' : 'none',
  );

  /**
   * The selected file's info. A resource keeps only the answer for the file selected last, and
   * forgets the last file's while the next one's loads.
   */
  private readonly info = resource({
    params: () => this.selected() ?? undefined,
    loader: ({ params }) => this.library.info(params),
  });
  protected readonly infoRows = computed(() => {
    const info = this.info.hasValue() ? this.info.value() : null;
    return info ? mediaInfoRows(info) : [];
  });
  protected readonly infoError = computed(() => {
    const failure = this.info.error();
    return failure ? failure.message : null;
  });
  /** The probe can tell a file is MJPEG that its extension does not (#170). */
  protected readonly preview = computed(() => {
    const path = this.selected();
    const info = this.info.hasValue() ? this.info.value() : null;
    return path
      ? filePreview(path, info?.type === 'video' && info.normalized_codec === 'mjpeg')
      : null;
  });

  protected clearChecked(): void {
    this.checked.set([]);
    this.holdFocus();
  }

  protected async delete(): Promise<void> {
    const paths = this.checked().length > 0 ? this.checked() : [this.selected()].filter(isPath);
    if (paths.length === 0 || this.asking || this.deleting()) return;
    // Delete… stays enabled while it asks: the confirmation gives the focus back to it on Cancel,
    // which a disabled button would not take. A second press meanwhile does nothing.
    this.asking = true;
    let confirmed: boolean;
    try {
      // Asked with the slots as they are now; a failed fetch asks with the last known ones and
      // says so (ruling Q16).
      const checked = await this.slots.refresh().then(
        () => true,
        () => false,
      );
      confirmed = await this.confirm.ask(deleteQuestion(paths, this.inUseOn(paths), checked));
    } finally {
      this.asking = false;
    }
    if (!confirmed) return;

    this.deleting.set(true);
    try {
      const { deleted, failed } = await this.library.delete(paths);
      this.checked.set([]);
      const selected = this.selected();
      if (selected !== null && deleted.includes(selected)) this.selected.set(null);
      if (failed.length > 0) {
        this.toasts.error(`${failed[0].path}: ${failed[0].message}`);
        this.toasts.status(`Removed ${deleted.length}/${paths.length} media file(s).`);
      } else {
        this.toasts.status(`Removed ${paths.length} media file(s).`);
      }
      this.holdFocus();
    } finally {
      this.deleting.set(false);
    }
  }

  /** The slots assigned to any of the files, each once, in index order. */
  private inUseOn(paths: readonly string[]): Slot[] {
    const slots = new Map<number, Slot>();
    for (const path of paths) {
      for (const slot of this.slots.assignedTo(path)) slots.set(slot.index, slot);
    }
    return [...slots.values()].sort((a, b) => a.index - b.index);
  }

  /**
   * Once the panel shows what changed: the button that had the focus may be gone by then, which
   * leaves the focus on the body. Focus still in the panel, or already on the body, moves on.
   */
  private holdFocus(): void {
    afterNextRender(
      {
        read: () => {
          const focused = this.document.activeElement;
          if (
            focused === null ||
            focused === this.document.body ||
            this.host.nativeElement.contains(focused)
          ) {
            this.lead().nativeElement.focus();
          }
        },
      },
      { injector: this.injector },
    );
  }
}

const isPath = (path: string | null): path is string => path !== null;
