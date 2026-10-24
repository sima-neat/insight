import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
} from '@angular/core';
import { NeatAsideActions, NeatAsidePanel, NeatButton, NeatCode, NeatNote } from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatCollapsible } from '@sima/neat-ui/collapsible';
import { NeatSelect } from '@sima/neat-ui/select';
import { Announcement } from '../../announcement';
import { CONNECTION_CODES } from '../../board/board-error';
import { BoardService } from '../../board/board.service';
import { ticking } from '../../clock';
import { PanelTitle } from '../../panel-title';
import type { CameraItem, CameraModeChoice } from '../../peripherals/api';
import {
  blockedFormatSummary,
  cameraSummaryLine,
  formatOptions,
  modeLabel,
  previewBlock,
  rateLabel,
  resolveSelection,
  sameSelection,
  sizeKey,
  sizeLabel,
  sizeOptions,
} from '../../peripherals/camera-modes';
import { CameraPreview } from '../../peripherals/camera-preview';
import { type DeviceChip, isSnapshotStale } from '../../peripherals/devices';
import { PeripheralsSession } from '../../peripherals/peripherals-session';
import { PeripheralsService } from '../../peripherals/peripherals.service';
import {
  PREVIEW_IDLE,
  previewErrorInfo,
  type PreviewState,
  previewStatus,
  previewStreamUrl,
} from '../../peripherals/preview-state';
import { PreviewFrame, type PreviewStream } from '../../sources/preview-frame';
import { TopBarDialogs } from '../../top-bar-dialogs';
import { DeviceDetails } from './device-details';

/** The panel's one main button: what it does now, and whether it waits for the board. */
interface PreviewAction {
  label: 'Start preview' | 'Stop preview' | 'Stopping…';
  stop: boolean;
  /** The board is starting or stopping the preview: the button waits, aria-disabled. */
  waiting: boolean;
}

/** Board failures that the board's settings fix, as #170's preview error offered them for. */
function opensBoardSettings(code: string): boolean {
  return code === 'no_target' || CONNECTION_CODES.has(code);
}

let nextId = 0;

/**
 * The selected camera in Peripherals' side panel (spec, "Camera panel"; #170's `CameraDetail` and
 * `PreviewPane`, copy per Inv-PB §2.3), top to bottom as settled with the mockup: its name and
 * chip (with why it is not Available, when it is not), the preview, its status line, the two mode
 * pickers, Start or Stop preview, then the collapsed Details.
 *
 * The preview is the page's (`CameraPreview`), one per Insight. This panel shows it only when it
 * is this camera's: another camera's preview, kept after a stop that failed, reads here as not
 * running and blocks Start, while its own camera's panel keeps its video and Stop. The page builds
 * the panel afresh per camera and leaves the preview when the panel goes.
 *
 * The mode the user picks is remembered per camera (`PeripheralsSession.modes`); the frame rate is
 * chosen for the user, as #170 did. Picking a mode while the preview starts or streams restarts it
 * on that mode (`CameraPreview.changeMode`).
 */
@Component({
  selector: 'app-camera-panel',
  imports: [
    Announcement,
    DeviceDetails,
    NeatAsideActions,
    NeatButton,
    NeatCallout,
    NeatCode,
    NeatCollapsible,
    NeatNote,
    NeatSelect,
    PanelTitle,
    PreviewFrame,
  ],
  hostDirectives: [NeatAsidePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './camera-panel.html',
  styleUrl: './camera-panel.css',
})
export class CameraPanel {
  readonly camera = input.required<CameraItem>();
  /** The camera's row chip in the device list, which the title repeats. */
  readonly chip = input.required<DeviceChip>();

  private readonly board = inject(BoardService);
  private readonly peripherals = inject(PeripheralsService);
  private readonly session = inject(PeripheralsSession);
  private readonly preview = inject(CameraPreview);
  private readonly dialogs = inject(TopBarDialogs);
  /** For "Starting the camera on the board… N s". */
  private readonly now = ticking(1000);

  protected readonly reasonId = `camera-panel-reason-${nextId++}`;

  /** Why the camera is not Available: one line, or none (`cameraSummaryLine`). */
  protected readonly summary = computed(() => cameraSummaryLine(this.camera()));

  private readonly wanted = computed(() => this.session.modes().get(this.camera().id) ?? null);
  /** The mode the pickers show; null when the camera has no usable mode. */
  protected readonly selection = computed(() => resolveSelection(this.camera(), this.wanted()));
  /** The mode picked before is gone from this scan: say which one shows instead. */
  protected readonly selectionNotice = computed(() => {
    const wanted = this.wanted();
    const selection = this.selection();
    if (!wanted || !selection || sameSelection(wanted, selection)) return '';
    return `${modeLabel(wanted)} is no longer offered; showing ${modeLabel(selection)}.`;
  });
  protected readonly formats = computed(() => formatOptions(this.camera()));
  protected readonly sizes = computed(() => {
    const selection = this.selection();
    return selection ? sizeOptions(this.camera(), selection.format) : [];
  });
  protected readonly sizeValue = computed(() => {
    const selection = this.selection();
    return selection ? sizeKey(selection.width, selection.height) : null;
  });
  protected readonly blockedSummary = computed(() => blockedFormatSummary(this.formats()));
  protected readonly blockedFormats = computed(() =>
    this.formats().filter((option) => option.disabled),
  );

  /**
   * The preview as this panel shows it: the page's when it is this camera's, and a stop under way
   * whatever it stops (#170's pane did the same). Another camera's reads as not running.
   */
  protected readonly view = computed<PreviewState>(() => {
    const state = this.preview.state();
    return state.status === 'stopping' || this.preview.camera() === this.camera().id
      ? state
      : PREVIEW_IDLE;
  });
  protected readonly block = computed(() =>
    previewBlock({
      camera: this.camera(),
      selection: this.selection(),
      stale: isSnapshotStale(this.board.state(), this.peripherals.snapshot()),
      // Any camera's: another camera's preview blocks this one's Start.
      session: this.preview.state().session,
      target: this.board.state()?.target ?? null,
    }),
  );
  /** Only Insight's own stream path is ever loaded (`previewStreamUrl`). */
  private readonly streamUrl = computed(() => {
    const view = this.view();
    return view.status === 'live' ? previewStreamUrl(view.session) : null;
  });
  /**
   * The live picture: the backend relays the board's JPEG frames as multipart/x-mixed-replace,
   * which an image plays.
   */
  protected readonly stream = computed<PreviewStream | null>(() => {
    const src = this.streamUrl();
    return src ? { src, alt: `Live preview of ${this.camera().name}` } : null;
  });
  /** When the board began starting the camera; null while it is not starting. */
  private readonly startedAt = linkedSignal<boolean, number | null>({
    source: () => this.view().status === 'starting',
    computation: (starting) => (starting ? Date.now() : null),
  });

  protected readonly statusLine = computed(() => {
    const view = this.view();
    switch (view.status) {
      case 'live': {
        const session = view.session;
        if (!session || !this.streamUrl()) {
          return 'The preview stream could not be opened. Stop the preview and report it with the board label.';
        }
        const { mode, camera_fps } = session;
        const rate = rateLabel(camera_fps);
        // A MIPI camera's rate is the most its sensor delivers in the mode (SiMa Sentinel's
        // `max_fps`), so it reads "up to"; any other camera's is its mode's (#170's `ceiling`).
        const shownRate = rate && this.camera().connection === 'mipi' ? `up to ${rate}` : rate;
        return ['Live preview', sizeLabel(mode.width, mode.height), mode.format, shownRate]
          .filter(Boolean)
          .join(' · ');
      }
      case 'starting': {
        const since = this.startedAt() ?? this.now();
        return `Starting the camera on the board… ${Math.max(0, Math.round((this.now() - since) / 1000))} s`;
      }
      case 'stopping':
        return 'Stopping the preview…';
      case 'elsewhere':
        return 'This preview is showing in another tab or window.';
      default:
        return previewStatus(view).label;
    }
  });
  /** #170's status lines for screen readers; the status line ticks, so it is not a live region. */
  protected readonly announcement = computed(() => {
    switch (this.view().status) {
      case 'live':
        return 'Preview live';
      case 'starting':
        return 'Starting the preview';
      case 'stopping':
        return 'Stopping the preview';
      default:
        return '';
    }
  });

  protected readonly action = computed<PreviewAction>(() => {
    const { status, session } = this.view();
    if (status === 'idle' || status === 'error') {
      return { label: 'Start preview', stop: false, waiting: false };
    }
    if (status === 'stopping') return { label: 'Stopping…', stop: true, waiting: true };
    // A start has no session until the board's first frame, so there is nothing to stop yet.
    if (!session) return { label: 'Start preview', stop: false, waiting: true };
    return { label: 'Stop preview', stop: true, waiting: false };
  });
  /** Start cannot start, and the reason shows under it. */
  protected readonly startBlocked = computed(() => {
    const action = this.action();
    return !action.stop && !action.waiting && this.block().blocked;
  });

  protected readonly error = computed(() => previewErrorInfo(this.view().error));
  protected readonly errorOpensBoard = computed(() => {
    const error = this.error();
    return error !== null && opensBoardSettings(error.code);
  });

  protected act(): void {
    const action = this.action();
    if (action.waiting) return;
    if (action.stop) {
      void this.preview.stop();
      return;
    }
    const board = this.board.state();
    const selection = this.selection();
    if (this.block().blocked || !board || !selection) return;
    void this.preview.start(this.camera(), selection, board.generation);
  }

  protected pickFormat(format: string | null): void {
    const current = this.selection();
    if (format === null || format === current?.format) return;
    // The size is kept where the new format has it (`resolveSelection`).
    this.choose({ format, width: current?.width, height: current?.height });
  }

  protected pickSize(key: string | null): void {
    const current = this.selection();
    const size = this.sizes().find((option) => option.value === key);
    if (!current || !size || key === this.sizeValue()) return;
    this.choose({ format: current.format, width: size.width, height: size.height });
  }

  protected streamFailed(): void {
    void this.preview.streamFailed();
  }

  protected openBoard(): void {
    void this.dialogs.openBoard();
  }

  /**
   * Remembers the mode the pickers resolve to for this camera. A preview that starts or streams
   * then restarts on it; `changeMode` leaves another camera's alone.
   */
  private choose(wanted: Partial<CameraModeChoice>): void {
    const camera = this.camera();
    const next = resolveSelection(camera, wanted);
    if (!next) return;
    this.session.setMode(camera.id, next);
    const { status } = this.preview.state();
    if (status === 'starting' || status === 'live') void this.preview.changeMode(camera, next);
  }
}
