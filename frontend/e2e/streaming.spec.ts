import { expect, Page, Request, test } from '@playwright/test';
import type { MediaEntry, RenditionUsage, Slot, SlotAssignment } from '../src/app/api.generated';
import {
  fileSlot,
  publisher,
  pull,
  slot,
  slotList,
  webcamSlot,
} from '../src/app/sources/slots.testing';
import { LAPTOP, pageOverflow, TABLET, sidePanelToggle, topBarSpill, VIEWPORTS } from './layout';
import { answerTopBar } from './top-bar';

// The Streaming page's layout at every viewport, and one flow through it, against a mocked
// streaming API. What the page does with each kind of slot and action is held by its unit specs
// (`src/app/pages/streaming/`).

// The rail's board block reads the board on every page.
test.beforeEach(({ page }) => answerTopBar(page));

/** What MediaMTX reports of a pulled camera while it is live. */
const PULLED = (fields: Parameters<typeof publisher>[0] = {}) =>
  publisher({
    protocol: 'rtspSource',
    address: undefined,
    width: 1280,
    height: 720,
    fps: 25,
    ...fields,
  });

/**
 * What the server answers on a board in use: a live file, a file at a rate of its own, a webcam
 * no browser publishes, an external publisher with a codec Neat cannot decode, and pulls live,
 * unreachable, refused and connecting, then an idle file. The other 39 slots are unassigned. The
 * long sources and states are what the layout tests hold the rows to.
 */
const SLOTS: Slot[] = Array.from({ length: 48 }, (_, i) => slot(i + 1));
SLOTS[0] = fileSlot(1, 'people/walk_720p30.mp4', {
  run: true,
  state: 'live',
  active_file: 'people/walk_720p30.mp4',
  publisher: publisher({ protocol: 'rtsp', address: '127.0.0.1' }),
});
SLOTS[1] = fileSlot(2, 'cars.mp4', { codec: 'h265', native_fps: 25, fps: 15 });
SLOTS[2] = webcamSlot(3);
SLOTS[3] = slot(4, {
  state: 'external',
  codec: 'av1',
  publisher: publisher({ address: '192.168.1.20', codec: 'av1', codec_supported: false }),
});
SLOTS[4] = slot(5, {
  kind: 'pull',
  run: true,
  state: 'live',
  codec: 'h264',
  pull: pull({ status: 'live' }),
  publisher: PULLED({ width: 1920, height: 1080 }),
});
SLOTS[5] = slot(6, {
  kind: 'pull',
  run: true,
  state: 'starting',
  error: 'connection refused',
  pull: pull({ status: 'unreachable', host: '10.0.0.8:554', error: 'connection refused' }),
});
SLOTS[6] = slot(7, {
  kind: 'pull',
  run: true,
  state: 'failed',
  error: 'The camera rejected the username or password',
  pull: pull({ status: 'auth_failed', error: 'The camera rejected the username or password' }),
});
SLOTS[7] = slot(8, {
  kind: 'pull',
  run: true,
  state: 'starting',
  pull: pull({ status: 'connecting' }),
});
SLOTS[8] = fileSlot(9, 'idle.mp4');

const file = (path: string): MediaEntry => ({
  name: path.split('/').pop()!,
  path,
  folder: false,
  streamable: true,
  probe: { kind: 'video', codec: 'h264', size: 1_000_000, streamable: true },
});

/** `GET /api/media`: the library's root. */
const TREE: MediaEntry = {
  name: '',
  path: '',
  folder: true,
  streamable: true,
  streamable_count: 2,
  probe: null,
  children: [
    {
      name: 'people',
      path: 'people',
      folder: true,
      streamable: true,
      streamable_count: 1,
      probe: null,
      children: [],
    },
    file('cars.mp4'),
  ],
};

/** A 1×1 PNG. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** What each slot action was sent, by action (`assign`, `start`), in order: its slot and body. */
type Calls = Map<string, unknown[]>;

/** A request's JSON body, `{}` when it has none. */
const bodyOf = (request: Request): Record<string, unknown> =>
  request.postData() ? (request.postDataJSON() as Record<string, unknown>) : {};

/**
 * Insight's streaming API without a board: the slots above, three renditions and a small library.
 * A file's assignment and a slot's start change the slots as the server would, so the page shows
 * what it holds after them. Every API the page reads is answered here, so whatever serves the app
 * cannot change what the tests see.
 */
async function withMockedSlots(page: Page): Promise<Calls> {
  const calls: Calls = new Map();
  // Each test starts from the board above and changes its own copy.
  const slots = structuredClone(SLOTS);

  await page.route(
    (url) => url.pathname === '/api/slots',
    (route) => route.fulfill({ json: slotList(slots) }),
  );
  await page.route(
    (url) => url.pathname === '/api/renditions',
    (route) =>
      route.fulfill({
        json: { count: 3, bytes: 1.2 * 1024 ** 3, in_use: 0 } satisfies RenditionUsage,
      }),
  );
  await page.route(
    (url) => url.pathname === '/api/media',
    (route) => route.fulfill({ json: TREE }),
  );
  // The side panel's previews: a live slot's stream and a file. A still image stands in for both.
  await page.route(
    (url) =>
      /^\/api\/slots\/\d+\/preview\.mjpg$/.test(url.pathname) ||
      url.pathname === '/api/media/file' ||
      url.pathname === '/api/media/preview.mjpg',
    (route) => route.fulfill({ contentType: 'image/png', body: PIXEL }),
  );
  // `PUT /api/slots/<n>` assigns a file, `POST /api/slots/<n>/start` starts the slot.
  await page.route(
    (url) => /^\/api\/slots\/\d+(\/start)?$/.test(url.pathname),
    (route) => {
      const request = route.request();
      const [, n, start] = /^\/api\/slots\/(\d+)(\/start)?$/.exec(new URL(request.url()).pathname)!;
      const action = start ? 'start' : 'assign';
      const body = bodyOf(request);
      calls.set(action, [...(calls.get(action) ?? []), { n: Number(n), ...body }]);
      const index = Number(n) - 1;
      const target = slots[index];
      // An assigned file as the server probes it: H.264 at 30 fps, stopped.
      slots[index] =
        action === 'assign'
          ? fileSlot(target.n, (body as unknown as SlotAssignment).file!)
          : {
              ...target,
              run: true,
              state: 'live',
              active_file: target.file,
              publisher: publisher({ address: '127.0.0.1' }),
            };
      return route.fulfill({ json: slots[index] });
    },
  );
  return calls;
}

const listbox = (page: Page) => page.getByRole('listbox', { name: 'Streaming slots' });
const rows = (page: Page) => listbox(page).getByRole('option');
const row = (page: Page, name: string) =>
  rows(page).filter({
    has: page.locator(':scope > div:first-child', { hasText: new RegExp(`^${name}$`) }),
  });
const panel = (page: Page) => page.getByRole('region', { name: 'Selected slot' });
const panelButton = (page: Page, name: string) =>
  panel(page).getByRole('button', { name, exact: true });

/** A row's cells as they read on screen, without the warning glyph. */
function cells(page: Page, name: string): Promise<string[]> {
  return row(page, name).evaluate((option) =>
    [...option.querySelectorAll(':scope > div')].map((cell) => {
      const shown = cell.cloneNode(true) as HTMLElement;
      shown.querySelectorAll('[role="img"]').forEach((glyph) => glyph.remove());
      return shown.textContent!.trim();
    }),
  );
}

/** How far the rows reach past the list's width: nothing may be pushed out of view sideways. */
function listOverflow(page: Page): Promise<number> {
  return listbox(page).evaluate((element) =>
    Math.max(
      0,
      ...[element.parentElement!, ...element.querySelectorAll('[role="option"]')].map(
        (box) => box.scrollWidth - box.clientWidth,
      ),
    ),
  );
}

test('48 rows at 1366×768, 1920×1080 and 768×1024, with the side panel open and closed: nothing overflows, no page scroll', async ({
  page,
}) => {
  await withMockedSlots(page);
  await page.setViewportSize(LAPTOP);
  await page.goto('/streaming');
  await expect(rows(page)).toHaveCount(48);

  for (const { size } of VIEWPORTS) {
    await page.setViewportSize(size);
    for (const sidePanel of [true, false]) {
      await expect(panel(page)).toHaveCount(sidePanel ? 1 : 0);
      await expect.poll(() => listOverflow(page)).toBe(0);
      await expect
        .poll(() => pageOverflow(page))
        .toEqual([
          { horizontal: 0, vertical: 0 },
          { horizontal: 0, vertical: 0 },
        ]);
      // The toolbar fits beside the title on a laptop and a desktop; a tablet scrolls it.
      await expect
        .poll(() => topBarSpill(page, size === TABLET))
        .toEqual({ spilled: [], toolsOverflow: 0 });
      await sidePanelToggle(page).click();
    }
  }

  // The list scrolls its rows inside: the last one is reachable.
  await listbox(page).focus();
  await page.keyboard.press('End');
  await expect(row(page, 'src48')).toBeInViewport();
});

test('the side panel of each kind of slot fits its column at 1366×768, 1920×1080 and 768×1024', async ({
  page,
}) => {
  await withMockedSlots(page);
  await page.setViewportSize(LAPTOP);
  await page.goto('/streaming');
  await expect(rows(page)).toHaveCount(48);

  /** How far the panel's content reaches past its width: it scrolls down, never sideways. */
  const panelOverflow = () =>
    panel(page).evaluate((aside) =>
      Math.max(
        0,
        ...[aside, ...aside.querySelectorAll('*')].map((box) =>
          box.getBoundingClientRect().right > aside.getBoundingClientRect().right + 0.5
            ? box.getBoundingClientRect().right - aside.getBoundingClientRect().right
            : 0,
        ),
      ),
    );

  /**
   * Whether the stream URL keeps to one line, with its Copy beside it or, where there is no room
   * beside it, under it: a URL that fits its column is never broken to make room for Copy.
   */
  const urlWhole = () =>
    panel(page)
      .locator('dd', { has: page.getByRole('button', { name: /^Copy stream URL/ }) })
      .evaluate((value) => {
        const code = value.querySelector('code')!;
        const text = document.createRange();
        text.selectNodeContents(code);
        const lines = new Set([...text.getClientRects()].map((line) => Math.round(line.top))).size;
        const url = code.getBoundingClientRect();
        const copy = value.querySelector('button')!.getBoundingClientRect();
        const beside = copy.left >= url.right && copy.top < url.bottom && copy.bottom > url.top;
        return lines === 1 && (beside || copy.top >= url.bottom);
      });

  /** Whether the main action fills the row it is alone on, the panel's width. */
  const mainActionFillsPanel = () =>
    panel(page)
      .locator('[neatAsideActions]')
      .first()
      .evaluate((actions) => {
        const row = actions.getBoundingClientRect();
        const button = actions.querySelector('button')!.getBoundingClientRect();
        return actions.children.length === 1 && Math.abs(button.width - row.width) < 1;
      });

  for (const { size } of VIEWPORTS) {
    await page.setViewportSize(size);
    // A live file, a file at another rate, an external publisher and a pull.
    for (const name of ['src1', 'src2', 'src4', 'src5']) {
      await row(page, name).click();
      await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText(name);
      await expect.poll(panelOverflow).toBe(0);
      await expect
        .poll(() => pageOverflow(page))
        .toEqual([
          { horizontal: 0, vertical: 0 },
          { horizontal: 0, vertical: 0 },
        ]);
      await expect.poll(urlWhole).toBe(true);
      await expect.poll(mainActionFillsPanel).toBe(true);
    }
  }

  // The live preview connects and shows its first frame.
  await row(page, 'src1').click();
  await expect(panel(page).getByRole('img', { name: 'Live preview of src1' })).toBeVisible();
  await expect(panel(page)).not.toContainText('Connecting to src1');
});

test('a file is assigned through the picker and started, then the row and panel follow', async ({
  page,
}) => {
  const calls = await withMockedSlots(page);
  await page.setViewportSize(LAPTOP);
  await page.goto('/streaming');
  await expect(rows(page)).toHaveCount(48);

  await row(page, 'src10').click();
  await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('src10');
  // Nothing to start before a source.
  await expect(panelButton(page, 'Start')).toBeDisabled();

  await panel(page).getByRole('button', { name: 'Change…' }).click();
  const picker = page.getByRole('dialog', { name: 'Source for src10' });
  await expect(picker).toContainText('Selected: Not assigned');
  await picker.getByRole('option').filter({ hasText: 'cars.mp4' }).click();
  await expect(picker).toContainText('Selected: cars.mp4');
  await picker.getByRole('button', { name: 'Assign', exact: true }).click();

  // The dialog closes once the server has the file, and the slot shows what it knows of it.
  await expect(picker).toHaveCount(0);
  expect(calls.get('assign')).toEqual([{ n: 10, kind: 'file', file: 'cars.mp4' }]);
  await expect(panel(page)).toContainText('File: cars.mp4 · 30 fps');
  expect(await cells(page, 'src10')).toEqual([
    'src10',
    'VID',
    'cars.mp4',
    'Idle',
    '30 fps',
    'H.264',
  ]);

  await panelButton(page, 'Start').click();
  await expect(panelButton(page, 'Stop')).toBeVisible();
  await expect(panel(page)).toContainText('Live');
  expect(calls.get('start')).toEqual([{ n: 10 }]);
  expect((await cells(page, 'src10'))[3]).toBe('Live');
});
