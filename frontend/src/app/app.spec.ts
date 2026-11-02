import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { App } from './app';
import { appConfig } from './app.config';
import { boardState, DEVKIT, railItem, shellInfo } from './board/board.testing';

/**
 * A routed page that does nothing of its own. The shell is what this spec is about; a real page
 * would load its lazy chunk and start its own requests and video, which its own specs cover.
 */
@Component({ selector: 'app-stand-in-page', template: '<p>Stand-in page</p>' })
class StandInPage {}

/** The SDK-paired DevKit, already checked: an unknown state would make the app check it at start. */
const checkedDevkit = () =>
  boardState({
    target: DEVKIT,
    status: { state: 'connected', checked_at: '2026-10-26T10:00:00Z', error: null },
  });

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
    http.expectOne('/api/board').flush(boardState());
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
    http.expectOne('/api/board').flush(boardState());
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;

    const hosts = root.querySelectorAll('neat-toast-host');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].parentElement).toBe(root);
    expect(root.querySelector('neat-shell neat-toast-host')).toBeNull();
  });

  it('puts the board at the end of the rail, naming the board it read, and none in the top bar', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/board').flush(
      boardState({
        target: DEVKIT,
        status: { state: 'connected', checked_at: null, error: null },
      }),
    );
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
    http.expectOne('/api/board').flush(boardState({ target: DEVKIT }));
    await settle(fixture);
    http
      .expectOne({ method: 'POST', url: '/api/board/test' })
      .flush({ ...checkedDevkit(), status: { state: 'error', checked_at: null, error: null } });
    await settle(fixture);

    const board = boardButton(fixture.nativeElement);
    expect(railItem(board).text()).toBe('DevKit');
    expect(railItem(board).detail()).toBe('Error');
    expect(railItem(board).tone()).toBe('danger');
  });

  it('reads the shell info when the dialog opens, never at app start', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/board').flush(checkedDevkit());
    await settle(fixture);
    // The shell details carry the launch URL with the SDK's default password (spec, "Shell URL").
    http.expectNone('/api/devkit-shell');
    http.expectNone('/api/peripherals');

    boardButton(fixture.nativeElement).click();
    // The dialog's module loads on this first open.
    await vi.waitFor(() => expect(document.querySelector('app-board-dialog')).not.toBeNull());
    http.expectOne('/api/devkit-shell').flush(shellInfo());
    // The camera setup comes from the last scan, which never contacts the board.
    http.expectOne('/api/peripherals').flush(
      { error: 'No board', code: 'no_target' },
      {
        status: 409,
        statusText: 'Conflict',
      },
    );
    await settle(fixture);
    expect(document.querySelector('app-board-dialog')?.textContent).toContain('Open shell');
  });

  it('closing the board dialog gives the focus back to the board block', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/board').flush(checkedDevkit());
    await settle(fixture);
    const pill = boardButton(fixture.nativeElement);

    pill.focus();
    pill.click();
    await vi.waitFor(() => expect(document.querySelector('app-board-dialog')).not.toBeNull());
    http.expectOne('/api/devkit-shell').flush(shellInfo());
    http.expectOne('/api/peripherals').flush(
      { error: 'No board', code: 'no_target' },
      {
        status: 409,
        statusText: 'Conflict',
      },
    );
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
    http.expectOne('/api/board').flush(checkedDevkit());
    await settle(fixture);
    // The command behind it runs for up to 15 s: never at app start.
    http.expectNone('/api/sysinfo');

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
    http.expectOne('/api/board').flush(checkedDevkit());
    await settle(fixture);
    const info = railButton(fixture.nativeElement, 'System information');

    info.focus();
    info.click();
    // The dialog's module loads on this first open.
    await vi.waitFor(() => expect(document.querySelector('app-system-info-dialog')).not.toBeNull());
    http.expectOne('/api/sysinfo').flush({ insight: { webUiUrl: 'https://127.0.0.1:9900' } });
    http.expectOne('/api/metrics').flush({ cpu_load: 3, memory: {}, disk: null, REMOTE: false });
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
