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

/** The top bar's System Info button, ⓘ, after the pill. */
const systemInfo = (page: Page) => page.getByRole('button', { name: 'System information' });

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
  test(`on ${path} at 1366×768, a board name at the pill's cap is cut and the top bar holds System Info`, async ({
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

    // System Info's button sits whole in the bar, after the pill, and the page tools keep their
    // room (nothing spills, nothing scrolls).
    await expect(systemInfo(page)).toBeVisible();
    const [pillBox, infoBox] = await Promise.all([
      pill(page).boundingBox(),
      systemInfo(page).boundingBox(),
    ]);
    expect(infoBox!.x).toBeGreaterThanOrEqual(pillBox!.x + pillBox!.width);
    expect(await topBarSpill(page, false)).toEqual({ spilled: [], toolsOverflow: 0 });
  });
}

test('System information opens from the top bar, tells what it can without neat, and Escape gives the focus back', async ({
  page,
}) => {
  await answerTopBar(page);
  await page.setViewportSize(LAPTOP);
  await page.goto('/stats');
  const button = systemInfo(page);
  await expect(button).toBeVisible();

  await button.focus();
  await button.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'System information' });
  await expect(dialog).toBeVisible();
  // The shared answer is Insight's own, without the neat command: its note instead of the
  // sections only neat can fill, and what Insight knows by itself.
  await expect(dialog.getByText('The neat command is not installed here')).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Insight' })).toBeVisible();
  await expect(dialog.getByText('https://127.0.0.1:9900').first()).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Environment' })).toHaveCount(0);
  await expect(dialog.getByRole('heading', { name: 'Components' })).toHaveCount(0);
  // Exposed ports start closed.
  const ports = dialog.getByRole('button', { name: 'Exposed ports' });
  await expect(ports).toHaveAttribute('aria-expanded', 'false');
  await ports.click();
  await expect(dialog.getByText('TCP 9900')).toBeVisible();

  // The dialog fits the screen.
  const box = (await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(LAPTOP.height);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
});
