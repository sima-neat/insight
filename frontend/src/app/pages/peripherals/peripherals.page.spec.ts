import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router, RouterOutlet } from '@angular/router';
import { NeatIcon, NeatShell, type NeatTone } from '@sima/neat-ui';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { BoardState } from '../../board/api';
import { boardState, DEVKIT } from '../../board/board.testing';
import { FakeLocalStorage } from '../../fake-storage.testing';
import type { MicrophoneItem, PeripheralSnapshot, PreviewSession } from '../../peripherals/api';
import { CameraPreview } from '../../peripherals/camera-preview';
import { imx477, previewSession, sel, usb } from '../../peripherals/cameras.testing';
import { MicTest } from '../../peripherals/mic-test';
import { yeti } from '../../peripherals/microphones.testing';
import { PeripheralsSession } from '../../peripherals/peripherals-session';
import { peripheralSnapshot } from '../../peripherals/snapshots.testing';
import { TopBarDialogs } from '../../top-bar-dialogs';
import { PeripheralsPage } from './peripherals.page';

const BOARD_URL = '/api/board';
const LOAD_URL = '/api/peripherals';
const REFRESH_URL = '/api/peripherals/refresh';
const PREVIEW_URL = '/api/peripherals/preview';
const START_URL = '/api/peripherals/cameras/preview';
const MIC_TEST_URL = '/api/peripherals/microphones/test';
const stopUrl = (id: string) => `${START_URL}/${id}/stop`;

const mode30 = sel('NV12', 1920, 1080, 30);
const live30 = previewSession();
/** The webcam's microphone: the same USB device as the C270 camera. */
const webcamMic: MicrophoneItem = {
  ...yeti,
  device: { ...yeti.device, part_of: { id: usb.id, name: usb.name } },
};
// Checked already: an unknown state would make the board service check it as the app starts.
const devkit = boardState({
  target: DEVKIT,
  generation: 3,
  status: { state: 'connected', checked_at: '2026-10-25T10:00:00Z', error: null },
});
const unreachable = {
  error: 'Could not connect to sima@192.168.1.20.',
  code: 'unreachable',
  hint: '',
};
const badGateway = { status: 502, statusText: 'Bad Gateway' };
const serverError = { status: 500, statusText: 'Internal Server Error' };

/** The app frame, so the page's toolbar has a top bar to render into. */
@Component({
  imports: [NeatShell, RouterOutlet],
  template: `<neat-shell appName="Neat Insight" [navItems]="[]"><router-outlet /></neat-shell>`,
})
class Shell {}

@Component({ template: '' })
class Elsewhere {}

describe('PeripheralsPage', () => {
  let http: HttpTestingController;
  let toasts: { status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let dialogs: { openBoard: ReturnType<typeof vi.fn> };
  let storage: FakeLocalStorage;
  let fixture: ComponentFixture<Shell>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(Date.parse('2026-10-25T10:00:30Z'));
    // A hidden tab: the live preview's watch reads nothing, so every preview read in these tests
    // is the page's own (camera-preview.spec covers the watch).
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    storage = new FakeLocalStorage();
    vi.stubGlobal('localStorage', storage);
    // jsdom has no ResizeObserver; the device list watches its width to give up narrow columns.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {
          // jsdom lays nothing out, so no width ever changes.
        }
        unobserve(): void {
          // Nothing observed.
        }
        disconnect(): void {
          // Nothing observed.
        }
      },
    );
    toasts = { status: vi.fn(), error: vi.fn() };
    dialogs = { openBoard: vi.fn(async () => undefined) };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'peripherals', component: PeripheralsPage },
          { path: 'elsewhere', component: Elsewhere },
        ]),
        { provide: NeatToasts, useValue: toasts },
        { provide: TopBarDialogs, useValue: dialogs },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Shell);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const root = (): HTMLElement => fixture.nativeElement;
  /** Lets the requests and promise chains behind an answer run, then renders. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 3; turn++) {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    }
  }

  /** Answers every pending request to `url` with `body` (or a failure with its status). */
  function answer(
    method: 'GET' | 'POST',
    url: string,
    body: object,
    status?: { status: number; statusText: string },
  ): number {
    const requests = http.match({ method, url });
    for (const request of requests) request.flush(body, status);
    return requests.length;
  }

  const posts = (url: string) => http.match({ method: 'POST', url });

  /** Opens Peripherals and answers what it reads as it opens. */
  async function visit({
    board = devkit,
    snapshot = peripheralSnapshot([usb, imx477, webcamMic]),
    preview = null,
  }: {
    board?: BoardState;
    snapshot?: PeripheralSnapshot;
    preview?: PreviewSession | null;
  } = {}): Promise<void> {
    await TestBed.inject(Router).navigateByUrl('/peripherals');
    await settle();
    answer('GET', BOARD_URL, board);
    answer('GET', LOAD_URL, snapshot);
    answer('GET', PREVIEW_URL, { session: preview });
    await settle();
  }

  /** Answers the scan a visit started, with `snapshot`, and the board read that ends it. */
  async function endScan(snapshot: PeripheralSnapshot): Promise<void> {
    answer('POST', REFRESH_URL, snapshot);
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
  }

  async function leave(): Promise<void> {
    await TestBed.inject(Router).navigateByUrl('/elsewhere');
    await settle();
  }

  /** What the page provides for itself: its camera preview and microphone test. */
  const pageInjector = () => fixture.debugElement.query(By.directive(PeripheralsPage)).injector;

  const toolbar = (): HTMLElement => root().querySelector('.page-toolbar')!;
  const refreshButton = (): HTMLButtonElement =>
    [...toolbar().querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      /^(Refresh|Scanning…)/.test(button.textContent!.trim()),
    )!;
  const listbox = (): HTMLElement | null => root().querySelector('[role="listbox"]');
  /** The device list as its group headings, each muted or not, with their rows' cells. */
  const groups = () =>
    [...listbox()!.querySelectorAll<HTMLElement>('[role="group"]')].map((group) => {
      const heading = group.querySelector<HTMLElement>('[data-slot="select-list-group-heading"]')!;
      return {
        heading: heading.textContent!.trim(),
        muted: heading.classList.contains('text-muted-foreground'),
        rows: [...group.querySelectorAll<HTMLElement>('[role="option"]')].map(cells),
      };
    });
  const cells = (row: HTMLElement): string[] =>
    [...row.querySelectorAll(':scope > div')].map((cell) =>
      cell.textContent!.replace(/\s+/g, ' ').trim(),
    );
  const rows = (): HTMLElement[] => [
    ...(listbox()?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
  ];
  const rowOf = (name: string): HTMLElement =>
    rows().find((row) => cells(row)[1].startsWith(name))!;
  const chipOf = (name: string): string => cells(rowOf(name))[3];
  const selectedRow = () => rows().find((row) => row.getAttribute('aria-selected') === 'true');
  const iconOf = (row: HTMLElement): string =>
    fixture.debugElement
      .queryAll(By.directive(NeatIcon))
      .find((debug) => row.contains(debug.nativeElement))!
      .componentInstance.name();
  const toneOf = (row: HTMLElement): NeatTone =>
    fixture.debugElement
      .queryAll(By.directive(NeatStatusChip))
      .find((debug) => row.contains(debug.nativeElement))!
      .componentInstance.tone();
  const aside = (): HTMLElement | null => root().querySelector('aside');
  const calloutHeadings = (): string[] =>
    [...root().querySelectorAll('neat-callout [role="heading"]')].map((heading) =>
      heading.textContent!.trim(),
    );
  const status = (): string => root().querySelector('app-announcement')?.textContent?.trim() ?? '';
  /** The tooltip, which the kit shows on focus (with a zero delay). */
  async function tooltip(button: HTMLElement): Promise<string | undefined> {
    // jsdom lays nothing out: give the overlay a viewport and the button a box inside it.
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1366);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
    button.getBoundingClientRect = () => new DOMRect(1000, 12, 120, 32);
    button.dispatchEvent(new FocusEvent('focus'));
    // Its zero delay is an RxJS timer, which runs on the faked setInterval.
    vi.advanceTimersByTime(1);
    await settle();
    return document.querySelector('[role="tooltip"]')?.textContent?.trim();
  }
  const buttonNamed = (label: string): HTMLButtonElement | undefined =>
    [...root().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === label,
    );

  it('lists devices under Cameras · N, Microphones · N and LiDAR · none found, with icon, name, connection and chip', async () => {
    await visit();
    expect(listbox()!.getAttribute('aria-label')).toBe('Devices');
    expect(groups()).toEqual([
      {
        heading: 'Cameras · 2',
        muted: false,
        rows: [
          ['', imx477.name, 'MIPI CSI', 'Available'],
          ['', 'HD Webcam C270', 'USB 2.0', 'Unsupported'],
        ],
      },
      {
        heading: 'Microphones · 1',
        muted: false,
        rows: [['', 'Yeti Nano Part of HD Webcam C270', 'USB', 'Available']],
      },
      { heading: 'LiDAR · none found', muted: true, rows: [] },
    ]);
    expect(rows().map(iconOf)).toEqual(['camera', 'camera', 'microphone']);
    expect(rows().map(toneOf)).toEqual(['success', 'neutral', 'success']);
    // The subtitle is muted text after the name.
    expect(rowOf('Yeti Nano').querySelector('.subtitle')?.textContent?.trim()).toBe(
      'Part of HD Webcam C270',
    );
    // The first device is selected, and shown in the side panel.
    expect(selectedRow()).toBe(rowOf(imx477.name));
    expect(aside()?.querySelector('h2')?.textContent?.trim()).toBe(imx477.name);
    // Scanned 30 s before now: said in the top bar, ageing every 10 s.
    expect(toolbar().textContent).toContain('Scanned 30 s ago');
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(toolbar().textContent).toContain('Scanned 1 min ago');
  });

  // F27: the spec greys a kind with no devices, not scanned yet, or unsupported.
  it('a kind Insight has no view for is a muted heading even with devices, its rows Not supported yet', async () => {
    const lidar = (id: string) => ({
      id,
      kind: 'lidar',
      connection: 'ethernet',
      name: `Ouster ${id}`,
      device: {},
      availability: { state: 'unknown' as const, users: [], reason: null },
      notes: [],
      errors: [],
    });
    const noted = { ...lidar('os-1'), notes: ['Reported by a newer SiMa Sentinel.'] };
    await visit({ snapshot: peripheralSnapshot([imx477, noted, lidar('os-2')]) });
    expect(groups()[2]).toEqual({
      heading: 'LiDAR · 2',
      muted: true,
      rows: [
        ['', 'Ouster os-1', 'Ethernet', 'Not supported yet'],
        ['', 'Ouster os-2', 'Ethernet', 'Not supported yet'],
      ],
    });
    expect(iconOf(rowOf('Ouster os-1'))).toBe('lidar');

    // Its panel says so, under its name and chip, with what the backend reports in Details.
    rowOf('Ouster os-1').click();
    await settle();
    expect(aside()!.querySelector('h2')?.textContent?.trim()).toBe('Ouster os-1');
    expect(aside()!.querySelector('app-panel-title neat-status-chip')?.textContent?.trim()).toBe(
      'Not supported yet',
    );
    expect(aside()!.querySelector('p[neatNote]')?.textContent?.trim()).toBe(
      'Insight does not read this device kind yet.',
    );
    expect(aside()!.querySelector('app-camera-panel')).toBeNull();
    expect(aside()!.querySelector('app-device-details li')?.textContent?.trim()).toBe(
      'Reported by a newer SiMa Sentinel.',
    );
  });

  // F23: the list belongs to the page, so the page tells each row what this page does with it.
  it('rows say Previewing for the camera this page previews and Testing for the microphone it tests', async () => {
    await visit();
    const preview = pageInjector().get(CameraPreview);
    const started = preview.start(imx477, mode30, 3);
    answer('POST', START_URL, { session: live30 });
    await started;
    await settle();
    expect(chipOf(imx477.name)).toBe('Previewing');
    expect(toneOf(rowOf(imx477.name))).toBe('info');
    expect(chipOf('HD Webcam C270')).toBe('Unsupported');

    void pageInjector().get(MicTest).start(webcamMic, 3);
    await settle();
    expect(chipOf('Yeti Nano')).toBe('Testing');
    expect(toneOf(rowOf('Yeti Nano'))).toBe('info');

    await leave();
    answer('POST', stopUrl(live30.id), { session: null });
    http.match(MIC_TEST_URL).forEach((request) => request.flush({ test: null }));
  });

  it('scans on every visit: a failed scan, or a snapshot already scanned, does not spare the next one', async () => {
    await visit({ snapshot: peripheralSnapshot(null) });
    const [scan] = posts(REFRESH_URL);
    expect(scan).toBeDefined();
    expect(status()).toBe('Scanning sima@192.168.1.20');
    scan.flush(unreachable, badGateway);
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
    expect(status()).toBe('');

    await leave();
    await visit({ snapshot: peripheralSnapshot(null) });
    const [again] = posts(REFRESH_URL);
    expect(again).toBeDefined();
    again.flush(peripheralSnapshot([imx477]));
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
    expect(calloutHeadings()).not.toContain('Scan failed: Could not connect to sima@192.168.1.20.');

    // Scanned already, and scanned again.
    await leave();
    await visit({ snapshot: peripheralSnapshot([imx477]) });
    expect(posts(REFRESH_URL)).toHaveLength(1);
  });

  it("a visit's scan is silent when it succeeds, and says so when it fails", async () => {
    await visit({ snapshot: peripheralSnapshot(null) });
    await endScan(peripheralSnapshot([imx477]));
    expect(toasts.status).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
    expect(rowOf(imx477.name)).toBeDefined();

    await leave();
    await visit();
    posts(REFRESH_URL)[0].flush(unreachable, badGateway);
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
    expect(calloutHeadings()).toContain('Scan failed: Could not connect to sima@192.168.1.20.');
    expect(toasts.status).not.toHaveBeenCalled();
  });

  it('scans nothing on a visit without a board target', async () => {
    await visit({ board: boardState({ generation: 3 }) });
    expect(posts(REFRESH_URL)).toHaveLength(0);
  });

  // The backend stops a running preview for a scan, so a preview started before the visit's scan
  // would end without a word.
  it("starts the preview the last visit left running only after this visit's scan", async () => {
    TestBed.inject(PeripheralsSession).resume = {
      cameraId: imx477.id,
      mode: mode30,
      generation: 3,
    };
    await visit({ snapshot: peripheralSnapshot([usb, imx477]) });
    const [scan] = posts(REFRESH_URL);
    expect(scan).toBeDefined();
    expect(posts(START_URL)).toHaveLength(0);

    scan.flush(peripheralSnapshot([usb, imx477]));
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
    const [restart] = posts(START_URL);
    expect(restart.request.body).toEqual({ id: imx477.id, ...mode30 });
    restart.flush({ session: live30 });
    await settle();
    expect(chipOf(imx477.name)).toBe('Previewing');
    await leave();
    answer('POST', stopUrl(live30.id), { session: null });
  });

  it("the preview the last visit left running is not started after a visit's scan that failed", async () => {
    TestBed.inject(PeripheralsSession).resume = {
      cameraId: imx477.id,
      mode: mode30,
      generation: 3,
    };
    await visit({ snapshot: peripheralSnapshot([usb, imx477]) });
    posts(REFRESH_URL)[0].flush(unreachable, badGateway);
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
    expect(calloutHeadings()).toContain('Scan failed: Could not connect to sima@192.168.1.20.');
    expect(posts(START_URL)).toHaveLength(0);
    expect(pageInjector().get(CameraPreview).state().status).toBe('idle');
  });

  it("a preview the user starts during the visit's scan is not started again afterwards", async () => {
    TestBed.inject(PeripheralsSession).resume = {
      cameraId: imx477.id,
      mode: mode30,
      generation: 3,
    };
    await visit({ snapshot: peripheralSnapshot([usb, imx477]) });
    const [scan] = posts(REFRESH_URL);
    const started = pageInjector().get(CameraPreview).start(imx477, mode30, 3);
    answer('POST', START_URL, { session: live30 });
    await started;

    scan.flush(peripheralSnapshot([usb, imx477]));
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
    expect(posts(START_URL)).toHaveLength(0);
    await leave();
    answer('POST', stopUrl(live30.id), { session: null });
  });

  it('Refresh shows Scanning… N s, stops the preview first and toasts the result', async () => {
    await visit({ preview: live30 });
    // The visit's own scan ended.
    await endScan(peripheralSnapshot([usb, imx477, webcamMic]));
    expect(refreshButton().textContent!.trim()).toBe('Refresh');
    refreshButton().click();
    await settle();
    // The preview stops before the scan: the backend would stop it anyway, and say nothing. A
    // second press while it stops waits with the first rather than scanning past the stop.
    refreshButton().click();
    await settle();
    expect(posts(REFRESH_URL)).toHaveLength(0);
    const stops = posts(stopUrl(live30.id));
    expect(stops).toHaveLength(1);
    stops[0].flush({ session: null });
    await settle();
    const scans = posts(REFRESH_URL);
    expect(scans).toHaveLength(1);
    const [scan] = scans;
    expect(refreshButton().textContent!.trim()).toBe('Scanning… 0 s');
    expect(refreshButton().getAttribute('aria-disabled')).toBe('true');
    // #170's busy section: the list is being replaced.
    expect(root().querySelector('app-list-column')!.getAttribute('aria-busy')).toBe('true');

    vi.advanceTimersByTime(3000);
    await settle();
    expect(refreshButton().textContent!.trim()).toBe('Scanning… 3 s');
    // A press while it scans is not a second scan.
    refreshButton().click();
    await settle();
    expect(posts(REFRESH_URL)).toHaveLength(0);

    scan.flush(peripheralSnapshot([imx477, webcamMic], { scanned_at: '2026-10-25T10:00:33Z' }));
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
    expect(toasts.status).toHaveBeenCalledExactlyOnceWith(
      'Scan complete: 1 camera, 1 microphone on sima@192.168.1.20.',
    );
    expect(refreshButton().textContent!.trim()).toBe('Refresh');
    expect(refreshButton().hasAttribute('aria-disabled')).toBe(false);
    expect(root().querySelector('app-list-column')!.hasAttribute('aria-busy')).toBe(false);
    expect(toolbar().textContent).toContain('Scanned just now');
  });

  // Review Focus 1, at the page: another tab, the board dialog or a re-read on focus switched it.
  it('shows the board-changed banner and blocks preview while the snapshot is for another generation', async () => {
    await visit({ preview: live30 });
    await endScan(peripheralSnapshot([usb, imx477, webcamMic]));
    expect(chipOf(imx477.name)).toBe('Previewing');

    window.dispatchEvent(new Event('focus'));
    answer('GET', BOARD_URL, boardState({ target: DEVKIT, generation: 4 }));
    await settle();
    expect(calloutHeadings()).toEqual(['Board changed — refresh']);
    expect(status()).toBe('The board changed. Refresh before starting a preview.');
    // The backend stopped the old board's preview with the change: it is let go of, unstopped.
    expect(pageInjector().get(CameraPreview).state().status).toBe('idle');
    expect(chipOf(imx477.name)).toBe('Available');
    expect(posts(stopUrl(live30.id))).toHaveLength(0);
    // The camera's Start waits for a refresh, and says so.
    const start = aside()!.querySelector<HTMLButtonElement>('app-camera-panel .actions button')!;
    expect(start.textContent!.trim()).toBe('Start preview');
    expect(start.disabled).toBe(true);
    expect(aside()!.textContent).toContain(
      'The board changed after this scan. Refresh before starting a preview.',
    );

    // Leaving records nothing to start again, and stops nothing.
    await leave();
    expect(posts(stopUrl(live30.id))).toHaveLength(0);
    expect(TestBed.inject(PeripheralsSession).resume).toBeNull();

    // A preview left on the old board is never started on the new one.
    TestBed.inject(PeripheralsSession).resume = {
      cameraId: imx477.id,
      mode: mode30,
      generation: 3,
    };
    await visit({
      board: boardState({ target: DEVKIT, generation: 4 }),
      snapshot: peripheralSnapshot([imx477], { generation: 4 }),
    });
    expect(posts(START_URL)).toHaveLength(0);
    expect(TestBed.inject(PeripheralsSession).resume).toBeNull();
  });

  it('a connection failure offers Open board settings; issues and the change summary show above the list', async () => {
    await visit({ snapshot: peripheralSnapshot(null) });
    posts(REFRESH_URL)[0].flush(unreachable, badGateway);
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
    expect(calloutHeadings()).toEqual(['Scan failed: Could not connect to sima@192.168.1.20.']);
    buttonNamed('Open board settings')!.click();
    expect(dialogs.openBoard).toHaveBeenCalledTimes(1);

    refreshButton().click();
    await settle();
    posts(REFRESH_URL)[0].flush(
      peripheralSnapshot([imx477], {
        changes: { added: [{ id: imx477.id, name: 'imx477' }], removed: [] },
        issues: [
          { severity: 'warning', code: 'c', message: 'Camera overlays unknown.', hint: null },
        ],
      }),
    );
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
    expect(calloutHeadings()).toEqual(['Warning']);
    const banners = root().querySelector('app-peripherals-banners')!;
    expect(banners.textContent).toContain('New: imx477');
    expect(banners.textContent).toContain('Camera overlays unknown.');
    expect(
      banners.compareDocumentPosition(listbox()!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Spec: leaving Peripherals stops the preview, coming back starts it again (Review Focus 2).
  it('leaving with a live preview stops it and coming back starts it again once', async () => {
    await visit();
    const started = pageInjector().get(CameraPreview).start(imx477, mode30, 3);
    answer('POST', START_URL, { session: live30 });
    await started;

    await leave();
    expect(answer('POST', stopUrl(live30.id), { session: null })).toBe(1);
    await settle();

    await visit({ snapshot: peripheralSnapshot([usb, imx477]) });
    await endScan(peripheralSnapshot([usb, imx477]));
    const [restart] = posts(START_URL);
    expect(restart.request.body).toEqual({ id: imx477.id, ...mode30 });
    expect(posts(START_URL)).toHaveLength(0);
    restart.flush({ session: { ...live30, id: '9a2d', stream_url: `${START_URL}/9a2d/stream` } });
    await settle();
    expect(selectedRow()).toBe(rowOf(imx477.name));
    expect(chipOf(imx477.name)).toBe('Previewing');
    expect(TestBed.inject(PeripheralsSession).resume).toBeNull();

    // Without a preview to come back to, coming back starts nothing.
    const stopped = pageInjector().get(CameraPreview).stop();
    answer('POST', stopUrl('9a2d'), { session: null });
    await stopped;
    await leave();
    await visit();
    expect(posts(START_URL)).toHaveLength(0);
  });

  // Task 12's M-1: the previous visit's start still runs on the board when the page comes back.
  it("coming back while the last visit's start is still out waits for it to stop before starting again", async () => {
    await visit();
    void pageInjector().get(CameraPreview).start(imx477, mode30, 3);
    const [late] = posts(START_URL);
    await leave();

    await TestBed.inject(Router).navigateByUrl('/peripherals');
    await settle();
    answer('GET', BOARD_URL, devkit);
    answer('GET', LOAD_URL, peripheralSnapshot([imx477]));
    await settle();
    // The running preview is not read, and nothing started, while the old start is out.
    http.expectNone(PREVIEW_URL);
    expect(posts(START_URL)).toHaveLength(0);

    late.flush({ session: live30 });
    await settle();
    http.expectNone(PREVIEW_URL);
    answer('POST', stopUrl(live30.id), { session: null });
    await settle();
    answer('GET', PREVIEW_URL, { session: null });
    await settle();
    await endScan(peripheralSnapshot([imx477]));
    const [restart] = posts(START_URL);
    expect(restart.request.body).toEqual({ id: imx477.id, ...mode30 });
  });

  it('a preview running at entry is adopted with its camera and mode', async () => {
    const webcam = previewSession({
      id: 'c270',
      camera_id: usb.id,
      mode: sel('MJPG', 1280, 720, 30),
      stream_url: `${START_URL}/c270/stream`,
    });
    // A preview left running when the page was last left loses to the one running now.
    TestBed.inject(PeripheralsSession).resume = {
      cameraId: imx477.id,
      mode: mode30,
      generation: 3,
    };
    await visit({ preview: webcam });
    expect(selectedRow()).toBe(rowOf('HD Webcam C270'));
    expect(chipOf('HD Webcam C270')).toBe('Previewing');
    expect(TestBed.inject(PeripheralsSession).modes().get(usb.id)).toEqual(
      sel('MJPG', 1280, 720, 30),
    );
    expect(pageInjector().get(CameraPreview).state().status).toBe('live');
    expect(posts(START_URL)).toHaveLength(0);
    expect(TestBed.inject(PeripheralsSession).resume).toBeNull();
    // The scan would make the backend stop the preview just taken up: a visit never does that.
    expect(posts(REFRESH_URL)).toHaveLength(0);
  });

  it('a preview running at entry opens the side panel it shows in, rather than being stopped', async () => {
    storage.values.set('neat-insight:peripherals:aside', 'closed');
    await visit({ preview: live30 });
    expect(aside()?.querySelector('app-camera-panel app-preview-frame img')?.getAttribute('src')).toBe(
      live30.stream_url,
    );
    expect(storage.values.get('neat-insight:peripherals:aside')).toBe('open');
    expect(posts(stopUrl(live30.id))).toHaveLength(0);
    expect(posts(REFRESH_URL)).toHaveLength(0);
    expect(pageInjector().get(CameraPreview).state().status).toBe('live');
    await leave();
    answer('POST', stopUrl(live30.id), { session: null });
  });

  /**
   * Presses the shown camera's Start, which the backend refuses because `running` already runs
   * (another tab, or a client of the API, started it after this page read the preview); the page
   * then reads the running preview, as #170 did.
   */
  async function startRefusedFor(running: PreviewSession): Promise<void> {
    startButton().click();
    await settle();
    answer(
      'POST',
      START_URL,
      {
        error: `A preview of ${running.camera_id} is already starting or running.`,
        code: 'preview_active',
        hint: 'Stop that preview before starting another one.',
        camera_id: running.camera_id,
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    answer('GET', PREVIEW_URL, { session: running });
    await settle();
  }
  const startButton = (): HTMLButtonElement =>
    aside()!.querySelector<HTMLButtonElement>('app-camera-panel .actions button')!;
  const webcamLive = previewSession({
    id: 'c270',
    camera_id: usb.id,
    mode: sel('MJPG', 1280, 720, 30),
    stream_url: `${START_URL}/c270/stream`,
  });

  // Final review I-1 (Review Focus 3): a refused Start takes the running preview up the way
  // entering the page does, rather than leaving it, which stopped it.
  it("a Start refused for another camera's preview selects that camera and its mode, and stops nothing", async () => {
    await visit();
    expect(selectedRow()).toBe(rowOf(imx477.name));
    await startRefusedFor(webcamLive);

    expect(selectedRow()).toBe(rowOf('HD Webcam C270'));
    expect(aside()!.querySelector('app-camera-panel h2')?.textContent?.trim()).toBe(
      'HD Webcam C270',
    );
    expect(TestBed.inject(PeripheralsSession).modes().get(usb.id)).toEqual(
      sel('MJPG', 1280, 720, 30),
    );
    // Nobody showed it yet, so it shows here, live.
    expect(pageInjector().get(CameraPreview).state()).toEqual({
      status: 'live',
      session: webcamLive,
      error: null,
    });
    expect(
      aside()!.querySelector('app-camera-panel app-preview-frame img')?.getAttribute('src'),
    ).toBe(webcamLive.stream_url);
    expect(chipOf('HD Webcam C270')).toBe('Previewing');
    await settle();
    expect(posts(stopUrl(webcamLive.id))).toHaveLength(0);
    expect(posts(START_URL)).toHaveLength(0);

    // It is this page's now: leaving stops it, as it would one adopted on entry.
    await leave();
    expect(answer('POST', stopUrl(webcamLive.id), { session: null })).toBe(1);
  });

  it('a Start refused for a preview another tab shows selects its camera, in another tab, with Stop', async () => {
    const shownThere = { ...webcamLive, viewer: true };
    await visit();
    await startRefusedFor(shownThere);

    expect(selectedRow()).toBe(rowOf('HD Webcam C270'));
    expect(pageInjector().get(CameraPreview).state().status).toBe('elsewhere');
    expect(aside()!.querySelector('app-camera-panel')!.textContent).toContain(
      'This preview is showing in another tab or window.',
    );
    expect(startButton().textContent!.trim()).toBe('Stop preview');
    await settle();
    expect(posts(stopUrl(webcamLive.id))).toHaveLength(0);

    // The other tab's to stop: leaving lets go of it.
    await leave();
    expect(posts(stopUrl(webcamLive.id))).toHaveLength(0);
  });

  it('a Start refused for the same camera in another mode remembers that mode, so the pickers match the video', async () => {
    const running60 = previewSession({
      id: '9a2d',
      mode: sel('NV12', 1920, 1080, 60),
      stream_url: `${START_URL}/9a2d/stream`,
    });
    await visit();
    await startRefusedFor(running60);

    expect(selectedRow()).toBe(rowOf(imx477.name));
    expect(TestBed.inject(PeripheralsSession).modes().get(imx477.id)).toEqual(
      sel('NV12', 1920, 1080, 60),
    );
    expect(pageInjector().get(CameraPreview).state().session).toEqual(running60);
    await settle();
    expect(posts(stopUrl(running60.id))).toHaveLength(0);
    await leave();
    answer('POST', stopUrl(running60.id), { session: null });
  });

  it('a Start refused for a camera the scan does not list says so, and leaves that preview alone', async () => {
    const unlisted = previewSession({
      id: 'e4d1',
      camera_id: 'mipi:/base/axi/i2c@88000/imx477@1a',
      stream_url: `${START_URL}/e4d1/stream`,
    });
    await visit();
    await startRefusedFor(unlisted);

    // No panel could show it: taking it up would only leave it again, which stops it.
    expect(selectedRow()).toBe(rowOf(imx477.name));
    const state = pageInjector().get(CameraPreview).state();
    expect(state.status).toBe('error');
    expect(state.error?.code).toBe('preview_active');
    expect(aside()!.textContent).toContain(
      'The running preview is on mipi:/base/axi/i2c@88000/imx477@1a.',
    );
    await settle();
    expect(posts(stopUrl(unlisted.id))).toHaveLength(0);
    await leave();
    expect(posts(stopUrl(unlisted.id))).toHaveLength(0);
  });

  // Ruling F4: the row says Previewing (F23); the panel's title names the camera's own state and
  // the status chip the preview's, so the panel never shows Previewing beside Live.
  it("the side panel shows the selected camera's panel, titled with the camera's own chip", async () => {
    await visit({ preview: live30 });
    expect(chipOf(imx477.name)).toBe('Previewing');
    const panel = aside()!.querySelector('app-camera-panel')!;
    expect(panel.querySelector('h2')?.textContent?.trim()).toBe(imx477.name);
    expect(panel.querySelector('app-panel-title neat-status-chip')?.textContent?.trim()).toBe(
      'Available',
    );
    expect(panel.querySelector('.status neat-status-chip')?.textContent?.trim()).toBe('Live');
    expect(panel.textContent).not.toContain('Previewing');
    expect(panel.querySelector('app-preview-frame img')?.getAttribute('src')).toBe(
      live30.stream_url,
    );
    await leave();
    answer('POST', stopUrl(live30.id), { session: null });
  });

  it('leaving a camera stops its preview: another device selected, or the side panel closed', async () => {
    await visit({ preview: live30 });
    const preview = pageInjector().get(CameraPreview);
    rowOf('HD Webcam C270').click();
    await settle();
    expect(answer('POST', stopUrl(live30.id), { session: null })).toBe(1);
    await settle();
    expect(preview.state().status).toBe('idle');

    // Back on the camera, started again from its panel; then the side panel closes.
    rowOf(imx477.name).click();
    await settle();
    aside()!.querySelector<HTMLButtonElement>('app-camera-panel .actions button')!.click();
    await settle();
    answer('POST', START_URL, { session: live30 });
    await settle();
    expect(preview.state().status).toBe('live');
    toolbar().querySelector<HTMLButtonElement>('neat-aside-toggle button')!.click();
    await settle();
    expect(answer('POST', stopUrl(live30.id), { session: null })).toBe(1);
    await settle();
    expect(preview.state().status).toBe('idle');
  });

  it('no target and a failed board read replace the list with their callouts', async () => {
    await TestBed.inject(Router).navigateByUrl('/peripherals');
    await settle();
    // Loading: the board's first read and the snapshot's are out.
    expect(root().textContent).toContain('Loading peripherals…');
    expect(listbox()).toBeNull();
    answer('GET', BOARD_URL, boardState());
    answer(
      'GET',
      LOAD_URL,
      { error: 'No board is selected.', code: 'no_target', hint: '' },
      { status: 409, statusText: 'Conflict' },
    );
    answer('GET', PREVIEW_URL, { session: null });
    await settle();
    expect(listbox()).toBeNull();
    expect(calloutHeadings()).toEqual(['No board selected']);
    expect(root().textContent).toContain(
      'Insight needs a board before it can discover peripherals.',
    );
    buttonNamed('Choose a board')!.click();
    expect(dialogs.openBoard).toHaveBeenCalledTimes(1);
    // Nothing to scan, and no Refresh until a board is chosen.
    expect(posts(REFRESH_URL)).toHaveLength(0);
    // Final review M-5: it keeps the focus (aria-disabled), so a keyboard reaches its tooltip.
    expect(refreshButton().disabled).toBe(false);
    expect(refreshButton().getAttribute('aria-disabled')).toBe('true');
    refreshButton().click();
    await settle();
    expect(posts(REFRESH_URL)).toHaveLength(0);
    expect(await tooltip(refreshButton())).toBe('Select a board first');

    // A board read that fails with no state to fall back on says why, with the board settings.
    await leave();
    await visit();
    window.dispatchEvent(new Event('focus'));
    answer('GET', BOARD_URL, { error: 'Bad gateway' }, badGateway);
    await settle();
    // A last good state is kept: the list stays, and the pill shows the error.
    expect(listbox()).not.toBeNull();
    expect(aside()?.querySelector('h2')?.textContent?.trim()).toBe(imx477.name);

    // The board loses its target: no device of the old scan stays in the side panel.
    window.dispatchEvent(new Event('focus'));
    answer('GET', BOARD_URL, boardState({ generation: 4 }));
    await settle();
    expect(calloutHeadings()).toContain('No board selected');
    expect(aside()?.querySelector('h2')).toBeNull();
  });

  it('a board that cannot be read at all says why, with the board settings', async () => {
    await TestBed.inject(Router).navigateByUrl('/peripherals');
    await settle();
    answer('GET', BOARD_URL, { error: 'Internal Server Error' }, serverError);
    answer('GET', LOAD_URL, peripheralSnapshot(null));
    answer('GET', PREVIEW_URL, { session: null });
    await settle();
    expect(listbox()).toBeNull();
    expect(root().querySelector('app-board-problem-notice')?.textContent).toContain(
      'Internal Server Error',
    );
    buttonNamed('Open board settings')!.click();
    expect(dialogs.openBoard).toHaveBeenCalledTimes(1);
    expect(posts(REFRESH_URL)).toHaveLength(0);
  });

  // Ruling Q9: Peripherals says what failed (Review Focus 4).
  it('a failed read of the peripherals says what failed above the list', async () => {
    await TestBed.inject(Router).navigateByUrl('/peripherals');
    await settle();
    answer('GET', BOARD_URL, devkit);
    answer('GET', LOAD_URL, { error: 'Internal Server Error' }, serverError);
    answer('GET', PREVIEW_URL, { session: null });
    await settle();
    expect(calloutHeadings()).toEqual(['Could not load peripherals: Internal Server Error']);
    expect(groups().map((group) => group.heading)).toEqual([
      'Cameras · not scanned yet',
      'Microphones · not scanned yet',
      'LiDAR · not scanned yet',
    ]);

    // A scan that answers says the peripherals were read after all: the failure goes (#170).
    refreshButton().click();
    await settle();
    posts(REFRESH_URL)[0].flush(peripheralSnapshot([imx477]));
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
    expect(calloutHeadings()).toEqual([]);
    expect(groups()[0].heading).toBe('Cameras · 1');
  });

  it('keeps the selection across rescans, a removed device included, and across visits', async () => {
    await visit();
    rowOf('Yeti Nano').click();
    await settle();
    expect(selectedRow()).toBe(rowOf('Yeti Nano'));
    // Its panel is the microphone's, which reads the board's test as it opens.
    expect(aside()!.querySelector('app-microphone-panel h2')?.textContent?.trim()).toBe(
      'Yeti Nano',
    );
    expect(answer('GET', MIC_TEST_URL, { test: null })).toBe(1);

    // A rescan still listing it keeps it.
    refreshButton().click();
    await settle();
    posts(REFRESH_URL)[0].flush(peripheralSnapshot([imx477, webcamMic]));
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
    expect(selectedRow()).toBe(rowOf('Yeti Nano'));

    // One reporting it removed keeps it selected, for its panel to say it is gone.
    refreshButton().click();
    await settle();
    posts(REFRESH_URL)[0].flush(
      peripheralSnapshot([imx477], {
        changes: { added: [], removed: [{ id: webcamMic.id, name: 'Yeti Nano' }] },
      }),
    );
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
    expect(selectedRow()).toBeUndefined();
    expect(aside()?.querySelector('neat-callout [role="heading"]')?.textContent?.trim()).toBe(
      'Yeti Nano is no longer detected',
    );
    expect(aside()!.querySelector('neat-callout')!.getAttribute('tone')).toBe('info');
    expect(aside()!.textContent).toContain(
      'It was disconnected since the last refresh. Reconnect it and refresh, or pick another device from the list.',
    );

    // Coming back finds it where it was left.
    await leave();
    expect(TestBed.inject(PeripheralsSession).selectedId).toBe(webcamMic.id);
    await visit({ snapshot: peripheralSnapshot([usb, imx477, webcamMic]) });
    expect(selectedRow()).toBe(rowOf('Yeti Nano'));

    // Gone from a later scan and not reported removed: the first device instead.
    refreshButton().click();
    await settle();
    posts(REFRESH_URL)[0].flush(peripheralSnapshot([usb]));
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
    expect(selectedRow()).toBe(rowOf('HD Webcam C270'));
  });

  // F28: #170's guidance, the MIPI power-off advice included, when there is no device to show.
  it('the side panel guides an unscanned board and an empty scan', async () => {
    await visit({ snapshot: peripheralSnapshot(null) });
    expect(aside()?.textContent?.trim()).toBe('Scanning sima@192.168.1.20…');
    posts(REFRESH_URL)[0].flush(unreachable, badGateway);
    await settle();
    answer('GET', BOARD_URL, devkit);
    await settle();
    // Hidden while the scan failure explains why there is nothing.
    expect(aside()?.textContent?.trim()).toBe('');

    // Another board, whose scan finds nothing.
    await leave();
    await visit({
      board: boardState({ target: DEVKIT, generation: 5 }),
      snapshot: peripheralSnapshot(null, { generation: 5 }),
    });
    posts(REFRESH_URL)[0].flush(
      peripheralSnapshot([], {
        generation: 5,
        issues: [{ severity: 'info', code: 'a', message: 'No overlays.', hint: null }],
      }),
    );
    await settle();
    answer('GET', BOARD_URL, boardState({ target: DEVKIT, generation: 5 }));
    await settle();
    const text = aside()!.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('No cameras detected on sima@192.168.1.20');
    expect(text).toContain(
      'Check the notes above. Connect a camera (power the board off before attaching a MIPI camera), then refresh.',
    );
    expect(text).toContain('No microphones detected on sima@192.168.1.20');
    expect(text).toContain('Connect a USB microphone, then refresh.');
  });

  it('remembers whether the side panel is open, as peripherals', async () => {
    await visit();
    const toggle = toolbar().querySelector<HTMLButtonElement>('neat-aside-toggle button')!;
    toggle.click();
    await settle();
    expect(aside()).toBeNull();
    expect(storage.values.get('neat-insight:peripherals:aside')).toBe('closed');

    // Enter on a row opens it: the device's controls are there.
    listbox()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(aside()).not.toBeNull();
  });
});
