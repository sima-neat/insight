import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, input, output, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { NeatConfirm, NeatIcon } from '@sima/neat-ui';
import {
  type NeatFrameStats,
  type NeatMetadataSnapshot,
  type NeatOverlaySettings,
  NeatRoiEditor,
  type NeatVideoBox,
  NeatVideoTile,
} from '@sima/neat-ui/video';
import { FakeResizeObserver, ViewerShell } from '../../pages/viewer/viewer-page.testing';
import { ViewerPage } from '../../pages/viewer/viewer.page';
import { FakeConnections } from '../fake-connections.testing';
import { FakeLocalStorage } from '../settings/fake-storage.testing';
import { LayoutPrefs } from '../settings/layout-prefs';
import { VfConnections } from '../vf/vf-connections';
import { ViewerTile } from '../viewer-tile';
import { ViewerInspector } from './inspector';

/** Most of the channel's metadata arrives late: 80 ms in the middle, 100 ms at the 90th percentile. */
const LATE: Partial<NeatMetadataSnapshot> = {
  recentLateShare: 0.9,
  recentLatenessMedianMs: 80,
  recentLatenessP90Ms: 100,
};

describe('ViewerInspector', () => {
  let storage: FakeLocalStorage;
  let fake: FakeConnections;
  let fixture: ComponentFixture<ViewerShell>;

  beforeEach(() => {
    storage = new FakeLocalStorage();
    vi.stubGlobal('localStorage', storage);
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    fake = new FakeConnections();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'viewer', component: ViewerPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    TestBed.overrideComponent(ViewerPage, {
      remove: { providers: [VfConnections] },
      add: { providers: [{ provide: VfConnections, useValue: fake.asVfConnections() }] },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const settle = () => fixture.whenStable();
  const root = (): HTMLElement => fixture.nativeElement;
  const page = (): ViewerPage =>
    fixture.debugElement.query(By.directive(ViewerPage)).componentInstance;
  const toolbarButton = (label: string): HTMLButtonElement =>
    root().querySelector(`.page-toolbar button[aria-label="${label}"]`)!;
  const aside = (): HTMLElement | null => root().querySelector('aside');
  const inspector = (): HTMLElement => aside()!.querySelector('app-viewer-inspector')!;
  const title = () => inspector().querySelector('h2')?.textContent?.trim();
  const flat = (element: Element | null | undefined) =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const tab = (label: string): HTMLElement =>
    [...inspector().querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (element) => element.textContent?.trim() === label,
    )!;
  const headings = () =>
    [...inspector().querySelectorAll('h3')].map((heading) => heading.textContent?.trim());
  /**
   * The setting row whose control is named `label`, prefixed with its Metadata section when
   * given ("Tracking: Show overlay"), as assistive technology names it.
   */
  const row = (label: string, section?: string): HTMLElement => {
    const name = section === undefined ? label : `${section}: ${label}`;
    return inspector().querySelector(`[aria-label="${name}"]`)!.closest('app-setting-row')!;
  };
  const rowLabels = () =>
    [...inspector().querySelectorAll('app-setting-row .label')].map((label) =>
      label.textContent?.trim(),
    );
  const buttonIn = (container: Element, label: string): HTMLButtonElement =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
      element.textContent?.replace(/\s+/g, ' ').trim().startsWith(label),
    )!;
  const field = (label: string): HTMLInputElement => row(label).querySelector('input')!;
  const tiles = () => fixture.debugElement.queryAll(By.directive(ViewerTile));
  const tileElement = (channel: number): HTMLElement =>
    tiles().find((tile) => (tile.componentInstance as ViewerTile).channel() === channel)!
      .nativeElement;
  const gridTile = (channel: number): NeatVideoTile =>
    tiles()
      .find((tile) => (tile.componentInstance as ViewerTile).channel() === channel)!
      .query(By.directive(NeatVideoTile)).componentInstance;
  const previewTile = (): NeatVideoTile | null =>
    fixture.debugElement.query(By.directive(ViewerInspector))?.query(By.directive(NeatVideoTile))
      ?.componentInstance ?? null;
  /** The status list's term → description pairs. */
  const status = () =>
    [...inspector().querySelectorAll('.status dt')].map((term) => [
      term.textContent?.trim(),
      term.nextElementSibling?.textContent?.trim(),
    ]);
  const notice = () => inspector().querySelector('app-late-notice');
  const noticeValue = (term: string) =>
    [...notice()!.querySelectorAll('dt')]
      .find((element) => element.textContent?.trim() === term)
      ?.nextElementSibling?.textContent?.trim();

  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  /** The dialog's title, message and buttons, in order. */
  const dialogText = () =>
    [...(dialog()?.querySelectorAll('h2, p, button') ?? [])]
      .map((part) => part.textContent?.trim())
      .join(' ');
  const footerButton = () =>
    [...inspector().querySelectorAll<HTMLButtonElement>('button')].find((element) =>
      element.textContent?.trim().startsWith('Reset all channels to global'),
    );
  /** The Go to channel popover, which the page's `/` shortcut opens. */
  const channelJump = () => document.querySelector('[role="dialog"][aria-label="Go to channel"]');

  /** Lets a dialog open or close: it moves focus after rendering and closes a frame later. */
  async function settleDialog(): Promise<void> {
    for (let turn = 0; turn < 3; turn++) {
      await new Promise((resolve) => setTimeout(resolve));
      await settle();
    }
  }

  /** Presses the open dialog's button and waits for it to close. */
  async function answer(label: string): Promise<void> {
    await settleDialog();
    [...dialog()!.querySelectorAll('button')]
      .find((element) => element.textContent?.trim() === label)!
      .click();
    await settleDialog();
  }

  /** Four settings on three channels: what the reset-all question counts. */
  const FOUR_ON_THREE = {
    'settings:global': { version: 10, general: { lineWidth: 4 } },
    'settings:channel:1': { version: 10, general: { lineWidth: 6, videoSyncBufferMs: 900 } },
    'settings:channel:2': {
      version: 10,
      types: { 'object-detection': { confidenceThreshold: 0.5 } },
    },
    'settings:channel:5': { version: 10, types: { segmentation: { visible: false } } },
  };

  /** Opens the Viewer with eight channels in a 1000×400 grid. */
  async function open(): Promise<void> {
    fixture = TestBed.createComponent(ViewerShell);
    await TestBed.inject(Router).navigateByUrl('/viewer?max_channels=8');
    await settle();
    FakeResizeObserver.grid().resize(1000, 400);
    await settle();
  }

  async function click(element: HTMLElement): Promise<void> {
    element.click();
    await settle();
  }

  async function press(
    key: string,
    target: EventTarget = window,
    init: KeyboardEventInit = {},
  ): Promise<void> {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
    await settle();
  }

  async function type(input: HTMLInputElement, value: string): Promise<void> {
    input.value = value;
    input.dispatchEvent(new Event('change'));
    await settle();
  }

  /** Selects the channel's tile and opens the inspector beside the grid. */
  async function inspect(channel: number): Promise<void> {
    await click(tileElement(channel));
    await click(toolbarButton('Inspector'));
  }

  /** The tile plays with its metadata late as `LATE` says, for one stats tick. */
  async function makeLate(tile: NeatVideoTile): Promise<void> {
    vi.spyOn(tile, 'snapshot').mockReturnValue({ ...tile.snapshot(), ...LATE });
    tile.stateChange.emit('playing');
    tile.frameStats.emit({} as NeatFrameStats);
    await settle();
  }

  it('closes with an icon-only button that draws the kit’s close icon and is named "Close inspector"', async () => {
    await open();
    await click(toolbarButton('Inspector'));

    const close = fixture.debugElement.query(
      By.css('app-viewer-inspector button[aria-label="Close inspector"]'),
    );
    expect(close.nativeElement.textContent.trim()).toBe('');
    expect(close.query(By.directive(NeatIcon)).componentInstance.name()).toBe('close');
  });

  it('without a selection edits global values and lists overrides per row', async () => {
    storage.seed({
      'settings:channel:2': {
        version: 10,
        types: { 'object-detection': { confidenceThreshold: 0.5 } },
      },
      'settings:channel:5': {
        version: 10,
        types: { 'object-detection': { confidenceThreshold: 0.7 } },
      },
    });
    await open();
    await click(toolbarButton('Inspector'));

    expect(title()).toBe('All channels');
    expect(previewTile()).toBeNull();
    expect(tab('Metadata').getAttribute('aria-selected')).toBe('true');
    expect(headings()).toEqual([
      'Object detection',
      'Segmentation',
      'Tracking',
      'Pose',
      'Classification',
    ]);

    const confidence = row('Confidence threshold', 'Object detection');
    expect(flat(confidence)).toContain('Overridden on 2 channels');
    await click(buttonIn(confidence, 'Overridden on 2 channels'));
    await click(buttonIn(confidence, 'Reset on 2 channels'));
    await answer('Reset');
    expect(storage.readStored('settings:channel:2')).toBeNull();
    expect(storage.readStored('settings:channel:5')).toBeNull();
    expect(gridTile(2).settings().types['object-detection'].confidenceThreshold).toBe(0);

    // A global change reaches every channel.
    await click(row('Show overlay', 'Segmentation').querySelector('button[role="switch"]')!);
    expect(storage.readStored('settings:global')).toEqual({
      version: 10,
      general: {},
      types: { segmentation: { visible: false } },
    });
    expect(gridTile(0).settings().types.segmentation.visible).toBe(false);
    expect(gridTile(7).settings().types.segmentation.visible).toBe(false);

    await click(tab('General'));
    expect(headings()).toEqual([]);
    expect(rowLabels()).toEqual(['Video sync buffer', 'Metadata retention', 'Line width']);
    await type(field('Video sync buffer'), '600');
    expect(fake.connections.get(0)!.syncBuffers.at(-1)).toBe(600);
    expect(fake.connections.get(7)!.syncBuffers.at(-1)).toBe(600);
  });

  it('with channel 2 selected a change writes an override marked "overrides global"; reset restores global', async () => {
    await open();
    await inspect(2);
    expect(title()).toBe('Channel 2');

    await click(tab('General'));
    await type(field('Video sync buffer'), '800');

    expect(storage.readStored('settings:channel:2')).toEqual({
      version: 10,
      general: { videoSyncBufferMs: 800 },
      types: {},
    });
    expect(storage.readStored('settings:global')).toBeNull();
    expect(flat(row('Video sync buffer'))).toContain('overrides global');
    expect(fake.connections.get(2)!.syncBuffers.at(-1)).toBe(800);
    expect(fake.connections.get(3)!.syncBuffers).toEqual([300]);

    await click(buttonIn(row('Video sync buffer'), 'Reset'));

    expect(storage.readStored('settings:channel:2')).toBeNull();
    expect(flat(row('Video sync buffer'))).not.toContain('overrides global');
    expect(field('Video sync buffer').value).toBe('300');
    expect(fake.connections.get(2)!.syncBuffers.at(-1)).toBe(300);

    // The Metadata tab's switches override too, for this channel's tiles only.
    await click(tab('Metadata'));
    await click(row('Show overlay', 'Tracking').querySelector('button[role="switch"]')!);
    expect(flat(row('Show overlay', 'Tracking'))).toContain('overrides global');
    expect(gridTile(2).settings().types.tracking.visible).toBe(false);
    expect(gridTile(3).settings().types.tracking.visible).toBe(true);
    expect(previewTile()!.settings().types.tracking.visible).toBe(false);
  });

  it('has no reset-all footer while no channel holds a value', async () => {
    await open();
    await click(toolbarButton('Inspector'));

    expect(footerButton()).toBeUndefined();
  });

  it('the footer asks with "4 settings on 3 channels go back…", and only on All channels', async () => {
    storage.seed(FOUR_ON_THREE);
    await open();
    await click(toolbarButton('Inspector'));
    const ask = vi.spyOn(TestBed.inject(NeatConfirm), 'ask');

    footerButton()!.click();
    await settleDialog();

    expect(ask).toHaveBeenCalledExactlyOnceWith({
      title: 'Reset all channels to global?',
      message:
        "4 settings on 3 channels go back to the global values. Regions of interest are kept. This can't be undone.",
      confirmLabel: 'Reset',
      tone: 'danger',
    });
    expect(dialogText()).toBe(
      "Reset all channels to global? 4 settings on 3 channels go back to the global values. Regions of interest are kept. This can't be undone. Cancel Reset",
    );
    await answer('Cancel');

    await click(tileElement(1));
    expect(title()).toBe('Channel 1');
    expect(footerButton()).toBeUndefined();
  });

  it('the footer goes with the last channel value and comes back with the next', async () => {
    storage.seed({ 'settings:channel:3': { version: 10, general: { lineWidth: 6 } } });
    await open();
    await click(toolbarButton('Inspector'));
    await click(tab('General'));
    expect(footerButton()).toBeDefined();

    await click(buttonIn(row('Line width'), 'Overridden on 1 channel'));
    await click(buttonIn(row('Line width'), 'Use global'));
    expect(footerButton()).toBeUndefined();

    await click(tileElement(3));
    await type(field('Video sync buffer'), '800');
    await press('Escape', tileElement(3));
    expect(title()).toBe('All channels');
    expect(footerButton()).toBeDefined();
  });

  it('asks in the singular for one setting on one channel', async () => {
    storage.seed({ 'settings:channel:3': { version: 10, general: { lineWidth: 6 } } });
    await open();
    await click(toolbarButton('Inspector'));

    footerButton()!.click();
    await settleDialog();

    expect(dialogText()).toContain(
      "1 setting on 1 channel goes back to the global values. Regions of interest are kept. This can't be undone.",
    );
  });

  it('asks with the plural verb for several settings on one channel', async () => {
    storage.seed({
      'settings:channel:3': { version: 10, general: { lineWidth: 6, videoSyncBufferMs: 900 } },
    });
    await open();
    await click(toolbarButton('Inspector'));

    footerButton()!.click();
    await settleDialog();

    expect(dialogText()).toContain(
      "2 settings on 1 channel go back to the global values. Regions of interest are kept. This can't be undone.",
    );
  });

  it('Cancel and Escape change nothing; the keys the page binds do not act behind the dialog', async () => {
    storage.seed(FOUR_ON_THREE);
    await open();
    await click(toolbarButton('Inspector'));
    const writes = storage.writes.length;
    const opener = footerButton()!;
    opener.focus();
    opener.click();
    await settleDialog();

    // `/` would open Go to channel, and an arrow turn the page, if the page took them.
    const cancel = dialog()!.querySelector<HTMLElement>('button')!;
    expect(document.activeElement).toBe(cancel);
    await press('/', cancel);
    await press('ArrowRight', cancel);
    await settleDialog();
    expect(channelJump()).toBeNull();
    expect(dialog()).not.toBeNull();

    await press('Escape', cancel);
    await settleDialog();

    expect(dialog()).toBeNull();
    expect(aside()).not.toBeNull();
    expect(storage.writes).toHaveLength(writes);
    expect(document.activeElement).toBe(opener);

    opener.click();
    await answer('Cancel');
    expect(storage.writes).toHaveLength(writes);
    expect(footerButton()).toBeDefined();
  });

  it('confirming reset-all clears every channel override; the footer disappears and focus goes to the heading', async () => {
    storage.seed(FOUR_ON_THREE);
    await open();
    await click(toolbarButton('Inspector'));
    await click(tab('General'));
    expect(gridTile(1).settings().general.lineWidth).toBe(6);
    const opener = footerButton()!;
    opener.focus();
    opener.click();
    await settleDialog();

    await answer('Reset');

    for (const channel of [1, 2, 5]) {
      expect(storage.readStored(`settings:channel:${channel}`)).toBeNull();
    }
    expect(storage.readStored('settings:global')).toEqual(FOUR_ON_THREE['settings:global']);
    expect(gridTile(1).settings().general.lineWidth).toBe(4);
    expect(gridTile(5).settings().types.segmentation.visible).toBe(true);
    expect(footerButton()).toBeUndefined();
    expect(flat(row('Line width'))).not.toContain('Overridden');
    // The button that opened the dialog is gone; the heading takes focus, though it is no tab stop.
    expect(opener.isConnected).toBe(false);
    const heading = inspector().querySelector('h2')!;
    expect(document.activeElement).toBe(heading);
    expect(heading.tabIndex).toBe(-1);
  });

  it('the footer asks with a note that regions of interest are kept, and confirming keeps them', async () => {
    const regions = {
      version: 1,
      regions: [
        {
          type: 'inclusion',
          points: [
            { x: 0.1, y: 0.1 },
            { x: 0.9, y: 0.1 },
            { x: 0.5, y: 0.9 },
          ],
        },
      ],
    };
    storage.seed({ ...FOUR_ON_THREE, 'roi:global': regions, 'roi:channel:1': regions });
    await open();
    await click(toolbarButton('Inspector'));
    footerButton()!.click();
    await settleDialog();
    expect(dialogText()).toContain('Regions of interest are kept.');

    await answer('Reset');

    expect(storage.readStored('settings:channel:1')).toBeNull();
    expect(storage.readStored('roi:global')).toStrictEqual(regions);
    expect(storage.readStored('roi:channel:1')).toStrictEqual(regions);
    expect(gridTile(1).settings().roi).toStrictEqual(regions.regions);
  });

  it('the preview shares the tile’s MediaStream: no second VfConnection is created', async () => {
    await open();
    const connections = fake.connections.size;

    await inspect(2);

    const preview = previewTile()!;
    expect(preview.source()).toBe(fake.connections.get(2));
    expect(gridTile(2).source()).toBe(fake.connections.get(2));
    expect(fake.connections.size).toBe(connections);
    expect(fake.holders.get(2)).toBe(2);
    expect(preview.bars()).toBe(false);
    expect(inspector().querySelector('neat-video-tile .bar')).toBeNull();

    // Only the grid tile reports to the connection and judges lateness.
    await makeLate(preview);
    expect(fake.connections.get(2)!.frameStats).toEqual([]);
    expect(notice()).toBeNull();

    await click(tileElement(3));
    expect(previewTile()!.source()).toBe(fake.connections.get(3));
    expect(fake.holders.get(2)).toBe(1);
    expect(fake.holders.get(3)).toBe(2);

    await click(toolbarButton('Inspector'));
    expect(fake.holders.get(3)).toBe(1);
    expect(fake.connections.size).toBe(connections);
  });

  it('a channel paged off the grid keeps its preview, which keeps the connection in step', async () => {
    // Six tiles per page: channels 6 and 7 are on page 2.
    storage.seed({ layout: { tileWidths: { 8: 300 } } });
    await open();
    await inspect(2);
    await press('ArrowRight');
    expect(tiles()).toHaveLength(2);

    expect(fake.holders.get(2)).toBe(1);
    expect(previewTile()!.source()).toBe(fake.connections.get(2));
    expect(status()).toContainEqual(['Late metadata', 'Not measured while off the grid']);

    // With no grid tile the preview's stats are the only ones: they feed the connection's status
    // line and vf's egress report (vf-connection.spec covers what the connection makes of them).
    const previewStats = { metadataMessagesPerSecond: 12 } as NeatFrameStats;
    previewTile()!.frameStats.emit(previewStats);
    expect(fake.connections.get(2)!.frameStats).toEqual([previewStats]);

    await click(tab('General'));
    await type(field('Video sync buffer'), '900');
    await type(field('Metadata retention'), '2000');
    expect(fake.connections.get(2)!.syncBuffers.at(-1)).toBe(900);
    expect(fake.connections.get(2)!.retentions.at(-1)).toBe(2000);
    expect(previewTile()!.retentionMs()).toBe(2000);

    // Back on the grid, only the grid tile reports again.
    await press('ArrowLeft');
    previewTile()!.frameStats.emit({ metadataMessagesPerSecond: 3 } as NeatFrameStats);
    const gridStats = { metadataMessagesPerSecond: 15 } as NeatFrameStats;
    gridTile(2).frameStats.emit(gridStats);
    await settle();
    expect(fake.connections.get(2)!.frameStats).toEqual([previewStats, gridStats]);
    expect(status()).toContainEqual(['Late metadata', 'Not measured yet']);
  });

  it('with a channel selected shows its stream status, sync buffer and lateness', async () => {
    await open();
    await inspect(2);
    expect(status()).toEqual([
      ['Stream', 'Connecting'],
      ['Sync buffer', '300 ms'],
      ['Late metadata', 'Not measured yet'],
    ]);

    fake.connections.get(2)!.status.set({
      phase: 'connected',
      codec: 'H.264',
      width: 640,
      height: 480,
      fps: 15,
      kbps: 812.4,
      messagesPerSecond: 15,
    });
    fake.connections.get(2)!.syncBuffer.set({ supported: false, applied: false, targetMs: 0 });
    await makeLate(gridTile(2));

    expect(status()).toEqual([
      ['Stream', 'H.264 · 640×480 · 15.0 fps · 812.4 kb/s · 15 msg/s'],
      ['Sync buffer', '300 ms (this browser cannot delay video)'],
      ['Late metadata', '90 % late, ~80 ms after its frame'],
    ]);
  });

  it('the late notice raises the channel buffer, or raises global without lowering it', async () => {
    storage.seed({
      'settings:global': { version: 10, general: { videoSyncBufferMs: 1000 } },
      'settings:channel:2': { version: 10, general: { videoSyncBufferMs: 300 } },
    });
    await open();

    // Global already covers what channel 2 needs (450 ms): it can follow global instead.
    await makeLate(gridTile(2));
    await click(tileElement(2).querySelector<HTMLElement>('button[neatTileChip]')!);
    expect(tab('General').getAttribute('aria-selected')).toBe('true');
    expect(noticeValue('Video sync buffer')).toBe('300 ms');
    expect(buttonIn(notice()!, 'Raise for this channel to 450 ms')).toBeDefined();
    await click(buttonIn(notice()!, 'Use global value (1000 ms)'));

    expect(storage.readStored('settings:channel:2')).toBeNull();
    // Never written: still as seeded.
    expect(storage.readStored('settings:global')).toEqual({
      version: 10,
      general: { videoSyncBufferMs: 1000 },
    });
    expect(fake.connections.get(2)!.syncBuffers.at(-1)).toBe(1000);
    // The new buffer is still settling: the notice is gone, and focus is on the changed value.
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(field('Video sync buffer'));

    // Channel 3 follows 1000 ms and needs 1150 ms: raised for itself, global stays.
    await makeLate(gridTile(3));
    await click(tileElement(3).querySelector<HTMLElement>('button[neatTileChip]')!);
    await click(buttonIn(notice()!, 'Raise for this channel to 1150 ms'));
    expect(storage.readStored('settings:channel:3')).toEqual({
      version: 10,
      general: { videoSyncBufferMs: 1150 },
      types: {},
    });
    expect(document.activeElement).toBe(field('Video sync buffer'));
    // Never written: still as seeded.
    expect(storage.readStored('settings:global')).toEqual({
      version: 10,
      general: { videoSyncBufferMs: 1000 },
    });
    expect(notice()).toBeNull();

    // Channel 4 needs 1150 ms too: raised globally, for every channel that follows global.
    await makeLate(gridTile(4));
    await click(tileElement(4).querySelector<HTMLElement>('button[neatTileChip]')!);
    await click(buttonIn(notice()!, 'Raise globally to 1150 ms'));
    expect(storage.readStored('settings:global')).toEqual({
      version: 10,
      general: { videoSyncBufferMs: 1150 },
      types: {},
    });
    expect(storage.readStored('settings:channel:4')).toBeNull();
    expect(fake.connections.get(5)!.syncBuffers.at(-1)).toBe(1150);
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(field('Video sync buffer'));
  });

  it('Escape closes the inspector and returns focus to the selected tile', async () => {
    await open();
    await inspect(2);
    await click(tab('General'));
    const input = field('Video sync buffer');
    input.focus();

    // With a modifier the key is the browser's or the system's.
    await press('Escape', input, { shiftKey: true });
    expect(aside()).not.toBeNull();

    await press('Escape', input);

    expect(aside()).toBeNull();
    expect(storage.readStored('layout')).toMatchObject({ inspector: false });
    expect(page().selectedChannel()).toBe(2);
    expect(document.activeElement).toBe(tileElement(2));

    // The close button does the same.
    await click(toolbarButton('Inspector'));
    await click(inspector().querySelector<HTMLElement>('button[aria-label="Close inspector"]')!);
    expect(aside()).toBeNull();
    expect(document.activeElement).toBe(tileElement(2));

    // Escape on the grid still clears the selection; with none, focus goes back to the toggle.
    await press('Escape', tileElement(2));
    expect(page().selectedChannel()).toBeNull();
    await click(toolbarButton('Inspector'));
    await press('Escape', tab('Metadata'));
    expect(aside()).toBeNull();
    expect(document.activeElement).toBe(toolbarButton('Inspector'));
  });

  describe('the ROI tab', () => {
    /** The radio of the ROI tab's Draw control labelled `label`. */
    const drawRadio = (label: string): HTMLButtonElement =>
      [...inspector().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (element) => element.textContent?.trim() === label,
      )!;
    const editor = (): NeatRoiEditor | null =>
      fixture.debugElement.query(By.directive(NeatRoiEditor))?.componentInstance ?? null;
    const backdropField = (): HTMLInputElement =>
      inspector().querySelector('input[aria-label="Draw on channel"]')!;

    async function enter(input: HTMLInputElement, value: string): Promise<void> {
      input.value = value;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
    }

    it('the tabs are Metadata, ROI and General', async () => {
      await open();
      await click(toolbarButton('Inspector'));

      expect(
        [...inspector().querySelectorAll('[role="tab"]')].map((element) =>
          element.textContent?.trim(),
        ),
      ).toEqual(['Metadata', 'ROI', 'General']);

      await click(tab('ROI'));
      expect(tab('ROI').getAttribute('aria-selected')).toBe('true');
      expect(rowLabels()).toEqual([]);
      expect(inspector().querySelector('app-roi-tab')).not.toBeNull();
    });

    /** The channel's grid tile reports that its video plays, or stops. */
    async function setPlaying(channel: number, playing: boolean): Promise<void> {
      gridTile(channel).stateChange.emit(playing ? 'playing' : 'stopped');
      await settle();
    }

    it('with no channel playing the ROI tab previews the first displayed one, and another once it leaves the grid', async () => {
      await open();
      await click(toolbarButton('Inspector'));
      expect(previewTile()).toBeNull();

      // No grid tile plays: the first displayed channel.
      await click(tab('ROI'));
      expect(title()).toBe('All channels');
      expect(previewTile()!.source()).toBe(fake.connections.get(0));
      expect(fake.holders.get(0)).toBe(2);
      expect(backdropField().value).toBe('0');
      // The backdrop is no selection: the panel has no channel status.
      expect(status()).toEqual([]);

      // Channel 0 goes from the grid when Hide empty shows only the live channels 3 and 5.
      const page = fixture.debugElement.query(By.directive(ViewerPage));
      page.injector.get(LayoutPrefs).setHideEmpty(true);
      await settle();
      TestBed.inject(HttpTestingController)
        .expectOne('/api/ingest/stats')
        .flush({
          channels: [
            { channel: 3, active: true },
            { channel: 5, active: true },
          ],
        });
      await settle();

      expect(previewTile()!.source()).toBe(fake.connections.get(3));
      expect(backdropField().value).toBe('3');
      expect(fake.holders.get(0)).toBeUndefined();
      expect(fake.holders.get(3)).toBe(2);

      // Other tabs have no preview without a selection, and let the connection go.
      await click(tab('Metadata'));
      expect(previewTile()).toBeNull();
      expect(fake.holders.get(3)).toBe(1);
    });

    it('with no channel selected the ROI tab previews the first displayed channel that plays, and keeps it while it plays', async () => {
      await open();
      await click(toolbarButton('Inspector'));
      // Hide empty is off: channel 0 is displayed but has no video.
      await setPlaying(2, true);

      await click(tab('ROI'));
      expect(previewTile()!.source()).toBe(fake.connections.get(2));
      expect(backdropField().value).toBe('2');

      // An earlier channel starting to play does not move a backdrop that still plays.
      await setPlaying(1, true);
      expect(previewTile()!.source()).toBe(fake.connections.get(2));

      // Once it stops, the first displayed channel that plays takes over, else the first displayed.
      await setPlaying(2, false);
      expect(previewTile()!.source()).toBe(fake.connections.get(1));
      expect(fake.holders.get(2)).toBe(1);
      await setPlaying(1, false);
      expect(previewTile()!.source()).toBe(fake.connections.get(0));
    });

    it('a channel picked in Draw on channel stays while it is displayed, whether it plays or not', async () => {
      await open();
      await click(toolbarButton('Inspector'));
      await setPlaying(2, true);
      await click(tab('ROI'));

      await enter(backdropField(), '0');
      expect(previewTile()!.source()).toBe(fake.connections.get(0));

      await setPlaying(3, true);
      await setPlaying(2, false);
      expect(previewTile()!.source()).toBe(fake.connections.get(0));
      expect(backdropField().value).toBe('0');
    });

    it('leaving the ROI tab forgets the pick: ROI, Metadata, ROI derives the backdrop again', async () => {
      await open();
      await click(toolbarButton('Inspector'));
      await click(tab('ROI'));
      await enter(backdropField(), '4');
      expect(previewTile()!.source()).toBe(fake.connections.get(4));

      await click(tab('Metadata'));
      await click(tab('ROI'));
      expect(previewTile()!.source()).toBe(fake.connections.get(0));
      expect(backdropField().value).toBe('0');

      // The same while channel 5 plays: the default, not the old pick.
      await enter(backdropField(), '4');
      await click(tab('General'));
      await setPlaying(5, true);
      await click(tab('ROI'));
      expect(previewTile()!.source()).toBe(fake.connections.get(5));
      expect(fake.holders.get(4)).toBe(1);
    });

    it('Draw on channel switches the backdrop and refuses channels that are not displayed', async () => {
      await open();
      await click(toolbarButton('Inspector'));
      await click(tab('ROI'));

      await enter(backdropField(), '4');
      expect(previewTile()!.source()).toBe(fake.connections.get(4));
      expect(fake.holders.get(0)).toBe(1);
      expect(fake.holders.get(4)).toBe(2);

      // Channel 12 is beyond the link's eight channels.
      await enter(backdropField(), '12');
      expect(previewTile()!.source()).toBe(fake.connections.get(4));
      expect(backdropField().value).toBe('4');
      expect(fake.connections.has(12)).toBe(false);

      // A selected channel is previewed instead; the backdrop is back when the selection goes.
      await click(tileElement(6));
      expect(previewTile()!.source()).toBe(fake.connections.get(6));
      expect(fake.holders.get(4)).toBe(1);
      expect(inspector().querySelector('input[aria-label="Draw on channel"]')).toBeNull();
    });

    it('the preview gets showRoi false and the editor while the ROI tab is open, and neither on other tabs', async () => {
      const regions = [
        {
          type: 'inclusion',
          points: [
            { x: 0.1, y: 0.1 },
            { x: 0.9, y: 0.1 },
            { x: 0.5, y: 0.9 },
          ],
        },
      ];
      storage.seed({ 'roi:global': { version: 1, regions } });
      await open();
      await inspect(2);
      expect(previewTile()!.settings().general.showRoi).toBe(true);
      expect(editor()).toBeNull();

      await click(tab('ROI'));
      // The editor draws the regions; the tile's overlay would draw them a second time.
      expect(previewTile()!.settings().general.showRoi).toBe(false);
      expect(previewTile()!.settings().roi).toStrictEqual(regions);
      expect(editor()!.regions()).toStrictEqual(regions);
      expect(editor()!.mode()).toBe('off');
      expect(
        inspector().querySelector('neat-video-tile neat-roi-editor[neatTileOverlay]'),
      ).not.toBeNull();
      // Only the preview: the channel's grid tile still draws its regions.
      expect(gridTile(2).settings().general.showRoi).toBe(true);

      await click(tab('General'));
      expect(previewTile()!.settings().general.showRoi).toBe(true);
      expect(editor()).toBeNull();
    });

    it('drawMode resets to Off when the channel or tab changes', async () => {
      await open();
      await inspect(2);
      await click(tab('ROI'));

      await click(drawRadio('Inclusion'));
      expect(editor()!.mode()).toBe('inclusion');

      await click(tileElement(3));
      expect(editor()!.mode()).toBe('off');
      expect(drawRadio('Off').getAttribute('aria-checked')).toBe('true');

      await click(drawRadio('Exclusion'));
      await click(tab('General'));
      await click(tab('ROI'));
      expect(editor()!.mode()).toBe('off');
      expect(drawRadio('Off').getAttribute('aria-checked')).toBe('true');

      // Deselecting is a change of channel too: to All channels, on the backdrop.
      await click(drawRadio('Inclusion'));
      await press('Escape', tileElement(3));
      expect(title()).toBe('All channels');
      expect(editor()!.mode()).toBe('off');
    });
  });

  /*
   * Drawing needs the editor to have an image to draw on, which only a playing tile gives it; in
   * jsdom no video plays, so here the preview is a stand-in tile whose video box the test sets.
   * The editor and everything around it are the real ones.
   */
  describe('drawing on the preview', () => {
    /** A 200×100 image at the stand-in tile's corner, which jsdom puts at the page origin. */
    const BOX: NeatVideoBox = { x: 0, y: 0, width: 200, height: 100 };

    beforeEach(() => {
      TestBed.overrideComponent(ViewerInspector, {
        remove: { imports: [NeatVideoTile] },
        add: { imports: [StandInTile] },
      });
    });

    const preview = (): StandInTile =>
      fixture.debugElement.query(By.directive(StandInTile)).componentInstance;
    const editorElement = (): HTMLElement => inspector().querySelector('neat-roi-editor')!;
    const drawRadio = (label: string): HTMLButtonElement =>
      [...inspector().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (element) => element.textContent?.trim() === label,
      )!;
    const lines = () => [...inspector().querySelectorAll('.regions li')].map((line) => flat(line));

    /** Clicks the image at fractions of its size. */
    async function clickAt(x: number, y: number): Promise<void> {
      editorElement()
        .querySelector('svg')!
        .dispatchEvent(
          new MouseEvent('click', {
            clientX: x * BOX.width,
            clientY: y * BOX.height,
            button: 0,
            detail: 1,
            bubbles: true,
            cancelable: true,
          }),
        );
      await settle();
    }

    /** Opens the ROI tab, gives the preview an image and chooses `mode`. */
    async function drawOn(mode: 'Inclusion' | 'Exclusion'): Promise<void> {
      await click(tab('ROI'));
      preview().videoBox.set(BOX);
      await settle();
      await click(drawRadio(mode));
    }

    const TRIANGLE = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.5, y: 0.9 },
    ];

    it('a polygon drawn on a channel that inherits stores the global regions plus the new one', async () => {
      const global = [{ type: 'exclusion', points: TRIANGLE }];
      storage.seed({ 'roi:global': { version: 1, regions: global } });
      await open();
      await inspect(2);
      await drawOn('Inclusion');

      await clickAt(0.2, 0.2);
      await clickAt(0.8, 0.2);
      await clickAt(0.8, 0.8);
      await clickAt(0.2, 0.2);

      const drawn = {
        type: 'inclusion',
        points: [
          { x: 0.2, y: 0.2 },
          { x: 0.8, y: 0.2 },
          { x: 0.8, y: 0.8 },
        ],
      };
      expect(storage.readStored('roi:channel:2')).toStrictEqual({
        version: 1,
        regions: [...global, drawn],
      });
      expect(storage.readStored('roi:global')).toStrictEqual({ version: 1, regions: global });
      expect(lines()).toEqual(['Exclusion 1 Delete', 'Inclusion 1 Delete', 'Delete all…']);
      expect(gridTile(2).settings().roi).toStrictEqual([...global, drawn]);
      expect(gridTile(3).settings().roi).toStrictEqual(global);
      // Clicks on the preview neither select nor deselect a tile.
      expect(page().selectedChannel()).toBe(2);
    });

    it('on All channels a polygon drawn on the backdrop is a global region', async () => {
      await open();
      await click(toolbarButton('Inspector'));
      await drawOn('Exclusion');

      await clickAt(0.1, 0.1);
      await clickAt(0.9, 0.1);
      await clickAt(0.5, 0.9);
      await clickAt(0.1, 0.1);

      expect(storage.readStored('roi:global')).toStrictEqual({
        version: 1,
        regions: [{ type: 'exclusion', points: TRIANGLE }],
      });
      expect(gridTile(5).settings().roi).toStrictEqual([{ type: 'exclusion', points: TRIANGLE }]);
      expect(page().selectedChannel()).toBeNull();
    });

    it('Escape while drawing cancels the open polygon and neither closes the inspector nor deselects the tile', async () => {
      await open();
      await inspect(2);
      await drawOn('Inclusion');
      const writes = storage.writes.length;

      await clickAt(0.2, 0.2);
      await clickAt(0.8, 0.2);
      await new Promise((resolve) => setTimeout(resolve));
      // The editor took focus on the first point, so Escape goes to it.
      expect(document.activeElement).toBe(editorElement());
      await press('Escape', editorElement());

      expect(aside()).not.toBeNull();
      expect(page().selectedChannel()).toBe(2);
      expect(editorElement().querySelector('polyline')).toBeNull();
      expect(storage.writes).toHaveLength(writes);

      // With nothing open, Escape is the inspector's again.
      await press('Escape', editorElement());
      expect(aside()).toBeNull();
      expect(page().selectedChannel()).toBe(2);
    });
  });
});

/** Stands in for the kit tile in the inspector, with a video box the test sets. */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector -- it takes the kit tile's place
  selector: 'neat-video-tile',
  providers: [{ provide: NeatVideoTile, useExisting: StandInTile }],
  template: '<ng-content select="[neatTileOverlay]" />',
})
class StandInTile {
  readonly source = input<unknown>();
  readonly settings = input<NeatOverlaySettings>();
  readonly retentionMs = input<number>();
  readonly channel = input<number>();
  readonly bars = input<boolean>();
  readonly frameStats = output<NeatFrameStats>();
  readonly videoBox = signal<NeatVideoBox | null>(null);
}
