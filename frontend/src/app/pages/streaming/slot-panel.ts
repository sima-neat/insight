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
import { NeatColumn, NeatSelectList } from '@sima/neat-ui/select-list';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { Slot } from '../../api.generated';
import { copyText } from '../../clipboard';
import { PanelTitle } from '../../panel-title';
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
  codecWarning,
  dimensionsText,
  externalChip,
  formatBitrate,
  isLive,
  isRunning,
  liveFor,
  protocolLabel,
  pullSourceText,
  pullStatusLabel,
  readersText,
  slotCodec,
  type SlotRow,
  slotOutput,
} from '../../sources/slot-row';
import { messageOf } from '../../sources/api-errors';
import { type EmptySourceForm, SourcesSession } from '../sources-session';

/** Which form the source switch shows. */
type SourceForm = 'file' | 'camera' | 'url';

const SOURCE_FORMS: NeatSegmentedOption<SourceForm>[] = [
  { value: 'file', label: 'File' },
  { value: 'camera', label: 'Camera' },
  { value: 'url', label: 'Stream URL' },
];

/** A pull accepts RTSP and RTSPS URLs only. */
const STREAM_URL = /^rtsps?:\/\//i;

const COPY_REFUSED = 'Could not copy the URL: the browser refused access to the clipboard.';

/** The slot's main action, one button whatever it is (see the template). */
interface PrimaryAction {
  readonly kind: 'start' | 'stop' | 'cancel' | 'takeOver';
  readonly label: string;
  readonly variant: NeatButtonVariant;
  /**
   * The glyph before the label, for the actions that start or end a stream; a start that waits
   * spins.
   */
  readonly icon: NeatIconName | null;
  /** Why the action cannot be taken at all; the button is then disabled. */
  readonly blocker: string | null;
  /** The action waits for something in flight: the button stays focusable, and a press does nothing. */
  readonly waiting: boolean;
  readonly tooltip: string | null;
}

/** A URL the slot is reached at, as the details list it with its Copy. */
interface StreamUrl {
  readonly label: string;
  readonly url: string;
  /** The Copy button's accessible name. */
  readonly copyLabel: string;
}

let nextPanelId = 0;

/**
 * The form for what the slot holds: a pull its URL, a webcam its camera, a file its file. An empty
 * slot holds nothing, so it shows the form it was left on.
 */
function formFor(slot: Slot, left: EmptySourceForm | undefined): SourceForm {
  switch (slot.kind) {
    case 'pull':
      return 'url';
    case 'webcam':
      return 'camera';
    case 'file':
      return 'file';
    default:
      return left ?? 'file';
  }
}

/**
 * The Streaming page's side panel for the selected slot. From the top:
 *
 * - the slot and its state, and its live preview (`SlotPreview`);
 * - its actions: Start and Stop, for a file, a webcam and a pulled camera alike (a stopped pull
 *   keeps its camera, and Start pulls again); Cancel encoding while a rendition encodes; "Take
 *   over…" for an external publisher;
 * - the source switch, File / Camera / Stream URL, which applies at once on a stopped slot (Camera
 *   makes it a webcam, File and Stream URL clear what it had) and asks first on a live one, whose
 *   stream it stops. A camera is assigned by clicking it, a pull by its form; each form's Clear
 *   leaves the slot with nothing assigned;
 * - the output frame rate of a file slot;
 * - the details: output, URLs with Copy, live for, bitrate, readers, publisher or camera, and why
 *   the slot failed.
 *
 * Every assignment from here goes through `CamerasService`, which ends this browser's
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
  protected readonly n = computed(() => this.slot().n);
  protected readonly sourceForms = SOURCE_FORMS;

  /** The form for what the slot holds now, or for the one an empty slot was left on. */
  private readonly slotForm = computed(() =>
    formFor(this.slot(), this.session.emptyForm(this.n())),
  );
  /** The form shown: the slot's, and the one a switch is changing to until the slot shows it. */
  protected readonly form = linkedSignal(this.slotForm);

  // What belongs to this slot alone starts afresh when the slot changes.
  protected readonly url = linkedSignal({ source: this.n, computation: () => '' });
  protected readonly username = linkedSignal({ source: this.n, computation: () => '' });
  protected readonly password = linkedSignal({ source: this.n, computation: () => '' });
  /**
   * The last pull's refusal, shown under the form, where the credentials are typed again, as well
   * as in a toast.
   */
  protected readonly pullError = linkedSignal<number, string | null>({
    source: this.n,
    computation: () => null,
  });
  private readonly fpsInvalid = linkedSignal({ source: this.n, computation: () => false });
  /** The camera assigned to this slot, by id: it changes only with this slot's assignment. */
  private readonly assignedCameraId = computed(
    () => this.cameras.assignments().get(this.n())?.deviceId ?? null,
  );
  protected readonly pulling = signal(false);
  protected readonly pickerBusy = signal(false);

  /** The slot is changing, or an action of this panel on it is in flight: its controls wait. */
  protected readonly busy = computed(
    () => this.control.busy().has(this.n()) || this.cameras.changingSlots().has(this.n()),
  );
  /** A start of this slot is in flight: the slot's state says Starting…. */
  private readonly starting = computed(() => this.control.starting().has(this.n()));
  protected readonly encode = computed(() => this.slots.encodes().get(this.n()) ?? null);
  protected readonly localStream = computed(
    () => this.cameras.localStreams().get(this.n()) ?? null,
  );
  protected readonly camera = computed<Camera | null>(
    () => this.cameras.assignments().get(this.n()) ?? null,
  );
  /** An external publisher holds the slot, over whatever is assigned under it. */
  protected readonly held = computed(() => this.slot().state === 'external');
  protected readonly isWebcam = computed(() => this.slot().kind === 'webcam');
  protected readonly isFile = computed(() => this.slot().kind === 'file');
  protected readonly running = computed(() => isRunning(this.slot()));
  /** A pull that came back from a restart without its credentials, which Insight never keeps. */
  protected readonly needsUrl = computed(() => this.slot().pull?.status === 'needs_credentials');

  // Start.
  protected readonly startBlocker = computed<string | null>(() => {
    switch (this.slot().kind) {
      case 'none':
        return 'Assign a source first';
      case 'webcam':
        return this.camera() ? null : 'Select a webcam first';
      case 'pull':
        return this.needsUrl() ? 'Enter the stream URL again first' : null;
      default:
        return this.fpsInvalid() ? 'FPS must be a whole number of at least 1' : null;
    }
  });
  protected readonly startTooltip = computed(() => {
    const camera = this.camera();
    if (this.startBlocker()) return this.startBlocker();
    return this.isWebcam() && camera ? `Start publishing ${camera.label}` : `Start src${this.n()}`;
  });

  protected readonly action = computed<PrimaryAction>(() => {
    const plain = { blocker: null, waiting: this.busy(), tooltip: null };
    if (this.held()) {
      return { ...plain, kind: 'takeOver', label: 'Take over…', variant: 'danger', icon: null };
    }
    if (this.encode()) {
      return {
        ...plain,
        kind: 'cancel',
        label: 'Cancel encoding',
        variant: 'outlined',
        icon: null,
      };
    }
    if (this.running()) {
      return { ...plain, kind: 'stop', label: 'Stop', variant: 'danger', icon: 'stop' };
    }
    // The glyph turns while a start waits, not for any other change of the slot; the button keeps
    // its name, and the template says it is busy.
    return {
      kind: 'start',
      label: 'Start',
      variant: 'success',
      icon: this.starting() ? 'spinner' : 'play',
      blocker: this.startBlocker(),
      waiting: this.busy() || this.starting(),
      tooltip: this.startTooltip(),
    };
  });

  // Frame rate (file slots).
  protected readonly fpsDisabled = computed(
    () => !this.slot().file || this.slot().codec === 'mjpeg',
  );
  /** Also while the slot is busy: a commit posts the file the slot has, and must not race a change. */
  protected readonly fpsLocked = computed(
    () => this.running() || this.encode() !== null || this.busy(),
  );
  /** Why the rate cannot be changed, said under the stepper. */
  protected readonly fpsReason = computed(() => {
    const slot = this.slot();
    if (!slot.file) return 'Assign media before choosing a frame rate';
    if (slot.codec === 'mjpeg') return 'FPS changes are not supported for MJPEG sources';
    if (this.running()) return 'Stop the source to change its frame rate';
    return null;
  });
  protected readonly nativeRate = computed(() => customRate(this.slot()) === null);
  protected readonly nativeLabel = computed(() => {
    const native = this.slot().native_fps;
    return native !== undefined ? `Native (${native} fps)` : 'Native';
  });
  protected readonly renditionHint = computed(() => {
    const native = this.slot().native_fps;
    return native !== undefined
      ? `Native ${native} fps. A different rate creates a rendition on start.`
      : 'A rate other than the native one creates a rendition on start.';
  });

  // The file form.
  protected readonly fileDetail = computed(() => {
    const slot = this.slot();
    if (!slot.file) return 'Not assigned';
    return slot.native_fps !== undefined ? `${slot.file} · ${slot.native_fps} fps` : slot.file;
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
  /** The rendition a running file slot streams, when it is not the file itself. */
  protected readonly streamingRendition = computed(() => {
    const slot = this.slot();
    return slot.kind === 'file' && slot.active_file && slot.active_file !== slot.file
      ? slot.active_file
      : null;
  });
  protected readonly renditionPending = computed(() => {
    const slot = this.slot();
    return (
      slot.kind === 'file' &&
      !this.streamingRendition() &&
      !this.running() &&
      this.encode() === null &&
      customRate(slot) !== null
    );
  });
  /** Where readers open the slot: always its RTSP URL, and its HTTP MJPEG one for an MJPEG stream. */
  protected readonly streamUrls = computed((): readonly StreamUrl[] => {
    const { n, urls } = this.slot();
    const rtsp: StreamUrl = {
      label: 'URL',
      url: urls.rtsp,
      copyLabel: `Copy stream URL for src${n}`,
    };
    return urls.http_mjpeg
      ? [rtsp, { label: 'HTTP', url: urls.http_mjpeg, copyLabel: `Copy HTTP URL for src${n}` }]
      : [rtsp];
  });
  protected readonly readers = computed(() => readersText(this.slot().readers));
  /** The publisher or the pulled camera holding the slot. */
  protected readonly holder = computed(() => {
    const slot = this.slot();
    if (!this.held() && slot.kind !== 'pull') return null;
    const publisher = slot.publisher;
    const dimensions = publisher ? dimensionsText(publisher) : '';
    return {
      // A pull names no codec until it is live: "-", as the list says.
      video: `${slotCodec(slot)}${dimensions ? ` · ${dimensions}` : ''}`,
      warning: codecWarning(slot),
      // Recomputed with each poll answer, every 2 s.
      liveFor: liveFor(publisher?.since, Date.now()),
      bitrate: formatBitrate(publisher?.bitrate_bps),
    };
  });
  protected readonly publisher = computed(() => {
    const publisher = this.slot().publisher;
    return this.held() && publisher
      ? `${protocolLabel(publisher.protocol)} · ${publisher.address || '-'}`
      : null;
  });
  protected readonly pullSource = computed(() => {
    const pull = this.slot().pull;
    return pull ? pullSourceText(pull) : null;
  });
  protected readonly pullStatus = computed(() => {
    const pull = this.slot().pull;
    return pull ? `${pullStatusLabel(pull)}${pull.error ? ` · ${pull.error}` : ''}` : null;
  });
  /** Why a file or webcam slot failed; a pull says it in its status. */
  protected readonly problem = computed(() => {
    const slot = this.slot();
    return slot.kind !== 'pull' ? (slot.error ?? null) : null;
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
        return this.stop();
      case 'cancel':
        return this.cancelEncoding();
      case 'takeOver':
        return this.takeOver();
    }
  }

  private async start(): Promise<void> {
    const n = this.n();
    await this.act(() => this.control.start(n));
  }

  private async stop(): Promise<void> {
    const slot = this.slot();
    await this.act(() => this.control.run<unknown>(slot.n, () => this.endStream(slot)));
  }

  /** A webcam this browser publishes lets go of its camera too. */
  private endStream(slot: Slot): Promise<unknown> {
    return slot.kind === 'webcam' ? this.cameras.release(slot.n) : this.slots.stop(slot.n);
  }

  private async cancelEncoding(): Promise<void> {
    const n = this.n();
    const cancelled = await this.act(() => this.control.cancelEncoding(n));
    if (cancelled) this.toasts.status(`Cancelled encoding for src${n}.`);
  }

  private async takeOver(): Promise<void> {
    const slot = this.slot();
    const name = `src${slot.n}`;
    const confirmed = await this.confirm.ask({
      title: `Disconnect external stream on ${name}?`,
      // The publisher's chip, its readers, and what disconnecting does.
      message: `${slot.publisher ? `${externalChip(slot.publisher)}. ` : ''}Readers: ${readersText(slot.readers)}. The publisher and all readers will be disconnected, and ${name} goes back to what it is assigned.`,
      confirmLabel: 'Disconnect',
      tone: 'danger',
    });
    if (!confirmed) return;
    await this.act(async () => {
      await this.control.run(slot.n, () => this.slots.takeOver(slot.n));
      this.toasts.status(`Disconnected the external stream on ${name}.`);
    });
  }

  protected openPicker(): void {
    this.dialogs.open(this.pickerTemplate(), {
      title: `Source for src${this.n()}`,
      size: 'large',
    });
  }

  /**
   * The picker's Import…: the import dialog opens over the picker, and what it saved is shown in
   * the picker, picked, ready to assign.
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
    const n = this.n();
    this.pickerBusy.set(true);
    dialog.setDismissible(false);
    try {
      await this.control.run(n, () => this.cameras.assignFile(n, file));
      dialog.close();
    } catch (failure) {
      this.toasts.error(messageOf(failure));
    } finally {
      this.pickerBusy.set(false);
      dialog.setDismissible(true);
    }
  }

  /**
   * Leaves the slot with nothing assigned: its file, or its pulled camera. The slot then shows the
   * form it was cleared from, and the focus goes on to what assigns it again.
   */
  protected async clear(): Promise<void> {
    const n = this.n();
    const form = this.form();
    if (form !== 'camera') this.session.rememberEmptyForm(n, form);
    const cleared = await this.act(() => this.control.run(n, () => this.cameras.clear(n)));
    if (cleared && form === 'file') this.focusAfterRender(() => this.changeButton());
  }

  protected async requestCameraAccess(): Promise<void> {
    await this.cameras.requestAccess();
  }

  /**
   * Switches the slot to the form clicked. A stopped slot changes at once; a live one is asked
   * first, and Cancel changes nothing. A refusal leaves the slot as it was. While the slot is busy
   * a click is ignored, so no second change races the first: the switch is not disabled for it,
   * which dimmed it at every change, and shows again the form it showed before the click.
   */
  protected async switchSource(target: SourceForm): Promise<void> {
    if (this.busy()) return this.showForm(this.form());
    const from = this.slotForm();
    const asked = this.slot();
    this.showForm(target);
    if (target === from) return;
    if (isLive(asked)) {
      const confirmed = await this.confirmStop(asked, target);
      // The slot may have changed while the question was open (stopped, taken over, switched by
      // another tab); the answer was about the slot as it was, so it then changes nothing.
      if (!confirmed || this.slotChangedSince(asked, from)) return this.showForm(this.slotForm());
    }
    const slot = this.slot();
    const switched = await this.act(() =>
      this.control.run(slot.n, () => this.applyForm(slot, target)),
    );
    if (!switched) return this.showForm(this.slotForm());
    // Remembered once it took, so that a refusal leaves what the empty slot was left on.
    if (target !== 'camera') this.session.rememberEmptyForm(slot.n, target);
  }

  /** Whether the slot is another one, or shows another form or a hold, than when asked about. */
  private slotChangedSince(asked: Slot, form: SourceForm): boolean {
    return this.slot().n !== asked.n || this.slotForm() !== form || this.held();
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
    const name = `src${slot.n}`;
    const label = SOURCE_FORMS.find((option) => option.value === target)!.label;
    const lost =
      slot.kind === 'webcam' ? 'camera' : slot.kind === 'pull' ? 'stream URL' : slot.file;
    return this.confirm.ask({
      title: `Stop ${name}?`,
      message: `Switching to ${label} stops ${name} and removes its ${lost}.`,
      confirmLabel: 'Stop and switch',
      tone: 'danger',
    });
  }

  /**
   * What the switch changes on the server: Camera makes the slot a webcam with no camera, which
   * the list then picks; File and Stream URL clear what the slot holds, which a live slot's
   * stream stops with. An empty slot switched to File or Stream URL has nothing to change.
   */
  private async applyForm(slot: Slot, target: SourceForm): Promise<void> {
    if (target === 'camera') await this.cameras.assign(slot.n, null);
    else if (slot.kind !== 'none') await this.cameras.clear(slot.n);
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
    const n = this.n();
    const live = this.isWebcam() && isLive(this.slot());
    const done = await this.act(() =>
      this.control.run(n, async () => {
        await this.cameras.assign(n, camera.deviceId);
        if (live) await this.control.start(n);
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

  /**
   * Makes the slot pull the camera typed in, replacing what it had. The server checks the camera
   * first: one that refuses the credentials or does not answer is not assigned.
   */
  protected async pull(): Promise<void> {
    if (!this.canPull()) return;
    const n = this.n();
    this.pulling.set(true);
    this.pullError.set(null);
    try {
      const pulled = await this.control.run(n, () =>
        this.cameras.assignPull(n, {
          url: this.url().trim(),
          username: this.username().trim(),
          password: this.password(),
        }),
      );
      // A credential is kept no longer than it is needed, and the form is done with.
      this.url.set('');
      this.username.set('');
      this.password.set('');
      // Named from the server's record, which carries no credentials, never from the typed URL.
      if (pulled.pull) {
        this.toasts.status(`src${n} is pulling from ${pullSourceText(pulled.pull)}.`);
      }
      // The pull runs at once; what comes next is its main action, Stop.
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

  protected async copyUrl(url: string): Promise<void> {
    try {
      await copyText(url);
      this.toasts.status(`Copied: ${url}`);
    } catch {
      this.toasts.error(COPY_REFUSED);
    }
  }

  /**
   * Runs an action and shows a refusal as the server words it; resolves whether it went through.
   */
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
