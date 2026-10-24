import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatSelect } from '@sima/neat-ui/select';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { BoardService } from '../../board/board.service';
import { boardState, DEVKIT, FakeBoard, FakePeripherals } from '../../board/board.testing';
import type { CameraItem, PreviewSession } from '../../peripherals/api';
import { CameraPreview } from '../../peripherals/camera-preview';
import {
  format,
  imx477,
  imx568,
  NOT_IN_OVERLAYS,
  previewSession,
  sel,
  size,
  support,
  usb,
} from '../../peripherals/cameras.testing';
import { PeripheralsSession } from '../../peripherals/peripherals-session';
import { PeripheralsService } from '../../peripherals/peripherals.service';
import { peripheralSnapshot } from '../../peripherals/snapshots.testing';
import { TopBarDialogs } from '../../top-bar-dialogs';
import { CameraPanel } from './camera-panel';

const PREVIEW_URL = '/api/peripherals/preview';
const START_URL = '/api/peripherals/cameras/preview';
const stopUrl = (id: string) => `${START_URL}/${id}/stop`;
const badGateway = { status: 502, statusText: 'Bad Gateway' };

/** The imx477 with two Available sizes, so a size can be changed while it streams. */
const imx477Two: CameraItem = {
  ...imx477,
  formats: [
    format('NV12', 'NV12 (YUV 4:2:0)', true, support('available'), [
      size(1920, 1080, [30, 'available']),
      size(1280, 720, [60, 'available']),
    ]),
  ],
};
const usbMjpg = sel('MJPG', 1280, 720, 30);
const usbLive = previewSession({
  id: '77ab',
  camera_id: usb.id,
  mode: usbMjpg,
  stream_url: '/api/peripherals/cameras/preview/77ab/stream',
  camera_fps: 30,
});

@Component({
  imports: [CameraPanel],
  providers: [CameraPreview],
  template: `<app-camera-panel [camera]="camera()" />`,
})
class Host {
  readonly camera = signal<CameraItem>(imx477);
}

describe('CameraPanel', () => {
  let http: HttpTestingController;
  let board: FakeBoard;
  let peripherals: FakePeripherals;
  let dialogs: { openBoard: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<Host>;
  let preview: CameraPreview;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(Date.parse('2026-10-25T10:00:30Z'));
    // A hidden tab: the live preview's watch reads nothing (camera-preview.spec covers it).
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    // jsdom has no ResizeObserver, which the kit's select measures its list with.
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
    board = new FakeBoard();
    board.state.set(boardState({ target: DEVKIT, generation: 3 }));
    peripherals = new FakePeripherals();
    peripherals.snapshot.set(peripheralSnapshot([imx477, usb]));
    dialogs = { openBoard: vi.fn(async () => undefined) };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: BoardService, useValue: board },
        { provide: PeripheralsService, useValue: peripherals },
        { provide: TopBarDialogs, useValue: dialogs },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Host);
    preview = fixture.debugElement.injector.get(CameraPreview);
  });

  afterEach(() => {
    // Every request a test caused was answered and checked: a stray stop or start fails it.
    http.verify();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const root = (): HTMLElement => fixture.nativeElement;
  const panel = (): HTMLElement => root().querySelector('app-camera-panel')!;

  /** Lets the requests and promise chains behind an answer run, then renders. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 3; turn++) {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    }
  }

  async function show(camera: CameraItem): Promise<void> {
    fixture.componentInstance.camera.set(camera);
    await settle();
  }

  const title = (): string => panel().querySelector('h2')!.textContent!.trim();
  const titleChip = (): string =>
    panel().querySelector('app-panel-title neat-status-chip')!.textContent!.trim();
  /** The status line's sentence; '' when there is none. */
  const statusLine = (): string => panel().querySelector('.status > p')?.textContent?.trim() ?? '';
  /** #170's preview status beside the status line, as its words and tone; null when idle. */
  const statusChip = (): { label: string; tone: string } | null => {
    const chip = fixture.debugElement
      .queryAll(By.directive(NeatStatusChip))
      .find((debug) => panel().querySelector('.status')!.contains(debug.nativeElement));
    return chip
      ? { label: chip.nativeElement.textContent.trim(), tone: chip.componentInstance.tone() }
      : null;
  };
  const announced = (): string =>
    panel().querySelector('app-announcement')!.textContent!.trim();
  const image = (): HTMLImageElement | null => panel().querySelector('app-preview-frame img');
  const button = (label: string): HTMLButtonElement | undefined =>
    [...panel().querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent!.trim() === label,
    );
  const mainButton = (): HTMLButtonElement =>
    panel().querySelector<HTMLButtonElement>('.actions button')!;
  const reason = (): string | undefined => {
    const id = mainButton().getAttribute('aria-describedby');
    return id ? panel().querySelector(`#${id}`)?.textContent?.trim() : undefined;
  };
  const notes = (): string[] =>
    [...panel().querySelectorAll(':scope > p[neatNote]')].map((note) => note.textContent!.trim());
  const callouts = () =>
    [
      ...panel().querySelectorAll<HTMLElement>(
        ':scope > neat-callout, :scope > app-device-errors > neat-callout',
      ),
    ].map((callout) => ({
      heading: callout.querySelector('[role="heading"]')?.textContent?.trim() ?? '',
      text: callout.textContent!.replace(/\s+/g, ' ').trim(),
      element: callout,
    }));
  const select = (label: string) =>
    fixture.debugElement
      .queryAll(By.directive(NeatSelect))
      .find((debug) => debug.componentInstance.label() === label)!;
  const selected = (label: string): string =>
    select(label)
      .nativeElement.querySelector('[data-slot="select-value"]')!
      .textContent!.trim();
  /** Picks an option as the user would; `neat-select` reports the pick through its model. */
  async function pick(label: string, value: string): Promise<void> {
    select(label).componentInstance.value.set(value);
    await settle();
  }

  async function startPreview(): Promise<void> {
    mainButton().click();
    await settle();
  }

  it('reads top to bottom: title and chip, preview, status line, the two pickers, Start/Stop, Details', async () => {
    await settle();
    expect(title()).toBe(imx477.name);
    expect(titleChip()).toBe('Available');
    expect(
      fixture.debugElement.query(By.directive(NeatStatusChip)).componentInstance.tone(),
    ).toBe('success');

    const parts = [...panel().children]
      .filter((child) => child.tagName !== 'APP-ANNOUNCEMENT')
      .map((child) => child.tagName.toLowerCase() + (child.className ? `.${child.className}` : ''));
    expect(parts).toEqual([
      'app-panel-title',
      'app-preview-frame',
      'div.status',
      'app-device-errors',
      'div.modes',
      'div.actions',
      'app-device-details',
    ]);
    expect(statusLine()).toBe('Not running');
    // Idle needs no chip: the sentence says it, and the title's chip names the camera's state.
    expect(statusChip()).toBeNull();
    expect(image()).toBeNull();
    expect(select('Pixel format').componentInstance.showLabel()).toBe(true);
    expect(selected('Pixel format')).toBe('NV12 (YUV 4:2:0)');
    expect(selected('Resolution')).toBe('1920×1080');
    expect(mainButton().textContent!.trim()).toBe('Start preview');
    expect(mainButton().disabled).toBe(false);
    // The panel's Details is closed until opened.
    expect(
      panel()
        .querySelector('app-device-details button[aria-expanded]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  // Ruling F4: the title names the camera's own state, never the preview's: the status chip does.
  it("the title's chip is the camera's own (its tier, or Last scan), whatever the preview does", async () => {
    await settle();
    preview.adopt(previewSession());
    await settle();
    expect(titleChip()).toBe('Available');
    expect(statusChip()).toEqual({ label: 'Live', tone: 'success' });
    expect(panel().textContent).not.toContain('Previewing');

    await show(usb);
    expect(titleChip()).toBe('Unsupported');
    await show({ ...imx477, modes_source: 'previous-scan' });
    expect(titleChip()).toBe('Last scan');
  });

  it('the status line names size, format and up to N fps once live', async () => {
    await settle();
    preview.adopt(previewSession({ camera_fps: null }));
    await settle();
    // A MIPI camera's rate arrives after the start: none is named before it is known.
    expect(statusLine()).toBe('Live preview · 1920×1080 · NV12');
    expect(statusChip()).toEqual({ label: 'Live', tone: 'success' });
    expect(announced()).toBe('Preview live');

    preview.adopt(previewSession({ camera_fps: 66.18 }));
    await settle();
    // Its rate is the most the sensor delivers in the mode, so it reads "up to".
    expect(statusLine()).toBe('Live preview · 1920×1080 · NV12 · up to 66 fps');

    // A USB camera's rate is its mode's.
    await show(usb);
    preview.adopt(usbLive);
    await settle();
    expect(statusLine()).toBe('Live preview · 1280×720 · MJPG · 30 fps');

    // Only a MIPI camera's rate is a ceiling (#170): a connection the backend names otherwise
    // reads its rate as it is.
    const other: CameraItem = { ...imx477, id: 'gmsl:cam0', connection: 'gmsl' };
    await show(other);
    preview.adopt(previewSession({ camera_id: other.id, camera_fps: 66.18 }));
    await settle();
    expect(statusLine()).toBe('Live preview · 1920×1080 · NV12 · 66 fps');
  });

  it('Start is blocked with the reason under it; a mode change while live restarts the preview', async () => {
    // The scan shown is of the board before a change.
    board.state.set(boardState({ target: DEVKIT, generation: 4 }));
    await show(imx477Two);
    expect(mainButton().disabled).toBe(true);
    expect(reason()).toBe('The board changed after this scan. Refresh before starting a preview.');

    // Refreshed: the scan is of the board selected now.
    peripherals.snapshot.set(peripheralSnapshot([imx477Two, usb], { generation: 4 }));
    await settle();
    expect(mainButton().disabled).toBe(false);
    expect(mainButton().hasAttribute('aria-describedby')).toBe(false);

    await startPreview();
    const start = http.expectOne({ method: 'POST', url: START_URL });
    expect(start.request.body).toEqual({ id: imx477Two.id, ...sel('NV12', 1920, 1080, 30) });
    start.flush({ session: previewSession({ generation: 4 }) });
    await settle();
    expect(mainButton().textContent!.trim()).toBe('Stop preview');

    await pick('Resolution', '1280x720');
    // The wanted mode is remembered for the camera, and the live preview restarts on it.
    expect(TestBed.inject(PeripheralsSession).modes().get(imx477Two.id)).toEqual(
      sel('NV12', 1280, 720, 60),
    );
    http.expectOne({ method: 'POST', url: stopUrl('8f1c') }).flush({ session: null });
    await settle();
    const restart = http.expectOne({ method: 'POST', url: START_URL });
    expect(restart.request.body).toEqual({ id: imx477Two.id, ...sel('NV12', 1280, 720, 60) });
    restart.flush({
      session: previewSession({ id: '9a2d', generation: 4, mode: sel('NV12', 1280, 720, 60) }),
    });
    await settle();
    expect(statusLine()).toBe('Live preview · 1280×720 · NV12');
    expect(selected('Resolution')).toBe('1280×720');
  });

  // Spec, "Camera panel": another tab shows "In another tab" with Stop (final review I-3).
  it('In another tab shows its status, the sentence, Stop and no image', async () => {
    await settle();
    preview.adopt({ ...previewSession(), viewer: true });
    await settle();
    expect(image()).toBeNull();
    expect(statusChip()).toEqual({ label: 'In another tab', tone: 'info' });
    expect(statusLine()).toBe('This preview is showing in another tab or window.');
    expect(mainButton().textContent!.trim()).toBe('Stop preview');

    mainButton().click();
    await settle();
    http.expectOne({ method: 'POST', url: stopUrl('8f1c') }).flush({ session: null });
    await settle();
    expect(statusLine()).toBe('Not running');
  });

  it('a preview error shows its recovery line and the board output folded', async () => {
    await settle();
    await startPreview();
    http.expectOne({ method: 'POST', url: START_URL }).flush(
      {
        error: 'The preview pipeline could not start.',
        code: 'command_failed',
        detail: 'ERROR: from element /GstPipeline:pipeline0/GstLibcameraSrc',
      },
      badGateway,
    );
    await settle();
    const [failure] = callouts();
    expect(failure.heading).toBe('The preview pipeline could not start.');
    expect(failure.element.getAttribute('role')).toBe('alert');
    // No hint from the backend: the recovery line is Insight's own for the code.
    expect(failure.text).toContain(
      'The preview pipeline could not start on the board. The board output below says why.',
    );
    const output = failure.element.querySelector<HTMLElement>('neat-collapsible')!;
    const outputTrigger = output.querySelector('button[aria-expanded]')!;
    expect(outputTrigger.textContent!.trim()).toBe('Board output');
    expect(outputTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(output.querySelector('pre')?.textContent).toBe(
      'ERROR: from element /GstPipeline:pipeline0/GstLibcameraSrc',
    );
    expect(button('Open board settings')).toBeUndefined();
    // The Start row stays, as the retry. The callout says why, so no sentence repeats the chip.
    expect(statusChip()).toEqual({ label: 'Could not start', tone: 'danger' });
    expect(statusLine()).toBe('');
    expect(mainButton().textContent!.trim()).toBe('Start preview');

    // A connection failure offers the board settings; the backend's hint is the recovery line.
    await startPreview();
    http.expectOne({ method: 'POST', url: START_URL }).flush(
      {
        error: 'Could not connect to sima@192.168.1.20.',
        code: 'unreachable',
        hint: 'Check that the board is powered on.',
      },
      badGateway,
    );
    await settle();
    expect(callouts()[0].text).toContain('Check that the board is powered on.');
    expect(callouts()[0].text).not.toContain('Board output');
    button('Open board settings')!.click();
    expect(dialogs.openBoard).toHaveBeenCalledTimes(1);
  });

  it('a menu that mixes tiers names the tier of each entry that is not Available', async () => {
    await settle();
    expect(
      select('Resolution')
        .componentInstance.options()
        .map((option: { label: string }) => option.label),
    ).toEqual(['1920×1080', '1280×720 · Unsupported']);
    // One tier only: the entries are named by their size alone.
    await show(imx477Two);
    expect(
      select('Resolution')
        .componentInstance.options()
        .map((option: { label: string }) => option.label),
    ).toEqual(['1920×1080', '1280×720']);
  });

  it('a mode picked while the board starts the preview is started once the first start answers', async () => {
    await show(imx477Two);
    await startPreview();
    const first = http.expectOne({ method: 'POST', url: START_URL });
    await pick('Resolution', '1280x720');
    // No session yet, so nothing to stop: the start in flight is stopped once it answers.
    http.expectNone({ method: 'POST', url: stopUrl('8f1c') });
    first.flush({ session: previewSession() });
    await settle();
    http.expectOne({ method: 'POST', url: stopUrl('8f1c') }).flush({ session: null });
    await settle();
    const restart = http.expectOne({ method: 'POST', url: START_URL });
    expect(restart.request.body).toEqual({ id: imx477Two.id, ...sel('NV12', 1280, 720, 60) });
    restart.flush({ session: previewSession({ id: '9a2d', mode: sel('NV12', 1280, 720, 60) }) });
    await settle();
    expect(statusLine()).toBe('Live preview · 1280×720 · NV12');
  });

  it("a mode picked for a camera leaves another camera's preview alone", async () => {
    await settle();
    preview.adopt(previewSession());
    await show(usb);
    await pick('Pixel format', 'YUYV');
    expect(TestBed.inject(PeripheralsSession).modes().get(usb.id)).toEqual(
      sel('YUYV', 640, 480, 30),
    );
    // No stop, no start (afterEach verifies): the imx477's preview streams on.
    expect(preview.state().status).toBe('live');
    expect(preview.state().session?.camera_id).toBe(imx477.id);
  });

  // #170's PreviewPane.test.js, adapted to the panel (ruling F7).

  it('Start preview sends the selected mode', async () => {
    await settle();
    await startPreview();
    const start = http.expectOne({ method: 'POST', url: START_URL });
    expect(start.request.body).toEqual({ id: imx477.id, ...sel('NV12', 1920, 1080, 30) });
    expect(statusLine()).toBe('Starting the camera on the board… 0 s');
    expect(statusChip()).toEqual({ label: 'Starting…', tone: 'info' });
    expect(announced()).toBe('Starting the preview');
    vi.advanceTimersByTime(3000);
    await settle();
    expect(statusLine()).toBe('Starting the camera on the board… 3 s');
    start.flush({ session: previewSession() });
    await settle();
  });

  it("another camera's retained preview is not shown as this camera's video", async () => {
    await settle();
    preview.adopt(previewSession());
    void preview.stop();
    http
      .expectOne({ method: 'POST', url: stopUrl('8f1c') })
      .flush({ error: 'Could not stop the preview.', code: 'unreachable' }, badGateway);
    await settle();

    await show(usb);
    expect(image()).toBeNull();
    expect(button('Stop preview')).toBeUndefined();
    expect(mainButton().textContent!.trim()).toBe('Start preview');
    expect(mainButton().disabled).toBe(true);
    expect(reason()).toMatch(/already running on mipi:\/base\/axi\/pcie@120000/);
    expect(statusLine()).toBe('Not running');
    expect(callouts()).toEqual([]);

    // The camera that owns it still shows its video, the failure and Stop to retry.
    await show(imx477);
    expect(image()).not.toBeNull();
    expect(button('Stop preview')).toBeDefined();
    expect(callouts()[0].heading).toBe('Could not stop the preview.');
  });

  it('a live preview shows the relayed stream in an img and reports a stream it cannot load', async () => {
    await settle();
    preview.adopt(previewSession());
    await settle();
    expect(image()?.getAttribute('src')).toBe('/api/peripherals/cameras/preview/8f1c/stream');
    expect(image()?.alt).toBe(`Live preview of ${imx477.name}`);
    expect(panel().querySelector('iframe')).toBeNull();

    image()!.dispatchEvent(new Event('error'));
    await settle();
    http.expectOne({ method: 'GET', url: PREVIEW_URL }).flush({ session: null });
    await settle();
    expect(image()).toBeNull();
    expect(statusLine()).toBe('Not running');
    expect(callouts()[0].heading).toBe('The preview stream stopped.');

    // A stream address that is not Insight's own API path is never loaded.
    preview.adopt(previewSession({ stream_url: 'https://evil.example/x' }));
    await settle();
    expect(image()).toBeNull();
    expect(statusLine()).toBe(
      'The preview stream could not be opened. Stop the preview and report it with the board label.',
    );
  });

  it('a USB camera can start a preview of any mode it lists in a format the preview reads', async () => {
    await show(usb);
    expect(selected('Pixel format')).toBe('Motion-JPEG');
    expect(mainButton().disabled).toBe(false);
    await startPreview();
    const start = http.expectOne({ method: 'POST', url: START_URL });
    expect(start.request.body).toEqual({ id: usb.id, ...usbMjpg });
    start.flush({ session: usbLive });
    await settle();
    expect(statusLine()).toBe('Live preview · 1280×720 · MJPG · 30 fps');
  });

  it('Start is disabled for a USB format the backend cannot preview, with the reason', async () => {
    const h264: CameraItem = {
      ...usb,
      formats: [...usb.formats, { ...usb.formats[0], format: 'H264', label: 'H.264' }],
    };
    await show(h264);
    await pick('Pixel format', 'H264');
    expect(mainButton().disabled).toBe(true);
    expect(reason()).toMatch(/not H264\. Choose another format\.$/);
  });

  it("the status line names the camera's rate once known, and no rate before a preview", async () => {
    await settle();
    // Insight sets no rate: before a preview the line names none.
    expect(statusLine()).toBe('Not running');
    for (const camera_fps of [null, 66.18]) {
      preview.adopt(previewSession({ camera_fps }));
      await settle();
      expect(statusLine()).toBe(
        camera_fps === null
          ? 'Live preview · 1920×1080 · NV12'
          : 'Live preview · 1920×1080 · NV12 · up to 66 fps',
      );
    }
  });

  it('a preview another tab shows is one line with Stop, never a second stream', async () => {
    await settle();
    preview.adopt({ ...previewSession(), viewer: true } satisfies PreviewSession);
    await settle();
    expect(panel().querySelectorAll('img')).toHaveLength(0);
    expect(statusLine()).toBe('This preview is showing in another tab or window.');
    expect(button('Stop preview')).toBeDefined();
  });

  it("a failed start's board output is folded, so the error stays one row", async () => {
    await settle();
    await startPreview();
    http.expectOne({ method: 'POST', url: START_URL }).flush(
      {
        error: 'The preview pipeline could not start.',
        code: 'command_failed',
        detail: 'ERROR: from element /GstPipeline...',
      },
      badGateway,
    );
    await settle();
    const details = callouts()[0].element.querySelector('neat-collapsible')!;
    expect(details.querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
    expect(details.querySelector('pre')).not.toBeNull();
  });

  it('a start with no session yet offers no Stop, since there is no preview to stop', async () => {
    await settle();
    await startPreview();
    expect(button('Stop preview')).toBeUndefined();
    // The one button keeps its place (and the focus), waiting.
    expect(mainButton().textContent!.trim()).toBe('Start preview');
    expect(mainButton().getAttribute('aria-disabled')).toBe('true');
    mainButton().click();
    http.expectOne({ method: 'POST', url: START_URL }).flush({ session: previewSession() });
    await settle();
    expect(button('Stop preview')).toBeDefined();

    mainButton().click();
    await settle();
    expect(mainButton().textContent!.trim()).toBe('Stopping…');
    expect(mainButton().getAttribute('aria-disabled')).toBe('true');
    expect(statusLine()).toBe('Stopping the preview…');
    expect(statusChip()).toEqual({ label: 'Stopping…', tone: 'info' });
    expect(announced()).toBe('Stopping the preview');
    http.expectOne({ method: 'POST', url: stopUrl('8f1c') }).flush({ session: null });
    await settle();
    expect(statusLine()).toBe('Not running');
  });

  // #170's model.test.js "the detail pane shows one explanation line, chosen by priority", at the panel.
  it('the panel shows one explanation line, chosen by priority', async () => {
    await show(imx568);
    expect(notes()).toEqual([NOT_IN_OVERLAYS]);
    expect(panel().querySelector('app-panel-title + p[neatNote]')?.textContent?.trim()).toBe(
      NOT_IN_OVERLAYS,
    );
    // An Available camera and a USB camera say nothing there.
    await show(imx477);
    expect(notes()).toEqual([]);
    await show(usb);
    expect(notes()).toEqual([]);
  });

  it('a mode that vanished says so, and a camera without a usable mode says why', async () => {
    TestBed.inject(PeripheralsSession).setMode(imx477.id, sel('NV12', 3840, 2160, 30));
    await settle();
    const notice = panel().querySelector('p[role="status"]');
    expect(notice?.textContent?.trim()).toBe(
      'NV12 3840×2160 is no longer offered; showing NV12 1920×1080.',
    );

    const rawOnly: CameraItem = {
      ...imx568,
      formats: [format('RGB888', 'RGB888', false, support('unsupported'), [size(1920, 1080)])],
    };
    await show(rawOnly);
    expect(panel().querySelector('neat-select')).toBeNull();
    const [none] = callouts();
    expect(none.heading).toBe('No usable modes');
    expect(none.element.getAttribute('tone')).toBe('warning');
    expect(none.text).toContain(
      'None of the formats this camera reports can be used. Open the list below for the reason for each one.',
    );
    const blocked = none.element.querySelector('neat-collapsible')!;
    expect(blocked.querySelector('button')!.textContent!.trim()).toBe(
      '1 format cannot be used (RGB888)',
    );
    expect(blocked.querySelector('li')!.textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'RGB888: no sizes with a frame rate were reported for it.',
    );
    expect(mainButton().disabled).toBe(true);
    expect(reason()).toBe(NOT_IN_OVERLAYS);

    // Modes that could not be read: the camera's error above says why.
    await show({
      ...rawOnly,
      formats: [],
      modes_source: 'unavailable',
      errors: [
        {
          code: 'no_modes',
          message: 'SiMa Sentinel reported no modes for this camera.',
          hint: 'Run sima-sentinel status on the board.',
        },
      ],
    });
    expect(callouts().map((callout) => callout.heading)).toEqual([
      'SiMa Sentinel reported no modes for this camera.',
      'No usable modes',
    ]);
    expect(callouts()[0].text).toContain('Run sima-sentinel status on the board.');
    expect(callouts()[1].text).toContain(
      'Modes could not be read from this camera; the message above says why and how to fix it.',
    );
  });
});
