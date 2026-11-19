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

/** The Stats views' addresses, each of which shows the Stats page, with the title it sets. */
const STATS_VIEWS: [string, string][] = [
  ['/stats/runs', 'Stats'],
  ['/stats/runs/compare', 'Compare'],
];

/**
 * Stubs jsdom's missing ResizeObserver, which the kit measures with, and gives the TestBed the
 * app's own providers, so the routes are tested with the titles the app sets.
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

  it.each(STATS_VIEWS)('%s renders the Stats page, titled %s', async (path, title) => {
    await harness.navigateByUrl(path, StatsPage);

    expect(router.url).toBe(path);
    expect(TestBed.inject(Title).getTitle()).toBe(`Neat Insight · ${title}`);
  });

  it('redirects / to /streaming', async () => {
    await harness.navigateByUrl('/', StreamingPage);

    expect(router.url).toBe('/streaming');
  });

  it.each(['/workspace', '/visualizer', '/media/unknown/nested'])(
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

    // Collapsed, as here, Stats is the button that opens its menu; expanded, its open child is the
    // current link instead. Either way one rail entry is current.
    const current = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'nav[aria-label="Main"] [aria-current="page"]',
    );
    expect(Array.from(current, (link) => link.textContent?.trim())).toEqual(['Stats']);
  });
});
