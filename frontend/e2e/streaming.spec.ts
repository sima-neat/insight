import { expect, Page, Request, test } from '@playwright/test';
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

// The top bar's pill reads the board on every page.
test.beforeEach(({ page }) => answerTopBar(page));

/** The fields of a `GET /api/mediasrc` slot these tests set; the rest take an unassigned slot's values. */
type SlotAnswer = Record<string, unknown> & { index: number };

const slot = (index: number, fields: Record<string, unknown> = {}): SlotAnswer => ({
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

const pull = (fields: Record<string, unknown>) => ({
  scheme: 'rtsp',
  host: '10.0.0.7:554',
  path: '/stream1',
  error: null,
  since: null,
  codec_supported: true,
  width: null,
  height: null,
  fps: null,
  bitrate_bps: null,
  ...fields,
});

/**
 * What Flask answers on a board in use: a playing file, a file at a rate of its own, a webcam, an
 * external publisher with a codec Neat cannot decode, and pulls live, unreachable, refused and
 * connecting, then an idle file. The other 38 slots are unassigned.
 */
const SLOTS: SlotAnswer[] = Array.from({ length: 48 }, (_, i) => slot(i + 1));
SLOTS[0] = slot(1, {
  file: 'people/walk_720p30.mp4',
  state: 'playing',
  codec: 'h264',
  transport: 'rtsp',
  native_fps: 30,
  active_file: 'people/walk_720p30.mp4',
  allowed_transports: ['rtsp'],
});
SLOTS[1] = slot(2, { file: 'cars.mp4', codec: 'h265', transport: 'rtsp', native_fps: 25, fps: 15 });
SLOTS[2] = slot(3, { type: 'webcam', codec: 'h264', transport: 'rtsp', readers: undefined });
SLOTS[3] = slot(4, {
  state: 'external',
  codec: 'av1',
  external: {
    protocol: 'rtsp',
    address: '192.168.1.20:41234',
    since: '2026-10-24T08:00:00Z',
    codec_supported: false,
    width: 1280,
    height: 720,
    fps: 30,
    bitrate_bps: 2_000_000,
  },
});
SLOTS[4] = slot(5, {
  file: 'under.mp4',
  state: 'pulled',
  codec: 'h264',
  pull: pull({ status: 'live', width: 1920, height: 1080, fps: 25, since: '2026-10-24T08:00:00Z' }),
});
SLOTS[5] = slot(6, {
  state: 'pulled',
  codec: 'none',
  pull: pull({ status: 'unreachable', host: '10.0.0.8:554', error: 'connection refused' }),
});
SLOTS[6] = slot(7, {
  state: 'pulled',
  codec: 'none',
  pull: pull({ status: 'auth_failed', error: 'The camera rejected the username or password' }),
});
SLOTS[7] = slot(8, { state: 'pulled', codec: 'none', pull: pull({ status: 'connecting' }) });
SLOTS[8] = slot(9, {
  file: 'idle.mp4',
  codec: 'h264',
  transport: 'rtsp',
  native_fps: 30,
  allowed_transports: ['rtsp'],
});

/** What the server knows of a file once it is assigned: the codec probe's result and its rate. */
const PROBED = {
  codec: 'h264',
  transport: 'rtsp',
  native_fps: 30,
  allowed_transports: ['rtsp'],
};

const TREE = [
  { name: '/people', path: 'people', type: 'folder', streamable_count: 1, children: [] },
  { name: 'cars.mp4', path: 'cars.mp4', type: 'file', streamable: true },
];

/** A 1×1 PNG. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface Mocked {
  /** The bodies of the POSTs to `/api/mediasrc/<action>`, by action, bulk or single. */
  readonly posts: Map<string, unknown[]>;
  /** Makes `GET /api/mediasrc` fail from now on. */
  failSlots(): void;
}

/**
 * Insight's streaming API without a board: the slots above, three renditions, a small library,
 * and a bulk action answering with the server's message. The single-slot actions (assign, start,
 * stop, take over, pull) change the slots as the server would, so the page shows what it holds
 * after them. Every API the page calls is answered here, so whatever serves the app cannot change
 * what the tests see.
 */
async function withMockedSlots(page: Page): Promise<Mocked> {
  const posts = new Map<string, unknown[]>();
  // Each test starts from the board above and changes its own copy.
  const slots = structuredClone(SLOTS);
  let failing = false;
  const record = (action: string, request: Request) =>
    posts.set(action, [...(posts.get(action) ?? []), request.postDataJSON()]);
  // The answers say what the server would for the slots above: stop all and reset stop the pulls
  // and leave the external publisher running, auto assign skips both, and a bulk start only
  // targets slots with a file (src1, src2, src9; src5's file sits under a pull).
  const bulk = (message: string, extra: object) => ({
    success: true,
    unconfirmed_webcams: [],
    changed_sources: [],
    message,
    ...extra,
  });

  await page.route(
    (url) => url.pathname === '/api/mediasrc',
    (route) =>
      failing
        ? route.fulfill({ status: 500, json: { error: 'MediaMTX is not answering' } })
        : route.fulfill({ json: slots }),
  );
  await page.route(
    (url) => url.pathname === '/api/mediasrc/renditions',
    (route) => route.fulfill({ json: { count: 3, bytes: 1.2 * 1024 ** 3 } }),
  );
  await page.route(
    (url) => url.pathname === '/api/media-files',
    (route) => route.fulfill({ json: TREE }),
  );
  // The side panel's previews: a live slot's stream and a file. A still image stands in for both.
  await page.route(
    (url) => url.pathname.startsWith('/stream/preview/') || url.pathname.startsWith('/media/'),
    (route) => route.fulfill({ contentType: 'image/png', body: PIXEL }),
  );
  const answers: Record<string, object> = {
    'start-bulk': {
      success: true,
      requested: 3,
      targeted: 3,
      started: [9],
      already_running: [1],
      errors: [
        {
          index: 2,
          error:
            'Encoding src2 at 15 fps failed. Partial output was removed; the source file is unchanged.',
        },
      ],
      skipped_external: [],
      skipped_pulled: [5],
      message: 'Started 1 source(s), 1 already running, 1 failed. Skipped pulled: src5.',
      started_or_running: 2,
    },
    'stop-all': bulk('Stopped 6 source(s). External stream(s) left running: src4.', {
      skipped_external: [4],
      skipped_pulled: [],
      stopped_count: 6,
      stopped_pulled: [5, 6, 7, 8],
    }),
    reset: bulk('Reset all source assignments. External stream(s) left running: src4.', {
      skipped_external: [4],
      skipped_pulled: [],
      stopped_pulled: [5, 6, 7, 8],
    }),
    'auto-assign-all': bulk(
      'Assigned 2 source(s) with unique media file(s). Skipped external: src4. Skipped pulled: src5, src6, src7, src8.',
      {
        skipped_external: [4],
        skipped_pulled: [5, 6, 7, 8],
        assigned_count: 2,
        source_count: 48,
        available_files: 2,
      },
    ),
  };
  for (const [action, answer] of Object.entries(answers)) {
    await page.route(
      (url) => url.pathname === `/api/mediasrc/${action}`,
      (route) => {
        record(action, route.request());
        return route.fulfill({ json: answer });
      },
    );
  }

  // The single-slot actions: `change` updates the slot the request names and answers `answer`.
  const slotAction = async (
    action: string,
    change: (target: SlotAnswer, body: Record<string, unknown>) => void,
    answer: (target: SlotAnswer) => object,
  ) =>
    page.route(
      (url) => url.pathname === `/api/mediasrc/${action}`,
      (route) => {
        record(action, route.request());
        const body = route.request().postDataJSON() as { index: number };
        const target = slots[body.index - 1];
        change(target, body);
        return route.fulfill({ json: answer(target) });
      },
    );
  const ok = () => ({ success: true });
  await slotAction(
    'assign',
    (target, { file }) => Object.assign(target, file ? { file, ...PROBED } : slot(target.index)),
    ok,
  );
  // A webcam slot is registered with no device; the server answers with the slot it made.
  await slotAction(
    'assign-webcam',
    (target) =>
      Object.assign(target, {
        type: 'webcam',
        file: '',
        state: 'stopped',
        active_file: null,
        pull: undefined,
        codec: 'h264',
        transport: 'rtsp',
        native_fps: null,
        allowed_transports: ['rtsp'],
      }),
    (target) => ({ success: true, source: target }),
  );
  await slotAction(
    'start',
    (target) => Object.assign(target, { state: 'playing', active_file: target['file'] }),
    ok,
  );
  // Stopping releases a pull as well: the slot is idle and holds whatever it was assigned.
  await slotAction(
    'stop',
    (target) =>
      Object.assign(target, {
        state: 'stopped',
        active_file: null,
        pull: undefined,
        codec: target['file'] ? target['codec'] : 'unknown',
      }),
    ok,
  );
  await slotAction(
    'takeover',
    (target) => Object.assign(target, { state: 'stopped', external: undefined, codec: 'unknown' }),
    (target) => ({ success: true, index: target.index }),
  );
  await slotAction(
    'pull',
    (target) =>
      Object.assign(target, {
        state: 'pulled',
        codec: 'h264',
        pull: pull({
          status: 'live',
          host: '10.0.0.9:554',
          path: '/cam',
          width: 1280,
          height: 720,
          fps: 25,
          since: '2026-10-24T08:00:00Z',
        }),
      }),
    (target) => target,
  );
  return { posts, failSlots: () => (failing = true) };
}

const listbox = (page: Page) => page.getByRole('listbox', { name: 'Streaming slots' });
const rows = (page: Page) => listbox(page).getByRole('option');
const row = (page: Page, name: string) =>
  rows(page).filter({
    has: page.locator(':scope > div:first-child', { hasText: new RegExp(`^${name}$`) }),
  });
const pageTools = (page: Page) => page.getByRole('group', { name: 'Page tools' });
const tool = (page: Page, name: string) =>
  pageTools(page).getByRole('button', { name, exact: true });
const panel = (page: Page) => page.getByRole('region', { name: 'Selected slot' });
const morePanel = (page: Page) => page.getByRole('dialog', { name: 'More actions', exact: true });
/** A row of the ⋯ menu, which the menu is opened for. */
async function menuItem(page: Page, name: string) {
  await tool(page, 'More actions').click();
  return morePanel(page).getByRole('button', { name, exact: true });
}
const confirmDialog = (page: Page) => page.getByRole('alertdialog');
/** A toast as shown; its text is also in the toast host's announcer, which is not. */
const toast = (page: Page, text: string) =>
  page.locator('[data-slot="toast"]').filter({ hasText: text });

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

/**
 * The cells a row shows at `size`: beside the side panel a tablet's list is too narrow for its
 * Rate and Codec columns, which then give way (the panel shows both).
 */
const shownAt = (size: { width: number }, cells: string[]) =>
  size === TABLET ? cells.slice(0, 4) : cells;

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

test.describe('Streaming with mocked slots', () => {
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
        // R14: the toolbar fits beside the title on a laptop and a desktop; a tablet scrolls it.
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

    /** Whether the stream URL's Copy sits beside the URL rather than on a line of its own. */
    const copyBesideUrl = () =>
      panel(page)
        .locator('dd', { has: page.getByRole('button', { name: /^Copy stream URL/ }) })
        .evaluate((value) => {
          const url = value.querySelector('code')!.getBoundingClientRect();
          const copy = value.querySelector('button')!.getBoundingClientRect();
          return copy.left >= url.right && copy.top < url.bottom && copy.bottom > url.top;
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
      // A playing file, a file at its own rate, an external publisher and a pull.
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
        await expect.poll(copyBesideUrl).toBe(true);
        await expect.poll(mainActionFillsPanel).toBe(true);
      }
    }

    // The live preview connects and shows its first frame.
    await row(page, 'src1').click();
    await expect(panel(page).getByRole('img', { name: 'Live preview of src1' })).toBeVisible();
    await expect(panel(page)).not.toContainText('Connecting to src1');
  });

  test('the preview’s badge says what each kind of slot shows, through a start and a stop', async ({
    page,
  }) => {
    await withMockedSlots(page);
    await page.setViewportSize(LAPTOP);
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);

    const preview = (name: string) =>
      panel(page).getByRole('group', { name: `Preview of ${name}` });

    // Live whatever the source: a playing file, an external publisher and a pull that receives.
    for (const name of ['src1', 'src4', 'src5']) {
      await row(page, name).click();
      await expect(preview(name)).toHaveAccessibleDescription('Live');
    }
    // A pull that waits or fails is not live, over its waiting text.
    for (const name of ['src6', 'src7', 'src8']) {
      await row(page, name).click();
      await expect(preview(name)).toHaveAccessibleDescription('Not live');
    }
    // Nothing to show, nothing to say.
    await row(page, 'src3').click();
    await expect(preview('src3')).not.toHaveAccessibleDescription(/\S/);

    // A stopped file is its file; started it is live, and stopped it is the file again.
    await row(page, 'src9').click();
    await expect(preview('src9')).toHaveAccessibleDescription('File preview');
    await panel(page).getByRole('button', { name: 'Start', exact: true }).click();
    await expect(preview('src9')).toHaveAccessibleDescription('Live');
    await panel(page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(preview('src9')).toHaveAccessibleDescription('File preview');
  });

  test('the side panel keeps the width it was dragged to across a reload, and ArrowLeft widens it', async ({
    page,
  }) => {
    await withMockedSlots(page);
    await page.setViewportSize(DESKTOP);
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);
    const asideWidth = () =>
      page.locator('aside').evaluate((aside) => aside.getBoundingClientRect().width);
    const separator = page.getByRole('separator', { name: 'Resize side panel' });
    const stored = () =>
      page.evaluate(() => localStorage.getItem('neat-insight:streaming:aside-width'));
    const initial = await asideWidth();
    expect(await stored()).toBeNull();

    // The separator is the panel's inline-start edge: dragging it left widens the panel.
    const box = (await separator.boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 120, y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(asideWidth).toBeCloseTo(initial + 120, -1);
    const dragged = await asideWidth();
    expect(Number(await stored())).toBeCloseTo(dragged, -1);

    await page.reload();
    await expect(rows(page)).toHaveCount(48);
    await expect.poll(asideWidth).toBe(dragged);

    await separator.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(asideWidth).toBe(dragged + 16);
    expect(Number(await stored())).toBeCloseTo(dragged + 16, -1);

    // A double click is back to the default, which is no stored width.
    await separator.dblclick();
    await expect.poll(asideWidth).toBe(initial);
    expect(await stored()).toBeNull();
  });

  for (const { name, size } of VIEWPORTS) {
    test(`Tab reaches Change… from the list, and it opens the picker on the slot’s file and Escape closes it at ${name}`, async ({
      page,
    }) => {
      await withMockedSlots(page);
      await page.setViewportSize(size);
      await page.goto('/streaming');
      await expect(rows(page)).toHaveCount(48);

      // The page opens on src1, as #170 did.
      await listbox(page).focus();
      await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('src1');
      // From the list into the panel: the panel's resize handle, the main action, the source
      // switch, then Change….
      await page.keyboard.press('Tab');
      await expect(page.getByRole('separator', { name: 'Resize side panel' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(panel(page).getByRole('button', { name: 'Stop', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(panel(page).getByRole('radio', { name: 'File' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(panel(page).getByRole('button', { name: 'Change…' })).toBeFocused();
      await page.keyboard.press('Enter');
      const picker = page.getByRole('dialog', { name: 'Source for src1' });
      await expect(picker).toBeVisible();
      await expect(picker).toContainText('Selected: people/walk_720p30.mp4');
      await page.keyboard.press('Escape');
      await expect(picker).toHaveCount(0);
    });

    test(`a file is assigned through the picker and started, then the row and panel follow at ${name}`, async ({
      page,
    }) => {
      const mocked = await withMockedSlots(page);
      await page.setViewportSize(size);
      await page.goto('/streaming');
      await expect(rows(page)).toHaveCount(48);

      await row(page, 'src10').click();
      await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('src10');
      // Nothing to start before a file: Start says why.
      await expect(panel(page).getByRole('button', { name: 'Start', exact: true })).toBeDisabled();

      await panel(page).getByRole('button', { name: 'Change…' }).click();
      const picker = page.getByRole('dialog', { name: 'Source for src10' });
      await expect(picker).toContainText('Selected: Not assigned');
      const assign = picker.getByRole('button', { name: 'Assign', exact: true });
      await expect(assign).toBeDisabled();
      await picker.getByRole('option').filter({ hasText: 'cars.mp4' }).click();
      await expect(picker).toContainText('Selected: cars.mp4');
      await assign.click();

      // The dialog closes once the server has the file, and the slot shows what it knows of it.
      await expect(picker).toHaveCount(0);
      expect(mocked.posts.get('assign')).toEqual([
        expect.objectContaining({ index: 10, file: 'cars.mp4' }),
      ]);
      await expect(panel(page)).toContainText('File: cars.mp4 · 30 fps');
      expect(await cells(page, 'src10')).toEqual(
        shownAt(size, ['src10', 'VID', 'cars.mp4', 'Idle', '30 fps', 'H.264']),
      );

      await panel(page).getByRole('button', { name: 'Start', exact: true }).click();
      await expect(panel(page).getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
      await expect(panel(page)).toContainText('Live');
      expect(mocked.posts.get('start')).toEqual([{ index: 10 }]);
      expect((await cells(page, 'src10'))[3]).toBe('Live');
    });

    test(`a stream is pulled into a slot and stopped at ${name}`, async ({ page }) => {
      const mocked = await withMockedSlots(page);
      await page.setViewportSize(size);
      await page.goto('/streaming');
      await expect(rows(page)).toHaveCount(48);

      await row(page, 'src11').click();
      await panel(page).getByRole('radio', { name: 'Stream URL' }).click();
      const pull = panel(page).getByRole('button', { name: 'Pull', exact: true });
      // Only RTSP and RTSPS URLs can be pulled.
      await panel(page).getByLabel('Stream URL', { exact: true }).fill('http://10.0.0.9/cam');
      await expect(pull).toBeDisabled();
      await panel(page).getByLabel('Stream URL', { exact: true }).fill('rtsp://10.0.0.9:554/cam');
      await panel(page).getByLabel('Username').fill('operator');
      const password = panel(page).getByLabel('Password');
      await password.fill('s3cret');
      await expect(pull).toBeEnabled();
      await pull.click();

      await expect(toast(page, 'src11 is pulling from rtsp://10.0.0.9:554/cam.')).toBeVisible();
      expect(mocked.posts.get('pull')).toEqual([
        { index: 11, url: 'rtsp://10.0.0.9:554/cam', username: 'operator', password: 's3cret' },
      ]);
      expect(await cells(page, 'src11')).toEqual(
        shownAt(size, [
          'src11',
          'URL',
          '⇠ RTSP · 10.0.0.9:554 · 1280×720 · 25 fps',
          'Pulled',
          '25 fps',
          'H.264',
        ]),
      );

      // The form goes with the pull, and its main action takes over the focus.
      const stop = panel(page).getByRole('button', { name: 'Stop pulling' });
      await expect(stop).toBeFocused();
      await stop.click();
      await expect(panel(page).getByRole('button', { name: 'Start', exact: true })).toBeVisible();
      expect(mocked.posts.get('stop')).toEqual([{ index: 11 }]);
      // The form comes back as it was, except that the password was not kept past the pull.
      await expect(panel(page).getByLabel('Username')).toHaveValue('operator');
      await expect(password).toHaveValue('');
      expect(await cells(page, 'src11')).toEqual(
        shownAt(size, ['src11', '', 'Not assigned', 'Idle', '', '-']),
      );
    });

    test(`the source switch applies at once on a stopped slot, and the keyboard stays on it at ${name}`, async ({
      page,
    }) => {
      const mocked = await withMockedSlots(page);
      await page.setViewportSize(size);
      await page.goto('/streaming');
      await expect(rows(page)).toHaveCount(48);

      // src9 holds an idle file.
      await row(page, 'src9').click();
      await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('src9');
      const file = panel(page).getByRole('radio', { name: 'File' });
      const camera = panel(page).getByRole('radio', { name: 'Camera' });
      await file.focus();
      await page.keyboard.press('ArrowRight');
      await expect(panel(page).getByRole('radio', { name: 'Camera', checked: true })).toBeVisible();
      await expect(camera).toBeFocused();
      expect(mocked.posts.get('assign-webcam')).toEqual([{ index: 9 }]);
      expect((await cells(page, 'src9'))[1]).toBe('CAM');

      await file.click();
      await expect(panel(page).getByText('File: Not assigned')).toBeVisible();
      expect(mocked.posts.get('assign')).toEqual([{ index: 9, file: '' }]);
      expect((await cells(page, 'src9'))[1]).toBe('');
    });

    test(`the source switch asks before it stops a live slot, and Cancel changes nothing at ${name}`, async ({
      page,
    }) => {
      const mocked = await withMockedSlots(page);
      await page.setViewportSize(size);
      await page.goto('/streaming');
      await expect(rows(page)).toHaveCount(48);

      // src1 is playing a file.
      await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('src1');
      await panel(page).getByRole('radio', { name: 'Camera' }).click();
      const question = confirmDialog(page);
      await expect(question).toContainText('Stop src1?');
      await expect(question).toContainText(
        'Switching to Camera stops src1 and removes its people/walk_720p30.mp4.',
      );
      await question.getByRole('button', { name: 'Cancel' }).click();
      await expect(question).toBeHidden();
      await expect(panel(page).getByRole('radio', { name: 'File', checked: true })).toBeVisible();
      await expect(panel(page)).toContainText('File: people/walk_720p30.mp4');
      expect(mocked.posts.get('stop')).toBeUndefined();
      expect(mocked.posts.get('assign-webcam')).toBeUndefined();
      expect((await cells(page, 'src1'))[3]).toBe('Live');

      await panel(page).getByRole('radio', { name: 'Camera' }).click();
      await question.getByRole('button', { name: 'Stop and switch' }).click();
      // The switch shows Camera at once; the row is a camera once the slot has been stopped and
      // registered.
      await expect.poll(async () => (await cells(page, 'src1'))[1]).toBe('CAM');
      expect(mocked.posts.get('stop')).toEqual([{ index: 1 }]);
      expect(mocked.posts.get('assign-webcam')).toEqual([{ index: 1 }]);
      expect(await cells(page, 'src1')).toEqual(
        shownAt(size, ['src1', 'CAM', 'Select a camera', 'Idle', '', 'H.264']),
      );
    });

    test(`an empty slot left on Stream URL shows it again at ${name}`, async ({ page }) => {
      await withMockedSlots(page);
      await page.setViewportSize(size);
      await page.goto('/streaming');
      await expect(rows(page)).toHaveCount(48);

      await row(page, 'src12').click();
      await panel(page).getByRole('radio', { name: 'Stream URL' }).click();
      await row(page, 'src13').click();
      await expect(panel(page).getByRole('radio', { name: 'File', checked: true })).toBeVisible();
      await row(page, 'src12').click();
      await expect(
        panel(page).getByRole('radio', { name: 'Stream URL', checked: true }),
      ).toBeVisible();
      await expect(panel(page).getByLabel('Stream URL', { exact: true })).toBeVisible();
    });

    test(`an external publisher is taken over after a confirmation at ${name}`, async ({
      page,
    }) => {
      const mocked = await withMockedSlots(page);
      await page.setViewportSize(size);
      await page.goto('/streaming');
      await expect(rows(page)).toHaveCount(48);

      await row(page, 'src4').click();
      const takeOver = panel(page).getByRole('button', { name: 'Take over…' });
      await takeOver.click();
      await expect(confirmDialog(page)).toContainText('Disconnect external stream on src4?');
      await expect(confirmDialog(page)).toContainText(
        'The publisher and all readers will be disconnected.',
      );
      // Escape asks nothing of the server, and the focus returns to where it was.
      await page.keyboard.press('Escape');
      await expect(confirmDialog(page)).toHaveCount(0);
      expect(mocked.posts.get('takeover')).toBeUndefined();
      await expect(takeOver).toBeFocused();

      await takeOver.click();
      await confirmDialog(page).getByRole('button', { name: 'Disconnect' }).click();
      await expect(toast(page, 'Disconnected the external stream on src4.')).toBeVisible();
      expect(mocked.posts.get('takeover')).toEqual([{ index: 4 }]);
      expect(await cells(page, 'src4')).toEqual(
        shownAt(size, ['src4', '', 'Not assigned', 'Idle', '', '-']),
      );
      await expect(panel(page).getByRole('button', { name: 'Start', exact: true })).toBeVisible();
    });
  }

  test('a row carries the tint of its state chip’s tone; an idle row has none', async ({
    page,
  }) => {
    await withMockedSlots(page);
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);
    // Away from src1, so the Live row is at rest (a selected row takes the stronger tint).
    await row(page, 'src2').click();

    /** The colour `background: var(token)` computes to, to compare with a row's. */
    const tokenColour = (token: string) =>
      page.evaluate((name) => {
        const probe = document.createElement('div');
        probe.style.background = `var(${name})`;
        document.body.append(probe);
        const colour = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return colour;
      }, token);
    const rowColour = (name: string) =>
      row(page, name).evaluate((element) => getComputedStyle(element).backgroundColor);

    const none = 'rgba(0, 0, 0, 0)';
    const success = await tokenColour('--neat-tint-success');
    const highlight = await tokenColour('--neat-tint-highlight');
    expect([success, highlight]).not.toContain(none);
    await expect.poll(() => rowColour('src1')).toBe(success);
    expect(await rowColour('src4')).toBe(highlight);
    expect(await rowColour('src3')).toBe(none);
  });

  test('rows show kind, source, state, rate and codec for files, a webcam, an external publisher and pulls', async ({
    page,
  }) => {
    await withMockedSlots(page);
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);

    expect(await cells(page, 'src1')).toEqual([
      'src1',
      'VID',
      'people/walk_720p30.mp4',
      'Live',
      '30 fps',
      'H.264',
    ]);
    expect(await cells(page, 'src2')).toEqual([
      'src2',
      'VID',
      'cars.mp4',
      'Idle',
      '15 fps · rendition',
      'H.265',
    ]);
    expect(await cells(page, 'src3')).toEqual([
      'src3',
      'CAM',
      'Select a camera',
      'Idle',
      '',
      'H.264',
    ]);
    expect(await cells(page, 'src4')).toEqual([
      'src4',
      'EXT',
      '⇢ RTSP · 192.168.1.20:41234 · 1280×720 · 30 fps',
      'External',
      '30 fps',
      'AV1',
    ]);
    expect(await cells(page, 'src5')).toEqual([
      'src5',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · 1920×1080 · 25 fps',
      'Pulled',
      '25 fps',
      'H.264',
    ]);
    expect(await cells(page, 'src6')).toEqual([
      'src6',
      'URL',
      '⇠ RTSP · 10.0.0.8:554 · retrying… (connection refused)',
      'Unreachable',
      'retrying…',
      '-',
    ]);
    expect(await cells(page, 'src7')).toEqual([
      'src7',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · The camera rejected the username or password',
      'Auth failed',
      '',
      '-',
    ]);
    expect(await cells(page, 'src8')).toEqual([
      'src8',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · connecting…',
      'Connecting…',
      '',
      '-',
    ]);
    expect(await cells(page, 'src10')).toEqual(['src10', '', 'Not assigned', 'Idle', '', '-']);

    // The undecodable codec's glyph is named by the warning, which also shows on hover.
    const glyph = row(page, 'src4').getByRole('img', {
      name: 'AV1 cannot be decoded by Neat video pipelines (expects H.264, H.265 or MJPEG). Readers can connect, but decoding will fail.',
    });
    await glyph.hover();
    await expect(page.getByRole('tooltip')).toContainText(
      'AV1 cannot be decoded by Neat video pipelines',
    );
  });

  test('In use shows assigned, external and pulled slots only', async ({ page }) => {
    await withMockedSlots(page);
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);

    await pageTools(page).getByRole('radio', { name: 'In use 9' }).click();
    await expect(rows(page)).toHaveCount(9);
    await expect(row(page, 'src10')).toHaveCount(0);

    await pageTools(page).getByRole('radio', { name: 'All 48' }).click();
    await expect(rows(page)).toHaveCount(48);
  });

  test('keyboard only: arrows select a slot and the side panel follows; Enter opens a closed panel', async ({
    page,
  }) => {
    await withMockedSlots(page);
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);

    // The page opens on src1, as #170 did.
    await listbox(page).focus();
    await expect(row(page, 'src1')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('src1');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('src4');
    await expect(panel(page)).toContainText('External');

    await sidePanelToggle(page).focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toHaveCount(0);

    await listbox(page).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('src5');
  });

  test('Start… starts the chosen count and reports the server message', async ({ page }) => {
    const mocked = await withMockedSlots(page);
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);

    await (await menuItem(page, 'Start…')).click();
    const dialog = page.getByRole('dialog', { name: 'Bulk Start Streams' });
    const slider = dialog.getByRole('slider', { name: 'How many streams do you want to start?' });
    // Q10: it opens at 1, as #170's did.
    await expect(slider).toHaveAttribute('aria-valuenow', '1');
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(dialog.locator('output')).toHaveText('3');
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();

    await expect(dialog).toHaveCount(0);
    await expect(
      toast(page, 'Started 1 source(s), 1 already running, 1 failed. Skipped pulled: src5.'),
    ).toBeVisible();
    await expect(toast(page, 'Failed: src2')).toBeVisible();
    expect(mocked.posts.get('start-bulk')).toEqual([{ count: 3 }]);

    // It opens again at the count chosen last. Escape closes it, the menu with it, and the focus
    // is on ⋯ again.
    await (await menuItem(page, 'Start…')).click();
    await expect(slider).toHaveAttribute('aria-valuenow', '3');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(morePanel(page)).toHaveCount(0);
    await expect(tool(page, 'More actions')).toBeFocused();
  });

  test('the ⋯ menu lists the bulk actions as full-width rows in keyboard order, with a line before Reset', async ({
    page,
  }) => {
    await withMockedSlots(page);
    // No renditions: the last row is disabled.
    await page.route(
      (url) => url.pathname === '/api/mediasrc/renditions',
      (route) => route.fulfill({ json: { count: 0, bytes: 0 } }),
    );
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);

    // The tools are the filter and ⋯; the side-panel toggle is the top bar's, not among them.
    await expect(pageTools(page).getByRole('button')).toHaveText(['']);
    await expect(pageTools(page).getByRole('button', { name: 'More actions' })).toBeVisible();
    await expect(sidePanelToggle(page)).toBeVisible();

    await tool(page, 'More actions').click();
    const items = morePanel(page).getByRole('button');
    await expect(items).toHaveText([
      'Auto assign',
      'Start…',
      'Stop all',
      'Reset',
      'Clear renditions',
    ]);
    await expect(morePanel(page).getByRole('separator')).toHaveCount(1);
    // The kit moves the focus to the first row itself.
    await expect(items.first()).toBeFocused();

    // Each row is as wide as the panel's content, and none touches the one above except to abut.
    const boxes = await items.evaluateAll((buttons) =>
      buttons.map((button) => {
        const { top, bottom, width } = button.getBoundingClientRect();
        return { top, bottom, width };
      }),
    );
    expect(new Set(boxes.map((box) => Math.round(box.width))).size).toBe(1);
    boxes
      .slice(1)
      .forEach((box, index) => expect(box.top).toBeGreaterThanOrEqual(boxes[index].bottom - 0.5));

    // Tab walks the rows in the order they read, each showing where the focus is; the disabled
    // row is passed over and reads as disabled.
    for (const index of [1, 2, 3]) {
      await page.keyboard.press('Tab');
      await expect(items.nth(index)).toBeFocused();
      expect(await items.nth(index).evaluate((button) => button.matches(':focus-visible'))).toBe(
        true,
      );
    }
    const colour = (index: number) =>
      items.nth(index).evaluate((button) => getComputedStyle(button).color);
    await expect(items.nth(4)).toBeDisabled();
    expect(await colour(4)).not.toBe(await colour(3));

    // A tooltip opens beside its row.
    await items.first().hover();
    await expect(page.getByRole('tooltip')).toHaveText(
      'Auto assign unique media files to all sources',
    );
  });

  test('Reset and Clear renditions ask first; Cancel and Escape change nothing', async ({
    page,
  }) => {
    const mocked = await withMockedSlots(page);
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);

    await tool(page, 'More actions').click();
    await expect(
      morePanel(page).getByRole('button', { name: 'Clear renditions (3 · 1.20 GB)' }),
    ).toBeVisible();

    await morePanel(page).getByRole('button', { name: 'Clear renditions' }).click();
    await expect(confirmDialog(page)).toContainText('Delete 3 cached rendition(s) (1.20 GB)?');
    await page.keyboard.press('Escape');
    await expect(confirmDialog(page)).toHaveCount(0);

    await morePanel(page).getByRole('button', { name: 'Reset' }).click();
    await expect(confirmDialog(page)).toContainText('Reset all sources?');
    await expect(confirmDialog(page)).toContainText(
      'Every slot goes back to unassigned. External streams are left running.',
    );
    await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
    expect(mocked.posts.get('reset')).toBeUndefined();

    await morePanel(page).getByRole('button', { name: 'Reset' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Reset' }).click();
    await expect(
      toast(page, 'Reset all source assignments. External stream(s) left running: src4.'),
    ).toBeVisible();
    // Every slot is unassigned now, and the side panel shows the first, as #170 did.
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('src1');
    await expect(morePanel(page)).toHaveCount(0);
    // No webcam was published from this browser, so none is named as released.
    expect(mocked.posts.get('reset')).toEqual([{ released_webcams: [] }]);
  });

  test('Stop all and Auto assign report the server message', async ({ page }) => {
    const mocked = await withMockedSlots(page);
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);

    await (await menuItem(page, 'Stop all')).click();
    await expect(morePanel(page)).toHaveCount(0);
    await expect(
      toast(page, 'Stopped 6 source(s). External stream(s) left running: src4.'),
    ).toBeVisible();
    await (await menuItem(page, 'Auto assign')).click();
    await expect(
      toast(
        page,
        'Assigned 2 source(s) with unique media file(s). Skipped external: src4. Skipped pulled: src5, src6, src7, src8.',
      ),
    ).toBeVisible();
    expect(mocked.posts.get('stop-all')).toEqual([{ released_webcams: [] }]);
    expect(mocked.posts.get('auto-assign-all')).toEqual([{ released_webcams: [] }]);
  });

  test('a failing slot poll keeps the last answer and says so', async ({ page }) => {
    const mocked = await withMockedSlots(page);
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);

    mocked.failSlots();
    await expect(
      page.getByText('Slot status could not be refreshed. Showing the last known state.'),
    ).toBeVisible();
    await expect(rows(page)).toHaveCount(48);
    expect(await cells(page, 'src1')).toEqual([
      'src1',
      'VID',
      'people/walk_720p30.mp4',
      'Live',
      '30 fps',
      'H.264',
    ]);
  });
});
