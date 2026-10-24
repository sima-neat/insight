import { expect, Page, test } from '@playwright/test';
import { DESKTOP, LAPTOP, pageOverflow, TABLET, topBarSpill } from './layout';

/** The fields of a `GET /api/mediasrc` slot these tests set; the rest take an unassigned slot's values. */
const slot = (index: number, fields: Record<string, unknown> = {}) => ({
  index,
  file: '',
  state: 'stopped',
  transport: '',
  codec: 'unknown',
  type: 'file',
  fps: null,
  native_fps: null,
  active_file: null,
  allowed_transports: [],
  urls: { rtsp: `rtsp://127.0.0.1:8554/src${index}` },
  readers: [],
  ...fields,
});

/** Two slots stream `people/walk.mp4` (one live, one idle) and one `cars.mp4`. */
const SLOTS = Array.from({ length: 48 }, (_, i) => slot(i + 1));
SLOTS[2] = slot(3, { file: 'people/walk.mp4', state: 'playing', codec: 'h264' });
SLOTS[8] = slot(9, { file: 'people/walk.mp4', codec: 'h264' });
SLOTS[4] = slot(5, { file: 'cars.mp4', codec: 'h265' });

const file = (path: string, streamable = true) => ({
  name: path.split('/').pop(),
  path,
  type: 'file',
  streamable,
});

const TREE = [
  {
    name: '/people',
    path: 'people',
    type: 'folder',
    streamable_count: 2,
    children: [file('people/run.mp4'), file('people/walk.mp4')],
  },
  file('cars.mp4'),
  file('notes.txt', false),
];

const INFO: Record<string, object> = {
  'people/walk.mp4': {
    filename: 'walk.mp4',
    size_bytes: 5_452_595,
    type: 'video',
    codec: 'H.264',
    normalized_codec: 'h264',
    width: 1280,
    height: 720,
    duration_ms: 134_000,
    frame_rate: '30000/1001',
  },
  'cars.mp4': {
    filename: 'cars.mp4',
    size_bytes: 1_610_612_736,
    type: 'video',
    codec: 'H.265',
    normalized_codec: 'h265',
    width: 1920,
    height: 1080,
    duration_ms: 3_725_000,
    frame_rate: '25/1',
  },
};

/** A 1×1 PNG. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface Mocked {
  /** The paths `/api/delete-media` was asked to delete, in order. */
  readonly deleted: string[];
  /** Makes `GET /api/mediasrc` fail from now on. */
  failSlots(): void;
}

/**
 * Insight's media and slot APIs without a board: the library above, its files' info, the slots
 * that use them, and a delete that removes the file from the tree (and clears its slots), so the
 * page shows what the server would after it. Every API the page calls is answered here.
 */
async function withMockedMedia(page: Page): Promise<Mocked> {
  const deleted: string[] = [];
  let failing = false;
  const remains = (node: { path: string }) => !deleted.includes(node.path);
  const tree = () =>
    TREE.filter(remains).map((node) =>
      'children' in node ? { ...node, children: node.children.filter(remains) } : node,
    );

  await page.route(
    (url) => url.pathname === '/api/media-files',
    (route) => route.fulfill({ json: tree() }),
  );
  await page.route(
    (url) => url.pathname === '/api/media-info',
    (route) => {
      const { path } = route.request().postDataJSON() as { path: string };
      return route.fulfill({
        json: INFO[path] ?? { filename: path, size_bytes: 10, type: 'unknown' },
      });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/delete-media',
    (route) => {
      deleted.push((route.request().postDataJSON() as { path: string }).path);
      return route.fulfill({ json: { message: 'Deleted successfully' } });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/mediasrc',
    (route) =>
      failing
        ? route.fulfill({ status: 500, json: { error: 'MediaMTX is not answering' } })
        : route.fulfill({
            json: SLOTS.map((s) => (deleted.includes(s.file) ? slot(s.index) : s)),
          }),
  );
  await page.route(
    (url) => url.pathname === '/api/mediasrc/renditions',
    (route) => route.fulfill({ json: { count: 0, bytes: 0 } }),
  );
  // The previews. A still image stands in for a video too.
  await page.route(
    (url) => url.pathname.startsWith('/media/') || url.pathname.startsWith('/api/media-preview/'),
    (route) => route.fulfill({ contentType: 'image/png', body: PIXEL }),
  );
  return { deleted, failSlots: () => (failing = true) };
}

const listbox = (page: Page) => page.getByRole('listbox', { name: 'Files' });
const rows = (page: Page) => listbox(page).getByRole('option');
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
const tool = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Page tools' }).getByRole('button', { name, exact: true });
const panel = (page: Page) => page.getByRole('region', { name: 'Selected media' });
const confirmDialog = (page: Page) => page.getByRole('alertdialog');
/** A toast as shown; its text is also in the toast host's announcer, which is not. */
const toast = (page: Page, text: string) =>
  page.locator('[data-slot="toast"]').filter({ hasText: text });

/** The info table's rows as `[name, value]`. */
function infoRows(page: Page): Promise<string[][]> {
  return panel(page)
    .locator('dt')
    .evaluateAll((terms) =>
      terms.map((term) => [term.textContent!.trim(), term.nextElementSibling!.textContent!.trim()]),
    );
}

test.describe('Media with mocked APIs', () => {
  test('the library and a file’s panel fit at 1366×768, 1920×1080 and 768×1024, with the side panel open and closed', async ({
    page,
  }) => {
    await withMockedMedia(page);
    await page.setViewportSize(LAPTOP);
    await page.goto('/media');
    await expect(rows(page)).toHaveCount(3);
    await row(page, 'cars.mp4').click();
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('cars.mp4');

    /** How far the rows, and the panel's content, reach past their widths. */
    const overflow = () =>
      page.evaluate(() => {
        const list = document.querySelector('[role="listbox"]')!;
        const boxes = [list.parentElement!, ...list.querySelectorAll('[role="option"]')];
        const sideways = boxes.map((box) => box.scrollWidth - box.clientWidth);
        const aside = document.querySelector('section[aria-label="Selected media"]');
        if (aside) {
          const right = aside.getBoundingClientRect().right;
          for (const box of aside.querySelectorAll('*')) {
            sideways.push(box.getBoundingClientRect().right - right);
          }
        }
        return Math.max(0, ...sideways.map((value) => Math.round(value)));
      });

    for (const viewport of [LAPTOP, DESKTOP, TABLET]) {
      await page.setViewportSize(viewport);
      for (const sidePanel of [true, false]) {
        await expect(panel(page)).toHaveCount(sidePanel ? 1 : 0);
        await expect.poll(overflow).toBe(0);
        await expect
          .poll(() => pageOverflow(page))
          .toEqual([
            { horizontal: 0, vertical: 0 },
            { horizontal: 0, vertical: 0 },
          ]);
        await expect
          .poll(() => topBarSpill(page, viewport === TABLET))
          .toEqual({ spilled: [], toolsOverflow: 0 });
        await tool(page, 'Side panel').click();
      }
    }
  });

  test('rows show the slots each file is in use on; a file’s panel shows its preview and readable info', async ({
    page,
  }) => {
    await withMockedMedia(page);
    await page.goto('/media');

    await expect(row(page, 'cars.mp4')).toContainText('src5 · Idle');
    await expect(row(page, 'notes.txt')).toContainText('NOT STREAMABLE');
    await row(page, 'people').click();
    await expect(page.getByRole('navigation', { name: 'Current folder' })).toContainText('people');
    await expect(row(page, 'walk.mp4')).toContainText('src3 · Live, src9 · Idle');

    await row(page, 'walk.mp4').click();
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('people/walk.mp4');
    await expect(panel(page).locator('video')).toHaveAttribute('src', '/media/people/walk.mp4');
    await expect
      .poll(() => infoRows(page))
      .toEqual([
        ['Filename', 'walk.mp4'],
        ['Size', '5.2 MB'],
        ['Type', 'Video'],
        ['Codec', 'H.264'],
        ['Width', '1280'],
        ['Height', '720'],
        ['Duration', '2:14'],
        ['Frame rate', '29.97 fps'],
      ]);
  });

  test('keyboard only: arrows select, Space ticks, Delete… asks with the slots it clears, Escape cancels, Delete deletes in order', async ({
    page,
  }) => {
    const mocked = await withMockedMedia(page);
    await page.goto('/media');
    await expect(rows(page)).toHaveCount(3);

    await listbox(page).focus();
    // people, then cars.mp4: the panel follows the selection.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('cars.mp4');
    await expect.poll(() => infoRows(page)).toContainEqual(['Duration', '1:02:05']);
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    // In people: run.mp4, walk.mp4.
    await expect(row(page, 'run.mp4')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('2 selected');

    const deleteButton = panel(page).getByRole('button', { name: 'Delete…' });
    await deleteButton.focus();
    await page.keyboard.press('Enter');
    await expect(confirmDialog(page)).toContainText('Delete Files');
    await expect(confirmDialog(page)).toContainText(
      'Delete 2 media files: cars.mp4, people/walk.mp4? In use on src3, src5, src9; those slots are cleared.',
    );
    await page.keyboard.press('Escape');
    await expect(confirmDialog(page)).toHaveCount(0);
    expect(mocked.deleted).toEqual([]);
    await expect(deleteButton).toBeFocused();

    await page.keyboard.press('Enter');
    await confirmDialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(toast(page, 'Removed 2 media file(s).')).toBeVisible();
    expect(mocked.deleted).toEqual(['cars.mp4', 'people/walk.mp4']);
    // The library and the slots are fetched again: the file is gone, and its slots with it.
    await expect(row(page, 'walk.mp4')).toHaveCount(0);
    await expect(row(page, 'run.mp4')).toHaveCount(1);
    await expect(panel(page).getByText('Select a file.')).toBeFocused();
  });

  test('a failing slot poll says so', async ({ page }) => {
    const mocked = await withMockedMedia(page);
    await page.goto('/media');
    await expect(row(page, 'cars.mp4')).toContainText('src5 · Idle');

    mocked.failSlots();
    await expect(
      page.getByText('Slot status could not be refreshed. Showing the last known state.'),
    ).toBeVisible();
    await expect(row(page, 'cars.mp4')).toContainText('src5 · Idle');
  });
});
