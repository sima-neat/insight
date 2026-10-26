import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import {
  NeatAsidePanel,
  NeatAsideToggle,
  NeatButton,
  NeatIcon,
  NeatNote,
  NeatPage,
  NeatPageToolbar,
  NeatTooltip,
} from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatColumn, NeatSelectList } from '@sima/neat-ui/select-list';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { Announcement } from '../../announcement';
import { AsidePrefs } from '../../aside-prefs';
import { problemOf, type BoardProblem } from '../../board/board-error';
import { BoardProblemNotice } from '../../board/board-problem-notice';
import { BoardSettingsAction } from '../../board/board-settings-action';
import { BoardService } from '../../board/board.service';
import { CellText } from '../../cell-text';
import { ticking } from '../../clock';
import type {
  CameraItem,
  PeripheralItem,
  PeripheralSnapshot,
  PreviewSession,
} from '../../peripherals/api';
import { previewBlock } from '../../peripherals/camera-modes';
import { CameraPreview } from '../../peripherals/camera-preview';
import {
  type DeviceActivity,
  deviceGroups,
  deviceRow,
  type DeviceRow,
  isCamera,
  isMicrophone,
  isScanned,
  isSnapshotStale,
  resolveDeviceId,
} from '../../peripherals/devices';
import { MicTest } from '../../peripherals/mic-test';
import { PeripheralsSession, type PreviewResume } from '../../peripherals/peripherals-session';
import { PeripheralsService } from '../../peripherals/peripherals.service';
import { ListColumn } from '../../list-column';
import { PanelTitle } from '../../panel-title';
import { elapsedSeconds, formatRelativeTime } from '../../relative-time';
import { TopBarDialogs } from '../../top-bar-dialogs';
import { CameraPanel } from './camera-panel';
import { DeviceDetails } from './device-details';
import { MicrophonePanel } from './microphone-panel';
import { PeripheralsBanners } from './peripherals-banners';

/** What stands in the page's main column: the device list, or why there is none (Inv-PB §1.1). */
type Body = 'loading' | 'read-failed' | 'no-target' | 'list';

/**
 * The device the side panel is about: a listed one, with its row, or one the last scan reported
 * removed (no row), whose panel says it is gone.
 */
interface ShownDevice {
  id: string;
  name: string;
  row: DeviceRow | null;
}

/**
 * Peripherals: the selected board's devices in one list grouped by kind, with the selected device
 * in the side panel (spec, "Peripherals page"; #170's `PeripheralsView`, Inv-PB §1.1 and §3.1).
 * The scan is `PeripheralsService`'s, which outlives the page; the camera preview and the
 * microphone test are this page's (`CameraPreview` and `MicTest`, provided here), so leaving the
 * page ends what they run.
 *
 * **Entering** reads the board, the snapshot and the running preview together. A preview running
 * then is adopted, its camera selected and its mode remembered, as is one a refused Start finds
 * later (`showAdopted`); otherwise the preview this page
 * left running on the last visit (`PeripheralsSession.resume`) starts again once, while its board
 * and camera are still there. The board is scanned on every visit (`scanOnVisit`), and that
 * preview starts after the scan, which the backend would otherwise stop it for.
 *
 * **Leaving** records the preview to start again, then stops it (`CameraPreview.release`). The
 * next visit waits until that stop has answered, a start still in flight included, so that it
 * does not find the old preview still running on the board.
 *
 * **The board changing** under the page (another tab, the board dialog, a re-read on focus) shows
 * the board-changed banner over a snapshot of the old board; the preview controller lets go of the
 * old board's preview, which the backend stopped (Review Focus 1). The page does not scan the new
 * board by itself then: Refresh now does.
 */
@Component({
  selector: 'app-peripherals-page',
  imports: [
    Announcement,
    BoardProblemNotice,
    BoardSettingsAction,
    CameraPanel,
    CellText,
    DeviceDetails,
    ListColumn,
    MicrophonePanel,
    NeatAsidePanel,
    NeatAsideToggle,
    NeatButton,
    NeatCallout,
    NeatColumn,
    NeatIcon,
    NeatNote,
    NeatPage,
    NeatPageToolbar,
    NeatSelectList,
    NeatStatusChip,
    NeatTooltip,
    PanelTitle,
    PeripheralsBanners,
  ],
  providers: [CameraPreview, MicTest],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './peripherals.page.html',
  styleUrl: './peripherals.page.css',
})
export class PeripheralsPage {
  protected readonly board = inject(BoardService);
  protected readonly peripherals = inject(PeripheralsService);
  private readonly session = inject(PeripheralsSession);
  private readonly preview = inject(CameraPreview);
  private readonly micTest = inject(MicTest);
  private readonly dialogs = inject(TopBarDialogs);
  protected readonly asides = inject(AsidePrefs);
  protected readonly asideOpen = computed(() => this.asides.open('peripherals'));

  /** This visit's read of the snapshot has answered, or failed. */
  private readonly loaded = signal(false);
  /**
   * Why this visit's read of the snapshot failed (ruling Q9); null while it did not. A snapshot
   * applied after it (a scan that answered) says the peripherals were read after all, so it
   * clears the failure, as #170's Refresh did.
   */
  protected readonly loadError = linkedSignal<PeripheralSnapshot | null, BoardProblem | null>({
    source: this.peripherals.snapshot,
    computation: () => null,
  });
  /** The Refresh running, from the preview's stop to the scan's end; null while none runs. */
  private refreshing: Promise<void> | null = null;
  /** The preview of the last visit to start again, until this visit has decided on it. */
  private pendingResume: PreviewResume | null = null;
  private destroyed = false;

  /** For "Scanning… N s". */
  private readonly now = ticking(1000);
  /** For "Scanned … ago", which moves in steps of 10 s and more. */
  private readonly scannedNow = ticking(10_000);

  protected readonly target = computed(() => this.board.state()?.target ?? null);
  protected readonly scanned = computed(() => isScanned(this.peripherals.snapshot()));
  protected readonly stale = computed(() =>
    isSnapshotStale(this.board.state(), this.peripherals.snapshot()),
  );

  /**
   * In priority order (ruling F35): loading while the board's first read or this visit's first
   * snapshot read is out (a snapshot read before, on an earlier visit, shows at once); the board
   * could not be read with no state known; no board is selected. A read failure with a last good
   * state keeps the list: the pill says the read failed.
   */
  protected readonly body = computed<Body>(() => {
    const state = this.board.state();
    if (state === null && this.board.error() === null) return 'loading';
    if (this.peripherals.snapshot() === null && !this.loaded()) return 'loading';
    if (state === null) return 'read-failed';
    if (state.target === null) return 'no-target';
    return 'list';
  });

  /**
   * Which camera this page previews and which microphone it tests, for the rows' chips (ruling
   * F23). Compared by value, so that a preview's rate arriving or a test's progress does not
   * rebuild the rows.
   */
  private readonly activity = computed<DeviceActivity>(
    () => {
      const preview = this.preview.state();
      const test = this.micTest.state();
      return {
        previewing:
          preview.status === 'live' || preview.status === 'elsewhere'
            ? (preview.session?.camera_id ?? null)
            : null,
        testing: test.status === 'recording' || test.status === 'playing' ? test.micId : null,
      };
    },
    { equal: (a, b) => a.previewing === b.previewing && a.testing === b.testing },
  );

  protected readonly list = computed(() => {
    const { groups, items } = deviceGroups(this.peripherals.snapshot());
    const activity = this.activity();
    return { groups, rows: items.map((item) => deviceRow(item, activity)) };
  });

  /**
   * The selected device's id: where the last visit left it, then whatever the user picks. A
   * rescan keeps it while the device is listed, or reported removed (its panel says so);
   * otherwise the first device is selected (`resolveDeviceId`).
   */
  private readonly selectedId = linkedSignal<PeripheralSnapshot | null, string | null>({
    source: this.peripherals.snapshot,
    computation: (snapshot, previous) => {
      const wanted = previous ? previous.value : this.session.selectedId;
      return snapshot === null ? wanted : resolveDeviceId(snapshot, wanted);
    },
  });
  protected readonly selectedRow = computed(
    () => this.list().rows.find((row) => row.item.id === this.selectedId()) ?? null,
  );
  /** The side panel's device, as a list of one (or none) that the panel is keyed on. */
  protected readonly selectedDevices = computed<ShownDevice[]>(() => {
    const id = this.selectedId();
    const row = this.selectedRow();
    if (row) return [{ id: row.item.id, name: row.name, row }];
    const removed = this.peripherals
      .snapshot()
      ?.changes?.removed.find((device) => device.id === id);
    return removed ? [{ id: removed.id, name: removed.name || removed.id, row: null }] : [];
  });
  /**
   * The camera whose panel shows, which is where its preview shows: none while the side panel is
   * closed, a body state stands in the list's place, or another kind of device is selected.
   */
  private readonly panelCamera = computed(() => {
    const row = this.selectedRow();
    if (!this.asideOpen() || this.body() !== 'list' || !row || !isCamera(row.item)) return null;
    return row.item.id;
  });

  protected readonly scannedText = computed(() => {
    const snapshot = this.peripherals.snapshot();
    if (!isScanned(snapshot)) return '';
    const ago = formatRelativeTime(snapshot.scanned_at, this.scannedNow());
    return ago ? `Scanned ${ago}` : '';
  });
  protected readonly scanning = computed(() => this.peripherals.scanning() !== null);
  protected readonly refreshLabel = computed(() => {
    const since = this.peripherals.scanning();
    if (since === null) return 'Refresh';
    return `Scanning… ${elapsedSeconds(since, this.now())} s`;
  });
  /** #170's status line for screen readers (ruling F28): a scan running, or a stale snapshot. */
  protected readonly scanStatus = computed(() => {
    if (this.scanning()) return `Scanning ${this.target()?.label || 'the board'}`;
    return this.stale() ? 'The board changed. Refresh before starting a preview.' : '';
  });
  /** Where the empty-kind guidance says it looked: the scanned board, else the selected one. */
  protected readonly scannedLabel = computed(
    () => this.peripherals.snapshot()?.board.label || this.target()?.label || '',
  );
  protected readonly hasIssues = computed(
    () => (this.peripherals.snapshot()?.issues.length ?? 0) > 0,
  );

  /** A row's identity across scans. */
  protected readonly rowKey = (row: DeviceRow): string => row.item.id;
  /** A row's group is its device's kind (`deviceGroups` keys the groups by kind). */
  protected readonly groupOf = (row: DeviceRow): string => row.item.kind;
  protected readonly isCamera = isCamera;
  protected readonly isMicrophone = isMicrophone;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.session.selectedId = this.selectedId();
      // A preview of the last visit this one had no time to decide on is kept for the next one.
      this.session.resume = this.preview.resumable() ?? this.pendingResume;
      const earlier = this.session.leaving;
      this.session.leaving = Promise.all([earlier, this.preview.release()]).then(() => undefined);
    });
    // The preview shows in its camera's panel: when that panel goes (another device selected, the
    // side panel closed), the page leaves the preview, as #170 did when the camera changed. It
    // runs on what is shown and whose preview it is, not on the preview's state, so that a stop
    // that fails, keeping the preview and its camera, is not sent again by itself. One case sends
    // it once more: a start left while still starting has no camera until its answer comes and
    // is stopped; when that stop fails, the preview is live again on its camera, and the effect
    // leaves it once more. That is one more stop of a preview nobody shows, and its failure keeps
    // the camera, so nothing repeats.
    effect(() => {
      const shown = this.panelCamera();
      const previewed = this.preview.camera();
      untracked(() => {
        const { status } = this.preview.state();
        const active = status === 'starting' || status === 'live' || status === 'elsewhere';
        if (active && previewed !== shown) void this.preview.leave();
      });
    });
    // Every preview the page takes up selects its camera, on entry and after a refused Start alike.
    this.preview.onAdopt((session) => this.showAdopted(session));
    void this.enter();
  }

  protected select(row: DeviceRow | null): void {
    if (row) this.selectedId.set(row.item.id);
  }

  /** Enter or a click on a row: the device's controls are in the side panel, so the panel opens. */
  protected openAside(): void {
    this.asides.setOpen('peripherals', true);
  }

  protected openBoard(): void {
    void this.dialogs.openBoard();
  }

  /**
   * Scans the board. This page's preview is stopped first: the backend stops it for the scan
   * anyway, and the page would otherwise show a preview that ended without a word.
   */
  protected refresh(): Promise<void> {
    if (this.scanning() || !this.target()) return Promise.resolve();
    // A press while the preview stops waits with the first one, rather than scanning before the
    // stop has answered.
    this.refreshing ??= (async () => {
      try {
        await this.preview.leave();
        await this.peripherals.refresh();
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async enter(): Promise<void> {
    const leaving = this.session.leaving;
    const shownBefore = this.peripherals.snapshot();
    this.pendingResume = this.session.resume;
    this.session.resume = null;
    // The board is read too, as #170 did: the scan and the resume are decided on the board as it
    // is now, which may have changed (or Insight restarted) while the page was away.
    const [loadError, running] = await Promise.all([
      this.peripherals.load().then(
        () => null,
        (failure: unknown) => problemOf(failure),
      ),
      // The last visit's preview may still be stopping, or starting, on the board.
      leaving.then(() => this.preview.current()).catch(() => null),
      this.board.reload(),
    ]);
    this.loaded.set(true);
    // A snapshot applied meanwhile (a scan of an earlier visit that answered) supersedes the failure.
    if (this.peripherals.snapshot() === shownBefore) this.loadError.set(loadError);
    if (this.destroyed) return;
    const board = this.board.state();
    const adopted = running && running.state !== 'stopped';
    if (adopted) {
      this.pendingResume = null;
      this.preview.adopt(running);
    }
    const scan = board ? this.peripherals.scanOnVisit(board) : Promise.resolve();
    if (adopted) return;
    // The backend stops a running preview for a scan, so the preview of the last visit starts
    // once this visit's scan ended, on the snapshot it made. Until then the resume stays with the
    // page, for the next visit if this one is left first (`pendingResume`), and a preview the
    // user started meanwhile is theirs to keep.
    await scan;
    const resume = this.pendingResume;
    this.pendingResume = null;
    if (resume && !this.destroyed && this.preview.state().status === 'idle') this.resume(resume);
  }

  /**
   * Shows a preview the page takes up (`CameraPreview.onAdopt`), one running as the page opens or
   * one a refused Start found (#170's `adoptPreview`): its camera selected, its mode remembered so
   * that the pickers match the video, and the side panel open, since the preview shows there (with
   * the panel closed it would be stopped). A camera the list does not show has no panel to show it
   * in, nor has any camera while a body state stands in the list's place: answers false then.
   */
  private showAdopted(session: PreviewSession): boolean {
    const listed = this.list().rows.some(
      (row) => row.item.id === session.camera_id && isCamera(row.item),
    );
    if (this.body() !== 'list' || !listed) return false;
    this.selectedId.set(session.camera_id);
    this.asides.setOpen('peripherals', true);
    this.session.setMode(session.camera_id, session.mode);
    return true;
  }

  /**
   * Starts the preview the last visit left running, on the board it ran on and while the scan
   * still lists its camera; never one that Start would refuse (`previewBlock`), such as a camera
   * kept from an earlier scan.
   */
  private resume(resume: PreviewResume): void {
    const board = this.board.state();
    const snapshot = this.peripherals.snapshot();
    if (!board || board.generation !== resume.generation) return;
    if (snapshot?.generation !== resume.generation) return;
    const camera = snapshot.items.find(
      (item: PeripheralItem): item is CameraItem => item.id === resume.cameraId && isCamera(item),
    );
    if (!camera) return;
    const block = previewBlock({
      camera,
      selection: resume.mode,
      stale: this.stale(),
      target: board.target,
    });
    if (block.blocked) return;
    this.selectedId.set(camera.id);
    void this.preview.start(camera, resume.mode, resume.generation);
  }
}
