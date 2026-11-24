import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
} from '@angular/core';
import { NeatAsideActions, NeatAsidePanel, NeatButton, NeatNote } from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatCollapsible } from '@sima/neat-ui/collapsible';
import { NeatSelect } from '@sima/neat-ui/select';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { Announcement } from '../../announcement';
import { CONNECTION_CODES } from '../../board/board-error';
import { BoardSettingsAction } from '../../board/board-settings-action';
import { BoardService } from '../../board/board.service';
import { ticking } from '../../clock';
import { PanelTitle } from '../../panel-title';
import type { CameraItem, PreviewMode } from '../../peripherals/api';
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
import { deviceChip, isSnapshotStale } from '../../peripherals/devices';
import { PeripheralsSession } from '../../peripherals/peripherals-session';
import { PeripheralsService } from '../../peripherals/peripherals.service';
import {
  PREVIEW_IDLE,
  type PreviewState,
  previewStatus,
  previewStreamUrl,
} from '../../peripherals/preview-state';
import { formatElapsed } from '../../duration';
import { PreviewFrame, type PreviewStream } from '../../sources/preview-frame';
import { DeviceDetails } from './device-details';
import { DeviceErrors } from './device-errors';

/** The panel's one main button: what it does now, and whether it waits for the board. */
interface PreviewAction {
  label: 'Start preview' | 'Stop preview' | 'Stopping…';
  stop: boolean;
  /** The board is starting or stopping the preview: the button waits, aria-disabled. */
  waiting: boolean;
}

/** Board failures that the board's settings fix. */
function opensBoardSettings(code: string): boolean {
  return code === 'no_target' || CONNECTION_CODES.has(code);
}

let nextId = 0;

/**
 * The selected camera in Peripherals' side panel, top to bottom: its name and chip (with why it is not Available, when it is not), the preview, its status chip and line, the
 * two mode pickers, Start or Stop preview, then the collapsed Details.
 *
 * The preview is the page's (`CameraPreview`), one per Insight. This panel shows it only when it
 * is this camera's: another camera's preview, kept after a stop that failed, reads here as not
 * running and blocks Start, while its own camera's panel keeps its video and Stop. The page builds
 * the panel afresh per camera and leaves the preview when the panel goes.
 *
 * The mode the user picks is remembered per camera (`PeripheralsSession.modes`); the frame rate is
 * chosen for the user. Picking a mode while the preview starts or streams restarts it
 * on that mode (`CameraPreview.changeMode`).
 */
@Component({
  selector: 'app-camera-panel',
  imports: [
    Announcement,
    BoardSettingsAction,
    DeviceDetails,
    DeviceErrors,
    NeatAsideActions,
    NeatButton,
    NeatCallout,
    NeatCollapsible,
    NeatNote,
    NeatSelect,
    NeatStatusChip,
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

  private readonly board = inject(BoardService);
  private readonly peripherals = inject(PeripheralsService);
  private readonly session = inject(PeripheralsSession);
  private readonly preview = inject(CameraPreview);
  /** For "Starting the camera on the board… N s". */
  private readonly now = ticking(1000);

  protected readonly reasonId = `camera-panel-reason-${nextId++}`;

  /**
   * The title's chip: the camera's own state (its tier, or Last scan), not the row's Previewing:
   * the status chip under the preview says what the preview does, so the panel never
   * shows Previewing beside Live.
   */
  protected readonly titleChip = computed(() => deviceChip(this.camera()));
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
   * whatever it stops. Another camera's reads as not running.
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
      stale: isSnapshotStale(this.board.id(), this.peripherals.snapshot()),
      // Any camera's: another camera's preview blocks this one's Start.
      session: this.preview.state().session,
      target: this.board.target(),
    }),
  );
  /** The stream of the preview this panel shows live, as the board's preview route serves it. */
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
  private readonly starting = computed(() => this.view().status === 'starting');
  /**
   * When the board began starting the camera; null while it is not starting. A linkedSignal reruns
   * whenever its source's inputs change, even to an equal value, so the source must be a computed
   * of the value: a new starting state would otherwise restart the count.
   */
  private readonly startedAt = linkedSignal<boolean, number | null>({
    source: this.starting,
    computation: (starting) => (starting ? Date.now() : null),
  });

  protected readonly statusLine = computed(() => {
    const view = this.view();
    switch (view.status) {
      case 'live': {
        const session = view.session;
        if (!session) return '';
        const { mode, camera_fps } = session;
        const rate = rateLabel(camera_fps);
        // A MIPI camera's rate is the most its sensor delivers in the mode (SiMa Sentinel's
        // `max_fps`), so it reads "up to"; any other camera's is its mode's.
        const shownRate = rate && this.camera().connection === 'mipi' ? `up to ${rate}` : rate;
        return ['Live preview', sizeLabel(mode.width, mode.height), mode.format, shownRate]
          .filter(Boolean)
          .join(' · ');
      }
      case 'starting': {
        const since = this.startedAt() ?? this.now();
        return `Starting the camera on the board… ${formatElapsed(since, this.now())}`;
      }
      case 'stopping':
        return 'Stopping the preview…';
      case 'elsewhere':
        return 'This preview is showing in another tab or window.';
      case 'error':
        // The chip says it could not start, and the callout under Start says why.
        return '';
      default:
        return previewStatus(view).label;
    }
  });
  /**
   * The preview's status chip, beside the status line: "In another tab" among them, with Stop.
   * Idle has none: its sentence says it is not running.
   */
  protected readonly statusChip = computed(() => {
    const view = this.view();
    return view.status === 'idle' ? null : previewStatus(view);
  });
  /** The status lines for screen readers; the status line ticks, so it is not a live region. */
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

  protected readonly error = computed(() => this.view().error);
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
    const board = this.board.id();
    const selection = this.selection();
    if (this.block().blocked || !board || !selection) return;
    void this.preview.start(this.camera(), selection, board);
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

  /**
   * Remembers the mode the pickers resolve to for this camera. A preview that starts or streams
   * then restarts on it; `changeMode` leaves another camera's alone.
   */
  private choose(wanted: Partial<PreviewMode>): void {
    const camera = this.camera();
    const next = resolveSelection(camera, wanted);
    if (!next) return;
    this.session.setMode(camera.id, next);
    const { status } = this.preview.state();
    if (status === 'starting' || status === 'live') void this.preview.changeMode(camera, next);
  }
}
