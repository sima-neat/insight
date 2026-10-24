import { expect, Page, test } from '@playwright/test';
import { LAPTOP, topBarSpill } from './layout';
import { answerTopBar, TOP_BAR_BOARD } from './top-bar';

/** A board whose name runs far past the pill's label cap: a long host name, entered by hand. */
const LONG_HOST = 'devkit-lab-bench-07.vision.corp.example.com';
const LONG_BOARD = {
  ...TOP_BAR_BOARD,
  target: {
    mode: 'ssh',
    source: 'manual',
    host: LONG_HOST,
    port: 22,
    user: 'sima',
    label: `sima@${LONG_HOST}`,
  },
  saved: { host: LONG_HOST, port: 22, user: 'sima' },
};

/** System Info's ⓘ, which Task 11 puts after the pill: a 40 px button and the end slot's 8 px gap. */
const SYSTEM_INFO_ROOM = 48;

/**
 * The space the page tools leave free in the top bar: between the page title and the tools, less
 * the bar's own gap. The tools sit at the end (`margin-inline-start: auto`), so what is left is
 * what a new end item can take before they have to shrink and scroll.
 */
function freeRoom(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('header')!;
    const title = header.querySelector('h1')!.getBoundingClientRect();
    const tools = header.querySelector('[role="group"][aria-label="Page tools"]')!;
    const gap = parseFloat(getComputedStyle(header).columnGap);
    return tools.getBoundingClientRect().left - title.right - gap;
  });
}

const pill = (page: Page) => page.locator('app-board-pill button');

/** The pages with the widest page tools, and what each needs answered to show them. */
const PAGES = [
  {
    path: '/viewer',
    answer: async (page: Page) => {
      await page.route(
        (url) => url.pathname === '/api/viewer-url',
        (route) =>
          route.fulfill({
            json: {
              url: 'https://127.0.0.1:9900/viewer?max_channels=16',
              max_video_channels: 16,
              channel_limit_source: 'sdk-port-map',
              sdk_channel_limited: true,
            },
          }),
      );
      await page.route(
        (url) => url.pathname === '/api/ingest/stats',
        (route) =>
          route.fulfill({
            json: { time: '2026-10-22T12:00:00Z', active_ttl_ms: 3000, channels: [] },
          }),
      );
      await page.route(
        (url) => url.pathname === '/api/vf/offer',
        (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'No stream' }),
      );
    },
  },
  {
    path: '/streaming',
    answer: (page: Page) =>
      page.route(
        (url) => url.pathname === '/api/mediasrc',
        (route) =>
          route.fulfill({
            json: Array.from({ length: 48 }, (_, i) => ({
              index: i + 1,
              file: '',
              state: 'stopped',
              transport: '',
              codec: 'unknown',
              type: 'file',
              allowed_transports: [],
              urls: {},
              readers: [],
            })),
          }),
      ),
  },
];

for (const { path, answer } of PAGES) {
  test(`on ${path} at 1366×768, a board name at the pill's cap is cut and leaves room for System Info`, async ({
    page,
  }) => {
    await answerTopBar(page);
    await page.route(
      (url) => url.pathname === '/api/board',
      (route) => route.fulfill({ json: LONG_BOARD }),
    );
    await answer(page);
    await page.setViewportSize(LAPTOP);
    await page.goto(path);
    await expect(page.getByRole('group', { name: 'Page tools' })).toBeVisible();
    await expect(pill(page)).toContainText('Board: devkit-lab');

    // The name is cut at the cap…
    const label = pill(page).locator('.label');
    const cut = await label.evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(cut).toBe(true);
    // …and the tooltip names the board in full.
    await pill(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText(
      `sima@${LONG_HOST} — Not checked. Open board settings.`,
    );

    expect(await freeRoom(page)).toBeGreaterThanOrEqual(SYSTEM_INFO_ROOM);
    expect(await topBarSpill(page, false)).toEqual({ spilled: [], toolsOverflow: 0 });
  });
}
