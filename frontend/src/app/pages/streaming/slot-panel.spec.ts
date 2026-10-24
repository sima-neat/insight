import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, computed, inject, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import { Observable, Subject } from 'rxjs';
import type {
  AssignRequest,
  MediaNode,
  PullRequest,
  Slot,
  StartRequest,
  StopRequest,
  SuccessResponse,
  TakeoverResponse,
} from '../../sources/api';
import { CamerasService, type CameraAccessState } from '../../sources/cameras.service';
import { MediaLibraryService } from '../../sources/media-library.service';
import type { Progress } from '../../sources/progress-lines';
import { SlotsService } from '../../sources/slots.service';
import { ApiRequestError, type StreamEvent } from '../../sources/stream-lines';
import type { Camera } from '../../sources/webcam-publishing';
import { SlotPanel } from './slot-panel';
import { slotRow } from './slot-row';

function slot(index: number, overrides: Partial<Slot> = {}): Slot {
  return {
    index,
    file: '',
    state: 'stopped',
    transport: '',
    codec: '',
    type: 'file',
    allowed_transports: [],
    urls: { rtsp: `rtsp://10.0.0.2:8554/src${index}` },
    readers: [],
    fps: null,
    native_fps: null,
    ...overrides,
  };
}

/** A file slot ready to start: H.264 at 30 fps. */
const fileSlot = (index = 2, overrides: Partial<Slot> = {}) =>
  slot(index, {
    file: 'people/walk.mp4',
    codec: 'h264',
    transport: 'rtsp',
    allowed_transports: ['rtsp'],
    native_fps: 30,
    ...overrides,
  });

const OK: SuccessResponse = { success: true };
const CAMERAS: Camera[] = [
  { deviceId: 'd1', label: 'Desk camera' },
  { deviceId: 'd2', label: 'iPhone' },
];

class FakeSlots {
  readonly slots = signal<readonly Slot[] | null>([fileSlot()]);
  readonly encodes = signal<ReadonlyMap<number, Progress>>(new Map());
  readonly prepares: { lines: Subject<StreamEvent>; cancelled: boolean }[] = [];
  readonly assign = vi.fn<(request: AssignRequest) => Promise<SuccessResponse>>(async () => OK);
  readonly start = vi.fn<(request: StartRequest) => Promise<SuccessResponse>>(async () => OK);
  readonly startAfterPrepare = vi.fn<(index: number) => Promise<SuccessResponse>>(async () => OK);
  readonly stop = vi.fn<(request: StopRequest) => Promise<SuccessResponse>>(async () => OK);
  readonly takeOver = vi.fn<(index: number) => Promise<TakeoverResponse>>(async (index) => ({
    success: true,
    index,
  }));
  readonly pull = vi.fn<(request: PullRequest) => Promise<Slot>>();
  /** Like the real service: the encode shows under its slot while it runs. */
  readonly prepare = vi.fn(
    (index: number) =>
      new Observable<StreamEvent>((subscriber) => {
        const run = { lines: new Subject<StreamEvent>(), cancelled: false };
        this.prepares.push(run);
        this.encodes.set(
          new Map([[index, { title: 'Preparing rendition…', detail: '', percent: null }]]),
        );
        let ended = false;
        const subscription = run.lines.subscribe({
          next: (event) => subscriber.next(event),
          complete: () => {
            ended = true;
            subscriber.complete();
          },
        });
        return () => {
          if (!ended) run.cancelled = true;
          subscription.unsubscribe();
          this.encodes.set(new Map());
        };
      }),
  );

  update(index: number, overrides: Partial<Slot>): void {
    this.slots.update((all) =>
      (all ?? []).map((one) => (one.index === index ? { ...one, ...overrides } : one)),
    );
  }
}

class FakeCameras {
  readonly cameras = signal<readonly Camera[]>([]);
  readonly state = signal<CameraAccessState>('unknown');
  readonly error = signal<string | null>(null);
  readonly assignments = signal<ReadonlyMap<number, Camera>>(new Map());
  readonly localStreams = signal<ReadonlyMap<number, MediaStream>>(new Map());
  readonly changingSlots = signal<ReadonlySet<number>>(new Set());
  readonly anyChanging = computed(() => this.changingSlots().size > 0);
  readonly assign = vi.fn<(slot: number, deviceId: string) => Promise<void>>(async () => undefined);
  readonly assignFile = vi.fn<
    (request: Omit<AssignRequest, 'publisher_released'>) => Promise<SuccessResponse>
  >(async () => OK);
  readonly publish = vi.fn<(slot: number) => Promise<void>>(async () => undefined);
  readonly release = vi.fn<(slot: number) => Promise<void>>(async () => undefined);
  readonly requestAccess = vi.fn(async () => {
    this.state.set('granted');
    this.cameras.set(CAMERAS);
  });
}

class FakeLibrary {
  readonly tree = signal<readonly MediaNode[] | null>([
    {
      name: '/people',
      path: 'people',
      type: 'folder',
      streamable_count: 2,
      children: [
        { name: 'walk.mp4', path: 'people/walk.mp4', type: 'file', streamable: true },
        { name: 'run.mp4', path: 'people/run.mp4', type: 'file', streamable: true },
      ],
    },
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
  readonly index = signal(2);
  readonly row = computed(() => {
    const slot = this.slots.slots()!.find((one) => one.index === this.index())!;
    return slotRow(slot, {
      camera: this.cameras.assignments().get(slot.index),
      encode: this.slots.encodes().get(slot.index),
    });
  });
}

describe('SlotPanel', () => {
  let slots: FakeSlots;
  let cameras: FakeCameras;
  let library: FakeLibrary;
  let toasts: { error: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<Host>;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    slots = new FakeSlots();
    cameras = new FakeCameras();
    library = new FakeLibrary();
    toasts = { error: vi.fn(), status: vi.fn() };
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SlotsService, useValue: slots },
        { provide: CamerasService, useValue: cameras },
        { provide: MediaLibraryService, useValue: library },
        { provide: NeatToasts, useValue: toasts },
      ],
    });
  });

  afterEach(() => {
    // Dialogs live in an overlay outside the fixture.
    fixture?.destroy();
    vi.restoreAllMocks();
  });

  async function open(index = 2): Promise<void> {
    fixture = TestBed.createComponent(Host);
    fixture.componentInstance.index.set(index);
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
      (radio) => radio.textContent?.trim() === label,
    )!;
  const field = (label: string) =>
    [...root().querySelectorAll<HTMLInputElement>('input')].find(
      (input) =>
        input.getAttribute('aria-label') === label ||
        input.closest('label')?.firstChild?.textContent?.trim() === label,
    )!;
  const dialog = () => document.querySelector<HTMLElement>('neat-dialog-panel');
  const confirmDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const details = (): Record<string, string> => {
    const values: Record<string, string> = {};
    const list = root().querySelector('dl')!;
    for (const term of list.querySelectorAll('dt')) {
      values[text(term)] = text(term.nextElementSibling!);
    }
    return values;
  };
  const encodeStatus = () => root().querySelector('.encode');

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
    expect(slots.assign).not.toHaveBeenCalled();
    expect(slots.pull).not.toHaveBeenCalled();
    expect(slots.start).not.toHaveBeenCalled();
    expect(slots.stop).not.toHaveBeenCalled();
  }

  it('heads the panel with the slot and its state, and previews it', async () => {
    slots.slots.set([fileSlot(2, { state: 'playing' })]);
    await open();
    expect(text(root().querySelector('h2')!)).toBe('src2');
    expect(text(root().querySelector('header app-status-chip')!)).toBe('Live');
    expect(root().querySelector('app-slot-preview')).not.toBeNull();
  });

  it('the switch changes only the form; nothing is sent until Assign, Pull or Clear', async () => {
    cameras.cameras.set(CAMERAS);
    await open();
    // A file slot opens on its file.
    expect(sourceKind('File').getAttribute('aria-checked')).toBe('true');
    expect(text()).toContain('File: people/walk.mp4 · 30 fps');

    await click(sourceKind('Camera'));
    expect(text()).toContain(
      'The browser publishes the camera to rtsp://…/src2 while this tab stays open.',
    );
    expect(text()).not.toContain('File: people/walk.mp4');
    await click(sourceKind('Stream URL'));
    expect(field('Stream URL')).toBeDefined();
    await click(sourceKind('File'));
    sentNothing();

    await click(button('Clear'));
    expect(cameras.assignFile).toHaveBeenCalledExactlyOnceWith({ index: 2, file: '' });

    await click(sourceKind('Camera'));
    const cameraList = root().querySelector<HTMLElement>('[role="listbox"][aria-label="Cameras"]')!;
    expect(button('Assign')!.disabled).toBe(true);
    await click([...cameraList.querySelectorAll<HTMLElement>('[role="option"]')][1]);
    await click(button('Assign'));
    expect(cameras.assign).toHaveBeenCalledExactlyOnceWith(2, 'd2');

    await click(sourceKind('Stream URL'));
    slots.pull.mockResolvedValueOnce(
      slot(2, {
        state: 'pulled',
        pull: {
          status: 'connecting',
          scheme: 'rtsp',
          host: '10.0.0.7:554',
          path: '/stream1',
          error: null,
          since: null,
          codec_supported: true,
          width: null,
          height: null,
          fps: null,
          bitrate_bps: null,
        },
      }),
    );
    expect(button('Pull')!.disabled).toBe(true);
    await type(field('Stream URL'), ' rtsp://cam:pw@10.0.0.7:554/stream1 ');
    await type(field('Username'), ' admin ');
    await type(field('Password'), 'secret');
    await click(button('Pull'));
    expect(slots.pull).toHaveBeenCalledExactlyOnceWith({
      index: 2,
      url: 'rtsp://cam:pw@10.0.0.7:554/stream1',
      username: 'admin',
      password: 'secret',
    });
    // Named from the server's credential-free record, never from what was typed.
    expect(toasts.status).toHaveBeenCalledWith('src2 is pulling from rtsp://10.0.0.7:554/stream1.');
    expect(field('Password').value).toBe('');
  });

  it('opens on the form for what the slot holds, and words the camera access as Media did', async () => {
    slots.slots.set([slot(3, { type: 'webcam', codec: 'h264', transport: 'rtsp' })]);
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
    expect(root().querySelector('[role="alert"]')!.textContent).toContain(
      'Camera permission was denied.',
    );

    // A webcam slot can be cleared from its own form, and refuses a pull until it is.
    await click(button('Clear'));
    expect(cameras.assignFile).toHaveBeenCalledWith({ index: 3, file: '' });
    await click(sourceKind('Stream URL'));
    expect(text()).toContain(
      'This slot is a webcam source. Clear it on the Camera tab before pulling a stream into it.',
    );
    await type(field('Stream URL'), 'rtsp://10.0.0.7/stream1');
    expect(button('Pull')!.disabled).toBe(true);
  });

  it('a refused pull shows the server message and keeps the form to try again', async () => {
    await open();
    await click(sourceKind('Stream URL'));
    let refuse!: () => void;
    slots.pull.mockReturnValueOnce(
      new Promise((_, reject) => {
        refuse = () =>
          reject(
            new ApiRequestError(400, 'The camera rejected the username or password', {
              reason: 'auth_failed',
            }),
          );
      }),
    );
    await type(field('Stream URL'), 'rtsp://10.0.0.7/stream1');
    await type(field('Password'), 'wrong');
    await click(button('Pull'));
    expect(button('Checking…')!.disabled).toBe(true);
    refuse();
    await settle();
    expect(toasts.error).toHaveBeenCalledWith('The camera rejected the username or password');
    expect(field('Stream URL').value).toBe('rtsp://10.0.0.7/stream1');
    expect(button('Pull')!.disabled).toBe(false);
  });

  it('Change… assigns the picked file through the cameras service, and keeps the picker open on a refusal', async () => {
    await open();
    await click(button('Change…'));
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain('Source for src2');
    expect(library.refresh).toHaveBeenCalled();

    const run = [...dialog()!.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
      row.textContent?.includes('run.mp4'),
    )!;
    await click(run);
    cameras.assignFile.mockRejectedValueOnce(
      new ApiRequestError(409, 'src2 is in use by an external publisher.', null),
    );
    await click(buttonIn(dialog()!, 'Assign'));
    expect(cameras.assignFile).toHaveBeenCalledWith({ index: 2, file: 'people/run.mp4' });
    expect(toasts.error).toHaveBeenCalledWith('src2 is in use by an external publisher.');
    expect(dialog()).not.toBeNull();

    await click(buttonIn(dialog()!, 'Assign'));
    expect(cameras.assignFile).toHaveBeenCalledTimes(2);
    expect(dialog()).toBeNull();
  });

  it('a different frame rate prepares a rendition with progress before start, and Cancel encoding stops it', async () => {
    await open();
    expect(text()).toContain('Native 30 fps. A different rate creates a rendition on start.');
    const rate = field('Frames per second');
    await type(rate, '15');
    rate.dispatchEvent(new Event('blur'));
    await settle();
    expect(slots.assign).toHaveBeenCalledExactlyOnceWith({
      index: 2,
      file: 'people/walk.mp4',
      transport: 'rtsp',
      fps: 15,
    });
    slots.update(2, { fps: 15 });
    await fixture.whenStable();
    expect(details()['Output']).toBe('RTSP / H.264 · 15 fps (rendition will be created on start)');

    await click(button('Start'));
    expect(slots.prepare).toHaveBeenCalledWith(2);
    expect(slots.start).not.toHaveBeenCalled();
    expect(text(encodeStatus()!)).toContain('Preparing rendition…');
    expect(text(root().querySelector('header app-status-chip')!)).toBe('Encoding');
    // The rate cannot change while the encode runs.
    expect(field('Frames per second').disabled).toBe(true);

    slots.encodes.set(
      new Map([[2, { title: 'Encoding 15 fps rendition…', detail: 'libx264', percent: 42 }]]),
    );
    await fixture.whenStable();
    expect(text(encodeStatus()!)).toContain('Encoding 15 fps rendition… 42%');
    expect(text(encodeStatus()!)).toContain('libx264');
    expect(
      encodeStatus()!
        .querySelector('neat-progress [role="progressbar"]')!
        .getAttribute('aria-valuenow'),
    ).toBe('42');

    await click(button('Cancel encoding'));
    expect(slots.prepares[0].cancelled).toBe(true);
    expect(toasts.status).toHaveBeenCalledWith('Cancelled encoding for src2.');
    expect(slots.startAfterPrepare).not.toHaveBeenCalled();
  });

  it('a finished encode starts the slot; Native goes back to the source rate', async () => {
    slots.slots.set([fileSlot(2, { fps: 15 })]);
    await open();
    await click(button('Start'));
    slots.prepares[0].lines.next({ kind: 'line', text: 'Rendition ready: .renditions/a.mp4' });
    slots.prepares[0].lines.complete();
    await settle();
    expect(slots.startAfterPrepare).toHaveBeenCalledWith(2);

    await click(button('Native (30 fps)'));
    expect(slots.assign).toHaveBeenLastCalledWith({
      index: 2,
      file: 'people/walk.mp4',
      transport: 'rtsp',
      fps: null,
    });
  });

  it('an invalid frame rate draft holds Start; MJPEG and unassigned slots have no frame rate to set', async () => {
    await open();
    await type(field('Frames per second'), '0');
    expect(button('Start')!.disabled).toBe(true);
    await type(field('Frames per second'), '25');
    expect(button('Start')!.disabled).toBe(false);

    slots.update(2, { file: 'cam.mjpeg', codec: 'mjpeg', allowed_transports: ['rtsp', 'http'] });
    await fixture.whenStable();
    expect(field('Frames per second').disabled).toBe(true);
    expect(button('Native (30 fps)')!.disabled).toBe(true);

    slots.update(2, { file: '', codec: '', allowed_transports: [] });
    await fixture.whenStable();
    expect(field('Frames per second').disabled).toBe(true);
    expect(button('Start')!.disabled).toBe(true);
  });

  it('offers the transport only where the media allows more than one, and sends a change', async () => {
    // The kit select's list measures itself and scrolls its active option into view.
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
    Element.prototype.scrollIntoView = vi.fn();
    await open();
    expect(root().querySelector('neat-select')).toBeNull();

    slots.update(2, {
      file: 'cam.mjpeg',
      codec: 'mjpeg',
      transport: 'rtsp',
      allowed_transports: ['rtsp', 'http'],
    });
    await fixture.whenStable();
    const select = root().querySelector('neat-select')!;
    expect(select.textContent).toContain('RTSP');
    // The kit select's value, as a pick would set it.
    (select.querySelector('[role="combobox"]') as HTMLElement).click();
    await settle();
    const http = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.trim() === 'HTTP',
    )!;
    await click(http);
    expect(slots.assign).toHaveBeenCalledWith({ index: 2, file: 'cam.mjpeg', transport: 'http' });
    vi.unstubAllGlobals();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it('Start and Stop: a file through the server, a webcam through the cameras, a pull with Stop pulling', async () => {
    await open();
    await click(button('Start'));
    expect(slots.start).toHaveBeenCalledWith({ index: 2 });

    slots.update(2, { state: 'playing' });
    await fixture.whenStable();
    slots.stop.mockRejectedValueOnce(
      new ApiRequestError(409, 'This source is now published by a different session', null),
    );
    await click(button('Stop'));
    expect(slots.stop).toHaveBeenCalledWith({ index: 2 });
    expect(toasts.error).toHaveBeenCalledWith(
      'This source is now published by a different session',
    );

    fixture.destroy();
    cameras.assignments.set(new Map([[3, CAMERAS[0]]]));
    slots.slots.set([
      slot(3, { type: 'webcam', codec: 'h264', transport: 'rtsp', allowed_transports: ['rtsp'] }),
    ]);
    await open(3);
    await click(button('Start'));
    expect(cameras.publish).toHaveBeenCalledWith(3);
    slots.update(3, { state: 'playing' });
    await fixture.whenStable();
    await click(button('Stop'));
    expect(cameras.release).toHaveBeenCalledWith(3);

    // While the slot is changing its controls wait.
    cameras.changingSlots.set(new Set([3]));
    await fixture.whenStable();
    expect(button('Stop')!.disabled).toBe(true);

    fixture.destroy();
    slots.slots.set([
      slot(5, {
        state: 'pulled',
        pull: {
          status: 'live',
          scheme: 'rtsp',
          host: '10.0.0.7:554',
          path: '/stream1',
          error: null,
          since: '2026-10-24T08:00:00Z',
          codec_supported: true,
          width: 1920,
          height: 1080,
          fps: 25,
          bitrate_bps: 4_000_000,
        },
      }),
    ]);
    await open(5);
    expect(button('Start')).toBeUndefined();
    await click(button('Stop pulling'));
    expect(slots.stop).toHaveBeenLastCalledWith({ index: 5 });
  });

  it('a webcam slot without a camera picked in this browser cannot start', async () => {
    slots.slots.set([
      slot(3, { type: 'webcam', codec: 'h264', transport: 'rtsp', allowed_transports: ['rtsp'] }),
    ]);
    await open(3);
    expect(button('Start')!.disabled).toBe(true);
  });

  it('Take over asks first and disconnects; a 409 shows the server message', async () => {
    slots.slots.set([
      slot(4, {
        state: 'external',
        codec: 'h264',
        readers: [{ protocol: 'rtsp', address: '10.42.0.79' }],
        external: {
          protocol: 'rtsp',
          address: '192.168.1.20:41234',
          since: '2026-10-24T08:00:00Z',
          codec_supported: true,
          width: 1280,
          height: 720,
          fps: 30,
          bitrate_bps: 2_000_000,
        },
      }),
    ]);
    await open(4);
    expect(button('Start')).toBeUndefined();
    await click(button('Take over…'));
    const question = confirmDialog()!;
    expect(text(question)).toContain('Disconnect external stream on src4?');
    expect(text(question)).toContain('⇢ RTSP · 192.168.1.20:41234 · 1280×720 · 30 fps');
    expect(text(question)).toContain('Readers: 1 · 10.42.0.79');
    expect(text(question)).toContain(
      'The publisher and all readers will be disconnected. src4 becomes Idle and you can assign a file to it.',
    );
    await click(buttonIn(question, 'Cancel'));
    expect(slots.takeOver).not.toHaveBeenCalled();

    await click(button('Take over…'));
    await click(buttonIn(confirmDialog()!, 'Disconnect'));
    expect(slots.takeOver).toHaveBeenCalledExactlyOnceWith(4);
    expect(toasts.status).toHaveBeenCalledWith('Disconnected the external stream on src4.');

    slots.takeOver.mockRejectedValueOnce(
      new ApiRequestError(409, 'A new external publisher took src4; try again.', null),
    );
    await click(button('Take over…'));
    await click(buttonIn(confirmDialog()!, 'Disconnect'));
    expect(toasts.error).toHaveBeenCalledWith('A new external publisher took src4; try again.');
  });

  it('details: output, URL, readers; and for a publisher or a pull, its source, video, live for and bitrate', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-24T08:12:04Z'));
    slots.slots.set([
      fileSlot(2, {
        state: 'playing',
        fps: 15,
        active_file: '.renditions/walk_15fps.mp4',
        readers: [{ protocol: 'rtsp', address: '127.0.0.1', label: 'insight preview' }],
      }),
      slot(5, {
        state: 'pulled',
        codec: 'h265',
        readers: [],
        pull: {
          status: 'unreachable',
          scheme: 'rtsp',
          host: '10.0.0.7:554',
          path: '/stream1?token=***',
          error: 'connection refused',
          since: '2026-10-24T08:00:00Z',
          codec_supported: false,
          width: 1920,
          height: 1080,
          fps: 25,
          bitrate_bps: 850_000,
        },
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
      Status: 'Unreachable · connection refused',
      Video: 'H.265 · 1920×1080 · 25 fps',
      URL: 'rtsp://10.0.0.2:8554/src5 Copy',
      'Live for': '12m 04s',
      Bitrate: '850 kbit/s',
      Readers: '0',
    });
    vi.useRealTimers();
  });

  it('Copy copies the URL, and reports a refused clipboard', async () => {
    await open();
    await click(button('Copy stream URL for src2'));
    expect(writeText).toHaveBeenCalledWith('rtsp://10.0.0.2:8554/src2');
    expect(toasts.status).toHaveBeenCalledWith('Copied: rtsp://10.0.0.2:8554/src2');

    writeText.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    await click(button('Copy stream URL for src2'));
    expect(toasts.error).toHaveBeenCalledWith(
      'Could not copy the URL: the browser refused access to the clipboard.',
    );

    // Until the codec is known there is no stream to copy.
    slots.update(2, { codec: 'unknown', allowed_transports: [] });
    await fixture.whenStable();
    expect(button('Copy stream URL for src2')!.disabled).toBe(true);
  });
});
