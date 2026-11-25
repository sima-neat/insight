import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { App } from './app';
import { appConfig } from './app.config';
import { boardList, boardWith, DEVKIT, railItem } from './board/board.testing';

/**
 * A routed page that does nothing of its own. The shell is what this spec is about; a real page
 * would load its lazy chunk and start its own requests and video, which its own specs cover.
 */
@Component({ selector: 'app-stand-in-page', template: '<p>Stand-in page</p>' })
class StandInPage {}

/** The SDK-paired DevKit, already checked: an unknown state would make the app check it at start. */
const checkedDevkit = () =>
  boardWith(DEVKIT, { status: { state: 'connected', checked_at: '2026-10-26T10:00:00Z' } });

/** The board routes of the DevKit. */
const devkitUrl = (path: string) => `/api/boards/${encodeURIComponent(DEVKIT.id)}/${path}`;

describe('App', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    // The app's own HTTP client, answered here: the rail's board block reads the board at start.
    TestBed.configureTestingModule({
      providers: [...appConfig.providers, provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    document.querySelectorAll('.cdk-overlay-container').forEach((container) => container.remove());
  });

  /** A rail button by its name: collapsed, its text is there for screen readers. */
  const railButton = (root: HTMLElement, name: string): HTMLButtonElement =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name,
    )!;
  const boardButton = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('app-board-rail button')!;

  /** Lets the promise chains behind an answered request run, then change detection. */
  async function settle(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  it('frames the routed page in the kit shell with the app name and the Insight rail', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/boards').flush(boardList());
    const router = TestBed.inject(Router);
    router.resetConfig([{ path: 'page', component: StandInPage }]);
    await router.navigateByUrl('/page');
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;

    expect(root.querySelector('neat-shell')?.textContent).toContain('Neat Insight');
    expect(
      Array.from(
        root.querySelectorAll('nav[aria-label="Main"] a, nav[aria-label="Main"] button'),
        (a) => a.textContent?.trim(),
      ),
    ).toEqual(['Media', 'Streaming', 'Viewer', 'Peripherals', 'Stats']);
    expect(root.querySelector('neat-shell app-stand-in-page')).not.toBeNull();
  });

  it('renders the toast host beside the shell, so any page can raise toasts', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/boards').flush(boardList());
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;

    const hosts = root.querySelectorAll('neat-toast-host');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].parentElement).toBe(root);
    expect(root.querySelector('neat-shell neat-toast-host')).toBeNull();
  });

  it('puts the board at the end of the rail, naming the board it read, and none in the top bar', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/boards').flush(boardWith(DEVKIT, { status: { state: 'connected' } }));
    await settle(fixture);
    const root: HTMLElement = fixture.nativeElement;

    const board = boardButton(root);
    expect(board.closest('header')).toBeNull();
    expect(railItem(board).text()).toBe('DevKit');
    expect(railItem(board).detail()).toBe('192.168.1.20');
    expect(railItem(board).label()).toBe('DevKit — 192.168.1.20 — Connected');
    // The top bar is the page's: nothing of the app's but the kiosk button is left in it.
    expect(root.querySelector('header app-board-rail')).toBeNull();
    expect(root.querySelector('header [aria-label="System information"]')).toBeNull();
    expect(root.querySelector('header .topbar-end')?.children).toHaveLength(0);
  });

  it('checks the connection once at start when the selected board was never checked', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/boards').flush(boardWith(DEVKIT));
    await settle(fixture);
    http
      .expectOne({ method: 'POST', url: devkitUrl('check') })
      .flush(boardWith(DEVKIT, { status: { state: 'error' } }));
    await settle(fixture);

    const board = boardButton(fixture.nativeElement);
    expect(railItem(board).text()).toBe('DevKit');
    expect(railItem(board).detail()).toBe('Error');
    expect(railItem(board).tone()).toBe('danger');
  });

  it('reads the last scan when the board dialog opens, never at app start, and shows the ssh command', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/boards').flush(checkedDevkit());
    await settle(fixture);
    http.expectNone(devkitUrl('peripherals'));

    boardButton(fixture.nativeElement).click();
    // The dialog's module loads on this first open.
    await vi.waitFor(() => expect(document.querySelector('app-board-dialog')).not.toBeNull());
    // The camera setup comes from the last scan, which never contacts the board.
    http.expectOne(devkitUrl('peripherals')).flush({ scan: null });
    await settle(fixture);
    expect(document.querySelector('app-board-dialog')?.textContent).toContain(
      'ssh sima@192.168.1.20',
    );
  });

  it('closing the board dialog gives the focus back to the board block', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/boards').flush(checkedDevkit());
    await settle(fixture);
    const pill = boardButton(fixture.nativeElement);

    pill.focus();
    pill.click();
    await vi.waitFor(() => expect(document.querySelector('app-board-dialog')).not.toBeNull());
    http.expectOne(devkitUrl('peripherals')).flush({ scan: null });
    await settle(fixture);
    // The focus moved into the dialog, which opens after an asynchronous import.
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);

    document
      .querySelector('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('app-board-dialog')).toBeNull());
    expect(document.activeElement).toBe(pill);
  });

  it('puts System information in the rail after the board and its divider, and loads it only when it is opened', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/boards').flush(checkedDevkit());
    await settle(fixture);
    // Its Refresh runs neat for up to 15 s: nothing of it at app start.
    http.expectNone('/api/system');

    const root: HTMLElement = fixture.nativeElement;
    const board = root.querySelector('app-board-rail')!;
    const divider = board.nextElementSibling!;
    const info = divider.nextElementSibling!;
    expect(divider.tagName).toBe('HR');
    expect(divider.getAttribute('aria-hidden')).toBe('true');
    expect(info.tagName).toBe('BUTTON');
    expect(info.textContent?.trim()).toBe('System information');
    expect(info.closest('header')).toBeNull();
    // The kit's theme item follows the app's items, then the rail's own control.
    expect(info.nextElementSibling?.textContent?.trim()).toBe('Dark theme');
  });

  it('System information opens from the rail; Escape closes it and focus returns to the item', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/boards').flush(checkedDevkit());
    await settle(fixture);
    const info = railButton(fixture.nativeElement, 'System information');

    info.focus();
    info.click();
    // The dialog's module loads on this first open.
    await vi.waitFor(() => expect(document.querySelector('app-system-info-dialog')).not.toBeNull());
    http.expectOne('/api/system/host').flush({ cpu_percent: 3, memory: null, disk: null });
    http.expectOne('/api/system').flush({
      insight: {
        version: '0.0.0',
        build: { go_version: 'go1.26.0', platform: 'linux/amd64' },
        place: 'host',
        data_dir: '/tmp/insight',
        port: 9900,
        web_ui_url: 'https://127.0.0.1:9900',
        network: { certificate_host: '127.0.0.1', browser_ice_address_source: 'default' },
        ports: {
          channels: 16,
          channels_source: 'default',
          webrtc_start: 9200,
          webrtc_end: 9215,
          rtsp: 0,
          whip: 8889,
          whip_ice: 8189,
        },
      },
      neat: { state: 'missing', exposed_ports: [] },
    });
    await settle(fixture);
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toContain(
      'System information',
    );
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);

    document
      .querySelector('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('app-system-info-dialog')).toBeNull());
    expect(document.activeElement).toBe(info);
  });
});
