import { expect, Locator, Page, test } from '@playwright/test';
// Types only, erased at run time.
import type { BoardState } from '../src/app/board/api';
import { LAPTOP, PHONE, sidePanelToggle, topBarSpill } from './layout';
import { answerSlots, answerTopBar, LONG_BOARD, LONG_HOST } from './top-bar';

/** The rail's System information item, below the board block. */
const systemInfo = (page: Page) => page.getByRole('button', { name: 'System information' });

/** The rail's board block; its name says the board, its address and its state. */
const board = (page: Page) => page.locator('app-board-rail button');
const showLabels = (page: Page) => page.getByRole('button', { name: 'Show labels' });

/**
 * The page the System Info tests open the dialog from: Streaming with no slots, which asks for
 * nothing else. (Stats polls the board's Sentinel, and these tests are about the dialog.)
 */
const answerEmptyStreaming = (page: Page) => answerSlots(page, 0);

/** The board a test sees unreachable: the long-named one, whose connection check failed. */
const UNREACHABLE_BOARD: BoardState = {
  ...LONG_BOARD,
  status: { state: 'error', checked_at: '2026-10-26T10:00:00Z', error: null },
};

const answerBoard = (page: Page, state: BoardState) =>
  page.route(
    (url) => url.pathname === '/api/board' || url.pathname === '/api/board/test',
    (route) => route.fulfill({ json: state }),
  );

test('the top bar holds only the page: no board and no System information in it', async ({
  page,
}) => {
  await answerTopBar(page);
  await answerSlots(page, 48);
  await page.setViewportSize(LAPTOP);
  await page.goto('/streaming');
  await expect(page.getByRole('group', { name: 'Page tools' })).toBeVisible();

  const header = page.getByRole('banner');
  await expect(header.locator('app-board-rail')).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'System information' })).toHaveCount(0);
  // The kiosk button, then the toggle, are the app's and the page's last items.
  const [kiosk, toggle] = await Promise.all([
    header.getByRole('button', { name: 'Kiosk mode' }).boundingBox(),
    sidePanelToggle(page).boundingBox(),
  ]);
  expect(toggle!.x).toBeGreaterThanOrEqual(kiosk!.x + kiosk!.width);
  expect(await topBarSpill(page, false)).toEqual({ spilled: [], toolsOverflow: 0 });
});

test('the rail ends with the board, a line, System information, the theme and its own control, in that tab order after the pages', async ({
  page,
}) => {
  await answerTopBar(page);
  await answerEmptyStreaming(page);
  await page.setViewportSize(LAPTOP);
  await page.goto('/streaming');
  await expect(board(page)).toBeVisible();

  await page.getByRole('link', { name: 'Stats', exact: true }).focus();
  for (const name of [
    'DevKit — 192.168.100.200 — Connected',
    'System information',
    'Dark theme',
    'Show labels',
  ]) {
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveAccessibleName(name);
  }

  // The lines: one above the group (the kit's), one below the board block, none around it.
  const lines = page.locator('hr[aria-hidden="true"]');
  await expect(lines).toHaveCount(2);
  const [boardBox, infoBox, lineBox] = await Promise.all([
    board(page).boundingBox(),
    systemInfo(page).boundingBox(),
    lines.nth(1).boundingBox(),
  ]);
  expect(lineBox!.y).toBeGreaterThanOrEqual(boardBox!.y + boardBox!.height);
  expect(lineBox!.y + lineBox!.height).toBeLessThanOrEqual(infoBox!.y);
  expect(lineBox!.height).toBeCloseTo(1, 0);
});

test('a connected board is quiet and has no outline; collapsed, its tooltip says name, address and state', async ({
  page,
}) => {
  await answerTopBar(page);
  await answerEmptyStreaming(page);
  await page.setViewportSize(LAPTOP);
  await page.goto('/streaming');
  await expect(board(page)).toBeVisible();

  // No outline and no border at rest: the block is the rail's own item, set apart by its lines.
  expect(
    await board(page).evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.outlineStyle, style.borderTopWidth];
    }),
  ).toEqual(['none', '0px']);

  await board(page).hover();
  await expect(page.getByRole('tooltip')).toHaveText('DevKit — 192.168.100.200 — Connected');

  // Expanded, the second line is the address in the rail's muted text, not in the success colour.
  await page.mouse.move(700, 400);
  await showLabels(page).click();
  // The pointer is off the rail's items, whose hover fill changes their text.
  await page.mouse.move(700, 400);
  const detail = board(page).getByText('192.168.100.200', { exact: true });
  await expect(detail).toBeVisible();
  const [detailColour, mutedColour] = await Promise.all([
    detail.evaluate((element) => getComputedStyle(element).color),
    page
      .getByRole('button', { name: 'Collapse' })
      .evaluate((element) => getComputedStyle(element).color),
  ]);
  expect(detailColour).toBe(mutedColour);
});

test('an unreachable board says so in words and in the danger colour of its dot', async ({
  page,
}) => {
  await answerTopBar(page);
  await answerBoard(page, UNREACHABLE_BOARD);
  await answerEmptyStreaming(page);
  await page.setViewportSize(LAPTOP);
  await page.goto('/streaming');
  await showLabels(page).click();

  const state = board(page).getByText('Error', { exact: true });
  await expect(state).toBeVisible();
  await expect(board(page)).toHaveAccessibleName(`Board — ${LONG_HOST} — Connection failed`);
  const [text, dot] = await Promise.all([
    state.evaluate((element) => getComputedStyle(element).color),
    // The dot has no text to find it by: `.dot` is the kit's own markup.
    board(page)
      .locator('.dot')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(text).toBe(dot);
});

test('in the expanded rail a long address is cut on its own line and the block stays in the rail', async ({
  page,
}) => {
  await answerTopBar(page);
  await answerBoard(page, LONG_BOARD);
  await answerEmptyStreaming(page);
  await page.setViewportSize(LAPTOP);
  await page.goto('/streaming');
  await showLabels(page).click();

  const detail = board(page).getByText(LONG_HOST, { exact: true });
  await expect(detail).toBeVisible();
  // The rail widens over a transition: measure once it has settled.
  const cut = (line: Locator) =>
    line.evaluate((element) => element.scrollWidth > element.clientWidth);
  await expect.poll(() => cut(detail)).toBe(true);
  // The short name above it is whole, and nothing reaches past the block or the rail.
  await expect.poll(() => cut(board(page).getByText('Board', { exact: true }))).toBe(false);
  await expect
    .poll(async () => {
      const [boardBox, mainBox, detailRight] = await Promise.all([
        board(page).boundingBox(),
        page.getByRole('main').boundingBox(),
        detail.evaluate((element) => element.getBoundingClientRect().right),
      ]);
      const boardRight = boardBox!.x + boardBox!.width;
      return boardRight <= mainBox!.x && detailRight <= boardRight;
    })
    .toBe(true);
});

test('on a phone the rail shows the bottom group whole: board, System information, theme', async ({
  page,
}) => {
  await answerTopBar(page);
  await answerEmptyStreaming(page);
  await page.setViewportSize(PHONE);
  await page.goto('/streaming');
  await expect(board(page)).toBeVisible();

  for (const item of [
    board(page),
    systemInfo(page),
    page.getByRole('button', { name: 'Dark theme' }),
    showLabels(page),
  ]) {
    const box = (await item.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height);
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(40);
  }
  // Nothing app-level is left to reach in the top bar's first row but the kiosk button and the
  // toggle; System information opens from the rail.
  await systemInfo(page).click();
  await expect(page.getByRole('dialog', { name: 'System information' })).toBeVisible();
});

test('System information opens from the rail, tells what it can without neat, and Escape gives the focus back', async ({
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
