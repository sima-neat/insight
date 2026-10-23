import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, RouterOutlet } from '@angular/router';
import { NeatShell } from '@sima/neat-ui';
import { NeatConfirm } from '@sima/neat-ui/confirm';
import { NeatToasts } from '@sima/neat-ui/toast';
import type {
  AutoAssignResult,
  BulkStartResult,
  MediaNode,
  ReleasedWebcam,
  RenditionsCleared,
  RenditionUsage,
  ResetResult,
  Slot,
  StopAllResult,
} from '../../sources/api';
import { CamerasService } from '../../sources/cameras.service';
import { MediaLibraryService } from '../../sources/media-library.service';
import type { Progress } from '../../sources/progress-lines';
import { SlotsService } from '../../sources/slots.service';
import { ApiRequestError } from '../../sources/stream-lines';
import type { Camera } from '../../sources/webcam-publishing';
import { StreamingPage } from './streaming.page';

function slot(index: number, overrides: Partial<Slot> = {}): Slot {
  return {
    index,
    file: '',
    state: 'stopped',
    transport: '',
    codec: '',
    type: 'file',
    allowed_transports: [],
    urls: {},
    ...overrides,
  };
}

/**
 * The 48 slots with one of each kind near the top: a playing file, an idle file at a custom rate,
 * a webcam, an external publisher with a codec Neat cannot decode, a live pull and an unreachable
 * one. Everything else is unassigned. Four slots are assigned and not held by a publisher.
 */
function mixedSlots(): Slot[] {
  const slots = Array.from({ length: 48 }, (_, index) => slot(index + 1));
  slots[0] = slot(1, {
    file: 'people/walk.mp4',
    state: 'playing',
    codec: 'h264',
    transport: 'rtsp',
    native_fps: 30,
    fps: null,
  });
  slots[1] = slot(2, { file: 'cars.mp4', codec: 'h265', native_fps: 25, fps: 15 });
  slots[2] = slot(3, { type: 'webcam', codec: 'h264', transport: 'rtsp' });
  slots[3] = slot(4, {
    state: 'external',
    codec: 'av1',
    external: {
      protocol: 'rtsp',
      address: '192.168.1.20:41234',
      since: '2026-10-24T08:00:00Z',
      codec_supported: false,
      width: 1280,
      height: 720,
      fps: 30,
      bitrate_bps: 2_000_000,
    },
  });
  slots[4] = slot(5, {
    file: 'under.mp4',
    state: 'pulled',
    codec: 'h264',
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
  });
  slots[5] = slot(6, {
    state: 'pulled',
    codec: 'none',
    pull: {
      status: 'unreachable',
      scheme: 'rtsp',
      host: '10.0.0.8:554',
      path: '/stream1',
      error: 'connection refused',
      since: null,
      codec_supported: true,
      width: null,
      height: null,
      fps: null,
      bitrate_bps: null,
    },
  });
  slots[6] = slot(7, { file: 'idle.mp4', codec: 'h264', native_fps: 30 });
  return slots;
}

const RELEASED: ReleasedWebcam[] = [{ index: 3, session: 'whip-1' }];

/** `SlotsService` as the page uses it: its signals set by the test, its actions recorded. */
class FakeSlots {
  readonly slots = signal<readonly Slot[] | null>(null);
  readonly unavailable = signal(false);
  readonly renditions = signal<RenditionUsage | null>(null);
  readonly encodes = signal<ReadonlyMap<number, Progress>>(new Map());
  watchers = 0;
  readonly watch = vi.fn(() => {
    this.watchers++;
    let released = false;
    return () => {
      if (!released) this.watchers--;
      released = true;
    };
  });
  readonly refreshRenditions = vi.fn(async () => undefined);
  readonly startBulk = vi.fn<(count: number) => Promise<BulkStartResult>>();
  readonly stopAll = vi.fn<(released: readonly ReleasedWebcam[]) => Promise<StopAllResult>>();
  readonly reset = vi.fn<(released: readonly ReleasedWebcam[]) => Promise<ResetResult>>();
  readonly autoAssign = vi.fn<(released: readonly ReleasedWebcam[]) => Promise<AutoAssignResult>>();
  readonly clearRenditions = vi.fn<() => Promise<RenditionsCleared>>();
}

class FakeCameras {
  readonly assignments = signal<ReadonlyMap<number, Camera>>(new Map());
  readonly anyChanging = signal(false);
  readonly releaseAll = vi.fn((options?: { clearAssignments?: boolean }) => {
    void options;
    return RELEASED;
  });
}

/** A library with streamable files, unless a test sets another answer (or none). */
class FakeLibrary {
  readonly tree = signal<readonly MediaNode[] | null>([
    { name: '/people', path: 'people', type: 'folder', streamable_count: 1, children: [] },
    { name: 'cars.mp4', path: 'cars.mp4', type: 'file', streamable: true },
  ]);
  readonly refresh = vi.fn(async () => undefined);
}

const bulkResult = (message: string) => ({
  success: true as const,
  skipped_external: [4],
  skipped_pulled: [5, 6],
  unconfirmed_webcams: [],
  changed_sources: [],
  message,
});

/** The app frame, so the page's toolbar has a top bar to render into. */
@Component({
  imports: [NeatShell, RouterOutlet],
  template: `<neat-shell appName="Neat Insight" [navItems]="[]"><router-outlet /></neat-shell>`,
})
class Shell {}

@Component({ template: '' })
class Elsewhere {}

describe('StreamingPage', () => {
  let slots: FakeSlots;
  let cameras: FakeCameras;
  let library: FakeLibrary;
  let toasts: { error: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<Shell>;

  beforeEach(() => {
    slots = new FakeSlots();
    cameras = new FakeCameras();
    library = new FakeLibrary();
    toasts = { error: vi.fn(), status: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'streaming', component: StreamingPage },
          { path: 'elsewhere', component: Elsewhere },
        ]),
        { provide: SlotsService, useValue: slots },
        { provide: CamerasService, useValue: cameras },
        { provide: MediaLibraryService, useValue: library },
        { provide: NeatToasts, useValue: toasts },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const root = (): HTMLElement => fixture.nativeElement;
  const settle = () => fixture.whenStable();
  /** Lets an overlay open or close: it moves focus after rendering and closes a frame later. */
  async function settleOverlay(): Promise<void> {
    for (let turn = 0; turn < 3; turn++) {
      await new Promise((resolve) => setTimeout(resolve));
      await settle();
    }
  }

  async function open(answer: readonly Slot[] | null = mixedSlots()): Promise<void> {
    slots.slots.set(answer);
    fixture = TestBed.createComponent(Shell);
    await TestBed.inject(Router).navigateByUrl('/streaming');
    await settle();
  }

  const toolbar = (): HTMLElement => root().querySelector('.page-toolbar')!;
  const toolbarButton = (name: string): HTMLButtonElement =>
    [...toolbar().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name,
    )!;
  const filter = (label: string): HTMLButtonElement =>
    [...toolbar().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) =>
      radio.textContent?.trim().startsWith(label),
    )!;
  const listbox = (): HTMLElement => root().querySelector('[role="listbox"]')!;
  const rows = (): HTMLElement[] => [...listbox().querySelectorAll<HTMLElement>('[role="option"]')];
  /** A row's cells as their text, in column order, without the warning glyph. */
  const cells = (row: HTMLElement): string[] =>
    [...row.querySelectorAll(':scope > div')].map((cell) => {
      const shown = cell.cloneNode(true) as HTMLElement;
      shown.querySelectorAll('[role="img"]').forEach((glyph) => glyph.remove());
      return shown.textContent!.trim();
    });
  const rowOf = (name: string): HTMLElement => rows().find((row) => cells(row)[0] === name)!;
  const aside = (): HTMLElement | null => root().querySelector('aside');
  const asideHeading = () => aside()?.querySelector('h2')?.textContent?.trim();
  const notice = () => root().querySelector('[role="status"]')?.textContent?.trim() ?? '';
  const morePanel = () => document.querySelector('[role="dialog"][aria-label="More actions"]');
  const menuItem = (label: string): HTMLButtonElement =>
    [...(morePanel()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) =>
      button.textContent?.trim().startsWith(label),
    )!;
  const confirmDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const confirmText = () =>
    [...(confirmDialog()?.querySelectorAll('h2, p, button') ?? [])]
      .map((part) => part.textContent?.trim())
      .join(' ');
  const bulkDialog = () => document.querySelector<HTMLElement>('neat-dialog-panel');

  async function click(element: HTMLElement): Promise<void> {
    element.click();
    await settleOverlay();
  }

  async function press(element: HTMLElement, key: string): Promise<void> {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await settle();
  }

  async function answer(dialog: HTMLElement, label: string): Promise<void> {
    [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === label)!
      .click();
    await settleOverlay();
  }

  async function openMore(): Promise<void> {
    await click(toolbarButton('More actions'));
    expect(morePanel()).not.toBeNull();
  }

  it('shows 48 rows with kind, source, state, rate and codec per Inv-SM §1.2 for file, webcam, external and pulled slots', async () => {
    cameras.assignments.set(new Map([[3, { deviceId: 'd1', label: 'Desk camera' }]]));
    await open();

    expect(rows()).toHaveLength(48);
    expect(rows().slice(0, 8).map(cells)).toEqual([
      ['src1', 'VID', 'people/walk.mp4', 'Live', '30 fps', 'H.264'],
      ['src2', 'VID', 'cars.mp4', 'Idle', '15 fps · rendition', 'H.265'],
      ['src3', 'CAM', 'Desk camera', 'Idle', '', 'H.264'],
      [
        'src4',
        'EXT',
        '⇢ RTSP · 192.168.1.20:41234 · 1280×720 · 30 fps',
        'External',
        '30 fps',
        'AV1',
      ],
      ['src5', 'URL', '⇠ RTSP · 10.0.0.7:554 · 1920×1080 · 25 fps', 'Pulled', '25 fps', 'H.264'],
      [
        'src6',
        'URL',
        '⇠ RTSP · 10.0.0.8:554 · retrying… (connection refused)',
        'Unreachable',
        'retrying…',
        '-',
      ],
      ['src7', 'VID', 'idle.mp4', 'Idle', '30 fps', 'H.264'],
      ['src8', '', 'Not assigned', 'Idle', '', '-'],
    ]);
    expect(cells(rowOf('src48'))).toEqual(['src48', '', 'Not assigned', 'Idle', '', '-']);
    // The chips carry the state's tone for the theme's status colours.
    const tone = (name: string) =>
      rowOf(name).querySelector('app-status-chip')!.getAttribute('data-tone');
    expect(['src1', 'src2', 'src4', 'src5', 'src6'].map(tone)).toEqual([
      'success',
      'neutral',
      'info',
      'success',
      'warning',
    ]);
    // The undecodable codec is in warning colours, and its glyph is named by the warning, which
    // the row is read with.
    const codec = rowOf('src4').querySelector(':scope > div:last-child app-status-chip')!;
    expect(codec.getAttribute('data-tone')).toBe('warning');
    expect(codec.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe(
      'AV1 cannot be decoded by Neat video pipelines (expects H.264, H.265 or MJPEG). Readers can connect, but decoding will fail.',
    );
  });

  it('shows an encoding slot as Encoding with its percent', async () => {
    slots.encodes.set(
      new Map([[2, { title: 'Encoding 15 fps rendition…', detail: '', percent: 42 }]]),
    );
    await open();

    expect(cells(rowOf('src2'))).toEqual([
      'src2',
      'VID',
      'cars.mp4',
      'Encoding',
      'encoding 42%',
      'H.265',
    ]);
  });

  it('In use shows assigned, external and pulled slots only', async () => {
    await open();
    expect(filter('All').textContent?.trim()).toBe('All 48');
    expect(filter('In use').textContent?.trim()).toBe('In use 7');

    await click(filter('In use'));

    expect(rows().map((row) => cells(row)[0])).toEqual([
      'src1',
      'src2',
      'src3',
      'src4',
      'src5',
      'src6',
      'src7',
    ]);

    await click(filter('All'));
    expect(rows()).toHaveLength(48);
  });

  it('In use with no slot in use says so', async () => {
    await open(Array.from({ length: 48 }, (_, index) => slot(index + 1)));
    await click(filter('In use'));

    expect(rows()).toHaveLength(0);
    expect(listbox().parentElement!.textContent).toContain('No slot is in use.');
  });

  it('Start… starts the chosen count and reports the server message', async () => {
    await open();
    slots.startBulk.mockResolvedValue({
      success: true,
      requested: 2,
      targeted: 2,
      started: [2],
      already_running: [1],
      errors: [{ index: 2, error: 'boom' }],
      skipped_external: [],
      skipped_pulled: [5],
      message: 'Started 0 source(s), 1 already running, 1 failed. Skipped pulled: src5.',
      started_or_running: 1,
    });

    await click(toolbarButton('Start…'));
    const dialog = bulkDialog()!;
    expect(dialog.textContent).toContain('Bulk Start Streams');
    expect(dialog.textContent).toContain('How many streams do you want to start?');
    expect(dialog.textContent).toContain(
      'Slots with a custom FPS may take longer to start while renditions are created.',
    );
    const slider = dialog.querySelector<HTMLElement>('[role="slider"]')!;
    expect(slider.getAttribute('aria-valuemin')).toBe('1');
    expect(slider.getAttribute('aria-valuemax')).toBe('48');
    // Ruling Q10: it opens at 1, as #170's did.
    expect(slider.getAttribute('aria-valuenow')).toBe('1');
    await press(slider, 'ArrowRight');
    expect(dialog.querySelector('output')?.textContent?.trim()).toBe('2');

    await answer(dialog, 'Start');

    expect(bulkDialog()).toBeNull();
    expect(slots.startBulk).toHaveBeenCalledExactlyOnceWith(2);
    expect(toasts.status).toHaveBeenCalledWith(
      'Started 0 source(s), 1 already running, 1 failed. Skipped pulled: src5.',
    );
    expect(toasts.error).toHaveBeenCalledWith('Failed: src2');

    // The next time it opens at the count chosen last.
    await click(toolbarButton('Start…'));
    expect(bulkDialog()!.querySelector('[role="slider"]')!.getAttribute('aria-valuenow')).toBe('2');
    await answer(bulkDialog()!, 'Cancel');
  });

  it('Start… cancelled starts nothing', async () => {
    await open();
    await click(toolbarButton('Start…'));
    await answer(bulkDialog()!, 'Cancel');

    expect(bulkDialog()).toBeNull();
    expect(slots.startBulk).not.toHaveBeenCalled();
  });

  it('a refused bulk start shows the server message and keeps the dialog open to try again', async () => {
    await open();
    slots.startBulk.mockRejectedValue(
      new ApiRequestError(400, 'No assigned sources available to start', null),
    );
    await click(toolbarButton('Start…'));
    await answer(bulkDialog()!, 'Start');

    expect(toasts.error).toHaveBeenCalledWith('No assigned sources available to start');
    expect(toasts.status).not.toHaveBeenCalled();
    expect(bulkDialog()).not.toBeNull();
    await answer(bulkDialog()!, 'Cancel');
  });

  it('a slot that began changing while the dialog or the menu was open is reported, and nothing is sent (Q9)', async () => {
    await open();
    await click(toolbarButton('Start…'));
    cameras.anyChanging.set(true);
    await settle();
    await answer(bulkDialog()!, 'Start');

    expect(toasts.error).toHaveBeenCalledWith(
      'Waiting for a source change to finish before starting sources.',
    );
    expect(slots.startBulk).not.toHaveBeenCalled();
    // As in #170 the dialog stays, so Start can be pressed again once the change is done.
    expect(bulkDialog()).not.toBeNull();
    await answer(bulkDialog()!, 'Cancel');

    cameras.anyChanging.set(false);
    await settle();
    await openMore();
    await click(menuItem('Reset'));
    cameras.anyChanging.set(true);
    await settle();
    await answer(confirmDialog()!, 'Reset');

    expect(toasts.error).toHaveBeenLastCalledWith(
      'Waiting for a source change to finish before resetting sources.',
    );
    expect(cameras.releaseAll).not.toHaveBeenCalled();
    expect(slots.reset).not.toHaveBeenCalled();
  });

  it("Stop all and Auto assign close this browser's webcams first and report the server message", async () => {
    await open();
    slots.stopAll.mockResolvedValue({
      ...bulkResult('Stopped 2 source(s).'),
      stopped_count: 2,
      stopped_pulled: [],
    });
    slots.autoAssign.mockResolvedValue({
      ...bulkResult('Assigned 3 source(s) with unique media file(s).'),
      assigned_count: 3,
      source_count: 48,
      available_files: 3,
    });

    await click(toolbarButton('Stop all'));
    // Stop all keeps the cameras picked for the slots; auto assign turns them into file slots.
    expect(cameras.releaseAll).toHaveBeenLastCalledWith();
    expect(slots.stopAll).toHaveBeenCalledExactlyOnceWith(RELEASED);
    expect(toasts.status).toHaveBeenLastCalledWith('Stopped 2 source(s).');

    await click(toolbarButton('Auto assign'));
    expect(cameras.releaseAll).toHaveBeenLastCalledWith({ clearAssignments: true });
    expect(slots.autoAssign).toHaveBeenCalledExactlyOnceWith(RELEASED);
    expect(toasts.status).toHaveBeenLastCalledWith(
      'Assigned 3 source(s) with unique media file(s).',
    );
  });

  it('the bulk actions wait while a slot change or another bulk action is in flight', async () => {
    await open();
    const bulk = ['Auto assign', 'Start…', 'Stop all'];
    expect(bulk.map((name) => toolbarButton(name).disabled)).toEqual([false, false, false]);

    cameras.anyChanging.set(true);
    await settle();
    expect(bulk.map((name) => toolbarButton(name).disabled)).toEqual([true, true, true]);
    await openMore();
    expect(menuItem('Reset').disabled).toBe(true);
    await press(morePanel() as HTMLElement, 'Escape');
    await settleOverlay();

    cameras.anyChanging.set(false);
    await settle();
    let finish!: (result: StopAllResult) => void;
    slots.stopAll.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await click(toolbarButton('Stop all'));
    expect(bulk.map((name) => toolbarButton(name).disabled)).toEqual([true, true, true]);

    finish({ ...bulkResult('Stopped 0 source(s).'), stopped_count: 0, stopped_pulled: [] });
    await settleOverlay();
    expect(bulk.map((name) => toolbarButton(name).disabled)).toEqual([false, false, false]);
  });

  it('Start… waits for the library to answer with a streamable file', async () => {
    library.tree.set(null);
    await open();
    expect(toolbarButton('Start…').disabled).toBe(true);

    library.tree.set([
      { name: 'notes.txt', path: 'notes.txt', type: 'file', streamable: false },
      { name: '/empty', path: 'empty', type: 'folder', streamable_count: 0, children: [] },
    ]);
    await settle();
    expect(toolbarButton('Start…').disabled).toBe(true);

    library.tree.set([
      { name: '/clips', path: 'clips', type: 'folder', streamable_count: 2, children: [] },
    ]);
    await settle();
    expect(toolbarButton('Start…').disabled).toBe(false);
  });

  it('Reset and Clear renditions ask first; Cancel changes nothing', async () => {
    slots.renditions.set({ count: 3, bytes: 1.2 * 1024 ** 3 });
    await open();
    slots.reset.mockResolvedValue({
      ...bulkResult('Reset all source assignments.'),
      stopped_pulled: [5, 6],
    });
    slots.clearRenditions.mockResolvedValue({
      removed: 2,
      freed_bytes: 800 * 1024 ** 2,
      kept: ['.renditions/cars_15fps_h265.mp4'],
    });

    await openMore();
    await click(menuItem('Reset'));
    expect(confirmText()).toBe(
      'Reset all sources? Every slot goes back to unassigned. External streams are left running. Cancel Reset',
    );
    await answer(confirmDialog()!, 'Cancel');
    expect(cameras.releaseAll).not.toHaveBeenCalled();
    expect(slots.reset).not.toHaveBeenCalled();

    expect(menuItem('Clear renditions').textContent?.trim()).toBe('Clear renditions (3 · 1.20 GB)');
    await click(menuItem('Clear renditions'));
    expect(confirmText()).toBe(
      'Clear cached renditions Delete 3 cached rendition(s) (1.20 GB)? They are re-created on the next start. Renditions in use by a playing source are kept. Cancel Clear',
    );
    await answer(confirmDialog()!, 'Cancel');
    expect(slots.clearRenditions).not.toHaveBeenCalled();

    await click(menuItem('Reset'));
    await answer(confirmDialog()!, 'Reset');
    expect(cameras.releaseAll).toHaveBeenCalledExactlyOnceWith({ clearAssignments: true });
    expect(slots.reset).toHaveBeenCalledExactlyOnceWith(RELEASED);
    expect(toasts.status).toHaveBeenLastCalledWith('Reset all source assignments.');
    // The action is done; the menu with it. Every slot is unassigned, and the first shows (#170).
    expect(morePanel()).toBeNull();
    expect(asideHeading()).toBe('src1');

    await openMore();
    await click(menuItem('Clear renditions'));
    await answer(confirmDialog()!, 'Clear');
    expect(slots.clearRenditions).toHaveBeenCalledOnce();
    expect(toasts.status).toHaveBeenLastCalledWith(
      'Removed 2 rendition(s), freed 800.0 MB. 1 kept: in use by a playing source.',
    );
  });

  it('Clear renditions asks with the usage fetched as it opens and as it is clicked', async () => {
    slots.renditions.set({ count: 0, bytes: 0 });
    await open();
    expect(slots.refreshRenditions).toHaveBeenCalledTimes(1);

    await openMore();
    expect(slots.refreshRenditions).toHaveBeenCalledTimes(2);
    expect(menuItem('Clear renditions').textContent?.trim()).toBe('Clear renditions');
    expect(menuItem('Clear renditions').disabled).toBe(true);

    // Another tab started a slot at a custom rate meanwhile: asking fetches the usage again.
    slots.renditions.set({ count: 1, bytes: 1024 });
    await settle();
    slots.refreshRenditions.mockImplementation(async () => {
      slots.renditions.set({ count: 2, bytes: 2048 });
    });
    const ask = vi.spyOn(TestBed.inject(NeatConfirm), 'ask');
    await click(menuItem('Clear renditions'));
    expect(slots.refreshRenditions).toHaveBeenCalledTimes(3);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Delete 2 cached rendition(s) (2.0 KB)? They are re-created on the next start. Renditions in use by a playing source are kept.',
      }),
    );
    await answer(confirmDialog()!, 'Cancel');

    // Another tab cleared them meanwhile: it still asks, with what is there now, as #170 did.
    slots.refreshRenditions.mockImplementation(async () => {
      slots.renditions.set({ count: 0, bytes: 0 });
    });
    await click(menuItem('Clear renditions'));
    expect(ask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message:
          'Delete 0 cached rendition(s) (0 B)? They are re-created on the next start. Renditions in use by a playing source are kept.',
      }),
    );
    await answer(confirmDialog()!, 'Cancel');
  });

  it('arrow keys move the selection and the side panel follows', async () => {
    await open();
    expect(aside()).not.toBeNull();
    expect(asideHeading()).toBeUndefined();

    listbox().focus();
    await press(listbox(), 'ArrowDown');
    expect(rowOf('src1').getAttribute('aria-selected')).toBe('true');
    expect(asideHeading()).toBe('src1');

    await press(listbox(), 'ArrowDown');
    await press(listbox(), 'ArrowDown');
    expect(asideHeading()).toBe('src3');
    await press(listbox(), 'End');
    expect(asideHeading()).toBe('src48');

    // A new poll answer keeps the selection on the same slot, now as the server describes it.
    slots.slots.set(
      mixedSlots().map((each) => (each.index === 48 ? { ...each, file: 'x.mp4' } : each)),
    );
    await settle();
    expect(rowOf('src48').getAttribute('aria-selected')).toBe('true');
    expect(asideHeading()).toBe('src48');
  });

  it('the side-panel toggle closes and opens the panel; Enter on a row opens it', async () => {
    await open();
    const toggle = toolbarButton('Side panel');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    await click(toggle);
    expect(aside()).toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    listbox().focus();
    await press(listbox(), 'ArrowDown');
    expect(aside()).toBeNull();
    await press(listbox(), 'Enter');
    expect(asideHeading()).toBe('src1');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('watches the slots while shown and fetches the library and the rendition usage on opening', async () => {
    await open();
    expect(slots.watchers).toBe(1);
    expect(library.refresh).toHaveBeenCalledOnce();
    expect(slots.refreshRenditions).toHaveBeenCalledOnce();

    await TestBed.inject(Router).navigateByUrl('/elsewhere');
    await settle();
    expect(slots.watchers).toBe(0);
  });

  it('a failed library or usage fetch on opening is not an error to show', async () => {
    library.tree.set(null);
    library.refresh.mockRejectedValue(new ApiRequestError(500, 'boom', null));
    slots.refreshRenditions.mockRejectedValue(new ApiRequestError(500, 'boom', null));
    await open();
    await settleOverlay();

    expect(toasts.error).not.toHaveBeenCalled();
    // Without the library Start… stays disabled, as in #170.
    expect(toolbarButton('Start…').disabled).toBe(true);
  });

  it('says so when the slot status could not be refreshed', async () => {
    await open();
    expect(notice()).toBe('');

    slots.unavailable.set(true);
    await settle();
    expect(notice()).toBe('Slot status could not be refreshed. Showing the last known state.');
    expect(rows()).toHaveLength(48);
  });
});
