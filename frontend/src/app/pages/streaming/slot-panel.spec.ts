import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, computed, inject, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatButton, NeatIcon, type NeatButtonVariant } from '@sima/neat-ui';
import { NeatDetails } from '@sima/neat-ui/details';
import { NeatSelect } from '@sima/neat-ui/select';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { MediaEntry, Slot } from '../../api.generated';
import { CamerasService, type CameraAccessState } from '../../sources/cameras.service';
import { ImportDialogs } from '../../sources/import-dialog';
import { MediaLibraryService } from '../../sources/media-library.service';
import { mediaFile, mediaFolder } from '../../sources/media.testing';
import type { Progress } from '../../sources/jobs';
import { slotRow } from '../../sources/slot-row';
import type { PullRequest } from '../../sources/slots.service';
import { SlotsService } from '../../sources/slots.service';
import { fileSlot, publisher, pull, slot, webcamSlot } from '../../sources/slots.testing';
import { ApiRequestError } from '../../sources/api-errors';
import { DEFAULT_WEBCAM_CAPTURE, type WebcamCapture } from '../../sources/webcam-capture';
import type { Camera } from '../../sources/webcam-publishing';
import { radioLabel } from '../../radio-label.testing';
import { SourcesSession } from '../sources-session';
import { SlotControl } from './slot-control';
import { SlotPanel } from './slot-panel';

/** A file slot ready to start: people/walk.mp4, H.264 at 30 fps. */
const walk = (n = 2, overrides: Partial<Slot> = {}) => fileSlot(n, 'people/walk.mp4', overrides);

/** A slot an external publisher holds. */
const external = (n: number, overrides: Partial<Slot> = {}) =>
  slot(n, {
    state: 'external',
    codec: 'h264',
    publisher: publisher({ address: '192.168.1.20' }),
    ...overrides,
  });

/** A slot that pulls a camera and has its stream. */
const pulled = (n: number, overrides: Partial<Slot> = {}) =>
  slot(n, {
    kind: 'pull',
    run: true,
    state: 'live',
    codec: 'h264',
    pull: pull(),
    publisher: publisher({ protocol: 'rtspSource', address: undefined, width: 1920, height: 1080 }),
    ...overrides,
  });

const ENCODING: Progress = { title: 'Encoding rendition…', detail: '', percent: null };

const CAMERAS: Camera[] = [
  { deviceId: 'd1', label: 'Desk camera' },
  { deviceId: 'd2', label: 'iPhone' },
];

class FakeSlots {
  readonly slots = signal<readonly Slot[] | null>([walk()]);
  readonly encodes = signal<ReadonlyMap<number, Progress>>(new Map());
  readonly assignFile = vi.fn<(n: number, file: string, fps?: number | null) => Promise<Slot>>(
    async (n) => this.of(n),
  );
  readonly start = vi.fn<(n: number) => Promise<Slot>>(async (n) => this.of(n));
  readonly stop = vi.fn<(n: number) => Promise<Slot>>(async (n) => this.of(n));
  readonly takeOver = vi.fn<(n: number) => Promise<Slot>>(async (n) => this.of(n));

  of(n: number): Slot {
    return this.slots()!.find((one) => one.n === n)!;
  }

  update(n: number, overrides: Partial<Slot>): void {
    this.slots.update((all) =>
      (all ?? []).map((one) => (one.n === n ? { ...one, ...overrides } : one)),
    );
  }

  /** The server answers with another slot `n` altogether: a new assignment. */
  replace(replacement: Slot): void {
    this.slots.update((all) =>
      (all ?? []).map((one) => (one.n === replacement.n ? replacement : one)),
    );
  }

  /** The server prepares the slot's rendition, as a start at another rate makes it. */
  prepare(n: number): void {
    this.update(n, { run: true, state: 'preparing', job: 'job-1' });
    this.encodes.set(new Map([[n, ENCODING]]));
  }
}

/** Like the real service, a change shows in the slots and in the cameras it remembers. */
class FakeCameras {
  readonly cameras = signal<readonly Camera[]>([]);
  readonly state = signal<CameraAccessState>('unknown');
  readonly error = signal<string | null>(null);
  readonly assignments = signal<ReadonlyMap<number, Camera>>(new Map());
  readonly captures = signal<ReadonlyMap<number, WebcamCapture>>(new Map());
  readonly localStreams = signal<ReadonlyMap<number, MediaStream>>(new Map());
  readonly changingSlots = signal<ReadonlySet<number>>(new Set());
  readonly anyChanging = computed(() => this.changingSlots().size > 0);
  readonly assign = vi.fn<(n: number, deviceId: string | null) => Promise<void>>(
    async (n, deviceId) => {
      this.slots.replace(webcamSlot(n));
      this.remember(n, this.cameras().find((camera) => camera.deviceId === deviceId) ?? null);
    },
  );
  readonly setCapture = vi.fn<(n: number, capture: WebcamCapture) => void>((n, capture) =>
    this.captures.set(new Map(this.captures()).set(n, capture)),
  );
  readonly assignFile = vi.fn<(n: number, file: string) => Promise<Slot>>(async (n) =>
    this.slots.of(n),
  );
  readonly assignPull = vi.fn<(n: number, request: PullRequest) => Promise<Slot>>();
  readonly clear = vi.fn<(n: number) => Promise<Slot>>(async (n) => this.slots.of(n));
  readonly publish = vi.fn<(n: number) => Promise<void>>(async () => undefined);
  readonly release = vi.fn<(n: number) => Promise<void>>(async () => undefined);
  readonly requestAccess = vi.fn(async () => {
    this.state.set('granted');
    this.cameras.set(CAMERAS);
  });

  constructor(private readonly slots: FakeSlots) {}

  captureOf(n: number): WebcamCapture {
    return this.captures().get(n) ?? DEFAULT_WEBCAM_CAPTURE;
  }

  /**
   * Makes clearing and stopping show in the slots, as the server's answers do on the next read;
   * the specs that only count calls leave the slots alone.
   */
  followTheServer(): void {
    this.clear.mockImplementation(async (n) => {
      this.slots.replace(slot(n));
      this.remember(n, null);
      return this.slots.of(n);
    });
    this.release.mockImplementation(async (n) =>
      this.slots.update(n, { state: 'idle', run: false }),
    );
  }

  private remember(n: number, camera: Camera | null): void {
    const next = new Map(this.assignments());
    if (camera) next.set(n, camera);
    else next.delete(n);
    this.assignments.set(next);
  }
}

class FakeLibrary {
  readonly tree = signal<readonly MediaEntry[] | null>([
    mediaFolder('people', [mediaFile('people/walk.mp4'), mediaFile('people/run.mp4')]),
  ]);
  readonly refresh = vi.fn(async () => undefined);
}

/** The page's way of showing the panel: the selected slot's row, rebuilt from every answer. */
@Component({
  imports: [SlotPanel],
  template: `<app-slot-panel [row]="row()" />`,
})
class Host {
  private readonly slots = inject(SlotsService);
  private readonly cameras = inject(CamerasService);
  private readonly control = inject(SlotControl);
  readonly n = signal(2);
  readonly row = computed(() => {
    const slot = this.slots.slots()!.find((one) => one.n === this.n())!;
    return slotRow(slot, {
      camera: this.cameras.assignments().get(slot.n),
      encode: this.slots.encodes().get(slot.n),
      starting: this.control.starting().has(slot.n),
    });
  });
}

describe('SlotPanel', () => {
  let slots: FakeSlots;
  let cameras: FakeCameras;
  let library: FakeLibrary;
  let toasts: { error: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
  let imports: { open: ReturnType<typeof vi.fn<() => Promise<string | null>>> };
  let fixture: ComponentFixture<Host>;
  let writeText: ReturnType<typeof vi.fn>;
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  beforeEach(() => {
    slots = new FakeSlots();
    cameras = new FakeCameras(slots);
    library = new FakeLibrary();
    toasts = { error: vi.fn(), status: vi.fn() };
    imports = { open: vi.fn<() => Promise<string | null>>() };
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    // Nor scrollIntoView, which the kit's select calls on its active option.
    Element.prototype.scrollIntoView = vi.fn();
    // jsdom has no ResizeObserver, which some of the kit's controls measure themselves with.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {
          // Nothing to measure in jsdom.
        }
        unobserve(): void {
          // Nothing observed.
        }
        disconnect(): void {
          // Nothing observed.
        }
      },
    );
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SlotsService, useValue: slots },
        { provide: CamerasService, useValue: cameras },
        { provide: MediaLibraryService, useValue: library },
        { provide: NeatToasts, useValue: toasts },
        { provide: ImportDialogs, useValue: imports },
      ],
    });
  });

  afterEach(() => {
    // Dialogs live in an overlay outside the fixture.
    fixture?.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  async function open(n = 2): Promise<void> {
    fixture = TestBed.createComponent(Host);
    fixture.componentInstance.n.set(n);
    await settle();
  }

  /** Lets an overlay open or close and promise chains run: it renders, then moves focus. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 3; turn++) {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    }
  }

  const root = (): HTMLElement => fixture.nativeElement;
  const text = (element: Element = root()) => element.textContent!.replace(/\s+/g, ' ').trim();
  const buttonIn = (scope: ParentNode, label: string): HTMLButtonElement | undefined =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === label,
    );
  const button = (label: string) => buttonIn(root(), label);
  const sourceKind = (label: string) =>
    [...root().querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (radio) => radioLabel(radio) === label,
    )!;
  const field = (label: string) =>
    [...root().querySelectorAll<HTMLInputElement>('input')].find(
      (input) =>
        input.getAttribute('aria-label') === label ||
        input.closest('neat-field label')?.firstChild?.textContent?.trim() === label,
    )!;
  const dialog = () => document.querySelector<HTMLElement>('neat-dialog-panel');
  const confirmDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const details = (): Record<string, string> => {
    const values: Record<string, string> = {};
    // The kit's details list.
    const list: HTMLElement = fixture.debugElement.query(By.directive(NeatDetails)).nativeElement;
    for (const term of list.querySelectorAll('dt')) {
      values[text(term)] = text(term.nextElementSibling!);
    }
    return values;
  };
  /** The encode's readout: the kit's titled progress. */
  const encodeStatus = () => root().querySelector('[data-slot="progress-readout"]');
  /** The readout's title line: the title, then the percent. */
  const encodeTitle = () =>
    [...encodeStatus()!.querySelector('[data-slot="progress-title"]')!.children]
      .map((part) => text(part))
      .join(' ');

  async function click(element: HTMLElement | undefined): Promise<void> {
    expect(element, 'the element to click').toBeDefined();
    element!.click();
    await settle();
  }

  async function type(input: HTMLInputElement, value: string): Promise<void> {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  }

  function sentNothing(): void {
    expect(cameras.assign).not.toHaveBeenCalled();
    expect(cameras.assignFile).not.toHaveBeenCalled();
    expect(cameras.assignPull).not.toHaveBeenCalled();
    expect(cameras.clear).not.toHaveBeenCalled();
    expect(slots.assignFile).not.toHaveBeenCalled();
    expect(slots.start).not.toHaveBeenCalled();
    expect(slots.stop).not.toHaveBeenCalled();
  }

  /** The kit button on `element`: what the panel gave it, whatever classes that makes. */
  const kitButton = (element: HTMLElement): NeatButton =>
    fixture.debugElement
      .queryAll(By.directive(NeatButton))
      .find((debug) => debug.nativeElement === element)!
      .injector.get(NeatButton);
  /** The name of the icon drawn in `element`, or null when it has none. */
  const iconOf = (element: HTMLElement): ReturnType<NeatIcon['name']> | null =>
    fixture.debugElement
      .queryAll(By.directive(NeatIcon))
      .find((debug) => element.contains(debug.nativeElement))
      ?.injector.get(NeatIcon)
      .name() ?? null;

  it('heads the panel with the slot and its state, and previews it', async () => {
    slots.slots.set([walk(2, { run: true, state: 'live' })]);
    await open();
    expect(text(root().querySelector('h2')!)).toBe('src2');
    expect(text(root().querySelector('app-panel-title neat-status-chip')!)).toBe('Live');
    expect(root().querySelector('app-slot-preview')).not.toBeNull();
  });

  const row = () => fixture.componentInstance.row();

  describe('the source switch', () => {
    beforeEach(() => cameras.followTheServer());

    it('applies at once on a stopped slot: Camera makes it a webcam with no camera picked', async () => {
      await open();
      expect(sourceKind('File').getAttribute('aria-checked')).toBe('true');
      expect(text()).toContain('File: people/walk.mp4 · 30 fps');
      expect(row().kind).toBe('VID');

      await click(sourceKind('Camera'));
      expect(cameras.assign).toHaveBeenCalledExactlyOnceWith(2, null);
      // The row is a camera from the next read, and the form is the camera's.
      expect(row().kind).toBe('CAM');
      expect(sourceKind('Camera').getAttribute('aria-checked')).toBe('true');
      // The hints name the slot's real URL, with the server's mapped port.
      expect(text()).toContain(
        'The browser publishes the camera to rtsp://10.0.0.2:8554/src2 while this tab stays open.',
      );
      expect(text()).not.toContain('File: people/walk.mp4');
    });

    it('applies at once on a stopped slot: File clears a webcam, and a file slot keeps its file', async () => {
      slots.slots.set([webcamSlot(2)]);
      await open();
      expect(sourceKind('Camera').getAttribute('aria-checked')).toBe('true');

      await click(sourceKind('File'));
      expect(cameras.clear).toHaveBeenCalledExactlyOnceWith(2);
      expect(row().kind).toBe('');
      expect(text()).toContain('File: Not assigned');

      // A file slot is on File already: choosing it again changes nothing.
      cameras.clear.mockClear();
      slots.slots.set([walk()]);
      await settle();
      expect(sourceKind('File').getAttribute('aria-checked')).toBe('true');
      await click(sourceKind('File'));
      sentNothing();
      expect(text()).toContain('File: people/walk.mp4');
    });

    it('applies at once on a stopped slot: Stream URL clears a webcam or a file, and leaves an empty slot alone', async () => {
      await open();
      await click(sourceKind('Stream URL'));
      expect(cameras.clear).toHaveBeenCalledExactlyOnceWith(2);
      expect(row().kind).toBe('');
      expect(field('Stream URL')).toBeDefined();
      expect(text()).toContain(
        'Insight pulls the stream and forwards it unchanged to rtsp://10.0.0.2:8554/src2. RTSP and RTSPS only.',
      );

      // Nothing left to clear on an empty slot: only the form changes.
      cameras.clear.mockClear();
      await click(sourceKind('File'));
      await click(sourceKind('Stream URL'));
      sentNothing();

      // A webcam is cleared the same way.
      await click(sourceKind('Camera'));
      expect(cameras.assign).toHaveBeenCalledExactlyOnceWith(2, null);
      await click(sourceKind('Stream URL'));
      expect(cameras.clear).toHaveBeenCalledExactlyOnceWith(2);
      expect(row().kind).toBe('');
    });

    it('a refused change shows the server’s message and goes back to the slot’s form', async () => {
      cameras.assign.mockRejectedValueOnce(new Error('src2 is in use by an external publisher.'));
      await open();
      await click(sourceKind('Camera'));
      expect(toasts.error).toHaveBeenCalledWith('src2 is in use by an external publisher.');
      expect(sourceKind('File').getAttribute('aria-checked')).toBe('true');
      expect(text()).toContain('File: people/walk.mp4');
    });

    it('remembers the empty slot’s form only once the change took', async () => {
      const session = TestBed.inject(SourcesSession);
      cameras.clear.mockRejectedValueOnce(new Error('There is no source 2.'));
      await open();
      await click(sourceKind('Stream URL'));
      expect(toasts.error).toHaveBeenCalledWith('There is no source 2.');
      expect(session.emptyForm(2)).toBeUndefined();
      expect(sourceKind('File').getAttribute('aria-checked')).toBe('true');

      await click(sourceKind('Stream URL'));
      expect(session.emptyForm(2)).toBe('url');
    });

    it('remembers the form left on an empty slot, for the session', async () => {
      slots.slots.set([slot(3), walk(2)]);
      await open(3);
      await click(sourceKind('Stream URL'));
      sentNothing();
      expect(sourceKind('Stream URL').getAttribute('aria-checked')).toBe('true');

      // Another slot, then back: the panel is built afresh each time.
      fixture.destroy();
      await open(2);
      expect(sourceKind('File').getAttribute('aria-checked')).toBe('true');
      fixture.destroy();
      await open(3);
      expect(sourceKind('Stream URL').getAttribute('aria-checked')).toBe('true');
      expect(field('Stream URL')).toBeDefined();

      await click(sourceKind('File'));
      fixture.destroy();
      await open(3);
      expect(sourceKind('File').getAttribute('aria-checked')).toBe('true');
    });

    it('asks first on a live file slot, and Cancel changes nothing', async () => {
      slots.slots.set([walk(2, { run: true, state: 'live' })]);
      await open();
      await click(sourceKind('Camera'));

      const ask = confirmDialog()!;
      expect(text(ask)).toContain('Stop src2?');
      expect(text(ask)).toContain(
        'Switching to Camera stops src2 and removes its people/walk.mp4.',
      );
      expect(buttonIn(ask, 'Stop and switch')).toBeDefined();
      // Nothing happens until the answer.
      sentNothing();

      await click(buttonIn(ask, 'Cancel'));
      sentNothing();
      expect(confirmDialog()).toBeNull();
      // The switch shows the slot's form again, and the form is the file's.
      expect(sourceKind('File').getAttribute('aria-checked')).toBe('true');
      expect(sourceKind('Camera').getAttribute('aria-checked')).toBe('false');
      expect(text()).toContain('File: people/walk.mp4');
      expect(row().state.label).toBe('Live');

      // Cancelled again, now for Stream URL: still nothing, and the same form shown.
      await click(sourceKind('Stream URL'));
      expect(text(confirmDialog()!)).toContain(
        'Switching to Stream URL stops src2 and removes its people/walk.mp4.',
      );
      await click(buttonIn(confirmDialog()!, 'Cancel'));
      sentNothing();
      expect(sourceKind('File').getAttribute('aria-checked')).toBe('true');
    });

    it('changes nothing when the slot changed while the question was open', async () => {
      slots.slots.set([walk(2, { run: true, state: 'live' })]);
      await open();
      await click(sourceKind('Camera'));
      expect(confirmDialog()).not.toBeNull();

      // Another tab gave it a webcam meanwhile.
      slots.slots.set([webcamSlot(2)]);
      await settle();
      await click(buttonIn(confirmDialog()!, 'Stop and switch'));
      sentNothing();
      expect(sourceKind('Camera').getAttribute('aria-checked')).toBe('true');

      // Or a pull took it: its form shows, and nothing was switched.
      slots.slots.set([walk(2, { run: true, state: 'live' })]);
      await settle();
      await click(sourceKind('File'));
      await click(sourceKind('Stream URL'));
      slots.slots.set([pulled(2)]);
      await settle();
      await click(buttonIn(confirmDialog()!, 'Stop and switch'));
      sentNothing();
      expect(sourceKind('Stream URL').getAttribute('aria-checked')).toBe('true');
    });

    it('switches a live file slot once the question is confirmed: the new assignment stops it on the server', async () => {
      slots.slots.set([walk(2, { run: true, state: 'live' })]);
      await open();
      await click(sourceKind('Camera'));
      await click(buttonIn(confirmDialog()!, 'Stop and switch'));

      expect(cameras.assign).toHaveBeenCalledExactlyOnceWith(2, null);
      expect(slots.stop).not.toHaveBeenCalled();
      expect(row().kind).toBe('CAM');
      expect(sourceKind('Camera').getAttribute('aria-checked')).toBe('true');
    });

    it('clears a live webcam through the cameras service, which ends its publish, once confirmed', async () => {
      slots.slots.set([webcamSlot(2, { state: 'live' })]);
      cameras.assignments.set(new Map([[2, CAMERAS[0]]]));
      await open();
      await click(sourceKind('File'));
      expect(text(confirmDialog()!)).toContain(
        'Switching to File stops src2 and removes its camera.',
      );
      sentNothing();

      await click(buttonIn(confirmDialog()!, 'Stop and switch'));
      expect(cameras.clear).toHaveBeenCalledExactlyOnceWith(2);
      expect(slots.stop).not.toHaveBeenCalled();
      expect(row().kind).toBe('');
    });

    it('never dims for a change in flight: a click then changes nothing and the form stays', async () => {
      await open();
      let registered!: () => void;
      cameras.assign.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            registered = () => {
              slots.update(2, webcamSlot(2));
              resolve();
            };
          }),
      );
      await click(sourceKind('Camera'));
      // The change is in flight. The switch stays as it is (a dimmed switch flashed on every
      // change), and a second click does not start a second change.
      expect(sourceKind('File').hasAttribute('disabled')).toBe(false);
      await click(sourceKind('File'));
      expect(cameras.assign).toHaveBeenCalledOnce();
      expect(cameras.clear).not.toHaveBeenCalled();
      // The change in flight is not a start: Start waits without spinning.
      expect(iconOf(button('Start')!)).toBe('play');
      // It shows what the change in flight is changing to, not the click it ignored.
      expect(sourceKind('Camera').getAttribute('aria-checked')).toBe('true');
      expect(sourceKind('File').getAttribute('aria-checked')).toBe('false');
      expect(text()).toContain('The browser publishes the camera');
      registered();
      await settle();
      expect(sourceKind('File').hasAttribute('disabled')).toBe(false);
      expect(sourceKind('Camera').getAttribute('aria-checked')).toBe('true');

      // Another action of the panel in flight ignores a click the same way, and shows the slot's
      // form.
      slots.slots.set([walk()]);
      await settle();
      let started!: (answer: Slot) => void;
      slots.start.mockReturnValueOnce(new Promise((resolve) => (started = resolve)));
      await click(button('Start'));
      expect(sourceKind('Camera').hasAttribute('disabled')).toBe(false);
      cameras.assign.mockClear();
      await click(sourceKind('Camera'));
      expect(cameras.assign).not.toHaveBeenCalled();
      expect(sourceKind('File').getAttribute('aria-checked')).toBe('true');
      expect(sourceKind('Camera').getAttribute('aria-checked')).toBe('false');
      expect(text()).toContain('File: people/walk.mp4');
      started(walk());
      await settle();
    });

    it('waits while the slot prepares its rendition: that is a state, not a moment', async () => {
      slots.slots.set([walk(2, { fps: 15 })]);
      slots.start.mockImplementationOnce(async (n) => {
        slots.prepare(n);
        return slots.of(n);
      });
      await open();
      await click(button('Start'));
      expect(text(button('Cancel encoding')!)).toBe('Cancel encoding');
      expect(sourceKind('Camera').hasAttribute('disabled')).toBe(true);
    });

    it('is hidden while an external publisher holds the slot', async () => {
      slots.slots.set([external(2)]);
      await open();
      expect(root().querySelector('[role="radiogroup"][aria-label="Source"]')).toBeNull();
    });
  });

  describe('the cameras', () => {
    const cameraList = () =>
      root().querySelector<HTMLElement>('[role="listbox"][aria-label="Cameras"]')!;
    const options = () => [...cameraList().querySelectorAll<HTMLElement>('[role="option"]')];

    it('assigns a camera when it is clicked, and there is no Assign button', async () => {
      slots.slots.set([webcamSlot(2)]);
      cameras.cameras.set(CAMERAS);
      await open();
      expect(button('Assign')).toBeUndefined();
      expect(options().every((option) => option.getAttribute('aria-selected') === 'false')).toBe(
        true,
      );

      await click(options()[1]);
      expect(cameras.assign).toHaveBeenCalledExactlyOnceWith(2, 'd2');
      // The list's selection is the assigned camera.
      expect(options()[1].getAttribute('aria-selected')).toBe('true');
      // What comes next for an assigned camera is starting it.
      expect(document.activeElement).toBe(button('Start'));

      // The assigned camera again changes nothing.
      await click(options()[1]);
      expect(cameras.assign).toHaveBeenCalledOnce();
    });

    it('moves the cursor with the arrow keys and assigns only on Enter', async () => {
      slots.slots.set([webcamSlot(3)]);
      cameras.cameras.set(CAMERAS);
      cameras.assignments.set(new Map([[3, CAMERAS[0]]]));
      await open(3);
      const press = async (key: string) => {
        cameraList().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        await settle();
      };

      await press('ArrowDown');
      expect(options()[1].getAttribute('aria-selected')).toBe('true');
      expect(cameras.assign).not.toHaveBeenCalled();
      await press('ArrowUp');
      await press('End');
      expect(cameras.assign).not.toHaveBeenCalled();

      await press('Enter');
      expect(cameras.assign).toHaveBeenCalledExactlyOnceWith(3, 'd2');
    });

    it('puts the assigned camera back in the list when the focus leaves it', async () => {
      slots.slots.set([webcamSlot(3)]);
      cameras.cameras.set(CAMERAS);
      cameras.assignments.set(new Map([[3, CAMERAS[0]]]));
      await open(3);
      cameraList().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await settle();
      expect(options()[1].getAttribute('aria-selected')).toBe('true');

      // Focus moving within the list keeps the cursor; leaving it ends the browsing.
      cameraList().dispatchEvent(
        new FocusEvent('focusout', { bubbles: true, relatedTarget: options()[0] }),
      );
      await settle();
      expect(options()[1].getAttribute('aria-selected')).toBe('true');
      cameraList().dispatchEvent(
        new FocusEvent('focusout', { bubbles: true, relatedTarget: button('Refresh cameras') }),
      );
      await settle();
      expect(options()[0].getAttribute('aria-selected')).toBe('true');
      expect(cameras.assign).not.toHaveBeenCalled();
    });

    it('keeps a live webcam live on the camera activated: the publish ends, the new camera is assigned and published', async () => {
      slots.slots.set([webcamSlot(3, { state: 'live' })]);
      cameras.cameras.set(CAMERAS);
      cameras.assignments.set(new Map([[3, CAMERAS[0]]]));
      cameras.assign.mockImplementation(async (n, deviceId) => {
        cameras.assignments.set(
          new Map([[n, CAMERAS.find((camera) => camera.deviceId === deviceId)!]]),
        );
      });
      await open(3);

      await click(options()[1]);
      expect(confirmDialog()).toBeNull();
      expect(cameras.assign).toHaveBeenCalledExactlyOnceWith(3, 'd2');
      expect(cameras.publish).toHaveBeenCalledExactlyOnceWith(3);
      expect(cameras.assign.mock.invocationCallOrder[0]).toBeLessThan(
        cameras.publish.mock.invocationCallOrder[0],
      );
      expect(options()[1].getAttribute('aria-selected')).toBe('true');

      // A stopped webcam is only assigned: starting it is the user's.
      slots.update(3, { state: 'idle' });
      await settle();
      cameras.publish.mockClear();
      await click(options()[0]);
      expect(cameras.assign).toHaveBeenLastCalledWith(3, 'd1');
      expect(cameras.publish).not.toHaveBeenCalled();
    });

    it('shows the assigned camera as selected, and a refused assignment puts the selection back', async () => {
      slots.slots.set([webcamSlot(3)]);
      cameras.cameras.set(CAMERAS);
      cameras.assignments.set(new Map([[3, CAMERAS[0]]]));
      await open(3);
      expect(options()[0].getAttribute('aria-selected')).toBe('true');

      cameras.assign.mockRejectedValueOnce(new Error('src3 is in use by an external publisher.'));
      await click(options()[1]);
      expect(toasts.error).toHaveBeenCalledWith('src3 is in use by an external publisher.');
      expect(options()[0].getAttribute('aria-selected')).toBe('true');
      expect(options()[1].getAttribute('aria-selected')).toBe('false');

      // An assignment on another slot finishing meanwhile leaves this slot's camera alone.
      cameras.assignments.set(
        new Map([
          [3, CAMERAS[0]],
          [5, CAMERAS[1]],
        ]),
      );
      await settle();
      expect(options()[0].getAttribute('aria-selected')).toBe('true');
    });

    it('waits while the slot is changing: a click then assigns nothing, and the selection stays', async () => {
      slots.slots.set([webcamSlot(3)]);
      cameras.cameras.set(CAMERAS);
      cameras.assignments.set(new Map([[3, CAMERAS[0]]]));
      await open(3);
      cameras.changingSlots.set(new Set([3]));
      await settle();

      await click(options()[1]);
      expect(cameras.assign).not.toHaveBeenCalled();
      expect(options()[0].getAttribute('aria-selected')).toBe('true');
      expect(options()[1].getAttribute('aria-selected')).toBe('false');
    });
  });

  describe('the capture of a camera', () => {
    const select = (label: string) =>
      [...root().querySelectorAll<HTMLElement>('neat-select')].find(
        (one) =>
          one.querySelector('[role="combobox"]')?.getAttribute('aria-label') === label ||
          text(one).startsWith(label),
      )!;
    const shown = (label: string) => text(select(label).querySelector('[role="combobox"]')!);
    /** The labels of the options a select offers, read by opening it. */
    async function offered(label: string): Promise<string[]> {
      await click(select(label).querySelector<HTMLElement>('[role="combobox"]')!);
      const labels = [
        ...document.querySelectorAll<HTMLElement>(
          `[role="listbox"][aria-label="${label}"] [role="option"]`,
        ),
      ].map((one) => text(one));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      return labels;
    }
    async function pick(label: string, option: string): Promise<void> {
      await click(select(label).querySelector<HTMLElement>('[role="combobox"]')!);
      await click(
        [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
          (one) => text(one) === option,
        ),
      );
    }

    it('offers a Resolution that is 1920x1080 at 30 fps and a Bitrate that is Auto, with its rate, until chosen', async () => {
      slots.slots.set([webcamSlot(3)]);
      cameras.cameras.set(CAMERAS);
      await open(3);

      expect(shown('Resolution')).toContain('1920x1080 at 30 fps');
      expect(shown('Bitrate')).toContain('Auto, 8.1 Mbps');
      expect(await offered('Resolution')).toEqual([
        '3840x2160 at 30 fps',
        '2560x1440 at 30 fps',
        '1920x1080 at 30 fps',
        '1280x720 at 30 fps',
        '640x480 at 30 fps',
        'Camera default',
      ]);
      expect(await offered('Bitrate')).toEqual([
        'Auto, 8.1 Mbps',
        '2 Mbps',
        '4 Mbps',
        '8 Mbps',
        '16 Mbps',
        '32 Mbps',
      ]);
    });

    it('lists only the modes the assigned camera reaches, and shows the largest of them while the chosen one is out of reach', async () => {
      const hd: Camera = {
        deviceId: 'hd',
        label: 'HD',
        captureModeIds: ['720p30', '480p30', 'camera'],
      };
      slots.slots.set([webcamSlot(3)]);
      cameras.cameras.set([hd]);
      cameras.assignments.set(new Map([[3, hd]]));
      await open(3);

      expect(await offered('Resolution')).toEqual([
        '1280x720 at 30 fps',
        '640x480 at 30 fps',
        'Camera default',
      ]);
      expect(shown('Resolution')).toContain('1280x720 at 30 fps');
      // Auto follows the mode shown.
      expect(shown('Bitrate')).toContain('Auto, 3.6 Mbps');
    });

    it('sets the choice for a stopped slot, to apply when it starts', async () => {
      slots.slots.set([webcamSlot(3)]);
      cameras.cameras.set(CAMERAS);
      cameras.assignments.set(new Map([[3, CAMERAS[0]]]));
      await open(3);

      await pick('Resolution', '1280x720 at 30 fps');
      await pick('Bitrate', '4 Mbps');

      expect(cameras.setCapture).toHaveBeenNthCalledWith(1, 3, { mode: '720p30', bitrate: 'auto' });
      expect(cameras.setCapture).toHaveBeenNthCalledWith(2, 3, {
        mode: '720p30',
        bitrate: '4mbps',
      });
      expect(cameras.assign).not.toHaveBeenCalled();
      expect(cameras.publish).not.toHaveBeenCalled();
      expect(shown('Resolution')).toContain('1280x720 at 30 fps');
    });

    it('keeps a live webcam live in the new mode: the publish ends, the camera is assigned again and published', async () => {
      slots.slots.set([webcamSlot(3, { state: 'live' })]);
      cameras.cameras.set(CAMERAS);
      cameras.assignments.set(new Map([[3, CAMERAS[0]]]));
      await open(3);

      await pick('Resolution', '640x480 at 30 fps');

      expect(cameras.setCapture).toHaveBeenCalledExactlyOnceWith(3, {
        mode: '480p30',
        bitrate: 'auto',
      });
      expect(cameras.assign).toHaveBeenCalledExactlyOnceWith(3, 'd1');
      expect(cameras.publish).toHaveBeenCalledExactlyOnceWith(3);
      expect(cameras.setCapture.mock.invocationCallOrder[0]).toBeLessThan(
        cameras.assign.mock.invocationCallOrder[0],
      );
    });

    it('shows a refusal to start in the new mode as a toast', async () => {
      slots.slots.set([webcamSlot(3, { state: 'live' })]);
      cameras.cameras.set(CAMERAS);
      cameras.assignments.set(new Map([[3, CAMERAS[0]]]));
      cameras.assign.mockRejectedValueOnce(new Error('src3 is in use by an external publisher.'));
      await open(3);

      await pick('Bitrate', '2 Mbps');

      expect(toasts.error).toHaveBeenCalledWith('src3 is in use by an external publisher.');
    });

    it('waits while the slot is changing', async () => {
      slots.slots.set([webcamSlot(3)]);
      cameras.cameras.set(CAMERAS);
      await open(3);
      const selects = () =>
        fixture.debugElement.queryAll(By.directive(NeatSelect)).map((d) => d.componentInstance);
      expect(selects().map((one) => one.disabled())).toEqual([false, false]);

      cameras.changingSlots.set(new Set([3]));
      await settle();

      expect(selects().map((one) => one.disabled())).toEqual([true, true]);
    });

    it('is not shown for a browser that cannot access cameras', async () => {
      slots.slots.set([webcamSlot(3)]);
      cameras.state.set('unsupported');
      await open(3);

      expect(root().querySelector('neat-select')).toBeNull();
    });
  });

  it('opens on the form for what the slot holds, and words the camera access as Media did', async () => {
    cameras.followTheServer();
    slots.slots.set([webcamSlot(3)]);
    await open(3);
    expect(sourceKind('Camera').getAttribute('aria-checked')).toBe('true');
    expect(text()).toContain(
      "No cameras enabled yet. Insight needs this browser's permission to use them.",
    );
    expect(button('Enable camera access')).toBeDefined();
    await click(button('Enable camera access'));
    expect(cameras.requestAccess).toHaveBeenCalledOnce();
    expect(button('Refresh cameras')).toBeDefined();

    cameras.state.set('requesting');
    await fixture.whenStable();
    expect(button('Requesting…')!.disabled).toBe(true);

    cameras.state.set('denied');
    cameras.error.set(
      'Camera permission was denied. Allow camera access for this site and try again.',
    );
    await fixture.whenStable();
    expect(root().querySelector('neat-error-note[role="alert"]')!.textContent).toContain(
      'Camera permission was denied.',
    );

    // The camera form has no Clear: switching away clears the webcam.
    expect(button('Clear')).toBeUndefined();

    await click(sourceKind('Stream URL'));
    expect(cameras.clear).toHaveBeenCalledExactlyOnceWith(3);
    await type(field('Stream URL'), 'rtsp://10.0.0.7/stream1');
    expect(button('Pull')!.disabled).toBe(false);
  });

  describe('a pull', () => {
    it('sends the trimmed URL and credentials, names the camera from the server’s record, and empties the form', async () => {
      slots.slots.set([slot(2)]);
      await open();
      await click(sourceKind('Stream URL'));
      cameras.assignPull.mockImplementationOnce(async (n) => {
        slots.slots.set([pulled(n, { state: 'starting', pull: pull({ status: 'connecting' }) })]);
        return slots.of(n);
      });
      expect(button('Pull')!.disabled).toBe(true);
      await type(field('Stream URL'), ' rtsp://cam:pw@10.0.0.7:554/stream1 ');
      await type(field('Username'), ' admin ');
      await type(field('Password'), 'secret');
      await click(button('Pull'));
      expect(cameras.assignPull).toHaveBeenCalledExactlyOnceWith(2, {
        url: 'rtsp://cam:pw@10.0.0.7:554/stream1',
        username: 'admin',
        password: 'secret',
      });
      // Named from the server's credential-free record, never from what was typed.
      expect(toasts.status).toHaveBeenCalledWith(
        'src2 is pulling from rtsp://10.0.0.7:554/stream1.',
      );
      expect([field('Stream URL').value, field('Username').value, field('Password').value]).toEqual(
        ['', '', ''],
      );
      // The camera it pulls, and what comes next: its Stop.
      expect(text()).toContain('Camera: rtsp://10.0.0.7:554/stream1');
      expect(document.activeElement).toBe(button('Stop'));
    });

    it('a refused pull shows the server message and keeps the form to try again', async () => {
      await open();
      await click(sourceKind('Stream URL'));
      let refuse!: () => void;
      cameras.assignPull.mockReturnValueOnce(
        new Promise((_, reject) => {
          refuse = () =>
            reject(
              new ApiRequestError(
                422,
                'The camera at 10.0.0.7 rejected the username or password.',
                {
                  error: {
                    code: 'pull_auth_failed',
                    message: 'The camera at 10.0.0.7 rejected the username or password.',
                  },
                },
              ),
            );
        }),
      );
      await type(field('Stream URL'), 'rtsp://10.0.0.7/stream1');
      await type(field('Password'), 'wrong');
      await click(button('Pull'));
      expect(button('Checking…')!.disabled).toBe(true);
      refuse();
      await settle();
      const message = 'The camera at 10.0.0.7 rejected the username or password.';
      expect(toasts.error).toHaveBeenCalledWith(message);
      // Also under the form, where the credentials are typed again.
      const inline = root().querySelector('form neat-error-note[role="alert"]')!;
      expect(text(inline)).toBe(message);
      expect(field('Stream URL').value).toBe('rtsp://10.0.0.7/stream1');
      expect(button('Pull')!.disabled).toBe(false);

      // A new attempt clears it.
      cameras.assignPull.mockReturnValueOnce(new Promise(() => undefined));
      await click(button('Pull'));
      expect(root().querySelector('form neat-error-note[role="alert"]')).toBeNull();
    });

    it('Stop keeps the camera and Start pulls again; Clear removes it', async () => {
      slots.slots.set([pulled(5)]);
      slots.stop.mockImplementationOnce(async (n) => {
        slots.update(n, { run: false, state: 'idle', pull: pull({ status: 'stopped' }) });
        return slots.of(n);
      });
      cameras.followTheServer();
      await open(5);
      expect(sourceKind('Stream URL').getAttribute('aria-checked')).toBe('true');
      expect(text()).toContain('Camera: rtsp://10.0.0.7:554/stream1');
      // A pull has no frame rate of its own.
      expect(root().querySelector('neat-number-field')).toBeNull();

      await click(button('Stop'));
      expect(slots.stop).toHaveBeenCalledExactlyOnceWith(5);
      expect(text()).toContain('Camera: rtsp://10.0.0.7:554/stream1');
      expect(row().state.label).toBe('Idle');

      await click(button('Start'));
      expect(slots.start).toHaveBeenCalledExactlyOnceWith(5);

      await click(button('Clear'));
      expect(cameras.clear).toHaveBeenCalledExactlyOnceWith(5);
      expect(text()).not.toContain('Camera: rtsp://');
      expect(sourceKind('Stream URL').getAttribute('aria-checked')).toBe('true');
    });

    it('a pull that lost its credentials to a restart cannot start until its URL is typed again', async () => {
      const error =
        'Insight keeps no camera credentials across a restart; enter the stream URL again.';
      slots.slots.set([
        pulled(5, {
          run: false,
          state: 'idle',
          error,
          publisher: undefined,
          pull: pull({ status: 'needs_credentials', error }),
        }),
      ]);
      await open(5);
      expect(row().state.label).toBe('Needs URL');
      expect(text()).toContain(error);
      expect(button('Start')!.disabled).toBe(true);
      expect(field('Stream URL')).toBeDefined();
    });
  });

  it('Change… assigns the picked file through the cameras service, and keeps the picker open on a refusal', async () => {
    await open();
    await click(button('Change…'));
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain('Source for src2');
    expect(library.refresh).toHaveBeenCalled();

    const run = [...dialog()!.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.includes('run.mp4'),
    )!;
    await click(run);
    cameras.assignFile.mockRejectedValueOnce(
      new ApiRequestError(409, 'src2 is in use by an external publisher (rtsp).', null),
    );
    await click(buttonIn(dialog()!, 'Assign'));
    expect(cameras.assignFile).toHaveBeenCalledWith(2, 'people/run.mp4');
    expect(toasts.error).toHaveBeenCalledWith('src2 is in use by an external publisher (rtsp).');
    expect(dialog()).not.toBeNull();

    await click(buttonIn(dialog()!, 'Assign'));
    expect(cameras.assignFile).toHaveBeenCalledTimes(2);
    expect(dialog()).toBeNull();
  });

  it("the picker's Import… opens the import dialog, then shows the imported file picked", async () => {
    await open();
    await click(button('Change…'));
    let finish!: (path: string | null) => void;
    imports.open.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await click(buttonIn(dialog()!, 'Import…'));
    expect(imports.open).toHaveBeenCalledOnce();

    // The import saved a file the tree did not hold yet; the picker fetches the library again.
    library.refresh.mockImplementationOnce(async () => {
      library.tree.update((tree) => [...(tree ?? []), mediaFile('clip.mp4')]);
    });
    finish('clip.mp4');
    await settle();
    expect(text(dialog()!)).toContain('Selected: clip.mp4');
    const clip = [...dialog()!.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.includes('clip.mp4'),
    )!;
    expect(clip.getAttribute('aria-selected')).toBe('true');

    await click(buttonIn(dialog()!, 'Assign'));
    expect(cameras.assignFile).toHaveBeenCalledWith(2, 'clip.mp4');
  });

  it('a rate set while the native rate is unknown is custom: Details say so, and Start leaves the rendition to the server', async () => {
    slots.slots.set([walk(2, { fps: 15, native_fps: undefined })]);
    await open();
    expect(details()['Output']).toBe('RTSP / H.264 · 15 fps (rendition will be created on start)');
    expect(button('Native')!.disabled).toBe(false);

    await click(button('Start'));
    expect(slots.start).toHaveBeenCalledWith(2);
  });

  it('a different frame rate is committed, the server prepares its rendition on start with progress, and Cancel encoding stops it', async () => {
    await open();
    expect(text()).toContain('Native 30 fps. A different rate creates a rendition on start.');
    const rate = field('Frames per second');
    await type(rate, '15');
    rate.dispatchEvent(new Event('blur'));
    await settle();
    expect(slots.assignFile).toHaveBeenCalledExactlyOnceWith(2, 'people/walk.mp4', 15);
    slots.update(2, { fps: 15 });
    await fixture.whenStable();
    expect(details()['Output']).toBe('RTSP / H.264 · 15 fps (rendition will be created on start)');

    slots.start.mockImplementationOnce(async (n) => {
      slots.prepare(n);
      return slots.of(n);
    });
    await click(button('Start'));
    expect(slots.start).toHaveBeenCalledWith(2);
    expect(encodeTitle()).toBe('Encoding rendition…');
    expect(text(root().querySelector('app-panel-title neat-status-chip')!)).toBe('Encoding');
    // The rate cannot change while the encode runs.
    expect(field('Frames per second').disabled).toBe(true);

    slots.encodes.set(
      new Map([[2, { title: 'Encoding rendition…', detail: '00:25 / 01:00', percent: 42 }]]),
    );
    await fixture.whenStable();
    expect(encodeTitle()).toBe('Encoding rendition… 42%');
    expect(text(encodeStatus()!.querySelector('[data-slot="progress-detail"]')!)).toBe(
      '00:25 / 01:00',
    );
    // The progress belongs to the frame rate it encodes.
    expect(encodeStatus()!.closest('[aria-label="Output frame rate"], .frame-rate')).not.toBeNull();
    expect(
      encodeStatus()!
        .querySelector('neat-progress [role="progressbar"]')!
        .getAttribute('aria-valuenow'),
    ).toBe('42');

    await click(button('Cancel encoding'));
    expect(slots.stop).toHaveBeenCalledExactlyOnceWith(2);
    expect(toasts.status).toHaveBeenCalledWith('Cancelled encoding for src2.');
  });

  it('a failed encode is the slot’s problem, said in its details', async () => {
    slots.slots.set([
      walk(2, {
        fps: 15,
        run: true,
        state: 'failed',
        error: 'Encoding people/walk.mp4 at 15 fps failed: disk full',
      }),
    ]);
    await open();
    expect(row().state.label).toBe('Failed');
    expect(details()['Problem']).toBe('Encoding people/walk.mp4 at 15 fps failed: disk full');
    // A slot that is to run offers Stop.
    expect(button('Stop')).toBeDefined();
  });

  it('Native goes back to the source rate', async () => {
    slots.slots.set([walk(2, { fps: 15 })]);
    await open();
    await click(button('Native (30 fps)'));
    expect(slots.assignFile).toHaveBeenLastCalledWith(2, 'people/walk.mp4', null);
  });

  describe('the frame rate field', () => {
    const decrease = () => button('Decrease Frames per second')!;
    const increase = () => button('Increase Frames per second')!;
    const fps = () => field('Frames per second');

    async function typeAndEnter(text: string): Promise<void> {
      await type(fps(), text);
      fps().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
    }

    it('shows the native rate until the slot sets another, and "–" before either is known', async () => {
      await open();
      expect(fps().value).toBe('30');
      slots.update(2, { fps: 15 });
      await fixture.whenStable();
      expect(fps().value).toBe('15');

      slots.slots.set([walk(2, { fps: undefined, native_fps: undefined })]);
      await fixture.whenStable();
      expect(fps().value).toBe('');
      expect(fps().getAttribute('placeholder')).toBe('–');
    });

    it('+ commits the shown rate plus 5 and − on 3 commits 1', async () => {
      await open();
      await click(increase());
      expect(slots.assignFile).toHaveBeenLastCalledWith(2, 'people/walk.mp4', 35);

      slots.update(2, { fps: 3 });
      await fixture.whenStable();
      await click(decrease());
      expect(slots.assignFile).toHaveBeenLastCalledWith(2, 'people/walk.mp4', 1);
    });

    it('− at 1 is disabled and commits nothing', async () => {
      slots.slots.set([walk(2, { fps: 1 })]);
      await open();
      expect(decrease().getAttribute('aria-disabled')).toBe('true');
      await click(decrease());
      expect(slots.assignFile).not.toHaveBeenCalled();
    });

    it('a typed 24 and Enter commits 24; a typed rate equal to the shown one sends nothing', async () => {
      await open();
      await typeAndEnter('24');
      expect(slots.assignFile).toHaveBeenCalledExactlyOnceWith(2, 'people/walk.mp4', 24);

      slots.assignFile.mockClear();
      await typeAndEnter('30');
      expect(slots.assignFile).not.toHaveBeenCalled();
    });

    it('a refused rate is put back in the field', async () => {
      await open();
      slots.assignFile.mockRejectedValueOnce(new Error('No codec level covers 500 fps'));
      await typeAndEnter('500');
      expect(slots.assignFile).toHaveBeenCalledExactlyOnceWith(2, 'people/walk.mp4', 500);
      expect(fps().value).toBe('30');
    });

    it('a locked or disabled slot disables the field and its steps', async () => {
      slots.slots.set([walk(2, { run: true, state: 'live' })]);
      await open();
      expect(fps().disabled).toBe(true);
      expect(increase().disabled).toBe(true);

      slots.update(2, { file: 'cam.mjpeg', codec: 'mjpeg', run: false, state: 'idle' });
      await fixture.whenStable();
      expect(fps().disabled).toBe(true);
      expect(button('Native (30 fps)')!.disabled).toBe(true);
    });

    it('a typed rate the field refuses does not hold Start', async () => {
      await open();
      await type(fps(), '0');
      expect(fps().getAttribute('aria-invalid')).toBe('true');
      expect(button('Start')!.disabled).toBe(false);
    });

    it('an unassigned slot has no frame rate field and no Start', async () => {
      await open();
      slots.slots.set([slot(2)]);
      await fixture.whenStable();
      expect(root().querySelector('neat-number-field')).toBeNull();
      expect(button('Start')!.disabled).toBe(true);
    });
  });

  it('an MJPEG stream also goes out over HTTP, with its URL and Copy, and there is no transport to choose', async () => {
    slots.slots.set([
      walk(2, {
        file: 'cam.mjpeg',
        codec: 'mjpeg',
        urls: {
          rtsp: 'rtsp://10.0.0.2:8554/src2',
          http_mjpeg: 'https://10.0.0.2:9900/stream/http/src2.mjpg',
        },
      }),
    ]);
    await open();
    expect(root().querySelector('neat-select')).toBeNull();
    expect(details()).toMatchObject({
      Output: 'RTSP and HTTP / MJPEG · 30 fps',
      URL: 'rtsp://10.0.0.2:8554/src2 Copy',
      HTTP: 'https://10.0.0.2:9900/stream/http/src2.mjpg Copy',
    });
    await click(button('Copy HTTP URL for src2'));
    expect(writeText).toHaveBeenCalledWith('https://10.0.0.2:9900/stream/http/src2.mjpg');
  });

  it('Start and Stop: a file through the server, a webcam through the cameras', async () => {
    await open();
    await click(button('Start'));
    expect(slots.start).toHaveBeenCalledWith(2);

    slots.update(2, { run: true, state: 'live' });
    await fixture.whenStable();
    slots.stop.mockRejectedValueOnce(new ApiRequestError(404, 'There is no source 2.', null));
    await click(button('Stop'));
    expect(slots.stop).toHaveBeenCalledWith(2);
    expect(toasts.error).toHaveBeenCalledWith('There is no source 2.');

    fixture.destroy();
    cameras.assignments.set(new Map([[3, CAMERAS[0]]]));
    slots.slots.set([webcamSlot(3)]);
    await open(3);
    // The server keeps a webcam slot on from its assignment: until a browser publishes, it starts.
    await click(button('Start'));
    expect(cameras.publish).toHaveBeenCalledWith(3);
    slots.update(3, { state: 'live' });
    await fixture.whenStable();
    await click(button('Stop'));
    expect(cameras.release).toHaveBeenCalledWith(3);

    // While the slot is changing its main action waits; it stays focusable, so focus is not lost.
    cameras.changingSlots.set(new Set([3]));
    await fixture.whenStable();
    expect(button('Stop')!.getAttribute('aria-disabled')).toBe('true');
    expect(button('Stop')!.disabled).toBe(false);
    cameras.release.mockClear();
    button('Stop')!.click();
    expect(cameras.release).not.toHaveBeenCalled();
  });

  it('Start spins while a start waits, keeping its name and saying it is busy; it is a play glyph otherwise', async () => {
    let started!: (answer: Slot) => void;
    slots.start.mockReturnValueOnce(new Promise((resolve) => (started = resolve)));
    await open();
    const start = () => button('Start')!;
    expect(iconOf(start())).toBe('play');
    expect(start().hasAttribute('aria-busy')).toBe(false);

    await click(start());
    // The start is in flight: the glyph turns, the name is the same, and assistive technology is
    // told the button is busy rather than given a new label.
    expect(iconOf(start())).toBe('spinner');
    expect(start().getAttribute('aria-busy')).toBe('true');
    expect(text(start())).toBe('Start');
    expect(start().getAttribute('aria-label')).toBeNull();

    slots.update(2, { run: true, state: 'starting' });
    started(slots.of(2));
    await settle();
    // Stop is not a start that waits: it keeps its own glyph.
    expect(iconOf(button('Stop')!)).toBe('stop');
    expect(button('Stop')!.hasAttribute('aria-busy')).toBe(false);
  });

  it('the main action is a medium button on a row of its own, in the look of what it does', async () => {
    slots.slots.set([
      walk(2),
      walk(3, { run: true, state: 'live' }),
      external(4),
      pulled(5),
      walk(6, { fps: 15, run: true, state: 'preparing', job: 'job-1' }),
    ]);
    slots.encodes.set(new Map([[6, ENCODING]]));
    const looks: Record<string, [NeatButtonVariant, ReturnType<NeatIcon['name']> | null]> = {};
    for (const n of [2, 3, 4, 5, 6]) {
      await open(n);
      const main = fixture.debugElement.query(By.css('[neatAsideActions] button')).nativeElement;
      const kit = kitButton(main);
      expect(kit.size(), `src${n}`).toBe('medium');
      // The row is its own and the button fills it: the panel's one rule for it.
      expect(getComputedStyle(main).inlineSize, `src${n}`).toBe('100%');
      looks[`src${n} ${text(main)}`] = [kit.variant(), iconOf(main)];
      fixture.destroy();
    }

    expect(looks).toEqual({
      'src2 Start': ['success', 'play'],
      'src3 Stop': ['danger', 'stop'],
      'src4 Take over…': ['danger', null],
      'src5 Stop': ['danger', 'stop'],
      'src6 Cancel encoding': ['outlined', null],
    });
  });

  it('a webcam slot without a camera picked in this browser cannot start', async () => {
    slots.slots.set([webcamSlot(3)]);
    await open(3);
    expect(button('Start')!.disabled).toBe(true);
  });

  it('Take over asks first and disconnects; a refusal shows the server message', async () => {
    slots.slots.set([external(4, { readers: [{ protocol: 'rtsp', address: '10.42.0.79' }] })]);
    await open(4);
    expect(button('Start')).toBeUndefined();
    await click(button('Take over…'));
    const question = confirmDialog()!;
    expect(text(question)).toContain('Disconnect external stream on src4?');
    expect(text(question)).toContain('⇢ RTSP · 192.168.1.20 · 1280×720 · 30 fps');
    expect(text(question)).toContain('Readers: 1 · 10.42.0.79');
    expect(text(question)).toContain(
      'The publisher and all readers will be disconnected, and src4 goes back to what it is assigned.',
    );
    await click(buttonIn(question, 'Cancel'));
    expect(slots.takeOver).not.toHaveBeenCalled();

    await click(button('Take over…'));
    await click(buttonIn(confirmDialog()!, 'Disconnect'));
    expect(slots.takeOver).toHaveBeenCalledExactlyOnceWith(4);
    expect(toasts.status).toHaveBeenCalledWith('Disconnected the external stream on src4.');

    slots.takeOver.mockRejectedValueOnce(
      new ApiRequestError(409, 'src4 is not held by an external publisher.', null),
    );
    await click(button('Take over…'));
    await click(buttonIn(confirmDialog()!, 'Disconnect'));
    expect(toasts.error).toHaveBeenCalledWith('src4 is not held by an external publisher.');
  });

  it('details: output, URL, readers; and for a publisher or a pull, its source, video, live for and bitrate', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-24T08:12:04Z'));
    slots.slots.set([
      walk(2, {
        run: true,
        state: 'live',
        fps: 15,
        active_file: '.renditions/walk_15fps.mp4',
        readers: [{ protocol: 'rtsp', address: '127.0.0.1', label: 'insight preview' }],
      }),
      pulled(5, {
        pull: pull({ path: '/stream1?token=***' }),
        publisher: publisher({ protocol: 'rtspSource', address: undefined, bitrate_bps: 850_000 }),
      }),
      pulled(6, {
        state: 'starting',
        codec: undefined,
        publisher: undefined,
        pull: pull({ status: 'unreachable', error: 'connection refused' }),
      }),
    ]);
    await open();
    expect(details()).toEqual({
      Output: 'RTSP / H.264 · 15 fps · streaming rendition .renditions/walk_15fps.mp4',
      URL: 'rtsp://10.0.0.2:8554/src2 Copy',
      Readers: '1 · insight preview',
    });

    fixture.destroy();
    await open(5);
    expect(details()).toEqual({
      Source: 'rtsp://10.0.0.7:554/stream1?token=***',
      Status: 'Live',
      Video: 'H.264 · 1280×720 · 30 fps',
      URL: 'rtsp://10.0.0.2:8554/src5 Copy',
      'Live for': '12 min 04 s',
      Bitrate: '850 kbit/s',
      Readers: '0',
    });

    fixture.destroy();
    await open(6);
    expect(details()).toEqual({
      Source: 'rtsp://10.0.0.7:554/stream1',
      Status: 'Unreachable · connection refused',
      Video: '–',
      URL: 'rtsp://10.0.0.2:8554/src6 Copy',
      'Live for': '–',
      Bitrate: '–',
      Readers: '0',
    });
  });

  it('an external publisher’s panel offers only Take over', async () => {
    slots.slots.set([external(4, { kind: 'file', file: 'under.mp4' })]);
    await open(4);
    const actions = [...root().querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(actions).toEqual(['Take over…', 'Copy']);
    expect(root().querySelector('neat-segmented, neat-number-field, neat-select')).toBeNull();
    expect(root().querySelector('app-slot-preview')).not.toBeNull();
    expect(root().querySelector('dl')).not.toBeNull();
  });

  it('holds the frame rate while the slot is busy, and an assignment waits for a commit on its way', async () => {
    await open();
    let landed!: () => void;
    slots.assignFile.mockReturnValueOnce(
      new Promise((resolve) => (landed = () => resolve(walk(2, { fps: 15 })))),
    );
    const rate = field('Frames per second');
    await type(rate, '15');
    rate.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    // Clear right after: it must not race the commit, which posts the file the slot has now.
    await click(button('Clear'));
    expect(cameras.clear).not.toHaveBeenCalled();
    expect(field('Frames per second').disabled).toBe(true);
    expect(button('Native (30 fps)')!.disabled).toBe(true);
    landed();
    await settle();
    expect(cameras.clear).toHaveBeenCalledExactlyOnceWith(2);
    expect(field('Frames per second').disabled).toBe(false);

    // The changing slot holds the frame rate field too.
    cameras.changingSlots.set(new Set([2]));
    await fixture.whenStable();
    expect(field('Frames per second').disabled).toBe(true);
  });

  it('keeps the focus on the main action as it changes, and moves it to what comes next', async () => {
    cameras.followTheServer();
    slots.slots.set([walk(2, { fps: 15 })]);
    slots.start.mockImplementationOnce(async (n) => {
      slots.prepare(n);
      return slots.of(n);
    });
    slots.stop.mockImplementationOnce(async (n) => {
      slots.update(n, { run: false, state: 'idle', job: undefined });
      slots.encodes.set(new Map());
      return slots.of(n);
    });
    await open();
    const action = button('Start')!;
    action.focus();
    await click(action);
    // The same element, now the action the slot offers: focus stays on it.
    expect(document.activeElement).toBe(action);
    expect(text(action)).toBe('Cancel encoding');
    await click(action);
    expect(text(action)).toBe('Start');
    expect(document.activeElement).toBe(action);

    // Clear leaves nothing to clear: focus goes on to Change….
    button('Clear')!.focus();
    await click(button('Clear'));
    expect(document.activeElement).toBe(button('Change…'));
  });

  it('says why the frame rate cannot change, in words the field is described by', async () => {
    slots.slots.set([walk(2, { file: 'cam.mjpeg', codec: 'mjpeg' })]);
    await open();
    const group = root().querySelector<HTMLElement>(
      '[role="group"][aria-label="Output frame rate"]',
    )!;
    const reason = document.getElementById(group.getAttribute('aria-describedby')!)!;
    expect(text(reason)).toBe('FPS changes are not supported for MJPEG sources');

    slots.update(2, { file: 'a.mp4', codec: 'h264', run: true, state: 'live' });
    await fixture.whenStable();
    expect(text(reason)).toBe('Stop the source to change its frame rate');

    slots.update(2, { run: false, state: 'idle' });
    await fixture.whenStable();
    expect(group.hasAttribute('aria-describedby')).toBe(false);
  });

  it('Copy copies the URL and says so on its button, a refused clipboard too, with no toast', async () => {
    const copy = () => root().querySelector<HTMLButtonElement>('dd neat-copy-button button')!;
    await open();
    await click(button('Copy stream URL for src2'));
    expect(writeText).toHaveBeenCalledWith('rtsp://10.0.0.2:8554/src2');
    expect(text(copy())).toBe('Copied');

    fixture.destroy();
    writeText.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    await open();
    await click(button('Copy stream URL for src2'));
    expect(text(copy())).toBe('Could not copy');
    expect(toasts.status).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });
});
