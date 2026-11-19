import { expect, Page, test } from '@playwright/test';
import type { BoardList } from '../src/app/api.generated';
import { LAPTOP, pageOverflow, PHONE, topBarSpill } from './layout';
import { FakePeripheralsBackend } from './peripherals-mocks';
import { FakeStatsBackend } from './stats-mocks';
import {
  answerEmptyLibrary,
  answerSlots,
  answerTopBar,
  answerViewer,
  LONG_BOARD,
  SYSTEM_INFO,
} from './top-bar';

// The app's own parts of the kit's shell, in layouts jsdom cannot measure: every page's top bar
// and rail at phone width, and the System information dialog. The pages' own layouts at the wider
// viewports are in their specs; how the shell behaves is the kit's.

// The rail's board block reads the board on every page.
test.beforeEach(({ page }) => answerTopBar(page));

/** The widest board block: a connection that failed, on a host name far past what the rail shows. */
const ERROR_BOARD: BoardList = {
  ...LONG_BOARD,
  selected: {
    ...LONG_BOARD.selected!,
    status: { state: 'error', checked_at: '2026-10-26T10:00:00Z' },
  },
};

/** `GET /api/boards`, answered with the error board on a page whose mocks do not take one. */
const answerErrorBoard = (page: Page) =>
  page.route(
    (url) => url.pathname === '/api/boards',
    (route) => route.fulfill({ json: ERROR_BOARD }),
  );

/** Each page, with what it asks for answered and the error board selected. */
const PAGES: { path: string; answer(page: Page): Promise<void> }[] = [
  {
    path: '/media',
    answer: async (page) => {
      await answerEmptyLibrary(page);
      await answerSlots(page, 0);
      await answerErrorBoard(page);
    },
  },
  {
    path: '/streaming',
    answer: async (page) => {
      await answerSlots(page, 8);
      await answerErrorBoard(page);
    },
  },
  {
    path: '/viewer',
    answer: async (page) => {
      await answerViewer(page);
      await answerErrorBoard(page);
    },
  },
  {
    path: '/peripherals',
    answer: async (page) => {
      const backend = new FakePeripheralsBackend();
      backend.board = ERROR_BOARD;
      await backend.install(page);
    },
  },
  {
    path: '/stats',
    answer: async (page) => {
      const backend = new FakeStatsBackend();
      backend.board = ERROR_BOARD;
      await backend.install(page);
    },
  },
];

const board = (page: Page) => page.locator('app-board-rail button');
const systemInfo = (page: Page) => page.getByRole('button', { name: 'System information' });

test.describe('phone width', () => {
  test.use({ viewport: PHONE });

  for (const { path, answer } of PAGES) {
    test(`${path} holds its top bar and rail with the board in an error state, and no page scrolls sideways`, async ({
      page,
    }) => {
      await answer(page);
      await page.goto(path);

      await expect(board(page)).toContainText('Error');
      await expect(systemInfo(page)).toBeVisible();
      await expect(page.getByRole('group', { name: 'Page tools' })).toBeVisible();
      expect(await topBarSpill(page, true)).toEqual({ spilled: [], toolsOverflow: 0 });
      expect(await pageOverflow(page)).toEqual([
        { horizontal: 0, vertical: 0 },
        { horizontal: 0, vertical: 0 },
      ]);

      // The rail's bottom group is on the screen whole: the board, System information, the theme
      // and the rail's own control.
      for (const item of [
        board(page),
        systemInfo(page),
        page.getByRole('button', { name: 'Dark theme' }),
        page.getByRole('button', { name: 'Show labels' }),
      ]) {
        const box = (await item.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height);
      }
    });
  }
});

test('System information fits the screen, and every list in it starts its values in the same column', async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === '/api/system',
    (route) =>
      route.fulfill({
        json: {
          ...SYSTEM_INFO,
          neat: {
            state: 'ready',
            environment: {
              label: 'SDK on a DevKit',
              sdkVersion: '2.1.0',
              devkitBuildVersion: '2.1.0-b12',
            },
            insight: { serviceState: 'Running' },
            components: {
              neatCore: { name: 'Neat core', version: '1.4.0', updateAvailable: false },
              neatInsight: {
                name: 'A component with a very long name that has to wrap',
                version: '0.9.1',
              },
            },
            exposed_ports: [
              { name: 'rtp.udp', protocol: 'udp', hostPortStart: 9000, hostPortEnd: 9079 },
            ],
            update_check: { offline: false, status: 'Current' },
          },
        },
      }),
  );
  // Streaming with no slots, which asks for nothing else.
  await answerSlots(page, 0);
  await page.setViewportSize(LAPTOP);
  await page.goto('/streaming');
  await systemInfo(page).click();
  const dialog = page.getByRole('dialog', { name: 'System information' });
  await dialog.getByRole('button', { name: 'Components' }).click();
  await dialog.getByRole('button', { name: 'Exposed ports' }).click();
  await expect(dialog.getByText('RTP UDP')).toBeVisible();

  // With every section open the dialog stays on the screen; its body scrolls.
  const box = (await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(LAPTOP.height);

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
