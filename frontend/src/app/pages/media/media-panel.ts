import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
import type { Slot } from '../../api.generated';
import { holdFocus } from '../../hold-focus';
import { MediaLibraryService } from '../../sources/media-library.service';
import { filePreview, PreviewFrame } from '../../sources/preview-frame';
import { SlotsService } from '../../sources/slots.service';
import { slotName, SLOTS_NOT_CHECKED } from '../../sources/slot-row';
import { messageOf } from '../../sources/api-errors';
import { mediaInfoRows } from './media-info';

/**
 * #170's delete confirmation, naming the files. `checked` is false when the slots could not be
 * fetched again before asking, so the files may be in use after all (the server then refuses).
 */
export function deleteQuestion(paths: readonly string[], checked: boolean): NeatConfirmOptions {
  const several = paths.length > 1;
  const files = several
    ? `${paths.length} media files: ${paths.join(', ')}`
    : `this media file ${paths[0]}`;
  const unchecked = checked ? '' : ` ${SLOTS_NOT_CHECKED}`;
  return {
    title: several ? 'Delete Files' : 'Delete File',
    message: `Delete ${files}?${unchecked}`,
    confirmLabel: 'Delete',
    tone: 'danger',
  };
}

/**
 * Why files the slots use are not deleted (spec, "In use"): Insight refuses to delete a file a
 * slot is assigned, so the slots are named, to be cleared first.
 */
export function inUseMessage(paths: readonly string[], inUse: readonly Slot[]): string {
  const files = paths.length > 1 ? 'These files are' : `${paths[0]} is`;
  return `${files} in use on ${inUse.map(slotName).join(', ')}. Clear those slots, then delete again.`;
}

/**
 * Media's side panel (Inv-SM §1.1, "Selected Media"). For the selected file: its preview, what
 * ffprobe says about it (`/api/media/info`, in readable values) and Delete…. With files ticked:
 * "N selected", their paths and Delete…, which then acts on them rather than on the selected file,
 * as #170's did.
 *
 * Delete first fetches the slots again: files a slot uses are not deleted (the server refuses
 * them), so the panel says which slots to clear instead of asking. Otherwise it asks, then deletes
 * the files in one request, which the server carries out whole or refuses whole (a slot may have
 * taken a file meanwhile, and its message says so). The ticks go once the files are deleted, and
 * the selection goes with its file; a refusal leaves both, to try again.
 *
 * When a delete or Clear removed the button that had the focus, the focus goes to what the panel
 * shows now, its heading or its note, so the keyboard stays in the panel rather than falling to
 * the page's body, and a screen reader says where it is. A focus the user has moved elsewhere
 * meanwhile is left where it is.
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
    return path ? filePreview(path, info?.probe.codec === 'mjpeg') : null;
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
      // Asked with the slots as they are now; a failed fetch asks anyway and says so (ruling Q16).
      const checked = await this.slots.recheck();
      const inUse = this.inUseOn(paths);
      if (checked && inUse.length > 0) {
        this.toasts.error(inUseMessage(paths, inUse));
        return;
      }
      confirmed = await this.confirm.ask(deleteQuestion(paths, checked));
    } finally {
      this.asking = false;
    }
    if (!confirmed) return;

    this.deleting.set(true);
    try {
      const deleted = await this.library.delete(paths);
      this.checked.set([]);
      const selected = this.selected();
      if (selected !== null && deleted.includes(selected)) this.selected.set(null);
      this.toasts.status(`Removed ${deleted.length} media file(s).`);
      this.holdFocus();
    } catch (failure) {
      this.toasts.error(messageOf(failure));
    } finally {
      this.deleting.set(false);
    }
  }

  /** The slots assigned to any of the files, each once, in number order. */
  private inUseOn(paths: readonly string[]): Slot[] {
    const slots = new Map<number, Slot>();
    for (const path of paths) {
      for (const slot of this.slots.assignedTo(path)) slots.set(slot.n, slot);
    }
    return [...slots.values()].sort((a, b) => a.n - b.n);
  }

  /**
   * Once the panel shows what changed: the button that had the focus may be gone by then, which
   * leaves the focus on the body. Focus still in the panel, or already on the body, moves on.
   */
  private holdFocus(): void {
    holdFocus(
      this.injector,
      () => this.lead().nativeElement,
      () => this.host.nativeElement,
    );
  }
}

const isPath = (path: string | null): path is string => path !== null;
