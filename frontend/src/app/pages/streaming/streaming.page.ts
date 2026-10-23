import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
  type TemplateRef,
  viewChild,
} from '@angular/core';
import {
  NeatButton,
  NeatIcon,
  NeatNote,
  NeatPage,
  NeatPageToolbar,
  NeatTooltip,
} from '@sima/neat-ui';
import { NeatConfirm } from '@sima/neat-ui/confirm';
import { NeatDialog, NeatDialogActions, NeatDialogBody } from '@sima/neat-ui/dialog';
import { NeatPopover, NeatPopoverContent, NeatPopoverTrigger } from '@sima/neat-ui/popover';
import { NeatSegmented, type NeatSegmentedOption } from '@sima/neat-ui/segmented';
import { NeatColumn, NeatSelectList } from '@sima/neat-ui/select-list';
import { NeatSlider } from '@sima/neat-ui/slider';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { MediaNode, RenditionsCleared } from '../../sources/api';
import { CamerasService } from '../../sources/cameras.service';
import { formatBytes } from '../../sources/format-bytes';
import { MediaLibraryService } from '../../sources/media-library.service';
import { SlotsService } from '../../sources/slots.service';
import { isAssigned, isInUse, type SlotRow, slotRow } from './slot-row';
import { SlotStateChip } from './slot-state-chip';

/** The slots Insight has, `src1`–`src48`: hard-coded as in #170 (the spec keeps it so). */
const SLOT_COUNT = 48;

type SlotFilter = 'all' | 'in-use';

/** Why the bulk actions are disabled while a slot is changing (#170's `webcamBusy`). */
const CHANGING_TOOLTIP = 'Waiting for a source change to finish';

/** Streamable files anywhere in the library. */
function streamableCount(tree: readonly MediaNode[]): number {
  return tree.reduce(
    (count, node) =>
      count + (node.type === 'folder' ? node.streamable_count : node.streamable ? 1 : 0),
    0,
  );
}

function clearedMessage({ removed, freed_bytes, kept }: RenditionsCleared): string {
  const keptText = kept.length > 0 ? ` ${kept.length} kept: in use by a playing source.` : '';
  return `Removed ${removed} rendition(s), freed ${formatBytes(freed_bytes)}.${keptText}`;
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Streaming: the 48 slots in a list, with the selected slot in the page's side panel, and the
 * actions on all of them in the top bar (Inv-SM §1.2). The slots come from `SlotsService`, which
 * polls them while the page is shown.
 *
 * The bulk actions that stop or rewrite slots first end the webcams this browser publishes
 * (`CamerasService.releaseAll`), since only this browser can; they wait while a slot is changing
 * (`CamerasService.anyChanging`: every assignment from this page goes through it), as a webcam
 * assigned or started meanwhile would register its slot again behind the bulk action's back.
 */
@Component({
  selector: 'app-streaming-page',
  imports: [
    NeatButton,
    NeatColumn,
    NeatDialogActions,
    NeatDialogBody,
    NeatIcon,
    NeatNote,
    NeatPage,
    NeatPageToolbar,
    NeatPopover,
    NeatPopoverContent,
    NeatPopoverTrigger,
    NeatSegmented,
    NeatSelectList,
    NeatSlider,
    NeatTooltip,
    SlotStateChip,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './streaming.page.html',
  styleUrl: './streaming.page.css',
})
export class StreamingPage {
  protected readonly slots = inject(SlotsService);
  private readonly cameras = inject(CamerasService);
  private readonly library = inject(MediaLibraryService);
  private readonly toasts = inject(NeatToasts);
  private readonly confirm = inject(NeatConfirm);
  private readonly dialogs = inject(NeatDialog);

  protected readonly slotCount = SLOT_COUNT;
  protected readonly filter = signal<SlotFilter>('all');
  protected readonly asideOpen = signal(true);
  protected readonly moreOpen = signal(false);
  /** The count the Start… dialog's slider is at. */
  protected readonly bulkCount = signal(1);

  /** By index rather than the row: each poll answer brings new rows for the same slots. */
  private readonly selectedIndex = signal<number | null>(null);
  private readonly bulkRunning = signal(false);
  private readonly bulkStartDialog = viewChild.required<TemplateRef<unknown>>('bulkStart');

  private readonly allRows = computed(() => {
    const cameras = this.cameras.assignments();
    const encodes = this.slots.encodes();
    return (this.slots.slots() ?? []).map((slot) =>
      slotRow(slot, { camera: cameras.get(slot.index), encode: encodes.get(slot.index) }),
    );
  });
  private readonly inUseRows = computed(() => this.allRows().filter((row) => isInUse(row.slot)));

  protected readonly rows = computed(() =>
    this.filter() === 'all' ? this.allRows() : this.inUseRows(),
  );
  protected readonly filterOptions = computed<NeatSegmentedOption<SlotFilter>[]>(() => [
    { value: 'all', label: `All ${SLOT_COUNT}` },
    { value: 'in-use', label: `In use ${this.inUseRows().length}` },
  ]);
  /** Said in place of rows only once the slots are known: before that there is nothing to say. */
  protected readonly emptyLabel = computed(() =>
    this.slots.slots() !== null && this.filter() === 'in-use' ? 'No slot is in use.' : '',
  );
  protected readonly selectedRow = computed(
    () => this.allRows().find((row) => row.slot.index === this.selectedIndex()) ?? null,
  );

  /** A slot is changing or a bulk action is running: another bulk action now would race it. */
  protected readonly bulkLocked = computed(() => this.cameras.anyChanging() || this.bulkRunning());
  protected readonly bulkTooltip = computed(() =>
    this.cameras.anyChanging() ? CHANGING_TOOLTIP : null,
  );
  protected readonly autoAssignTooltip = computed(
    () => this.bulkTooltip() ?? 'Auto assign unique media files to all sources',
  );
  /**
   * Starting needs a file to stream. Until the library has answered that is not known, and Start…
   * stays available: the server says so when nothing can start.
   */
  protected readonly noStreamableFile = computed(() => {
    const tree = this.library.tree();
    return tree !== null && streamableCount(tree) === 0;
  });

  protected readonly hasRenditions = computed(() => (this.slots.renditions()?.count ?? 0) > 0);
  protected readonly clearRenditionsLabel = computed(() => {
    const usage = this.slots.renditions();
    return usage && usage.count > 0
      ? `Clear renditions (${usage.count} · ${formatBytes(usage.bytes)})`
      : 'Clear renditions';
  });

  /** A row's identity across poll answers. */
  protected readonly rowKey = (row: SlotRow): number => row.slot.index;

  constructor() {
    inject(DestroyRef).onDestroy(this.slots.watch());
    // Both only inform the top bar (Start… and the ⋯ menu's count), so a failure here leaves the
    // defaults; the server still answers each action, and the usage is fetched again on use.
    this.library.refresh().catch(() => undefined);
    void this.refreshRenditions();
  }

  protected select(row: SlotRow | null): void {
    this.selectedIndex.set(row?.slot.index ?? null);
  }

  /** Enter or a click on a row: its actions are in the side panel, so the panel opens. */
  protected openAside(): void {
    this.asideOpen.set(true);
  }

  protected toggleAside(): void {
    this.asideOpen.update((open) => !open);
  }

  /** The ⋯ menu shows the rendition usage, which only changes with a fetch: fetch it as it opens. */
  protected moreOpenChange(open: boolean): void {
    this.moreOpen.set(open);
    if (open) void this.refreshRenditions();
  }

  protected autoAssign(): Promise<void> {
    return this.runBulk(async () => {
      const released = this.cameras.releaseAll({ clearAssignments: true });
      this.toasts.status((await this.slots.autoAssign(released)).message);
    });
  }

  protected stopAll(): Promise<void> {
    return this.runBulk(async () => {
      // The cameras stay picked for their slots: stopping is not reassigning.
      const released = this.cameras.releaseAll();
      this.toasts.status((await this.slots.stopAll(released)).message);
    });
  }

  protected async openBulkStart(): Promise<void> {
    // The slider starts at what a bulk start can start: the server starts the first `count`
    // assigned slots, skipping those a publisher or a pull holds.
    const startable = this.allRows().filter(
      ({ slot }) => isAssigned(slot) && slot.state !== 'external' && slot.state !== 'pulled',
    ).length;
    this.bulkCount.set(Math.min(Math.max(startable, 1), SLOT_COUNT));
    const count = await this.dialogs.open<number>(this.bulkStartDialog(), {
      title: 'Bulk Start Streams',
      size: 'small',
    }).closed;
    if (count === undefined) return;
    await this.runBulk(async () => {
      const result = await this.slots.startBulk(count);
      this.toasts.status(result.message);
      if (result.errors.length > 0) {
        this.toasts.error(`Failed: ${result.errors.map(({ index }) => `src${index}`).join(', ')}`);
      }
    });
  }

  protected async reset(): Promise<void> {
    const confirmed = await this.confirm.ask({
      title: 'Reset all sources?',
      message: 'Every slot goes back to unassigned. External streams are left running.',
      confirmLabel: 'Reset',
      tone: 'danger',
    });
    if (!confirmed) return;
    this.moreOpen.set(false);
    await this.runBulk(async () => {
      const released = this.cameras.releaseAll({ clearAssignments: true });
      this.toasts.status((await this.slots.reset(released)).message);
    });
  }

  protected async clearRenditions(): Promise<void> {
    // The question names what goes, so it asks with the usage as it is now, not as the menu
    // found it: another tab may have started a slot at a custom rate meanwhile.
    await this.refreshRenditions();
    const usage = this.slots.renditions();
    if (!usage || usage.count === 0) return;
    const confirmed = await this.confirm.ask({
      title: 'Clear cached renditions',
      message: `Delete ${usage.count} cached rendition(s) (${formatBytes(usage.bytes)})? They are re-created on the next start. Renditions in use by a playing source are kept.`,
      confirmLabel: 'Clear',
      tone: 'danger',
    });
    if (!confirmed) return;
    this.moreOpen.set(false);
    try {
      this.toasts.status(clearedMessage(await this.slots.clearRenditions()));
    } catch (failure) {
      this.toasts.error(messageOf(failure));
    }
  }

  private refreshRenditions(): Promise<void> {
    return this.slots.refreshRenditions().catch(() => undefined);
  }

  /**
   * Runs a bulk action with the bulk actions locked, and shows a refusal as the server words it.
   * Their buttons are disabled while locked; a confirmation answered after a slot began changing
   * still finds the lock and leaves the slots alone.
   */
  private async runBulk(action: () => Promise<void>): Promise<void> {
    if (this.bulkLocked()) return;
    this.bulkRunning.set(true);
    try {
      await action();
    } catch (failure) {
      this.toasts.error(messageOf(failure));
    } finally {
      this.bulkRunning.set(false);
    }
  }
}
