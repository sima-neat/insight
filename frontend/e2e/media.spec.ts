import { expect, Page, test } from '@playwright/test';
import type {
  LibraryError,
  MediaDeleted,
  MediaEntry,
  MediaFileInfo,
  MediaSaved,
  RenditionUsage,
} from '../src/app/api.generated';
import { fileSlot, slot, slotList } from '../src/app/sources/slots.testing';
import { jobEvents, jobOf } from './jobs';
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

interface Mocked {
  /** What `POST /api/media/delete` was asked to delete, a request's paths each. */
  readonly deletes: string[][];
  /** Makes `GET /api/slots` fail from now on. */
  failSlots(): void;
  /** Puts a file into the library, as an upload or import does. */
  add(path: string): void;
  /** Makes slot `n` use the file on the server, before any slot poll could have said so. */
  assignOnServer(n: number, path: string): void;
}

/** `entries` with the file at `segments` added, under the folders those name. */
function insert(entries: MediaEntry[], segments: string[], parent: string): MediaEntry[] {
  const [first, ...rest] = segments;
  const path = parent ? `${parent}/${first}` : first;
  if (rest.length === 0) return [...entries, file(path)];
  const existing = entries.find((entry) => entry.path === path);
  const updated = folder(path, insert([...(existing?.children ?? [])], rest, path));
  return existing
    ? entries.map((entry) => (entry === existing ? updated : entry))
    : [...entries, updated];
}

/**
 * Insight's media and slot APIs without a board: the library above, its files' info, the slots
 * that use them, and a delete that removes the files from the tree, or refuses them all while a
 * slot uses one, as the server does, so the page shows what the server would after it. Every API
 * the page calls is answered here.
 */
async function withMockedMedia(page: Page): Promise<Mocked> {
  const deletes: string[][] = [];
  const deleted = new Set<string>();
  const added: string[] = [];
  /** Files slots use that the slot list does not show yet, by slot. */
  const unlisted = new Map<number, string>();
  let failing = false;
  const remaining = (entries: readonly MediaEntry[]): MediaEntry[] =>
    entries
      .filter((entry) => !deleted.has(entry.path))
      .map((entry) => (entry.folder ? folder(entry.path, remaining(entry.children ?? [])) : entry));
  // The root's name and path are empty.
  const tree = (): MediaEntry =>
    folder('', [
      ...remaining(TREE),
      // An imported file lands in the folders its path names, as catalog imports save it.
      ...added.reduce<MediaEntry[]>((entries, path) => insert(entries, path.split('/'), ''), []),
    ]);

  await page.route(
    (url) => url.pathname === '/api/media',
    (route) => route.fulfill({ json: tree() }),
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
      const using = [
        ...SLOTS.filter((s) => s.file && paths.includes(s.file)).map((s) => s.n),
        ...[...unlisted].filter(([, path]) => paths.includes(path)).map(([n]) => n),
      ];
      if (using.length > 0) {
        const refusal: LibraryError = {
          error: {
            code: 'in_use',
            message: `Files are used by ${using.map((n) => `src${n}`).join(', ')}.`,
            hint: 'Clear those slots, then delete again.',
          },
          slots: using,
        };
        return route.fulfill({ status: 409, json: refusal });
      }
      paths.forEach((path) => deleted.add(path));
      return route.fulfill({ json: { paths } satisfies MediaDeleted });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/slots',
    (route) =>
      failing
        ? route.fulfill({
            status: 500,
            json: { error: { code: 'internal_error', message: 'MediaMTX is not answering.' } },
          })
        : route.fulfill({ json: slotList(SLOTS) }),
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
  return {
    deletes,
    failSlots: () => (failing = true),
    add: (path) => added.push(path),
    assignOnServer: (n, path) => unlisted.set(n, path),
  };
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

  test('rows show the slots each file is in use on; a file’s panel shows its preview and readable info', async ({
    page,
  }) => {
    await withMockedMedia(page);
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
  });

  for (const { name, size } of VIEWPORTS) {
    test(`keyboard only: arrows select, Space ticks, Delete… asks, Escape cancels, Delete deletes them in one request at ${name}`, async ({
      page,
    }) => {
      const mocked = await withMockedMedia(page);
      await page.setViewportSize(size);
      await page.goto('/media');
      await expect(rows(page)).toHaveCount(3);

      await listbox(page).focus();
      // people, then cars.mp4: the panel follows the selection.
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('cars.mp4');
      await expect.poll(() => infoRows(page)).toContainEqual(['Duration', '1:02:05']);
      // notes.txt, which no slot uses, is ticked.
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Space');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Enter');
      // In people: run.mp4, walk.mp4.
      await expect(row(page, 'run.mp4')).toHaveCount(1);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Space');
      await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('2 selected');

      const deleteButton = panel(page).getByRole('button', { name: 'Delete…' });
      await deleteButton.focus();
      await page.keyboard.press('Enter');
      await expect(confirmDialog(page)).toContainText('Delete Files');
      await expect(confirmDialog(page)).toContainText(
        'Delete 2 media files: notes.txt, people/run.mp4?',
      );
      await page.keyboard.press('Escape');
      await expect(confirmDialog(page)).toHaveCount(0);
      expect(mocked.deletes).toEqual([]);
      await expect(deleteButton).toBeFocused();

      await page.keyboard.press('Enter');
      await confirmDialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(toast(page, 'Removed 2 media file(s).')).toBeVisible();
      expect(mocked.deletes).toEqual([['notes.txt', 'people/run.mp4']]);
      // The library is fetched again: the files are gone.
      await expect(row(page, 'run.mp4')).toHaveCount(0);
      await expect(row(page, 'walk.mp4')).toHaveCount(1);
      await expect(panel(page).getByText('Select a file.')).toBeFocused();
    });
  }

  test('a file a slot uses is not deleted: the panel names the slots instead of asking', async ({
    page,
  }) => {
    const mocked = await withMockedMedia(page);
    await page.goto('/media');
    await row(page, 'people').getByRole('button', { name: 'Open people' }).click();
    await row(page, 'walk.mp4').click();
    await panel(page).getByRole('button', { name: 'Delete…' }).click();

    await expect(
      toast(page, 'people/walk.mp4 is in use on src3, src9. Clear those slots, then delete again.'),
    ).toBeVisible();
    await expect(confirmDialog(page)).toHaveCount(0);
    expect(mocked.deletes).toEqual([]);
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('people/walk.mp4');
  });

  test('a delete the server refuses, as a slot took the file meanwhile, says why and keeps the file', async ({
    page,
  }) => {
    const mocked = await withMockedMedia(page);
    mocked.assignOnServer(12, 'people/run.mp4');
    await page.goto('/media');
    await row(page, 'people').getByRole('button', { name: 'Open people' }).click();
    await row(page, 'run.mp4').click();
    await panel(page).getByRole('button', { name: 'Delete…' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Delete', exact: true }).click();

    // The server's message, then its hint.
    await expect(
      toast(page, 'Files are used by src12. Clear those slots, then delete again.'),
    ).toBeVisible();
    expect(mocked.deletes).toEqual([['people/run.mp4']]);
    await expect(row(page, 'run.mp4')).toHaveCount(1);
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('people/run.mp4');
  });

  test('Shift-click ticks a range from the selected row and Ctrl+A ticks every file, never a folder', async ({
    page,
  }) => {
    await withMockedMedia(page);
    await page.goto('/media');
    await expect(rows(page)).toHaveCount(3);
    const ticked = (name: string) => row(page, name).getAttribute('aria-selected');

    // The folder is selected, not opened; the range from it to notes.txt skips it.
    await listbox(page).focus();
    await page.keyboard.press('ArrowDown');
    await row(page, 'notes.txt').click({ modifiers: ['Shift'] });
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('2 selected');
    // A folder has no box to tick: it is not selected for deleting, so it has no state to say.
    expect([await ticked('people'), await ticked('cars.mp4'), await ticked('notes.txt')]).toEqual([
      null,
      'true',
      'true',
    ]);

    await panel(page).getByRole('button', { name: 'Clear' }).click();
    await expect(panel(page).getByRole('heading', { level: 2 })).not.toHaveText('2 selected');
    expect([await ticked('cars.mp4'), await ticked('notes.txt')]).toEqual(['false', 'false']);

    await listbox(page).focus();
    await page.keyboard.press('Control+A');
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('2 selected');
    expect(await ticked('people')).toBeNull();
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

const YOUTUBE_PREVIEW = {
  video_id: 'abc',
  normalized_url: 'https://www.youtube.com/watch?v=abc',
  embed_url: 'https://www.youtube.com/embed/abc',
  thumbnail_url: '',
  title: 'Street walk',
  duration: 600,
  is_live: false,
  live_status: 'not_live',
};

const importDialog = (page: Page) => page.getByRole('dialog', { name: 'Import media' });
const dialogButton = (page: Page, name: string) =>
  importDialog(page).getByRole('button', { name, exact: true });

/** Chooses files in the Local files tab's drop zone, as the system's file chooser would. */
const choose = (page: Page, ...names: string[]) =>
  importDialog(page)
    .locator('neat-drop-zone input[type="file"]')
    .setInputFiles(
      names.map((name) => ({ name, mimeType: 'video/mp4', buffer: Buffer.from('x') })),
    );

test.describe('Import with mocked APIs', () => {
  test.beforeEach(async ({ page }) => {
    // Nothing leaves the machine: the catalog's previews and YouTube's player are stubbed.
    await page.route(
      (url) => url.hostname === 'artifacts.neat.sima.ai',
      (route) => route.abort(),
    );
    await page.route(
      (url) => url.hostname.endsWith('youtube.com'),
      (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Player</title>' }),
    );
  });

  for (const { name, size } of VIEWPORTS) {
    test(`an upload whose name exists asks, sends again with Keep both, and shows the saved file at ${name}`, async ({
      page,
    }) => {
      const mocked = await withMockedMedia(page);
      await page.setViewportSize(size);
      const sent: (string | null)[] = [];
      await page.route(
        (url) => url.pathname === '/api/media/uploads',
        async (route) => {
          const body = route.request().postData() ?? '';
          const choice = /name="on_conflict"\r\n\r\n(\w+)/.exec(body)?.[1] ?? null;
          sent.push(choice);
          if (choice === null) {
            const clash: LibraryError = {
              error: { code: 'name_taken', message: 'cars.mp4 exists already.' },
              conflict: { existing: 'cars.mp4', suggested: 'cars_2.mp4' },
            };
            return route.fulfill({ status: 409, json: clash });
          }
          // The server re-encodes this one first: the answer is the job.
          return route.fulfill({ status: 202, json: jobOf('upload-1', 'upload') });
        },
      );
      await page.route(
        (url) => url.pathname === '/api/jobs/upload-1/events',
        (route) => {
          mocked.add('cars_2.mp4');
          const saved: MediaSaved = { path: 'cars_2.mp4', reencoded: ['cars_2.mp4'] };
          return route.fulfill(
            jobEvents([
              jobOf('upload-1', 'upload', {
                progress: { phase: 'encode', detail: '00:05 / 00:10', percent: 50 },
              }),
              jobOf('upload-1', 'upload', { state: 'done', result: saved }),
            ]),
          );
        },
      );
      await page.goto('/media');
      await tool(page, 'Import…').click();
      await expect(importDialog(page)).toBeVisible();

      await choose(page, 'cars.mp4');
      await expect(importDialog(page)).toContainText('cars.mp4 already exists.');
      await expect(importDialog(page)).toContainText('In use on src5');
      // The safe answer has the focus: Enter keeps both.
      await expect(dialogButton(page, 'Keep both')).toBeFocused();
      await page.keyboard.press('Enter');

      await expect(importDialog(page)).toHaveCount(0);
      expect(sent).toEqual([null, 'keep_both']);
      await expect(toast(page, 'Uploaded and prepared 1 file(s).')).toBeVisible();
      await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('cars_2.mp4');
    });
  }

  test('a re-encode that fails keeps the dialog open and says what failed', async ({ page }) => {
    await withMockedMedia(page);
    await page.route(
      (url) => url.pathname === '/api/media/uploads',
      (route) => route.fulfill({ status: 202, json: jobOf('upload-2', 'upload') }),
    );
    await page.route(
      (url) => url.pathname === '/api/jobs/upload-2/events',
      (route) =>
        route.fulfill(
          jobEvents([
            jobOf('upload-2', 'upload', {
              state: 'failed',
              error: 'Re-encoding bad.mp4 failed: moov atom not found.',
            }),
          ]),
        ),
    );
    await page.goto('/media');
    await tool(page, 'Import…').click();
    await choose(page, 'bad.mp4');

    const alert = importDialog(page).getByRole('alert');
    await expect(alert).toContainText('Uploaded and prepared 0/1 file(s).');
    await expect(alert).toContainText('bad.mp4: Re-encoding bad.mp4 failed: moov atom not found.');
    await expect(importDialog(page)).toBeVisible();
    // No longer busy: Escape closes it.
    await page.keyboard.press('Escape');
    await expect(importDialog(page)).toHaveCount(0);
  });

  test('a catalog asset imports and is shown in the library', async ({ page }) => {
    const mocked = await withMockedMedia(page);
    await page.route(
      (url) => url.pathname === '/api/catalog',
      (route) => route.fulfill({ json: CATALOG }),
    );
    const imported: string[] = [];
    await page.route(
      (url) => url.pathname === '/api/catalog/imports',
      (route) => {
        imported.push((route.request().postDataJSON() as { path: string }).path);
        return route.fulfill({ status: 202, json: jobOf('import-1', 'catalog_import') });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/jobs/import-1/events',
      (route) => {
        const path = 'catalog/street/street_720p30_30fps_h264.mp4';
        mocked.add(path);
        return route.fulfill(
          jobEvents([
            jobOf('import-1', 'catalog_import', {
              progress: { phase: 'download', detail: '3.0 / 3.0 MB', percent: 100 },
            }),
            jobOf('import-1', 'catalog_import', {
              state: 'done',
              result: { path } satisfies MediaSaved,
            }),
          ]),
        );
      },
    );
    await page.goto('/media');
    await tool(page, 'Import…').click();
    await importDialog(page).getByRole('tab', { name: 'Catalog', exact: true }).click();

    const assets = importDialog(page).getByRole('listbox', { name: 'Catalog assets' });
    await assets.getByRole('option').filter({ hasText: 'Street' }).click();
    await expect(importDialog(page)).toContainText('1 asset(s) selected');
    await dialogButton(page, 'Import Selected').click();

    await expect(importDialog(page)).toHaveCount(0);
    expect(imported).toEqual(['street/street_720p30_30fps_h264.mp4']);
    await expect(toast(page, 'Imported 1 catalog asset(s).')).toBeVisible();
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText(
      'catalog/street/street_720p30_30fps_h264.mp4',
    );
    // Revealed two folders down, where the server saves it.
    await expect(page.getByRole('navigation', { name: 'Current folder' })).toContainText('street');
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
      await tab('YouTube').click();
      await expect(importDialog(page).getByLabel('YouTube URL')).toBeVisible();
      expect(await height()).toBe(local);
    }
  });

  test('the YouTube row lines up: names on one baseline, controls level with Validate', async ({
    page,
  }) => {
    await withMockedMedia(page);
    await page.setViewportSize(LAPTOP);
    await page.goto('/media');
    await tool(page, 'Import…').click();
    await importDialog(page).getByRole('tab', { name: 'YouTube', exact: true }).click();
    const row = importDialog(page).locator('app-import-youtube .form');
    await expect(row.getByRole('button', { name: 'Validate' })).toBeVisible();

    // Under the URL, which spans the row: target, start, length and Validate side by side.
    const edges = await row.evaluate((form) => {
      const box = (element: Element) => element.getBoundingClientRect();
      const named = (text: string) =>
        [...form.querySelectorAll('label, span')].find(
          (element) => element.textContent?.trim() === text && element.children.length === 0,
        )!;
      const combos = [...form.querySelectorAll('[role="combobox"]')];
      const controls = [
        combos[0],
        form.querySelectorAll('neat-field input')[1],
        combos[1],
        form.querySelector(':scope > button')!,
      ].map(box);
      const names = ['Target Resolution & FPS', 'Start Time', 'Clip Length'].map(
        (text) => box(named(text)).bottom,
      );
      return {
        tops: controls.map((control) => Math.round(control.top)),
        bottoms: controls.map((control) => Math.round(control.bottom)),
        names: names.map(Math.round),
      };
    });
    expect(new Set(edges.tops).size, `control tops ${edges.tops}`).toBe(1);
    expect(new Set(edges.bottoms).size, `control bottoms ${edges.bottoms}`).toBe(1);
    expect(new Set(edges.names).size, `name baselines ${edges.names}`).toBe(1);
  });

  test('a YouTube link is validated before import, and Cancel Import aborts the import', async ({
    page,
  }) => {
    await withMockedMedia(page);
    await page.route(
      (url) => url.pathname === '/api/import/youtube/validate',
      (route) => route.fulfill({ json: YOUTUBE_PREVIEW }),
    );
    // The import never answers: it runs until cancelled.
    await page.route(
      (url) => url.pathname === '/api/import/youtube',
      () => undefined,
    );
    await page.goto('/media');
    await tool(page, 'Import…').click();
    await importDialog(page).getByRole('tab', { name: 'YouTube' }).click();
    await expect(dialogButton(page, 'Import')).toBeDisabled();

    await importDialog(page).getByLabel('YouTube URL').fill('https://youtu.be/abc');
    await dialogButton(page, 'Validate').click();
    await expect(importDialog(page).getByLabel('YouTube URL')).toHaveValue(
      'https://www.youtube.com/watch?v=abc',
    );
    await expect(importDialog(page)).toContainText('Ready to import YouTube video');

    const aborted = page.waitForEvent(
      'requestfailed',
      (request) => new URL(request.url()).pathname === '/api/import/youtube',
    );
    await dialogButton(page, 'Import').click();
    await expect(importDialog(page)).toContainText('Importing YouTube video');
    await dialogButton(page, 'Cancel Import').click();

    await aborted;
    await expect(toast(page, 'YouTube import canceled.')).toBeVisible();
    await expect(importDialog(page)).toBeVisible();
    await expect(dialogButton(page, 'Cancel Import')).toHaveCount(0);
  });
});
