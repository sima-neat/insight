import { expect, Page, test } from '@playwright/test';
import type {
  MediaDeleted,
  MediaEntry,
  MediaFileInfo,
  RenditionUsage,
} from '../src/app/api.generated';
import { fileSlot, slot, slotList } from '../src/app/sources/slots.testing';
import {
  DESKTOP,
  LAPTOP,
  pageOverflow,
  TABLET,
  sidePanelToggle,
  topBarSpill,
  VIEWPORTS,
} from './layout';
import { answerTopBar } from './top-bar';

// The Media page's layout at every viewport, the import dialog's, and one flow through the page,
// against a mocked media API. What the page and the import dialog do in each case is held by their
// unit specs (`src/app/pages/media/`, `src/app/sources/`).

// The rail's board block reads the board on every page.
test.beforeEach(({ page }) => answerTopBar(page));

/** Two slots stream `people/walk.mp4` (one live, one idle) and one `cars.mp4`. */
const SLOTS = Array.from({ length: 48 }, (_, i) => slot(i + 1));
SLOTS[2] = fileSlot(3, 'people/walk.mp4', { run: true, state: 'live' });
SLOTS[8] = fileSlot(9, 'people/walk.mp4');
SLOTS[4] = fileSlot(5, 'cars.mp4', { codec: 'h265' });

const file = (path: string, streamable = true): MediaEntry => ({
  name: path.split('/').pop()!,
  path,
  folder: false,
  streamable,
  probe: { kind: streamable ? 'video' : 'unknown', size: 10, streamable },
});

const folder = (path: string, children: MediaEntry[]): MediaEntry => ({
  name: path.split('/').pop()!,
  path,
  folder: true,
  streamable: children.some((child) => child.streamable),
  streamable_count: children.reduce(
    (count, child) =>
      count + (child.folder ? (child.streamable_count ?? 0) : child.streamable ? 1 : 0),
    0,
  ),
  probe: null,
  children,
});

const TREE: MediaEntry[] = [
  folder('people', [file('people/run.mp4'), file('people/walk.mp4')]),
  file('cars.mp4'),
  file('notes.txt', false),
];

const INFO: Record<string, MediaFileInfo> = {
  'people/walk.mp4': {
    name: 'walk.mp4',
    path: 'people/walk.mp4',
    probe: {
      kind: 'video',
      codec: 'h264',
      codec_name: 'H.264',
      width: 1280,
      height: 720,
      duration_ms: 134_000,
      frame_rate: '30000/1001',
      size: 5_452_595,
      streamable: true,
    },
  },
  'cars.mp4': {
    name: 'cars.mp4',
    path: 'cars.mp4',
    probe: {
      kind: 'video',
      codec: 'h265',
      codec_name: 'H.265',
      width: 1920,
      height: 1080,
      duration_ms: 3_725_000,
      frame_rate: '25/1',
      size: 1_610_612_736,
      streamable: true,
    },
  },
};

/** A 1×1 PNG. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Insight's media and slot APIs without a board: the library above, its files' info, the slots
 * that use them, and a delete that removes the files from the tree, so the page shows what the
 * server would after it. Every API the page calls is answered here. Resolves to what
 * `POST /api/media/delete` was asked to delete, a request's paths each.
 */
async function withMockedMedia(page: Page): Promise<string[][]> {
  const deletes: string[][] = [];
  const deleted = new Set<string>();
  const remaining = (entries: readonly MediaEntry[]): MediaEntry[] =>
    entries
      .filter((entry) => !deleted.has(entry.path))
      .map((entry) => (entry.folder ? folder(entry.path, remaining(entry.children ?? [])) : entry));

  // The root's name and path are empty.
  await page.route(
    (url) => url.pathname === '/api/media',
    (route) => route.fulfill({ json: folder('', remaining(TREE)) }),
  );
  await page.route(
    (url) => url.pathname === '/api/media/info',
    (route) => {
      const path = new URL(route.request().url()).searchParams.get('path')!;
      const info: MediaFileInfo = INFO[path] ?? {
        name: path.split('/').pop()!,
        path,
        probe: { kind: 'unknown', size: 10, streamable: false },
      };
      return route.fulfill({ json: info });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/media/delete',
    (route) => {
      const { paths } = route.request().postDataJSON() as { paths: string[] };
      deletes.push(paths);
      paths.forEach((path) => deleted.add(path));
      return route.fulfill({ json: { paths } satisfies MediaDeleted });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/slots',
    (route) => route.fulfill({ json: slotList(SLOTS) }),
  );
  await page.route(
    (url) => url.pathname === '/api/renditions',
    (route) => route.fulfill({ json: { count: 0, bytes: 0, in_use: 0 } satisfies RenditionUsage }),
  );
  // The previews. A still image stands in for a video too.
  await page.route(
    (url) => url.pathname === '/api/media/file' || url.pathname === '/api/media/preview.mjpg',
    (route) => route.fulfill({ contentType: 'image/png', body: PIXEL }),
  );
  return deletes;
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

  for (const { size } of VIEWPORTS) {
    await page.setViewportSize(size);
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
        .poll(() => topBarSpill(page, size === TABLET))
        .toEqual({ spilled: [], toolsOverflow: 0 });
      await sidePanelToggle(page).click();
    }
  }
});

test('rows show the slots each file is in use on, a file’s panel its preview and readable info, and Delete… removes a file no slot uses', async ({
  page,
}) => {
  const deletes = await withMockedMedia(page);
  await page.goto('/media');

  await expect(row(page, 'cars.mp4')).toContainText('src5 · Idle');
  await expect(row(page, 'notes.txt')).toContainText('NOT STREAMABLE');
  await row(page, 'people').getByRole('button', { name: 'Open people' }).click();
  await expect(page.getByRole('navigation', { name: 'Current folder' })).toContainText('people');
  await expect(row(page, 'walk.mp4')).toContainText('src3 · Live, src9 · Idle');

  await row(page, 'walk.mp4').click();
  await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('people/walk.mp4');
  await expect(panel(page).locator('video')).toHaveAttribute(
    'src',
    '/api/media/file?path=people%2Fwalk.mp4',
  );
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

  await row(page, 'run.mp4').click();
  await panel(page).getByRole('button', { name: 'Delete…' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(toast(page, 'Removed 1 media file(s).')).toBeVisible();
  expect(deletes).toEqual([['people/run.mp4']]);
  // The library is fetched again: the file is gone.
  await expect(row(page, 'run.mp4')).toHaveCount(0);
  await expect(row(page, 'walk.mp4')).toHaveCount(1);
});

const CATALOG = {
  schema: '1',
  index_url: 'https://artifacts.neat.sima.ai/media-assets/index.json',
  base_url: 'https://artifacts.neat.sima.ai/media-assets/',
  sources: [
    { id: 'street', title: 'Street', description: 'Cars at a crossing', file: '', url: '' },
  ],
  assets: [
    {
      source_id: 'street',
      source_title: 'Street',
      profile: '720p30',
      preview: false,
      codec: 'h264',
      container: 'mp4',
      fps: 30,
      target_height: 720,
      path: 'street/street_720p30_30fps_h264.mp4',
      bytes: 3_145_728,
      sha256: '',
      width: 1280,
      height: 720,
      url: 'https://artifacts.neat.sima.ai/media-assets/street/street_720p30_30fps_h264.mp4',
    },
  ],
};

const importDialog = (page: Page) => page.getByRole('dialog', { name: 'Import media' });

test.describe('the import dialog', () => {
  test.beforeEach(async ({ page }) => {
    // Nothing leaves the machine: the catalog's previews are stubbed.
    await page.route(
      (url) => url.hostname === 'artifacts.neat.sima.ai',
      (route) => route.abort(),
    );
  });

  test('the catalog Size heading ends where its cells end', async ({ page }) => {
    await withMockedMedia(page);
    // Two sizes of different widths, so the column is as wide as the longer one and the shorter
    // one has to sit at the column's end to line up.
    const [street] = CATALOG.assets;
    await page.route(
      (url) => url.pathname === '/api/catalog',
      (route) =>
        route.fulfill({
          json: {
            ...CATALOG,
            assets: [
              street,
              {
                ...street,
                profile: '1080p30',
                path: 'street/street_1080p30_30fps_h264.mp4',
                bytes: 1_610_612_736,
              },
            ],
          },
        }),
    );
    await page.setViewportSize(DESKTOP);
    await page.goto('/media');
    await tool(page, 'Import…').click();
    await importDialog(page).getByRole('tab', { name: 'Catalog', exact: true }).click();
    const list = importDialog(page).locator('neat-select-list', {
      has: page.getByRole('listbox', { name: 'Catalog assets' }),
    });
    await expect(list.getByRole('option')).toHaveCount(2);

    // The right edge of the text itself: a heading's or a cell's box fills its column whichever
    // way the text sits in it.
    const textEdges = (selector: string) =>
      list.locator(selector).evaluateAll((elements) =>
        elements.map((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getBoundingClientRect().right;
        }),
      );
    const [heading] = await textEdges('[data-slot="select-list-header"] span:text-is("Size")');
    const cells = await textEdges('[role="option"] .size');

    expect(cells).toHaveLength(2);
    for (const edge of cells) {
      expect(Math.abs(edge - heading), `heading ${heading}, cells ${cells}`).toBeLessThanOrEqual(1);
    }
  });

  test('the dialog keeps its height whichever tab is open, at 1366×768 and 1920×1080', async ({
    page,
  }) => {
    await withMockedMedia(page);
    await page.route(
      (url) => url.pathname === '/api/catalog',
      (route) => route.fulfill({ json: CATALOG }),
    );
    const height = () =>
      importDialog(page).evaluate((dialog) => dialog.getBoundingClientRect().height);
    const tab = (name: string) => importDialog(page).getByRole('tab', { name, exact: true });

    for (const viewport of [LAPTOP, DESKTOP]) {
      await page.setViewportSize(viewport);
      await page.goto('/media');
      await tool(page, 'Import…').click();
      await expect(tab('Local files')).toHaveAttribute('aria-selected', 'true');
      // Measured once the opening animation, which scales the dialog, is over: two readings in a
      // row agree.
      let previous = -1;
      await expect
        .poll(async () => {
          const now = await height();
          const settled = now > 0 && now === previous;
          previous = now;
          return settled;
        })
        .toBe(true);
      const local = await height();

      await tab('Catalog').click();
      await expect(
        importDialog(page).getByRole('listbox', { name: 'Catalog assets' }),
      ).toBeVisible();
      expect(await height()).toBe(local);
      await tab('Catalog by asset name').click();
      await expect(
        importDialog(page).getByRole('listbox', { name: 'Catalog variants' }),
      ).toBeVisible();
      expect(await height()).toBe(local);
    }
  });
});
