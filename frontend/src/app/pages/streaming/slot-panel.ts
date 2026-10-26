import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  Injector,
  input,
  linkedSignal,
  signal,
  type TemplateRef,
  viewChild,
} from '@angular/core';
import {
  NeatAsideActions,
  NeatAsideHeading,
  NeatAsidePanel,
  NeatButton,
  NeatCode,
  NeatIcon,
  NeatInlineButton,
  NeatNote,
  NeatTooltip,
  type NeatButtonVariant,
  type NeatIconName,
} from '@sima/neat-ui';
import { NeatConfirm } from '@sima/neat-ui/confirm';
import { NeatDetails } from '@sima/neat-ui/details';
import { NeatDialog, type NeatDialogRef } from '@sima/neat-ui/dialog';
import { NeatErrorNote, NeatField } from '@sima/neat-ui/field';
import { NeatInput } from '@sima/neat-ui/input';
import { NeatProgress } from '@sima/neat-ui/progress';
import { NeatSegmented, type NeatSegmentedOption } from '@sima/neat-ui/segmented';
import { NeatSelect, type NeatSelectOption } from '@sima/neat-ui/select';
import { NeatColumn, NeatSelectList } from '@sima/neat-ui/select-list';
import { NeatToasts } from '@sima/neat-ui/toast';
import { copyText } from '../../clipboard';
import { holdFocus } from '../../hold-focus';
import { PanelTitle } from '../../panel-title';
import type { Slot, SlotTransport } from '../../sources/api';
import { CamerasService } from '../../sources/cameras.service';
import { ImportDialogs } from '../../sources/import-dialog';
import { customRate } from '../../sources/fps';
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
  isLive,
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
import { messageOf } from '../../sources/stream-lines';
import { type EmptySourceForm, SourcesSession } from '../sources-session';

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
  /** The glyph before the label, for the actions that start or end a stream. */
  readonly icon: NeatIconName | null;
  /** Why the action cannot be taken at all; the button is then disabled. */
  readonly blocker: string | null;
  /** The action waits for something in flight: the button stays focusable, and a press does nothing. */
  readonly waiting: boolean;
  readonly tooltip: string | null;
}

let nextPanelId = 0;

/**
 * The form for what the slot holds: a pull its URL, a webcam its camera, a file its file. An empty
 * slot holds nothing, so it shows the form it was left on.
 */
function formFor(slot: Slot, left: EmptySourceForm | undefined): SourceForm {
  if (slot.state === 'pulled') return 'url';
  if (slot.type === 'webcam') return 'camera';
  return slot.file ? 'file' : (left ?? 'file');
}

/**
 * The Streaming page's side panel for the selected slot (spec, "Streaming": the side panel; Inv-SM
 * §1.2's Source Preview and assign dialog, now in one place). From the top:
 *
 * - the slot and its state, and its live preview (`SlotPreview`);
 * - its actions: Start and Stop; Cancel encoding while a rendition encodes; "Take over…" for an
 *   external publisher; Stop pulling for a pull;
 * - the source switch, File / Camera / Stream URL, which applies at once on a stopped slot (Camera
 *   registers it as a webcam, File and Stream URL clear a webcam, Stream URL a file as well) and
 *   asks first on a live one, whose stream it stops. A camera is assigned by clicking it;
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
    NeatAsideActions,
    NeatAsideHeading,
    NeatButton,
    NeatCode,
    NeatColumn,
    NeatDetails,
    NeatErrorNote,
    NeatField,
    NeatIcon,
    NeatInlineButton,
    NeatInput,
    NeatNote,
    NeatProgress,
    NeatSegmented,
    NeatSelect,
    NeatSelectList,
    NeatTooltip,
    PanelTitle,
    SlotPreview,
  ],
  hostDirectives: [NeatAsidePanel],
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
  private readonly imports = inject(ImportDialogs);
  private readonly confirm = inject(NeatConfirm);
  private readonly session = inject(SourcesSession);
  private readonly toasts = inject(NeatToasts);
  private readonly injector = inject(Injector);

  private readonly pickerTemplate = viewChild.required<TemplateRef<unknown>>('picker');
  private readonly stepper = viewChild(FpsStepper);
  private readonly primaryButton = viewChild.required<ElementRef<HTMLButtonElement>>('primary');
  private readonly changeButton = viewChild<ElementRef<HTMLButtonElement>>('change');
  private readonly sourceSwitch = viewChild<NeatSegmented<SourceForm>>(NeatSegmented);
  private readonly cameraList = viewChild<NeatSelectList<Camera, string>>(NeatSelectList);

  protected readonly fpsReasonId = `slot-panel-${nextPanelId++}-fps-reason`;

  protected readonly slot = computed(() => this.row().slot);
  protected readonly index = computed(() => this.slot().index);
  protected readonly sourceForms = SOURCE_FORMS;

  /** The form for what the slot holds now, or for the one an empty slot was left on. */
  private readonly slotForm = computed(() =>
    formFor(this.slot(), this.session.emptyForm(this.index())),
  );
  /** The form shown: the slot's, and the one a switch is changing to until the slot shows it. */
  protected readonly form = linkedSignal(this.slotForm);

  // What belongs to this slot alone starts afresh when the slot changes.
  protected readonly url = linkedSignal({ source: this.index, computation: () => '' });
  protected readonly username = linkedSignal({ source: this.index, computation: () => '' });
  protected readonly password = linkedSignal({ source: this.index, computation: () => '' });
  /** The last pull's refusal, shown under the form (#170's dialog did) as well as in a toast. */
  protected readonly pullError = linkedSignal<number, string | null>({
    source: this.index,
    computation: () => null,
  });
  private readonly fpsInvalid = linkedSignal({ source: this.index, computation: () => false });
  /** The camera assigned to this slot, by id: it changes only with this slot's assignment. */
  private readonly assignedCameraId = computed(
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
        return { ...plain, kind: 'takeOver', label: 'Take over…', variant: 'danger', icon: null };
      case 'pulled':
        return {
          ...plain,
          kind: 'stopPulling',
          label: 'Stop pulling',
          variant: 'danger',
          icon: 'stop',
        };
    }
    if (this.encode()) {
      // Once the encode is over the start that follows it cannot be cancelled.
      return {
        ...plain,
        kind: 'cancel',
        label: 'Cancel encoding',
        variant: 'outlined',
        icon: null,
        waiting: !this.preparing(),
      };
    }
    if (this.playing()) {
      return { ...plain, kind: 'stop', label: 'Stop', variant: 'danger', icon: 'stop' };
    }
    return {
      kind: 'start',
      label: 'Start',
      variant: 'success',
      icon: 'play',
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
  protected readonly nativeRate = computed(() => customRate(this.slot()) === null);
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
  /** The list's selection is the assigned camera, when it is one the browser lists. */
  protected readonly assignedCamera = computed(
    () =>
      this.cameras.cameras().find((camera) => camera.deviceId === this.assignedCameraId()) ?? null,
  );
  protected readonly accessLabel = computed(() => {
    if (this.cameras.state() === 'requesting') return 'Requesting…';
    return this.cameras.cameras().length > 0 ? 'Refresh cameras' : 'Enable camera access';
  });

  // The stream URL form.
  protected readonly canPull = computed(() => STREAM_URL.test(this.url().trim()) && !this.busy());

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
      customRate(slot) !== null
    );
  });
  protected readonly streamUrl = computed(() => streamUrl(this.slot()));
  /**
   * Where a camera or a pulled stream goes out, for the hints: the slot's RTSP URL, with the
   * server's mapped port. Not `streamUrl`, which names the HTTP stream of an MJPEG file slot. The
   * path alone until the server has said the URL.
   */
  protected readonly rtspUrl = computed(
    () => this.slot().urls.rtsp ?? `rtsp://…/src${this.index()}`,
  );
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
    const slot = this.slot();
    await this.act(() => this.control.run<unknown>(slot.index, () => this.endStream(slot)));
  }

  /** A webcam is this browser's to end; the cameras service stops it bound to its session. */
  private endStream(slot: Slot): Promise<unknown> {
    return slot.type === 'webcam'
      ? this.cameras.release(slot.index)
      : this.slots.stop({ index: slot.index });
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

  /**
   * The picker's Import…: the import dialog opens over the picker, and what it saved is shown in
   * the picker, picked, ready to assign (ruling Q1).
   */
  protected async importInto(picker: MediaPicker): Promise<void> {
    const path = await this.imports.open();
    if (path === null) return;
    try {
      await picker.reveal(path);
    } catch (failure) {
      this.toasts.error(messageOf(failure));
    }
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
   * Unassigns the file (`file: ''`). There is nothing to clear afterwards, so the focus goes on to
   * Change….
   */
  protected async clear(): Promise<void> {
    const index = this.index();
    // An empty slot shows the File form, which is what a cleared one is.
    this.session.rememberEmptyForm(index, 'file');
    const cleared = await this.act(() =>
      this.control.run(index, () => this.cameras.assignFile({ index, file: '' })),
    );
    if (cleared) this.focusAfterRender(() => this.changeButton());
  }

  protected async requestCameraAccess(): Promise<void> {
    await this.cameras.requestAccess();
  }

  /**
   * Switches the slot to the form clicked. A stopped slot changes at once; a live one is asked
   * first, and Cancel changes nothing. A refusal leaves the slot as it was. The switch waits while
   * the slot is busy, so no second change races the first.
   */
  protected async switchSource(target: SourceForm): Promise<void> {
    const from = this.slotForm();
    const asked = this.slot();
    this.showForm(target);
    if (target === from) return;
    try {
      if (isLive(asked)) {
        const confirmed = await this.confirmStop(asked, target);
        // The slot may have changed while the question was open (stopped, taken over, switched by
        // another tab); the answer was about the slot as it was, so it then changes nothing.
        if (!confirmed || this.slotChangedSince(asked, from)) return this.showForm(this.slotForm());
      }
      const slot = this.slot();
      const switched = await this.act(() =>
        this.control.run(slot.index, async () => {
          if (isLive(slot)) await this.endStream(slot);
          await this.applyForm(slot, target);
        }),
      );
      if (!switched) return this.showForm(this.slotForm());
      // Remembered once it took, so that a refusal leaves what the empty slot was left on.
      if (target !== 'camera') this.session.rememberEmptyForm(slot.index, target);
    } finally {
      // The switch was disabled while the change ran, which drops the focus it had.
      holdFocus(this.injector, () => this.sourceSwitch());
    }
  }

  /** Whether the slot is another one, or shows another form or a hold, than when asked about. */
  private slotChangedSince(asked: Slot, form: SourceForm): boolean {
    return this.slot().index !== asked.index || this.slotForm() !== form || this.held();
  }

  /**
   * Shows a form in the content and in the switch, which holds the choice it was clicked to:
   * a binding writes nothing back to a switch whose value it did not change, so a choice taken
   * back is set on the switch itself.
   */
  private showForm(form: SourceForm): void {
    this.form.set(form);
    this.sourceSwitch()?.value.set(form);
  }

  private confirmStop(slot: Slot, target: SourceForm): Promise<boolean> {
    const name = `src${slot.index}`;
    const label = SOURCE_FORMS.find((option) => option.value === target)!.label;
    const lost = slot.type === 'webcam' ? 'camera' : slot.file;
    return this.confirm.ask({
      title: `Stop ${name}?`,
      message: `Switching to ${label} stops ${name} and removes its ${lost}.`,
      confirmLabel: 'Stop and switch',
      tone: 'danger',
    });
  }

  /**
   * What the switch changes on the server, for a slot that is stopped: Camera registers a webcam
   * with no camera, which the list then picks; File and Stream URL clear a webcam, and Stream URL
   * a file too. An empty slot, or a file slot switched to File, has nothing to change.
   */
  private async applyForm(slot: Slot, target: SourceForm): Promise<void> {
    const webcam = slot.type === 'webcam';
    switch (target) {
      case 'camera':
        if (!webcam) await this.cameras.assign(slot.index, null);
        return;
      case 'file':
        if (webcam) await this.cameras.assignFile({ index: slot.index, file: '' });
        return;
      case 'url':
        if (webcam || slot.file) await this.cameras.assignFile({ index: slot.index, file: '' });
        return;
    }
  }

  /**
   * A camera activated (a click, or Enter) is assigned; the arrow keys only move the list's cursor.
   * On a live webcam the stream goes on with the new camera: the old publish ends with the
   * assignment, and the slot is started again. The list waits for a change, so an activation then
   * is undone.
   */
  protected async activateCamera(camera: Camera): Promise<void> {
    const assigned = this.assignedCamera();
    if (camera.deviceId === assigned?.deviceId) return;
    if (this.busy()) return this.cameraList()?.selected.set(assigned);
    const index = this.index();
    const live = this.isWebcam() && this.playing();
    const done = await this.act(() =>
      this.control.run(index, async () => {
        await this.cameras.assign(index, camera.deviceId);
        if (live) await this.control.start(index);
      }),
    );
    // A refusal leaves the camera the slot had; the list goes back to it.
    this.cameraList()?.selected.set(this.assignedCamera());
    // What comes next for a camera picked is starting it (a live slot already runs).
    if (done) this.focusAfterRender(() => this.primaryButton());
  }

  /** Arrowing moves the list's selection; leaving the list puts the assigned camera back. */
  protected leaveCameras(event: FocusEvent): void {
    const list = event.currentTarget as HTMLElement;
    if (!list.contains(event.relatedTarget as Node | null)) {
      this.cameraList()?.selected.set(this.assignedCamera());
    }
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

  /**
   * Through `CamerasService.assignFile`, as every file assign from Streaming (Q7): the change holds
   * the bulk actions until it lands. (A frame-rate commit is the one exception; see `commitFps`.)
   */
  protected async setTransport(transport: SlotTransport | null): Promise<void> {
    const slot = this.slot();
    if (transport === null || transport === slot.transport) return;
    await this.act(() =>
      this.control.run(slot.index, () =>
        this.cameras.assignFile({ index: slot.index, file: slot.file, transport }),
      ),
    );
  }

  protected async copyUrl(): Promise<void> {
    const url = this.streamUrl();
    if (url === null) return;
    try {
      await copyText(url);
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
