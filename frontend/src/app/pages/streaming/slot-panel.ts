import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DOCUMENT,
  type ElementRef,
  inject,
  Injector,
  input,
  linkedSignal,
  signal,
  type TemplateRef,
  untracked,
  viewChild,
} from '@angular/core';
import {
  NeatButton,
  type NeatButtonVariant,
  NeatInlineButton,
  NeatNote,
  NeatTooltip,
} from '@sima/neat-ui';
import { NeatConfirm } from '@sima/neat-ui/confirm';
import { NeatDialog, type NeatDialogRef } from '@sima/neat-ui/dialog';
import { NeatInput } from '@sima/neat-ui/input';
import { NeatProgress } from '@sima/neat-ui/progress';
import { NeatSegmented, type NeatSegmentedOption } from '@sima/neat-ui/segmented';
import { NeatSelect, type NeatSelectOption } from '@sima/neat-ui/select';
import { NeatColumn, NeatSelectList } from '@sima/neat-ui/select-list';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { Slot, SlotTransport } from '../../sources/api';
import { CamerasService } from '../../sources/cameras.service';
import { isNativeRate } from '../../sources/fps';
import { SlotsService } from '../../sources/slots.service';
import type { Camera } from '../../sources/webcam-publishing';
import { FpsStepper } from './fps-stepper';
import { MediaPicker } from './media-picker';
import { SlotControl } from './slot-control';
import { SlotPreview } from './slot-preview';
import {
  codecLabel,
  dimensionsText,
  externalChip,
  formatBitrate,
  isAssigned,
  liveFor,
  protocolLabel,
  pullSourceText,
  pullStatusLabel,
  readersText,
  slotCodec,
  type SlotRow,
  slotOutput,
  streamUrl,
} from '../../sources/slot-row';
import { StatusChip } from './status-chip';

/** Which form the source switch shows. */
type SourceForm = 'file' | 'camera' | 'url';

const SOURCE_FORMS: NeatSegmentedOption<SourceForm>[] = [
  { value: 'file', label: 'File' },
  { value: 'camera', label: 'Camera' },
  { value: 'url', label: 'Stream URL' },
];

const TRANSPORT_LABELS: Record<SlotTransport, string> = { rtsp: 'RTSP', http: 'HTTP' };

/** A pull accepts RTSP and RTSPS URLs only (#170). */
const STREAM_URL = /^rtsps?:\/\//i;

const COPY_REFUSED = 'Could not copy the URL: the browser refused access to the clipboard.';

/** The slot's main action, one button whatever it is (see the template). */
interface PrimaryAction {
  readonly kind: 'start' | 'stop' | 'cancel' | 'takeOver' | 'stopPulling';
  readonly label: string;
  readonly variant: NeatButtonVariant;
  /** Why the action cannot be taken at all; the button is then disabled. */
  readonly blocker: string | null;
  /** The action waits for something in flight: the button stays focusable, and a press does nothing. */
  readonly waiting: boolean;
  readonly tooltip: string | null;
}

let nextPanelId = 0;

/** The form for what the slot holds: a webcam its camera, a pull its URL, anything else its file. */
function formFor(slot: Slot): SourceForm {
  if (slot.state === 'pulled') return 'url';
  return slot.type === 'webcam' ? 'camera' : 'file';
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * The Streaming page's side panel for the selected slot (spec, "Streaming": the side panel; Inv-SM
 * §1.2's Source Preview and assign dialog, now in one place). From the top:
 *
 * - the slot and its state, and its live preview (`SlotPreview`);
 * - its actions: Start and Stop; Cancel encoding while a rendition encodes; "Take over…" for an
 *   external publisher; Stop pulling for a pull;
 * - the source switch, File / Camera / Stream URL, which only chooses the form shown: nothing
 *   changes until Assign, Pull or Clear;
 * - the output frame rate of a file slot, and its transport where the media allows a choice;
 * - the details: output, URL with Copy, live for, bitrate, readers, publisher or source.
 *
 * Every assignment from here goes through `CamerasService` (ruling Q7), which ends this browser's
 * webcam on the slot first; a slot it is changing, or one with an action of this panel in flight
 * (`SlotControl`), holds its controls. Every refusal shows the server's message as an error toast;
 * the services fetch the slots again either way.
 *
 * The page builds the panel afresh for each slot, so the form, the typed URL and password and the
 * stepper's draft never carry over to another slot; it reacts to its slot changing all the same.
 */
@Component({
  selector: 'app-slot-panel',
  imports: [
    FpsStepper,
    MediaPicker,
    NeatButton,
    NeatColumn,
    NeatInlineButton,
    NeatInput,
    NeatNote,
    NeatProgress,
    NeatSegmented,
    NeatSelect,
    NeatSelectList,
    NeatTooltip,
    SlotPreview,
    StatusChip,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './slot-panel.html',
  styleUrl: './slot-panel.css',
})
export class SlotPanel {
  readonly row = input.required<SlotRow>();

  private readonly slots = inject(SlotsService);
  protected readonly cameras = inject(CamerasService);
  private readonly control = inject(SlotControl);
  private readonly dialogs = inject(NeatDialog);
  private readonly confirm = inject(NeatConfirm);
  private readonly toasts = inject(NeatToasts);
  private readonly clipboard = inject(DOCUMENT).defaultView?.navigator.clipboard;
  private readonly injector = inject(Injector);

  private readonly pickerTemplate = viewChild.required<TemplateRef<unknown>>('picker');
  private readonly stepper = viewChild(FpsStepper);
  private readonly primaryButton = viewChild.required<ElementRef<HTMLButtonElement>>('primary');
  private readonly changeButton = viewChild<ElementRef<HTMLButtonElement>>('change');

  protected readonly fpsReasonId = `slot-panel-${nextPanelId++}-fps-reason`;

  protected readonly slot = computed(() => this.row().slot);
  protected readonly index = computed(() => this.slot().index);
  protected readonly sourceForms = SOURCE_FORMS;

  // What belongs to this slot alone starts afresh when the slot changes.
  protected readonly form = linkedSignal<number, SourceForm>({
    source: this.index,
    computation: () => untracked(() => formFor(this.slot())),
  });
  protected readonly url = linkedSignal({ source: this.index, computation: () => '' });
  protected readonly username = linkedSignal({ source: this.index, computation: () => '' });
  protected readonly password = linkedSignal({ source: this.index, computation: () => '' });
  /** The last pull's refusal, shown under the form (#170's dialog did) as well as in a toast. */
  protected readonly pullError = linkedSignal<number, string | null>({
    source: this.index,
    computation: () => null,
  });
  private readonly fpsInvalid = linkedSignal({ source: this.index, computation: () => false });
  protected readonly pickedCamera = linkedSignal<string | null>(
    () => this.cameras.assignments().get(this.index())?.deviceId ?? null,
  );
  protected readonly pulling = signal(false);
  protected readonly pickerBusy = signal(false);

  /** The slot is changing, or an action of this panel on it is in flight: its controls wait. */
  protected readonly busy = computed(
    () => this.control.busy().has(this.index()) || this.cameras.changingSlots().has(this.index()),
  );
  protected readonly encode = computed(() => this.slots.encodes().get(this.index()) ?? null);
  protected readonly preparing = computed(() => this.control.preparing().has(this.index()));
  protected readonly localStream = computed(
    () => this.cameras.localStreams().get(this.index()) ?? null,
  );
  protected readonly camera = computed<Camera | null>(
    () => this.cameras.assignments().get(this.index()) ?? null,
  );
  /** An external publisher or a pull holds the slot, over whatever is assigned under it. */
  protected readonly held = computed(() => {
    const state = this.slot().state;
    return state === 'external' || state === 'pulled';
  });
  protected readonly isWebcam = computed(() => this.slot().type === 'webcam');
  protected readonly playing = computed(() => this.slot().state === 'playing');
  /** Assigned, with a codec the streamer can send: what Start and Copy need (#170). */
  protected readonly canStream = computed(
    () => isAssigned(this.slot()) && this.slot().allowed_transports.length > 0,
  );

  // Start.
  protected readonly startBlocker = computed<string | null>(() => {
    if (this.isWebcam()) return this.camera() ? null : 'Select a webcam first';
    if (!this.canStream()) return 'Codec must be detected before streaming';
    return this.fpsInvalid() ? 'FPS must be a whole number of at least 1' : null;
  });
  protected readonly startTooltip = computed(() => {
    const camera = this.camera();
    if (this.startBlocker()) return this.startBlocker();
    return this.isWebcam() && camera
      ? `Start publishing ${camera.label}`
      : `Start src${this.index()}`;
  });

  protected readonly action = computed<PrimaryAction>(() => {
    const plain = { blocker: null, waiting: this.busy(), tooltip: null };
    switch (this.slot().state) {
      case 'external':
        return { ...plain, kind: 'takeOver', label: 'Take over…', variant: 'danger' };
      case 'pulled':
        return { ...plain, kind: 'stopPulling', label: 'Stop pulling', variant: 'outlined' };
    }
    if (this.encode()) {
      // Once the encode is over the start that follows it cannot be cancelled.
      return {
        ...plain,
        kind: 'cancel',
        label: 'Cancel encoding',
        variant: 'outlined',
        waiting: !this.preparing(),
      };
    }
    if (this.playing()) return { ...plain, kind: 'stop', label: 'Stop', variant: 'outlined' };
    return {
      kind: 'start',
      label: 'Start',
      variant: 'primary',
      blocker: this.startBlocker(),
      waiting: this.busy(),
      tooltip: this.startTooltip(),
    };
  });

  // Frame rate (file slots).
  protected readonly hasFrameRate = computed(() => !this.isWebcam() && !this.held());
  protected readonly fpsDisabled = computed(
    () => !this.slot().file || !this.canStream() || this.slot().codec === 'mjpeg',
  );
  /** Also while the slot is busy: a commit posts the file the slot has, and must not race a change. */
  protected readonly fpsLocked = computed(
    () => this.playing() || this.encode() !== null || this.busy(),
  );
  /** Why the rate cannot be changed, said under the stepper (#170 put it in a tooltip). */
  protected readonly fpsReason = computed(() => {
    const slot = this.slot();
    if (!slot.file) return 'Assign media before choosing a frame rate';
    if (slot.codec === 'mjpeg') return 'FPS changes are not supported for MJPEG sources';
    if (this.playing()) return 'Stop the source to change its frame rate';
    return null;
  });
  protected readonly nativeRate = computed(() =>
    isNativeRate(this.slot().fps, this.slot().native_fps),
  );
  protected readonly nativeLabel = computed(() => {
    const native = this.slot().native_fps;
    return native != null ? `Native (${native} fps)` : 'Native';
  });
  protected readonly renditionHint = computed(() => {
    const native = this.slot().native_fps;
    return native != null
      ? `Native ${native} fps. A different rate creates a rendition on start.`
      : 'A rate other than the native one creates a rendition on start.';
  });

  // Transport (MJPEG files only, where the server allows RTSP or HTTP).
  protected readonly transportOptions = computed<NeatSelectOption<SlotTransport>[]>(() =>
    this.slot().allowed_transports.map((value) => ({ value, label: TRANSPORT_LABELS[value] })),
  );
  protected readonly transport = computed<SlotTransport | null>(
    () => this.slot().transport || null,
  );

  // The file form.
  protected readonly fileDetail = computed(() => {
    const slot = this.slot();
    if (!slot.file) return 'Not assigned';
    return slot.native_fps != null ? `${slot.file} · ${slot.native_fps} fps` : slot.file;
  });

  // The camera form.
  protected readonly cameraKey = (camera: Camera): string => camera.deviceId;
  protected readonly pickedCameraItem = computed(
    () => this.cameras.cameras().find((camera) => camera.deviceId === this.pickedCamera()) ?? null,
  );
  protected readonly accessLabel = computed(() => {
    if (this.cameras.state() === 'requesting') return 'Requesting…';
    return this.cameras.cameras().length > 0 ? 'Refresh cameras' : 'Enable camera access';
  });
  protected readonly canAssignCamera = computed(() => {
    const picked = this.pickedCamera();
    return !this.busy() && picked !== null && picked !== this.camera()?.deviceId;
  });

  // The stream URL form.
  protected readonly canPull = computed(
    () => STREAM_URL.test(this.url().trim()) && !this.isWebcam() && !this.busy(),
  );

  // Details.
  protected readonly output = computed(() => slotOutput(this.slot()));
  /** The rendition a playing file slot streams, when it is not the file itself. */
  protected readonly streamingRendition = computed(() => {
    const slot = this.slot();
    return slot.state === 'playing' && slot.active_file && slot.active_file !== slot.file
      ? slot.active_file
      : null;
  });
  protected readonly renditionPending = computed(() => {
    const slot = this.slot();
    return (
      !this.streamingRendition() &&
      slot.state !== 'playing' &&
      this.encode() === null &&
      slot.fps != null &&
      slot.native_fps != null &&
      slot.fps !== slot.native_fps
    );
  });
  protected readonly streamUrl = computed(() => streamUrl(this.slot()));
  /** A held slot has a stream to copy whatever its assignment; otherwise it needs a codec. */
  protected readonly canCopy = computed(
    () => this.streamUrl() !== null && (this.held() || this.canStream()),
  );
  protected readonly readers = computed(() =>
    this.slot().readers === undefined ? null : readersText(this.slot().readers),
  );
  /** The publisher or pull holding the slot, as #170's table showed it. */
  protected readonly holder = computed(() => {
    const slot = this.slot();
    const stream =
      slot.state === 'external' ? slot.external : slot.state === 'pulled' ? slot.pull : undefined;
    if (!stream) return null;
    const dimensions = dimensionsText(stream);
    const showWarning = slot.state === 'external' || slot.pull?.status === 'live';
    return {
      // A pull names no codec until it is live: "-", as the list says.
      video: `${slotCodec(slot)}${dimensions ? ` · ${dimensions}` : ''}`,
      warning:
        showWarning && !stream.codec_supported
          ? `${codecLabel(slot.codec)} cannot be decoded by Neat video pipelines (expects H.264, H.265 or MJPEG). Readers can connect, but decoding will fail.`
          : null,
      // Recomputed with each poll answer, every 2 s, which is when #170 ticked it too.
      liveFor: liveFor(stream.since, Date.now()),
      bitrate: formatBitrate(stream.bitrate_bps),
    };
  });
  protected readonly publisher = computed(() => {
    const external = this.slot().external;
    return external ? `${protocolLabel(external.protocol)} · ${external.address || '-'}` : null;
  });
  protected readonly pullSource = computed(() => {
    const pull = this.slot().pull;
    return pull ? pullSourceText(pull) : null;
  });
  protected readonly pullStatus = computed(() => {
    const pull = this.slot().pull;
    return pull ? `${pullStatusLabel(pull)}${pull.error ? ` · ${pull.error}` : ''}` : null;
  });

  // Actions.

  /** The main action's button. A press while it waits does nothing. */
  protected async runAction(): Promise<void> {
    const action = this.action();
    if (action.waiting || action.blocker !== null) return;
    switch (action.kind) {
      case 'start':
        return this.start();
      case 'stop':
      case 'stopPulling':
        return this.stop();
      case 'cancel':
        return this.cancelEncoding();
      case 'takeOver':
        return this.takeOver();
    }
  }

  private async start(): Promise<void> {
    const index = this.index();
    await this.act(async () => {
      if ((await this.control.start(index)) === 'cancelled') {
        this.toasts.status(`Cancelled encoding for src${index}.`);
      }
    });
  }

  private async stop(): Promise<void> {
    const index = this.index();
    const webcam = this.isWebcam();
    // A webcam is this browser's to end; the cameras service stops it bound to its session.
    await this.act(() =>
      this.control.run<unknown>(index, () =>
        webcam ? this.cameras.release(index) : this.slots.stop({ index }),
      ),
    );
  }

  private cancelEncoding(): void {
    this.control.cancelEncoding(this.index());
  }

  private async takeOver(): Promise<void> {
    const slot = this.slot();
    const name = `src${slot.index}`;
    const confirmed = await this.confirm.ask({
      title: `Disconnect external stream on ${name}?`,
      // #170's dialog: the publisher's chip, its readers, and what disconnecting does.
      message: `${slot.external ? `${externalChip(slot.external)}. ` : ''}Readers: ${readersText(slot.readers)}. The publisher and all readers will be disconnected. ${name} becomes Idle and you can assign a file to it.`,
      confirmLabel: 'Disconnect',
      tone: 'danger',
    });
    if (!confirmed) return;
    await this.act(async () => {
      await this.control.run(slot.index, () => this.slots.takeOver(slot.index));
      this.toasts.status(`Disconnected the external stream on ${name}.`);
    });
  }

  protected openPicker(): void {
    this.dialogs.open(this.pickerTemplate(), {
      title: `Source for src${this.index()}`,
      size: 'large',
    });
  }

  /** The picker's Assign: the dialog closes once the file is assigned, and stays for a retry if not. */
  protected async assignPicked(dialog: NeatDialogRef, file: string): Promise<void> {
    const index = this.index();
    this.pickerBusy.set(true);
    dialog.setDismissible(false);
    try {
      await this.control.run(index, () => this.cameras.assignFile({ index, file }));
      dialog.close();
    } catch (failure) {
      this.toasts.error(messageOf(failure));
    } finally {
      this.pickerBusy.set(false);
      dialog.setDismissible(true);
    }
  }

  /**
   * Unassigns the slot (`file: ''`), ending this browser's webcam on it first. There is nothing to
   * clear afterwards, so the focus goes on to Change… (or, from the camera form, the main action).
   */
  protected async clear(): Promise<void> {
    const index = this.index();
    const cleared = await this.act(() =>
      this.control.run(index, () => this.cameras.assignFile({ index, file: '' })),
    );
    if (cleared) this.focusAfterRender(() => this.changeButton() ?? this.primaryButton());
  }

  protected async requestCameraAccess(): Promise<void> {
    await this.cameras.requestAccess();
  }

  protected selectCamera(camera: Camera | null): void {
    this.pickedCamera.set(camera?.deviceId ?? null);
  }

  protected async assignCamera(): Promise<void> {
    const deviceId = this.pickedCamera();
    if (deviceId === null) return;
    const index = this.index();
    const assigned = await this.act(() =>
      this.control.run(index, () => this.cameras.assign(index, deviceId)),
    );
    // What comes next for a camera picked is starting it.
    if (assigned) this.focusAfterRender(() => this.primaryButton());
  }

  protected async pull(): Promise<void> {
    if (!this.canPull()) return;
    const index = this.index();
    this.pulling.set(true);
    this.pullError.set(null);
    try {
      const pulled = await this.control.run(index, () =>
        this.slots.pull({
          index,
          url: this.url().trim(),
          username: this.username().trim(),
          password: this.password(),
        }),
      );
      // A credential is kept no longer than it is needed.
      this.password.set('');
      // Named from the server's record, which carries no credentials, never from the typed URL.
      if (pulled.pull) {
        this.toasts.status(`src${index} is pulling from ${pullSourceText(pulled.pull)}.`);
      }
      // The form goes with the pull; its main action, Stop pulling, stays.
      this.focusAfterRender(() => this.primaryButton());
    } catch (failure) {
      this.pullError.set(messageOf(failure));
      this.toasts.error(messageOf(failure));
    } finally {
      this.pulling.set(false);
    }
  }

  protected async commitFps(fps: number | null): Promise<void> {
    const result = await this.control.commitFps(this.slot(), fps);
    // Refused (and reported): the field shows the rate the slot still has.
    if (!result.ok) this.stepper()?.reset();
  }

  protected setFpsInvalid(invalid: boolean): void {
    this.fpsInvalid.set(invalid);
  }

  protected async setTransport(transport: SlotTransport | null): Promise<void> {
    const slot = this.slot();
    if (transport === null || transport === slot.transport) return;
    await this.act(() =>
      this.control.run(slot.index, () =>
        this.slots.assign({ index: slot.index, file: slot.file, transport }),
      ),
    );
  }

  protected async copyUrl(): Promise<void> {
    const url = this.streamUrl();
    if (url === null) return;
    try {
      // Absent outside a secure context; refused when the browser denies the permission.
      if (!this.clipboard) throw new Error(COPY_REFUSED);
      await this.clipboard.writeText(url);
      this.toasts.status(`Copied: ${url}`);
    } catch {
      this.toasts.error(COPY_REFUSED);
    }
  }

  /** Runs an action and shows a refusal as the server words it; resolves whether it went through. */
  private async act(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (failure) {
      this.toasts.error(messageOf(failure));
      return false;
    }
  }

  /**
   * Moves the focus once the page shows what the action changed: the target may be disabled
   * until then (while the slot was busy), and a disabled button takes no focus.
   */
  private focusAfterRender(target: () => ElementRef<HTMLElement> | undefined): void {
    afterNextRender({ read: () => target()?.nativeElement.focus() }, { injector: this.injector });
  }
}
