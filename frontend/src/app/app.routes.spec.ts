import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
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

describe('routes', () => {
  let harness: RouterTestingHarness;
  let router: Router;

  beforeEach(async () => {
    // The app's own providers, so the routes are tested with the title strategy the app uses.
    TestBed.configureTestingModule({ providers: appConfig.providers });
    harness = await RouterTestingHarness.create();
    router = TestBed.inject(Router);
  });

  it.each(PAGES)('%s renders its page', async (path, page) => {
    // The harness throws unless the routed component is an instance of `page`.
    await harness.navigateByUrl(path, page);

    expect(router.url).toBe(path);
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
