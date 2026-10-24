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
  NeatAsideToggle,
  NeatButton,
  NeatIcon,
  NeatNote,
  NeatPage,
  NeatPageToolbar,
  type NeatTone,
  NeatTooltip,
} from '@sima/neat-ui';
import { NeatConfirm } from '@sima/neat-ui/confirm';
import {
  NeatDialog,
  NeatDialogActions,
  NeatDialogBody,
  type NeatDialogRef,
} from '@sima/neat-ui/dialog';
import {
  NeatPopover,
  NeatPopoverContent,
  NeatPopoverItem,
  NeatPopoverTrigger,
} from '@sima/neat-ui/popover';
import { NeatSegmented, type NeatSegmentedOption } from '@sima/neat-ui/segmented';
import { NeatColumn, NeatSelectList } from '@sima/neat-ui/select-list';
import { NeatSlider } from '@sima/neat-ui/slider';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { NeatToasts } from '@sima/neat-ui/toast';
import { AsidePrefs } from '../../aside-prefs';
import { CellText } from '../../cell-text';
import type { MediaNode, RenditionsCleared } from '../../sources/api';
import { CamerasService } from '../../sources/cameras.service';
import { formatBytes } from '../../format-bytes';
import { MediaLibraryService } from '../../sources/media-library.service';
import { SlotsColumn } from '../../sources/slots-column';
import { SlotsService } from '../../sources/slots.service';
import { SourcesSession } from '../sources-session';
import { SlotControl } from './slot-control';
import { SlotPanel } from './slot-panel';
import { isInUse, type SlotRow, slotRow } from '../../sources/slot-row';
import { messageOf } from '../../sources/stream-lines';

/** The slots Insight has, `src1`–`src48`: hard-coded as in #170 (the spec keeps it so). */
const SLOT_COUNT = 48;

type SlotFilter = 'all' | 'in-use';

/** Why the bulk actions are disabled while a slot is changing (#170's `webcamBusy`). */
const CHANGING_TOOLTIP = 'Waiting for a source change to finish';

/**
 * What a bulk action says when a slot began changing after its dialog or menu opened (ruling Q9:
 * #170's Start message, worded for each action).
 */
const changingMessage = (doing: 'starting' | 'stopping' | 'resetting' | 'assigning') =>
  `Waiting for a source change to finish before ${doing} sources.`;

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
    CellText,
    NeatAsideToggle,
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
    NeatPopoverItem,
    NeatPopoverTrigger,
    NeatSegmented,
    NeatSelectList,
    NeatSlider,
    NeatStatusChip,
    NeatTooltip,
    SlotPanel,
    SlotsColumn,
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
  private readonly control = inject(SlotControl);

  protected readonly slotCount = SLOT_COUNT;
  protected readonly filter = signal<SlotFilter>('all');
  protected readonly asides = inject(AsidePrefs);
  protected readonly asideOpen = computed(() => this.asides.open('streaming'));
  protected readonly moreOpen = signal(false);
  /** The count the Start… dialog's slider is at: 1 at first, then the last one chosen (#170). */
  protected readonly bulkCount = signal(1);

  private readonly session = inject(SourcesSession);
  /**
   * By index rather than the row: each poll answer brings new rows for the same slots. Where the
   * last visit left it, src1 on the first (#170).
   */
  private readonly selectedIndex = signal<number | null>(this.session.streaming.slot);
  /** A bulk action of this page is running; the Start… dialog's Start waits for it. */
  protected readonly bulkRunning = signal(false);
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
  /** The side panel's slot, as a list of one (or none) that the panel is keyed on. */
  protected readonly selectedRows = computed(() => {
    const row = this.selectedRow();
    return row ? [row] : [];
  });

  /** A slot is changing or a bulk action is running: another bulk action now would race it. */
  protected readonly bulkLocked = computed(() => this.cameras.anyChanging() || this.bulkRunning());
  protected readonly bulkTooltip = computed(() =>
    this.cameras.anyChanging() ? CHANGING_TOOLTIP : null,
  );
  protected readonly autoAssignTooltip = computed(
    () => this.bulkTooltip() ?? 'Auto assign unique media files to all sources',
  );
  /** Starting needs a file to stream: until the library has answered with one, Start… waits (#170). */
  protected readonly noStreamableFile = computed(() => {
    const tree = this.library.tree();
    return tree === null || streamableCount(tree) === 0;
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
  /** A row is tinted with its state chip's tone: the same `SlotStateView`, so they never differ. */
  protected readonly rowTone = (row: SlotRow): NeatTone => row.state.tone;

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(this.slots.watch());
    destroyRef.onDestroy(() => (this.session.streaming = { slot: this.selectedIndex() }));
    // Both only inform the top bar (Start… and the ⋯ menu's count). A failure leaves Start…
    // disabled and the count unknown, as in #170; the usage is fetched again on use.
    this.library.refresh().catch(() => undefined);
    void this.refreshRenditions();
  }

  protected select(row: SlotRow | null): void {
    this.selectedIndex.set(row?.slot.index ?? null);
  }

  /** Enter or a click on a row: its actions are in the side panel, so the panel opens. */
  protected openAside(): void {
    this.asides.setOpen('streaming', true);
  }

  /** The ⋯ menu shows the rendition usage, which only changes with a fetch: fetch it as it opens. */
  protected moreOpenChange(open: boolean): void {
    this.moreOpen.set(open);
    if (open) void this.refreshRenditions();
  }

  protected async autoAssign(): Promise<void> {
    await this.runBulk('assigning', async () => {
      const released = this.cameras.releaseAll({ clearAssignments: true });
      this.toasts.status((await this.slots.autoAssign(released)).message);
    });
  }

  protected async stopAll(): Promise<void> {
    await this.runBulk('stopping', async () => {
      // The cameras stay picked for their slots: stopping is not reassigning.
      const released = this.cameras.releaseAll();
      this.toasts.status((await this.slots.stopAll(released)).message);
    });
  }

  protected openBulkStart(): void {
    this.dialogs.open(this.bulkStartDialog(), { title: 'Bulk Start Streams', size: 'small' });
  }

  /**
   * The dialog's Start. As in #170 the dialog closes once the server has answered, and stays open
   * when the request was refused, or when a slot began changing meanwhile, so it can be tried again.
   *
   * Like a slot's own Start it first waits for the frame rates the side panel is committing (the
   * stepper commits as it loses focus, which opening the dialog makes it do), so the server starts
   * the rates just chosen; when one was refused (and reported) it starts nothing (#170).
   */
  protected async startBulk(dialog: NeatDialogRef): Promise<void> {
    const count = this.bulkCount();
    const started = await this.runBulk('starting', async () => {
      if (!(await this.control.commitsSettled())) return false;
      const result = await this.slots.startBulk(count);
      this.toasts.status(result.message);
      if (result.errors.length > 0) {
        this.toasts.error(`Failed: ${result.errors.map(({ index }) => `src${index}`).join(', ')}`);
      }
      return true;
    });
    if (started) dialog.close();
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
    await this.runBulk('resetting', async () => {
      const released = this.cameras.releaseAll({ clearAssignments: true });
      this.toasts.status((await this.slots.reset(released)).message);
      // Every slot is unassigned now; #170 then shows the first.
      this.selectedIndex.set(1);
    });
  }

  protected async clearRenditions(): Promise<void> {
    // The question names what goes, so it asks with the usage as it is now, not as the menu
    // found it: another tab may have started or cleared renditions meanwhile. It asks even when
    // that is none, as #170's dialog did, rather than let the click do nothing.
    await this.refreshRenditions();
    const usage = this.slots.renditions() ?? { count: 0, bytes: 0 };
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
   * Their buttons are disabled while a slot is changing; one that began changing after the action's
   * dialog or menu opened is reported, as #170 did for Start, and the slots are left alone.
   * Resolves whether the action went through; an action resolving `false` did nothing.
   */
  private async runBulk(
    doing: Parameters<typeof changingMessage>[0],
    action: () => Promise<boolean | void>,
  ): Promise<boolean> {
    if (this.cameras.anyChanging()) {
      this.toasts.error(changingMessage(doing));
      return false;
    }
    // Another bulk action of this page is running: its buttons are disabled, so this is a second
    // click that got in before they were.
    if (this.bulkRunning()) return false;
    this.bulkRunning.set(true);
    try {
      return (await action()) !== false;
    } catch (failure) {
      this.toasts.error(messageOf(failure));
      return false;
    } finally {
      this.bulkRunning.set(false);
    }
  }
}
