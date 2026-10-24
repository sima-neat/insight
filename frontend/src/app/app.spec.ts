import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { App } from './app';
import { appConfig } from './app.config';
import { boardState, DEVKIT, shellInfo } from './board/board.testing';

/**
 * A routed page that does nothing of its own. The shell is what this spec is about; a real page
 * would load its lazy chunk and start its own requests and video, which its own specs cover.
 */
@Component({ selector: 'app-stand-in-page', template: '<p>Stand-in page</p>' })
class StandInPage {}

describe('App', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    // The app's own HTTP client, answered here: the top bar's pill reads the board at start.
    TestBed.configureTestingModule({
      providers: [...appConfig.providers, provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    document.querySelectorAll('.cdk-overlay-container').forEach((container) => container.remove());
  });

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
    expect(Array.from(root.querySelectorAll('nav a'), (a) => a.textContent?.trim())).toEqual([
      'Media',
      'Streaming',
      'Viewer',
      'Peripherals',
      'Stats',
    ]);
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

  it('puts the board pill at the end of the top bar, naming the board it read', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/board').flush(
      boardState({
        target: DEVKIT,
        status: { state: 'connected', checked_at: null, error: null },
      }),
    );
    await settle(fixture);
    const root: HTMLElement = fixture.nativeElement;

    const pill = root.querySelector('header .topbar-end app-board-pill button')!;
    expect(pill.querySelector('.label')?.textContent?.trim()).toBe('DevKit: 192.168.1.20');
    expect(pill.querySelector('neat-status-chip')?.textContent?.trim()).toBe('Connected');
  });

  it('reads the shell info when the dialog opens, never at app start', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/board').flush(boardState({ target: DEVKIT }));
    await settle(fixture);
    // The shell details carry the launch URL with the SDK's default password (spec, "Shell URL").
    http.expectNone('/api/devkit-shell');
    http.expectNone('/api/peripherals');

    fixture.nativeElement.querySelector('app-board-pill button').click();
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

  it('closing the board dialog gives the focus back to the pill', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/board').flush(boardState({ target: DEVKIT }));
    await settle(fixture);
    const pill: HTMLButtonElement = fixture.nativeElement.querySelector('app-board-pill button');

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

  it('puts System information after the pill, and loads it only when it is opened', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/board').flush(boardState({ target: DEVKIT }));
    await settle(fixture);
    // The command behind it runs for up to 15 s: never at app start.
    http.expectNone('/api/sysinfo');

    const pill = fixture.nativeElement.querySelector('header .topbar-end app-board-pill');
    const info = pill.nextElementSibling;
    expect(info.getAttribute('aria-label')).toBe('System information');
    expect(info.tagName).toBe('BUTTON');
  });

  it('the ⓘ button opens the dialog; Escape closes it and focus returns to the button', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/board').flush(boardState({ target: DEVKIT }));
    await settle(fixture);
    const info: HTMLButtonElement = fixture.nativeElement.querySelector(
      'header button[aria-label="System information"]',
    );

    info.focus();
    info.click();
    // The dialog's module loads on this first open.
    await vi.waitFor(() => expect(document.querySelector('app-system-info-dialog')).not.toBeNull());
    http.expectOne('/api/sysinfo').flush({ insight: { webUiUrl: 'https://127.0.0.1:9900' } });
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
