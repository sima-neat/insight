import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { type NeatFrameStats, NeatVideoTile } from '@sima/neat-ui';
import { FakeConnections } from '../../viewer/fake-connections.testing';
import { FakeLocalStorage } from '../../viewer/settings/fake-storage.testing';
import { VfConnections } from '../../viewer/vf/vf-connections';
import { ViewerTile } from '../../viewer/viewer-tile';
import { FakeResizeObserver, ViewerShell as Shell } from './viewer-page.testing';
import { ViewerPage } from './viewer.page';

const VIEWER_URL = '/api/viewer-url';
const STATS_URL = '/api/ingest/stats';

const range = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => from + index);

/** Another page of the app, to leave the Viewer for. */
@Component({ template: '' })
class Elsewhere {}

describe('ViewerPage', () => {
  let storage: FakeLocalStorage;
  let fake: FakeConnections;
  let http: HttpTestingController;
  let fixture: ComponentFixture<Shell>;

  beforeEach(() => {
    storage = new FakeLocalStorage();
    vi.stubGlobal('localStorage', storage);
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    fake = new FakeConnections();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'viewer', component: ViewerPage },
          { path: 'elsewhere', component: Elsewhere },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    TestBed.overrideComponent(ViewerPage, {
      remove: { providers: [VfConnections] },
      add: { providers: [{ provide: VfConnections, useValue: fake.asVfConnections() }] },
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    document.documentElement.classList.remove('neat-dark');
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // Last, so an unanswered request fails only its own test, not the clean-up for the next.
    http.verify();
  });

  const root = (): HTMLElement => fixture.nativeElement;
  const page = (): ViewerPage =>
    fixture.debugElement.query(By.directive(ViewerPage)).componentInstance;
  const toolbar = (): HTMLElement => root().querySelector('.page-toolbar')!;
  const button = (label: string): HTMLButtonElement =>
    toolbar().querySelector(`button[aria-label="${label}"]`)!;
  const toggle = (text: string): HTMLButtonElement =>
    [...toolbar().querySelectorAll<HTMLButtonElement>('button[role="switch"]')].find(
      (element) => element.textContent?.trim() === text,
    )!;
  const notice = () => root().querySelector('[role="status"]')?.textContent?.trim() ?? '';
  const pageInput = (): HTMLInputElement => toolbar().querySelector('input[aria-label="Page"]')!;
  const channelInput = (): HTMLInputElement =>
    toolbar().querySelector('input[aria-label="Go to channel"]')!;
  const slider = (): HTMLElement => toolbar().querySelector('[role="slider"]')!;
  const gridObserver = () => FakeResizeObserver.grid();
  const tileWidth = () =>
    root()
      .querySelector<HTMLElement>('neat-tile-grid .grid')!
      .style.getPropertyValue('--grid-tile-width');
  /** The channels whose tiles are on screen, in screen order. */
  const shown = () =>
    fixture.debugElement
      .queryAll(By.directive(ViewerTile))
      .map((tile) => (tile.componentInstance as ViewerTile).channel());
  const tileElement = (channel: number): HTMLElement =>
    fixture.debugElement
      .queryAll(By.directive(ViewerTile))
      .find((tile) => (tile.componentInstance as ViewerTile).channel() === channel)!.nativeElement;
  const kitTile = (channel: number): NeatVideoTile =>
    fixture.debugElement
      .queryAll(By.directive(ViewerTile))
      .find((tile) => (tile.componentInstance as ViewerTile).channel() === channel)!
      .query(By.directive(NeatVideoTile)).componentInstance;

  const settle = () => fixture.whenStable();

  async function resize(width: number, height: number): Promise<void> {
    gridObserver().resize(width, height);
    await settle();
  }

  interface Visit {
    /** The channel limit Flask answers, or null for a failed request. */
    readonly limit?: number | null;
    /** The grid's size, or null to leave it unmeasured. */
    readonly area?: readonly [number, number] | null;
  }

  /**
   * Opens `url` in the shell, answers the channel limit if the page asks, and sizes the grid. With
   * `area: null` the grid is left unmeasured; with `limit: null` the limit request fails.
   */
  async function open(url: string, visit: Visit = {}): Promise<void> {
    fixture = TestBed.createComponent(Shell);
    await visitViewer(url, visit);
  }

  /** Goes to another page of the app and back to the Viewer at `url`, which opens afresh. */
  async function leaveAndReturn(url: string, visit: Visit = {}): Promise<void> {
    await navigate('/elsewhere');
    expect(fixture.debugElement.query(By.directive(ViewerPage))).toBeNull();
    await visitViewer(url, visit);
  }

  async function visitViewer(
    url: string,
    { limit = 16, area = [1000, 400] }: Visit = {},
  ): Promise<void> {
    await TestBed.inject(Router).navigateByUrl(url);
    await settle();
    if (!url.includes('max_channels=')) {
      const request = http.expectOne(VIEWER_URL);
      if (limit === null) {
        request.flush({ error: 'unavailable' }, { status: 500, statusText: 'Server Error' });
      } else {
        request.flush({ url: '', max_video_channels: limit });
      }
      await settle();
    }
    if (area !== null) await resize(area[0], area[1]);
  }

  async function navigate(url: string): Promise<void> {
    await TestBed.inject(Router).navigateByUrl(url);
    await settle();
  }

  async function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
    // Cancelable like a real key press, so a control's preventDefault is seen by the page.
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
    await settle();
  }

  async function click(element: HTMLElement): Promise<void> {
    element.click();
    await settle();
  }

  async function enter(input: HTMLInputElement, value: string): Promise<void> {
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
  }

  /** Six 300 px tiles per page in the 1000×400 grid: three columns, two rows. */
  const sixPerPage = () => storage.seed({ layout: { tileWidths: { 16: 300 } } });

  /** Makes the channel's tile play with most of its metadata late, for one stats tick. */
  async function makeLate(channel: number): Promise<void> {
    const tile = kitTile(channel);
    vi.spyOn(tile, 'snapshot').mockReturnValue({ ...tile.snapshot(), recentLateShare: 0.9 });
    tile.stateChange.emit('playing');
    tile.frameStats.emit({} as NeatFrameStats);
    await settle();
  }

  it('shows one tile per channel on the current page: max 16, perPage 6 → pages 1..3', async () => {
    sixPerPage();
    await open('/viewer');

    expect(shown()).toEqual(range(6));
    expect(toolbar().textContent).toContain('of 3');
    expect(pageInput().value).toBe('1');
    expect(button('Previous page').disabled).toBe(true);

    await click(button('Next page'));
    expect(shown()).toEqual(range(6, 6));
    expect(pageInput().value).toBe('2');

    await click(button('Next page'));
    expect(shown()).toEqual([12, 13, 14, 15]);
    expect(button('Next page').disabled).toBe(true);
    expect(fake.held()).toEqual([12, 13, 14, 15]);
  });

  it('src=3,1,9 shows channels 3, 1, 9 in that order and max_channels=4 drops 9', async () => {
    await open('/viewer?src=3,1,9');
    expect(shown()).toEqual([3, 1, 9]);

    await navigate('/viewer?src=3,1,9&max_channels=4');
    expect(shown()).toEqual([3, 1]);
  });

  it('the stored width for the displayed count wins; without one the fit-all width is used', async () => {
    storage.seed({ layout: { tileWidths: { 4: 400 } } });
    await open('/viewer');
    // 16 tiles in 1000×400 fit at most 167 px wide (4 or 5 columns, 4 rows).
    expect(tileWidth()).toBe('167px');

    // The fit follows the area until the user picks a size.
    await resize(600, 400);
    expect(tileWidth()).toBe('144px');

    await navigate('/viewer?src=0,1,2,3');
    expect(tileWidth()).toBe('400px');
  });

  it('fits all with the gap the grid reports, not one of its own', async () => {
    // A stylesheet that sets the grid's gap to 24 px (jsdom has none, so the grid would use 8).
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) =>
      element.classList.contains('grid')
        ? ({ columnGap: '24px' } as CSSStyleDeclaration)
        : computed(element, pseudo),
    );
    await open('/viewer');

    // 16 tiles in 1000×400 fit 167 px wide with an 8 px gap (the test above), 146 px with 24.
    expect(tileWidth()).toBe('146px');
    expect(
      root()
        .querySelector<HTMLElement>('neat-tile-grid .grid')!
        .style.getPropertyValue('--grid-gap'),
    ).toBe('24px');
  });

  it('moving the slider stores the width for the current count only', async () => {
    await open('/viewer');
    expect(storage.readStored('layout')).toBeNull();

    await press('ArrowRight', {}, slider());
    expect(tileWidth()).toBe('168px');
    expect(storage.readStored('layout')).toMatchObject({ tileWidths: { 16: 168 } });

    // Four channels have no size of their own: they fit all (2×2 at 348 px), and 16 keeps 168.
    await navigate('/viewer?src=0,1,2,3');
    expect(tileWidth()).toBe('348px');
    expect(storage.readStored('layout')).toMatchObject({ tileWidths: { 16: 168 } });
    expect(
      Object.keys((storage.readStored('layout') as { tileWidths: object }).tileWidths),
    ).toEqual(['16']);
  });

  it('Fit all forgets the width chosen for the displayed count, so all channels fit again', async () => {
    await open('/viewer');
    expect(button('Fit all').disabled).toBe(true);
    expect(button('Fit all').getAttribute('neatTooltip')).toBe('Fit all');

    await press('ArrowRight', {}, slider());
    expect(tileWidth()).toBe('168px');
    expect(button('Fit all').disabled).toBe(false);

    await click(button('Fit all'));
    expect(tileWidth()).toBe('167px');
    expect((storage.readStored('layout') as { tileWidths: object }).tileWidths).toStrictEqual({});
    expect(button('Fit all').disabled).toBe(true);
  });

  it('shrinking the area keeps the selected channel on screen', async () => {
    sixPerPage();
    await open('/viewer');

    await enter(channelInput(), '10');
    expect(shown()).toEqual(range(6, 6));
    expect(tileElement(10).querySelector('neat-video-tile')!.hasAttribute('data-selected')).toBe(
      true,
    );

    // Two columns and two rows of 300 px tiles: four per page, and 10 is on the third.
    await resize(700, 400);
    expect(shown()).toEqual([8, 9, 10, 11]);
    expect(pageInput().value).toBe('3');
  });

  it('arrow keys page, g focuses the page input, both ignored with modifiers and inside inputs', async () => {
    sixPerPage();
    await open('/viewer');

    await press('ArrowRight');
    expect(shown()).toEqual(range(6, 6));
    await press('ArrowLeft');
    expect(shown()).toEqual(range(6));

    for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey']) {
      await press('ArrowRight', { [modifier]: true });
      expect(shown()).toEqual(range(6));
      await press('g', { [modifier]: true });
      expect(document.activeElement).not.toBe(pageInput());
    }

    await press('ArrowRight', {}, channelInput());
    await press('ArrowRight', {}, slider());
    expect(shown()).toEqual(range(6));

    await click(button('Inspector'));
    await press('ArrowRight', {}, root().querySelector('aside [neatPageAside]')!);
    expect(shown()).toEqual(range(6));

    await press('g');
    expect(document.activeElement).toBe(pageInput());
    // Focus is in the page input now, so a further g is typing, not a shortcut.
    await press('ArrowRight', {}, pageInput());
    expect(shown()).toEqual(range(6));
  });

  it('go to page clamps the page number; a channel jump pages to the channel and selects it', async () => {
    sixPerPage();
    await open('/viewer');

    await enter(pageInput(), '3');
    expect(shown()).toEqual([12, 13, 14, 15]);
    await enter(pageInput(), '9');
    expect(pageInput().value).toBe('3');
    await enter(pageInput(), 'x');
    expect(pageInput().value).toBe('3');
    expect(shown()).toEqual([12, 13, 14, 15]);

    await enter(channelInput(), '7');
    expect(shown()).toEqual(range(6, 6));
    expect(page().selectedChannel()).toBe(7);
    // As in 829ec7c, the field keeps what was typed.
    expect(channelInput().value).toBe('7');
    await enter(channelInput(), '16');
    expect(shown()).toEqual(range(6, 6));
    expect(page().selectedChannel()).toBe(7);
  });

  it('a click or Enter selects a tile and Escape clears the selection', async () => {
    sixPerPage();
    await open('/viewer');

    await click(tileElement(4));
    expect(page().selectedChannel()).toBe(4);

    await press('Enter', {}, tileElement(2));
    expect(page().selectedChannel()).toBe(2);

    await press('Escape');
    expect(page().selectedChannel()).toBeNull();
  });

  it('hide empty shows only channels live in /api/ingest/stats and stops polling when switched off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    sixPerPage();
    await open('/viewer');

    await click(toggle('Hide empty'));
    // Until the first answer it is unknown which channels are live, so none is shown.
    expect(shown()).toEqual([]);
    expect(fake.held()).toEqual([]);
    http.expectOne(STATS_URL).flush({
      channels: [
        { channel: 2, active: true },
        { channel: 5, active: true },
      ],
    });
    await settle();
    expect(shown()).toEqual([2, 5]);

    vi.advanceTimersByTime(2000);
    http.expectOne(STATS_URL).flush({ channels: [{ channel: 5, active: true }] });
    await settle();
    expect(shown()).toEqual([5]);

    await click(toggle('Hide empty'));
    expect(shown()).toEqual(range(6));
    vi.advanceTimersByTime(10_000);
    http.expectNone(STATS_URL);
  });

  it('with hide empty on, shows no channel and holds no connection until ingest stats answer', async () => {
    storage.seed({ layout: { tileWidths: { 16: 300 }, hideEmpty: true } });
    await open('/viewer');

    expect(shown()).toEqual([]);
    expect(fake.held()).toEqual([]);
    // Not "no channel is receiving video": that is not known yet either.
    expect(root().querySelector('.empty')).toBeNull();
    expect(notice()).toBe('');

    http.expectOne(STATS_URL).flush({ channels: [{ channel: 3, active: true }] });
    await settle();
    expect(shown()).toEqual([3]);
    expect(fake.held()).toEqual([3]);
  });

  it('with ingest stats unavailable, hide empty shows every channel and says why', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    storage.seed({ layout: { tileWidths: { 16: 300 }, hideEmpty: true } });
    await open('/viewer');
    expect(notice()).toBe('');

    http
      .expectOne(STATS_URL)
      .flush({ error: 'vf ingest stats unavailable' }, { status: 502, statusText: 'Bad Gateway' });
    await settle();
    expect(shown()).toEqual(range(6));
    expect(notice()).toBe('Live channels unknown: ingest stats unavailable');

    vi.advanceTimersByTime(2000);
    http.expectOne(STATS_URL).flush({ channels: [{ channel: 3, active: true }] });
    await settle();
    expect(shown()).toEqual([3]);
    expect(notice()).toBe('');
  });

  it('a stats failure after a good answer keeps the tiles and shows the notice until the next answer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    storage.seed({ layout: { tileWidths: { 16: 300 }, hideEmpty: true } });
    await open('/viewer');
    http.expectOne(STATS_URL).flush({ channels: [{ channel: 3, active: true }] });
    await settle();
    expect(shown()).toEqual([3]);

    vi.advanceTimersByTime(2000);
    http
      .expectOne(STATS_URL)
      .flush({ error: 'vf ingest stats unavailable' }, { status: 502, statusText: 'Bad Gateway' });
    await settle();
    expect(shown()).toEqual([3]);
    expect(fake.held()).toEqual([3]);
    expect(notice()).toBe('Live channels unknown: ingest stats unavailable');

    vi.advanceTimersByTime(2000);
    http.expectOne(STATS_URL).flush({
      channels: [
        { channel: 3, active: true },
        { channel: 7, active: true },
      ],
    });
    await settle();
    expect(shown()).toEqual([3, 7]);
    expect(notice()).toBe('');
  });

  it('arrow keys on the tile shape change the shape, not the page', async () => {
    sixPerPage();
    await open('/viewer');

    await press('ArrowRight', {}, toolbar().querySelector('[role="radio"][aria-checked="true"]')!);

    expect(storage.readStored('layout')).toMatchObject({ aspect: '1:1' });
    expect(pageInput().value).toBe('1');
  });

  it('falls back to all 80 channels when the channel limit cannot be read', async () => {
    storage.seed({ layout: { tileWidths: { 80: 300 } } });
    await open('/viewer', { limit: null });

    expect(shown()).toEqual(range(6));
    expect(toolbar().textContent).toContain('of 14');
    expect(channelInput().placeholder).toBe('0–79');
  });

  it('holds no connection before the grid has measured itself', async () => {
    await open('/viewer', { area: null });

    expect(shown()).toEqual([]);
    expect(fake.held()).toEqual([]);

    await resize(1000, 400);
    expect(fake.held()).toEqual(range(16));
  });

  it('paging from a focused tile moves focus to the first tile of the new page', async () => {
    sixPerPage();
    await open('/viewer');
    tileElement(2).focus();

    await press('ArrowRight', {}, tileElement(2));
    expect(shown()).toEqual(range(6, 6));
    expect(document.activeElement).toBe(tileElement(6));

    await press('ArrowLeft', {}, tileElement(6));
    expect(document.activeElement).toBe(tileElement(0));
  });

  it('bars off hides labels, statuses and chips on every tile', async () => {
    sixPerPage();
    await open('/viewer');
    await makeLate(0);
    expect(root().querySelectorAll('neat-video-tile .bar')).toHaveLength(6);
    expect(root().querySelector('button[neatTileChip]')).not.toBeNull();

    await click(toggle('Bars'));

    expect(root().querySelectorAll('neat-video-tile .bar')).toHaveLength(0);
    expect(root().querySelector('button[neatTileChip]')).toBeNull();
    expect(storage.readStored('layout')).toMatchObject({ bars: false });
  });

  it('the late chip selects its tile and opens the inspector on the General tab', async () => {
    sixPerPage();
    await open('/viewer');
    await makeLate(3);

    await click(root().querySelector<HTMLElement>('button[neatTileChip]')!);

    expect(page().selectedChannel()).toBe(3);
    expect(page().inspectorTab()).toBe('General');
    expect(root().querySelector('aside')?.textContent).toContain('Channel 3');
    expect(button('Inspector').getAttribute('aria-pressed')).toBe('true');
  });

  it('switches the tile shape and stores it', async () => {
    await open('/viewer');

    await click(toolbar().querySelector<HTMLElement>('[role="radio"][aria-checked="false"]')!);

    expect(storage.readStored('layout')).toMatchObject({ aspect: '1:1' });
    // 16 squares in 1000×400 fit at most 128 px wide (6 columns, 3 rows).
    expect(tileWidth()).toBe('128px');
  });

  it('mode=dark applies dark without persisting it', async () => {
    await open('/viewer?mode=dark');

    expect(document.documentElement.classList.contains('neat-dark')).toBe(true);
    expect(storage.writes.filter((write) => write.key === 'neat-ui:color-scheme')).toEqual([]);
  });

  it('debug=1 logs connection events', async () => {
    await open('/viewer');
    expect(fake.debug).toBe(false);

    await navigate('/viewer?debug=1');
    expect(fake.debug).toBe(true);
  });

  it('the stored debug flag logs connection events too', async () => {
    storage.seed({ debug: '1' });
    await open('/viewer');

    expect(fake.debug).toBe(true);
  });

  it('leaving the page releases off-page connections; destroying it closes all', async () => {
    sixPerPage();
    await open('/viewer');
    expect(fake.held()).toEqual(range(6));

    await click(button('Next page'));
    expect(fake.held()).toEqual(range(6, 6));
    expect([...fake.released].sort((a, b) => a - b)).toEqual(range(6));

    fixture.destroy();
    expect(fake.closedAll).toBeGreaterThan(0);
  });

  it('page, selection and inspector tab survive leaving the Viewer and coming back', async () => {
    sixPerPage();
    await open('/viewer');
    await enter(channelInput(), '10');
    await click(button('Inspector'));
    await click(
      [...root().querySelectorAll<HTMLElement>('aside [role="tab"]')].find(
        (tab) => tab.textContent?.trim() === 'General',
      )!,
    );
    expect(page().inspectorTab()).toBe('General');

    await leaveAndReturn('/viewer');

    // Leaving closed the connections, as it must; the position came back.
    expect(fake.closedAll).toBeGreaterThan(0);
    expect(shown()).toEqual(range(6, 6));
    expect(pageInput().value).toBe('2');
    expect(page().selectedChannel()).toBe(10);
    expect(page().inspectorTab()).toBe('General');
    expect(root().querySelector('aside')?.textContent).toContain('Channel 10');
  });

  it('a different number of tiles per page on return still shows the first channel left on screen', async () => {
    sixPerPage();
    await open('/viewer');
    await enter(pageInput(), '3');
    expect(shown()).toEqual([12, 13, 14, 15]);

    // Four 300 px tiles per page now: channel 12 is on the fourth.
    await leaveAndReturn('/viewer', { area: [700, 400] });

    expect(shown()).toEqual([12, 13, 14, 15]);
    expect(pageInput().value).toBe('4');
  });

  it('a remembered position the link no longer shows falls back to the first page, nothing selected', async () => {
    sixPerPage();
    await open('/viewer');
    await enter(channelInput(), '10');

    await leaveAndReturn('/viewer?src=0,1,2,3');

    expect(shown()).toEqual([0, 1, 2, 3]);
    expect(pageInput().value).toBe('1');
    expect(page().selectedChannel()).toBeNull();
  });
});
