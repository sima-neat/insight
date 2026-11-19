import { expect, Page, test } from '@playwright/test';
import { IMX477, YETI } from '../src/app/peripherals/scans.testing';
import { pageOverflow, TABLET, sidePanelToggle, topBarSpill, VIEWPORTS } from './layout';
import { devkitPath, FakePeripheralsBackend } from './peripherals-mocks';
import { answerTopBar, LONG_BOARD } from './top-bar';

// The rail's board block reads the board on every page; the backend below answers it for these tests.
test.beforeEach(({ page }) => answerTopBar(page));

/** The paths the page posts to on the DevKit: a camera's preview start, a scan, a mic test. */
const PREVIEW_URL = devkitPath(`cameras/${encodeURIComponent(IMX477.id)}/preview`);
/** The stop of the IMX477's preview `id`, which names the preview. */
const stopPath = (id: string) => `${PREVIEW_URL}/stop?preview=${id}`;
const REFRESH_URL = devkitPath('peripherals/refresh');
const MIC_TEST_URL = devkitPath(`microphones/${encodeURIComponent(YETI.id)}/test`);

const devices = (page: Page) => page.getByRole('listbox', { name: 'Devices' });
const device = (page: Page, name: string) =>
  devices(page).getByRole('option', { name: new RegExp(`^${escape(name)} `) });
const panel = (page: Page) => page.getByRole('region', { name: 'Selected device' });
const panelTitle = (page: Page) => panel(page).getByRole('heading', { level: 2 });
const tool = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Page tools' }).getByRole('button', { name });
const rail = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });
const toast = (page: Page, text: string) =>
  page.locator('[data-slot="toast"]').filter({ hasText: text });

/**
 * Whether the side panel title's chip lies inside the panel, and level with the heading's first
 * line (its middle within that line's height).
 */
function titleChipFit(page: Page): Promise<{ inside: boolean; firstLine: boolean }> {
  return panel(page)
    .locator('app-panel-title')
    .first()
    .evaluate((title) => {
      const box = (element: Element) => element.getBoundingClientRect();
      const chip = box(title.querySelector('neat-status-chip')!);
      const heading = title.querySelector('h2')!;
      const lineHeight = parseFloat(getComputedStyle(heading).lineHeight);
      const panelBox = box(title.closest('[aria-label="Selected device"]')!);
      const middle = (chip.top + chip.bottom) / 2;
      return {
        inside: chip.left >= panelBox.left && chip.right <= panelBox.right,
        firstLine: middle >= box(heading).top && middle <= box(heading).top + lineHeight,
      };
    });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Picks `option` in the side panel's select labelled `label`. */
async function choose(page: Page, label: string, option: string): Promise<void> {
  await panel(page).getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/**
 * Counts the plays and the ends of every `<audio>` in the page. Media events do not bubble, so
 * they are caught on the way down.
 */
async function countPlayback(
  page: Page,
): Promise<() => Promise<{ played: number; ended: number }>> {
  await page.addInitScript(() => {
    const counts = { played: 0, ended: 0 };
    (window as unknown as { playback: typeof counts }).playback = counts;
    document.addEventListener('playing', () => counts.played++, true);
    document.addEventListener('ended', () => counts.ended++, true);
  });
  return () =>
    page.evaluate(() => ({
      ...(window as unknown as { playback: { played: number; ended: number } }).playback,
    }));
}

// The page's one smoke flow: the scan, the preview and the microphone test end to end, in a real
// browser (the unit specs cover each state and every interleaving).
test('the devices are listed by kind, a camera previews and restarts on a new mode and stops while the page is away, and a microphone records and plays back', async ({
  page,
}) => {
  const playback = await countPlayback(page);
  const backend = new FakePeripheralsBackend();
  await backend.install(page);
  await page.goto('/peripherals');

  // The page scans the board as it opens, without a toast; then the list is grouped, with a muted
  // heading for the kind that has no devices.
  await expect(devices(page).getByRole('group', { name: 'Cameras · 2' })).toBeVisible();
  await expect(toast(page, 'Scan complete')).toHaveCount(0);
  await expect(devices(page).getByRole('group', { name: 'Microphones · 1' })).toBeVisible();
  await expect(devices(page).getByRole('group', { name: 'LiDAR · none found' })).toBeVisible();
  await expect(
    devices(page).getByRole('group', { name: 'Cameras · 2' }).getByRole('option'),
  ).toHaveText([
    /^imx477 5-001a\s*MIPI CSI\s*Available$/,
    /^HD Webcam C270\s*USB 2\.0\s*Unsupported$/,
  ]);
  await expect(page.getByRole('group', { name: 'Page tools' })).toContainText('Scanned just now');

  // The first camera is selected; its preview starts in its default mode.
  await expect(panelTitle(page)).toHaveText(IMX477.name);
  await panel(page).getByRole('button', { name: 'Start preview' }).click();
  await expect(
    panel(page).getByRole('img', { name: `Live preview of ${IMX477.name}` }),
  ).toBeVisible();
  await expect(panel(page)).toContainText('Live preview · 1920×1080 · NV12');
  await expect(device(page, IMX477.name)).toContainText('Previewing');
  expect(backend.posted(PREVIEW_URL)).toEqual([IMX477.default_selection]);

  // Another resolution restarts the preview on it: a stop, then a start.
  await choose(page, 'Resolution', '1280×720');
  await expect(panel(page)).toContainText('Live preview · 1280×720 · NV12');
  expect(backend.postedPaths().slice(-2)).toEqual([stopPath('p1'), PREVIEW_URL]);
  const hd = { format: 'NV12', width: 1280, height: 720, fps: 60 };
  expect(backend.posted(PREVIEW_URL).at(-1)).toEqual(hd);

  // Leaving the page stops the preview…
  await rail(page, 'Streaming').click();
  await expect(page).toHaveTitle('Neat Insight · Streaming');
  await expect.poll(() => backend.postedPaths().at(-1)).toBe(stopPath('p2'));

  // …and coming back scans the board again, then starts the preview again, in the mode it had:
  // one scan, before the one start, and nothing else.
  const leftAt = backend.postedPaths().length;
  await rail(page, 'Peripherals').click();
  await expect(panel(page)).toContainText('Live preview · 1280×720 · NV12');
  expect(backend.posted(PREVIEW_URL).at(-1)).toEqual(hd);
  expect(backend.postedPaths().slice(leftAt)).toEqual([REFRESH_URL, PREVIEW_URL]);

  // The microphone records with the live level, and its recording plays back by itself.
  await device(page, YETI.name).click();
  await expect(panelTitle(page)).toHaveText(YETI.name);
  await expect(panel(page)).toContainText('S24_3LE · 2 ch · 24-bit');
  const button = panel(page).getByRole('button', { name: /Test microphone|Stop recording/ });
  await button.click();
  await expect(button).toHaveText('Stop recording');
  await expect(panel(page)).toContainText(/Recording · 0:0\d/);
  await expect(device(page, YETI.name)).toContainText('Testing');
  // `seconds` is left to the server's default of 30.
  await expect.poll(() => backend.posted(MIC_TEST_URL)).toEqual([{}]);
  await button.click();
  // The stop names the test it stops.
  await expect.poll(() => backend.posted(`${MIC_TEST_URL}/stop?test=t1`)).toEqual([{}]);
  const replay = panel(page).getByRole('button', { name: 'Replay' });
  await expect(replay).toBeVisible();
  expect(await playback()).toEqual({ played: 1, ended: 1 });
  await replay.click();
  await expect.poll(playback).toEqual({ played: 2, ended: 2 });
  // Replay plays what was recorded: nothing more is asked of the board.
  expect(backend.posted(MIC_TEST_URL)).toHaveLength(1);
});

test('Peripherals fits at 1366×768, 1920×1080 and 768×1024 with the side panel open and closed, with the board and System Info in the rail', async ({
  page,
}) => {
  const backend = new FakePeripheralsBackend();
  await backend.install(page);
  await page.goto('/peripherals');
  await expect(devices(page).getByRole('group', { name: 'Cameras · 2' })).toBeVisible();
  await expect(page.locator('app-board-rail button')).toHaveAccessibleName(/Connected$/);
  await expect(page.getByRole('button', { name: 'System information' })).toBeVisible();

  for (const { size } of VIEWPORTS) {
    await page.setViewportSize(size);
    for (const sidePanel of [true, false]) {
      await expect(panel(page)).toHaveCount(sidePanel ? 1 : 0);
      // A long camera name wraps, so its chip stays in the panel, on the title's first line.
      if (sidePanel) expect(await titleChipFit(page)).toEqual({ inside: true, firstLine: true });
      await expect
        .poll(() => pageOverflow(page))
        .toEqual([
          { horizontal: 0, vertical: 0 },
          { horizontal: 0, vertical: 0 },
        ]);
      // The page tools fit beside the title on a laptop and a desktop; a tablet scrolls them.
      await expect
        .poll(() => topBarSpill(page, size === TABLET))
        .toEqual({ spilled: [], toolsOverflow: 0 });
      await sidePanelToggle(page).click();
    }
  }
});

// The widest top bar Peripherals shows: a scan running for a while, with a board whose long name
// the rail cuts (the top bar no longer carries the board).
test('Peripherals fits with its widest top bar: an old scan and Scanning… N s, on a long-named board', async ({
  page,
}) => {
  const backend = new FakePeripheralsBackend();
  backend.board = LONG_BOARD;
  await backend.install(page);
  // The visit's scan, held open.
  const release = backend.holdScans();
  await page.clock.install();
  await page.goto('/peripherals');
  await expect(page.locator('app-board-rail button')).toHaveAccessibleName(/Connected$/);
  await expect(tool(page, 'Scanning… 0 s')).toBeVisible();
  await page.clock.fastForward(12_000);
  await expect(tool(page, 'Scanning… 12 s')).toBeVisible();

  for (const { size } of VIEWPORTS) {
    await page.setViewportSize(size);
    await expect
      .poll(() => topBarSpill(page, size === TABLET))
      .toEqual({ spilled: [], toolsOverflow: 0 });
    await expect
      .poll(() => pageOverflow(page))
      .toEqual([
        { horizontal: 0, vertical: 0 },
        { horizontal: 0, vertical: 0 },
      ]);
  }
  release();
  await expect(tool(page, 'Refresh')).toBeVisible();
});
