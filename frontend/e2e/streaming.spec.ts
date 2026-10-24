import { expect, Page, Request, test } from '@playwright/test';
import { DESKTOP, LAPTOP, pageOverflow, TABLET, topBarSpill } from './layout';

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
SLOTS[8] = slot(9, { file: 'idle.mp4', codec: 'h264', transport: 'rtsp', native_fps: 30 });

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
  /** The bodies of the POSTs to `/api/mediasrc/<action>`, by action. */
  readonly posts: Map<string, unknown[]>;
  /** Makes `GET /api/mediasrc` fail from now on. */
  failSlots(): void;
}

/**
 * Insight's streaming API without a board: the slots above, three renditions, a small library,
 * and a bulk action answering with the server's message. Every API the page calls is answered
 * here, so whatever serves the app cannot change what the tests see.
 */
async function withMockedSlots(page: Page): Promise<Mocked> {
  const posts = new Map<string, unknown[]>();
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
        : route.fulfill({ json: SLOTS }),
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

    for (const viewport of [LAPTOP, DESKTOP, TABLET]) {
      await page.setViewportSize(viewport);
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
          .poll(() => topBarSpill(page, viewport === TABLET))
          .toEqual({ spilled: [], toolsOverflow: 0 });
        await tool(page, 'Side panel').click();
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

    for (const viewport of [LAPTOP, DESKTOP, TABLET]) {
      await page.setViewportSize(viewport);
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
      }
    }

    // The live preview connects and shows its first frame.
    await row(page, 'src1').click();
    await expect(panel(page).getByRole('img', { name: 'Live preview of src1' })).toBeVisible();
    await expect(panel(page)).not.toContainText('Connecting to src1');
  });

  test('Change… opens the picker on the slot’s file, from the keyboard, and Escape closes it', async ({
    page,
  }) => {
    await withMockedSlots(page);
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);

    await listbox(page).focus();
    await page.keyboard.press('ArrowDown');
    await panel(page).getByRole('button', { name: 'Change…' }).focus();
    await page.keyboard.press('Enter');
    const picker = page.getByRole('dialog', { name: 'Source for src1' });
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('Selected: people/walk_720p30.mp4');
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
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

    await listbox(page).focus();
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'src1')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('src1');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('src4');
    await expect(panel(page)).toContainText('External');

    await tool(page, 'Side panel').focus();
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

    await tool(page, 'Start…').click();
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

    // It opens again at the count chosen last.
    await tool(page, 'Start…').click();
    await expect(slider).toHaveAttribute('aria-valuenow', '3');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
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

    await tool(page, 'Stop all').click();
    await expect(
      toast(page, 'Stopped 6 source(s). External stream(s) left running: src4.'),
    ).toBeVisible();
    await tool(page, 'Auto assign').click();
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
