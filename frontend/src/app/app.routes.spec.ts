import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { App } from './app';
import { appConfig } from './app.config';
import { MediaPage } from './pages/media/media.page';
import { PeripheralsPage } from './pages/peripherals/peripherals.page';
import { StatsPage } from './pages/stats/stats.page';
import { StreamingPage } from './pages/streaming/streaming.page';
import { ViewerPage } from './pages/viewer/viewer.page';

const PAGES: [path: string, page: Type<unknown>, title: string][] = [
  ['/media', MediaPage, 'Media'],
  ['/streaming', StreamingPage, 'Streaming'],
  ['/viewer', ViewerPage, 'Viewer'],
  ['/peripherals', PeripheralsPage, 'Peripherals'],
  ['/stats', StatsPage, 'Stats'],
];

/** The Stats views' addresses, each of which shows the Stats page. */
const STATS_VIEWS = ['/stats/runs', '/stats/compare'];

/**
 * Stubs jsdom's missing ResizeObserver, which the kit measures with, and gives the TestBed the
 * app's own providers, so the routes are tested with the title strategy the app uses.
 */
function setUp(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        // jsdom lays nothing out, so nothing ever resizes.
      }
      unobserve(): void {
        // Nothing observed.
      }
      disconnect(): void {
        // Nothing observed.
      }
    },
  );
  TestBed.configureTestingModule({ providers: appConfig.providers });
}

describe('routes', () => {
  let harness: RouterTestingHarness;
  let router: Router;

  beforeEach(async () => {
    setUp();
    harness = await RouterTestingHarness.create();
    router = TestBed.inject(Router);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(PAGES)('%s renders its page', async (path, page) => {
    // The harness throws unless the routed component is an instance of `page`.
    await harness.navigateByUrl(path, page);

    expect(router.url).toBe(path);
  });

  it.each(STATS_VIEWS)('%s renders the Stats page, titled Stats', async (path) => {
    await harness.navigateByUrl(path, StatsPage);

    expect(router.url).toBe(path);
    expect(TestBed.inject(Title).getTitle()).toBe('Neat Insight · Stats');
  });

  it('redirects / to /streaming', async () => {
    await harness.navigateByUrl('/', StreamingPage);

    expect(router.url).toBe('/streaming');
  });

  it('redirects /rtsp to /streaming and /visualizer to /stats', async () => {
    await harness.navigateByUrl('/rtsp', StreamingPage);
    expect(router.url).toBe('/streaming');

    await harness.navigateByUrl('/visualizer', StatsPage);
    expect(router.url).toBe('/stats');
  });

  it.each(['/workspace', '/genai', '/media/unknown/nested'])(
    'redirects unknown paths such as %s to /streaming',
    async (path) => {
      await harness.navigateByUrl(path, StreamingPage);

      expect(router.url).toBe('/streaming');
    },
  );

  it('sets the document title to "Neat Insight · <Page>"', async () => {
    const documentTitle = TestBed.inject(Title);

    for (const [path, page, title] of PAGES) {
      await harness.navigateByUrl(path, page);
      expect(documentTitle.getTitle()).toBe(`Neat Insight · ${title}`);
    }
  });
});

describe('the rail on the Stats views', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(STATS_VIEWS)('keeps Stats current at %s', async (path) => {
    setUp();
    const fixture = TestBed.createComponent(App);
    await TestBed.inject(Router).navigateByUrl(path);
    await fixture.whenStable();

    // The rail only: the page's own tabs (Stats' views) are `aria-current` links too.
    const current = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'nav[aria-label="Main"] a[aria-current="page"]',
    );
    expect(Array.from(current, (link) => link.textContent?.trim())).toEqual(['Stats']);
  });
});
