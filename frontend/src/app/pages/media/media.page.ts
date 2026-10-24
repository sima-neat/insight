import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { NeatButton, NeatIcon, NeatPage, NeatPageToolbar, NeatTooltip } from '@sima/neat-ui';
import { NeatFileBrowser } from '@sima/neat-ui/file-browser';
import { NeatColumn } from '@sima/neat-ui/select-list';
import { NeatToasts } from '@sima/neat-ui/toast';
import { CellText } from '../../cell-text';
import type { MediaNode, Slot } from '../../sources/api';
import { ImportDialogs } from '../../sources/import-dialog';
import {
  hasFile,
  MEDIA_BROWSER_LABELS,
  MEDIA_ROOT_LABEL,
  mediaCountLabel,
  mediaFilterPlaceholder,
  revealIn,
} from '../../sources/media-browser';
import { MediaLibraryService, toFileNodes } from '../../sources/media-library.service';
import type { Progress } from '../../sources/progress-lines';
import { SlotsNotice } from '../../sources/slots-notice';
import { SlotsService } from '../../sources/slots.service';
import { slotName, slotState } from '../../sources/slot-row';
import { MediaPanel } from './media-panel';

/** "src3 · Live, src9 · Idle": the slots a file is assigned to, with their state as Streaming words it. */
function inUseText(slots: readonly Slot[], encodes: ReadonlyMap<number, Progress>): string {
  return slots
    .map((slot) => `${slotName(slot)} · ${slotState(slot, encodes.get(slot.index)).label}`)
    .join(', ');
}

/**
 * Media: the library in a `neat-file-browser` (manage mode: every file, ticked for deletion,
 * those Insight cannot stream greyed and tagged), with the selected or ticked files in the page's
 * side panel (Inv-SM §1.1). A file's "In use" column names the slots assigned to it, whatever
 * their state (spec, "In use"); the slots come from `SlotsService`, which polls them while the page
 * is shown. The library is fetched as the page opens, since it may have changed meanwhile.
 * Folders cannot be deleted from here, as in #170.
 */
@Component({
  selector: 'app-media-page',
  imports: [
    CellText,
    MediaPanel,
    NeatButton,
    NeatColumn,
    NeatFileBrowser,
    NeatIcon,
    NeatPage,
    NeatPageToolbar,
    NeatTooltip,
    SlotsNotice,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media.page.html',
  styleUrl: './media.page.css',
})
export class MediaPage {
  protected readonly slots = inject(SlotsService);
  private readonly library = inject(MediaLibraryService);
  private readonly toasts = inject(NeatToasts);
  private readonly imports = inject(ImportDialogs);

  protected readonly rootLabel = MEDIA_ROOT_LABEL;
  protected readonly countLabel = mediaCountLabel;
  protected readonly labels = MEDIA_BROWSER_LABELS;
  protected readonly nodes = computed(() => toFileNodes(this.library.tree() ?? [], 'manage'));
  protected readonly folder = signal('');
  /**
   * The selected file, let go when a new tree no longer holds it (deleted from another tab, or a
   * delete that failed because the file had gone), so the panel does not describe a file that is
   * not there. The browser itself drops such files from `checked`.
   */
  protected readonly selected = linkedSignal<readonly MediaNode[] | null, string | null>({
    source: this.library.tree,
    computation: (tree, previous) => {
      const path = previous?.value ?? null;
      return path !== null && tree !== null && !hasFile(tree, path) ? null : path;
    },
  });
  protected readonly checked = signal<readonly string[]>([]);
  protected readonly placeholder = computed(() => mediaFilterPlaceholder(this.folder()));
  protected readonly asideOpen = signal(true);

  /** Each assigned file's "In use" text, once per poll answer rather than per row and check. */
  private readonly inUse = computed(() => {
    const encodes = this.slots.encodes();
    const texts = new Map<string, string>();
    for (const slot of this.slots.slots() ?? []) {
      if (slot.file && !texts.has(slot.file)) {
        texts.set(slot.file, inUseText(this.slots.assignedTo(slot.file), encodes));
      }
    }
    return texts;
  });

  constructor() {
    inject(DestroyRef).onDestroy(this.slots.watch());
    this.library.refresh().catch((failure: unknown) => {
      this.toasts.error(failure instanceof Error ? failure.message : String(failure));
    });
  }

  protected inUseOf(path: string): string {
    return this.inUse().get(path) ?? '';
  }

  /**
   * Opens the import dialog on Local files, then shows what it saved: a file in its folder,
   * selected, or an archive's folder. Nothing changes when the dialog closed without an import.
   */
  protected async openImport(): Promise<void> {
    const path = await this.imports.open('local');
    if (path === null) return;
    // The import refreshed the library already, but without waiting for it; the file must be in
    // the tree before it can be selected. A failure leaves the tree there was.
    await this.library.refresh().catch(() => undefined);
    const target = revealIn(this.library.tree() ?? [], path);
    this.folder.set(target.folder);
    if (target.file) this.selected.set(target.file);
  }

  protected toggleAside(): void {
    this.asideOpen.update((open) => !open);
  }
}
