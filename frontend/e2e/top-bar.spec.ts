import { expect, Page, test } from '@playwright/test';
// Types only, erased at run time.
import type { BoardState } from '../src/app/board/api';
import { LAPTOP, topBarSpill } from './layout';
import { answerSlots, answerTopBar, answerViewer, LONG_BOARD, LONG_HOST } from './top-bar';

/** The top bar's System Info button, ⓘ, after the pill. */
const systemInfo = (page: Page) => page.getByRole('button', { name: 'System information' });

const pill = (page: Page) => page.locator('app-board-pill button');

/**
 * The page the System Info tests open the dialog from: Streaming with no slots, which asks for
 * nothing else. (Stats polls the board's Sentinel, and these tests are about the dialog.)
 */
const answerEmptyStreaming = (page: Page) =>
  page.route(
    (url) => url.pathname === '/api/mediasrc',
    (route) => route.fulfill({ json: [] }),
  );

/** The pages with the widest page tools, and what each needs answered to show them. */
const PAGES = [
  { path: '/viewer', answer: answerViewer },
  { path: '/streaming', answer: (page: Page) => answerSlots(page, 48) },
];

/**
 * The long-named board with the widest chip a board with a target shows, "Not checked" (as after
 * Change board, where nothing checks), so the layout checks see the pill at its widest. A board in
 * that state is checked as the app loads; the check answers it unchanged, so the chip stays.
 */
const UNCHECKED_LONG_BOARD: BoardState = {
  ...LONG_BOARD,
  status: { state: 'unknown', checked_at: null, error: null },
};

for (const { path, answer } of PAGES) {
  test(`on ${path} at 1366×768, a board name at the pill's cap is cut and the top bar holds System Info`, async ({
    page,
  }) => {
    await answerTopBar(page);
    await page.route(
      (url) => url.pathname === '/api/board' || url.pathname === '/api/board/test',
      (route) => route.fulfill({ json: UNCHECKED_LONG_BOARD }),
    );
    await answer(page);
    await page.setViewportSize(LAPTOP);
    await page.goto(path);
    await expect(page.getByRole('group', { name: 'Page tools' })).toBeVisible();
    await expect(pill(page)).toContainText('Board: devkit-lab');
    await expect(pill(page)).toContainText('Not checked');

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
  await answerEmptyStreaming(page);
  await page.setViewportSize(LAPTOP);
  await page.goto('/streaming');
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
  // The host's readings do not come from neat: they are there beside its note.
  await expect(dialog.getByRole('heading', { name: 'This computer' })).toBeVisible();
  await expect(dialog.getByText('61% · 120.00 GB of 200.00 GB · /home/sima')).toBeVisible();
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

test('every list in System information starts its values in the same column', async ({ page }) => {
  await answerTopBar(page);
  await page.route(
    (url) => url.pathname === '/api/sysinfo',
    (route) =>
      route.fulfill({
        json: {
          environment: {
            label: 'SDK on a DevKit',
            sdkVersion: '2.1.0',
            devkitBuildVersion: '2.1.0-b12',
          },
          insight: { serviceState: 'Running', webUiUrl: 'https://10.1.1.5:9900' },
          components: {
            neatCore: { name: 'Neat core', version: '1.4.0', updateAvailable: false },
            neatInsight: {
              name: 'A component with a very long name that has to wrap',
              version: '0.9.1',
            },
          },
          exposedPorts: [
            { name: 'rtp.udp', protocol: 'udp', hostPortStart: 9000, hostPortEnd: 9079 },
          ],
          updateCheck: { offline: false, status: 'Current' },
        },
      }),
  );
  await answerEmptyStreaming(page);
  await page.setViewportSize(LAPTOP);
  await page.goto('/streaming');
  await systemInfo(page).click();
  const dialog = page.getByRole('dialog', { name: 'System information' });
  await dialog.getByRole('button', { name: 'Components' }).click();
  await dialog.getByRole('button', { name: 'Exposed ports' }).click();
  await expect(dialog.getByText('RTP UDP')).toBeVisible();

  const columns = await dialog.evaluate((root) =>
    [...root.querySelectorAll('dl')].map((list) => {
      const dd = list.querySelector('dd')!.getBoundingClientRect();
      return {
        valueStart: Math.round(dd.left),
        // No term runs into the values, however long it is.
        termsFit: [...list.querySelectorAll('dt')].every(
          (dt) => dt.getBoundingClientRect().right <= dd.left,
        ),
      };
    }),
  );
  // Environment, Insight, This computer, Components, Exposed ports and Update check.
  expect(columns).toHaveLength(6);
  expect(new Set(columns.map((column) => column.valueStart)).size).toBe(1);
  expect(columns.every((column) => column.termsFit)).toBe(true);
});
