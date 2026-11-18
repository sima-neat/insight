import { expect, Page, Request, Route, test } from '@playwright/test';
import type {
  AutoAssignResult,
  MediaEntry,
  RenditionUsage,
  Slot,
  SlotAssignment,
  SlotStartResult,
  SlotStopResult,
} from '../src/app/api.generated';
import {
  fileSlot,
  publisher,
  pull,
  slot,
  slotList,
  webcamSlot,
} from '../src/app/sources/slots.testing';
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
 * unreachable, refused and connecting, then an idle file. The other 39 slots are unassigned.
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

/** What the server knows of a file once it is assigned: the codec probe's result and its rate. */
const PROBED = { codec: 'h264', native_fps: 30 };

/** The encode of src2's 15 fps rendition, which its start waits for. */
const ENCODE = 'encode-2';

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

interface Mocked {
  /**
   * What each action was sent, by action, in order: a slot's (`assign`, `clear`, `start`, `stop`,
   * `take-over`) as its number with its body, the bulk ones (`start-bulk`, `stop-all`, `reset`,
   * `auto-assign`) as their body, `{}` for none.
   */
  readonly calls: Map<string, unknown[]>;
  /** Makes `GET /api/slots` fail from now on. */
  failSlots(): void;
  /** Ends src2's rendition encode: its job is done, and the slot streams the rendition. */
  finishEncode(): void;
}

/** A request's JSON body, `{}` when it has none. */
const bodyOf = (request: Request): Record<string, unknown> =>
  request.postData() ? (request.postDataJSON() as Record<string, unknown>) : {};

/**
 * Insight's streaming API without a board: the slots above, three renditions, a small library, and
 * the bulk actions answering as the server would for them. The slot routes (assign, clear, start,
 * stop, take over) change the slots as the server would, so the page shows what it holds after
 * them; a start at another rate encodes its rendition as a job first. Every API the page calls is
 * answered here, so whatever serves the app cannot change what the tests see. `edit` changes the
 * slots before the page loads.
 */
async function withMockedSlots(page: Page, edit?: (slots: Slot[]) => void): Promise<Mocked> {
  const calls = new Map<string, unknown[]>();
  // Each test starts from the board above and changes its own copy.
  const slots = structuredClone(SLOTS);
  edit?.(slots);
  let failing = false;
  let encoded = false;
  const record = (action: string, body: unknown) =>
    calls.set(action, [...(calls.get(action) ?? []), body]);

  await page.route(
    (url) => url.pathname === '/api/slots',
    (route) =>
      failing
        ? route.fulfill({
            status: 500,
            json: { error: { code: 'internal_error', message: 'MediaMTX is not answering.' } },
          })
        : route.fulfill({ json: slotList(slots) }),
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
  // src2's encode: in progress, the stream ending without a final state so that the browser asks
  // again soon, until the test finishes it.
  await page.route(
    (url) => url.pathname === `/api/jobs/${ENCODE}/events`,
    (route) => {
      const running = jobOf(ENCODE, 'rendition', {
        progress: { phase: 'encode', detail: '00:10 / 00:25', percent: 40 },
      });
      return route.fulfill(
        encoded
          ? jobEvents([{ ...running, state: 'done', result: { rendition: '.renditions/x.mp4' } }])
          : jobEvents([running], 200),
      );
    },
  );

  // The answers say what the server would for the slots above: stop all and reset leave the
  // external publisher running, auto assign skips it and the pulls, and a bulk start only targets
  // file slots (src1, src2, src9).
  const bulk: Record<string, object> = {
    start: {
      started: [9],
      already_running: [1],
      skipped_external: [],
      errors: [
        {
          n: 2,
          code: 'renditions_failed',
          error: 'Encoding cars.mp4 at 15 fps failed: the disk is full.',
        },
      ],
    } satisfies SlotStartResult,
    stop: { stopped: [1, 3, 5, 6, 7, 8], skipped_external: [4] } satisfies SlotStopResult,
    reset: { stopped: [1, 3, 5, 6, 7, 8], skipped_external: [4] } satisfies SlotStopResult,
    'auto-assign': {
      assigned: 2,
      available: 2,
      skipped_external: [4],
      skipped_pulled: [5, 6, 7, 8],
    } satisfies AutoAssignResult,
  };
  const bulkActions: Record<string, string> = {
    start: 'start-bulk',
    stop: 'stop-all',
    reset: 'reset',
    'auto-assign': 'auto-assign',
  };
  for (const [path, answer] of Object.entries(bulk)) {
    await page.route(
      (url) => url.pathname === `/api/slots/${path}`,
      (route) => {
        record(bulkActions[path], bodyOf(route.request()));
        return route.fulfill({ json: answer });
      },
    );
  }

  // The routes of one slot: what each does to it, as the server would.
  const change = (target: Slot, action: string, body: Record<string, unknown>): Slot => {
    const n = target.n;
    switch (action) {
      case 'assign': {
        const assignment = body as unknown as SlotAssignment;
        if (assignment.kind === 'webcam') return webcamSlot(n);
        if (assignment.kind === 'pull') {
          const camera = new URL(assignment.url!);
          return slot(n, {
            kind: 'pull',
            run: true,
            state: 'live',
            codec: 'h264',
            pull: pull({ host: camera.host, path: camera.pathname }),
            publisher: PULLED(),
          });
        }
        // A slot that streamed a file goes on streaming the new one.
        const run = target.kind === 'file' && target.run;
        return fileSlot(n, assignment.file!, {
          ...PROBED,
          ...(assignment.fps ? { fps: assignment.fps } : {}),
          run,
          state: run ? 'live' : 'idle',
        });
      }
      case 'clear':
        return slot(n);
      case 'start':
        if (target.kind === 'pull') {
          return {
            ...target,
            run: true,
            state: 'live',
            codec: 'h264',
            pull: { ...target.pull!, status: 'live' },
            publisher: PULLED(),
          };
        }
        if (target.fps !== undefined && target.fps !== target.native_fps) {
          return { ...target, run: true, state: 'preparing', job: ENCODE };
        }
        return {
          ...target,
          run: true,
          state: 'live',
          active_file: target.file,
          publisher: publisher({ address: '127.0.0.1' }),
        };
      case 'stop':
        return {
          ...target,
          run: false,
          state: 'idle',
          job: undefined,
          active_file: undefined,
          publisher: undefined,
          ...(target.kind === 'pull'
            ? { codec: undefined, pull: { ...target.pull!, status: 'stopped' } }
            : {}),
        };
      default:
        // Take over: the publisher goes, and the slot is what it is assigned.
        return { ...slot(n), kind: target.kind, state: 'idle', publisher: undefined };
    }
  };
  await page.route(
    (url) => /^\/api\/slots\/\d+(\/(start|stop|take-over))?$/.test(url.pathname),
    (route: Route) => {
      const request = route.request();
      const [, n, , verb] = /^\/api\/slots\/(\d+)(\/(start|stop|take-over))?$/.exec(
        new URL(request.url()).pathname,
      )!;
      const action = verb ?? (request.method() === 'PUT' ? 'assign' : 'clear');
      const body = bodyOf(request);
      record(action, { n: Number(n), ...body });
      const index = Number(n) - 1;
      slots[index] = change(slots[index], action, body);
      return route.fulfill({ json: slots[index] });
    },
  );
  return {
    calls,
    failSlots: () => (failing = true),
    finishEncode: () => {
      encoded = true;
      slots[1] = {
        ...slots[1],
        state: 'live',
        job: undefined,
        active_file: '.renditions/x.mp4',
        publisher: publisher({ address: '127.0.0.1', fps: 15 }),
      };
    },
  };
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
const panelButton = (page: Page, name: string) =>
  panel(page).getByRole('button', { name, exact: true });
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

    // Live whatever the source: a live file, an external publisher and a pull that receives.
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
    await panelButton(page, 'Start').click();
    await expect(preview('src9')).toHaveAccessibleDescription('Live');
    await panelButton(page, 'Stop').click();
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
      await expect(panelButton(page, 'Stop')).toBeFocused();
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
      // Nothing to start before a source: Start says why.
      await expect(panelButton(page, 'Start')).toBeDisabled();

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
      expect(mocked.calls.get('assign')).toEqual([{ n: 10, kind: 'file', file: 'cars.mp4' }]);
      await expect(panel(page)).toContainText('File: cars.mp4 · 30 fps');
      expect(await cells(page, 'src10')).toEqual(
        shownAt(size, ['src10', 'VID', 'cars.mp4', 'Idle', '30 fps', 'H.264']),
      );

      await panelButton(page, 'Start').click();
      await expect(panelButton(page, 'Stop')).toBeVisible();
      await expect(panel(page)).toContainText('Live');
      expect(mocked.calls.get('start')).toEqual([{ n: 10 }]);
      expect((await cells(page, 'src10'))[3]).toBe('Live');
    });

    test(`a camera is pulled into a slot, stopped, started again and cleared at ${name}`, async ({
      page,
    }) => {
      const mocked = await withMockedSlots(page);
      await page.setViewportSize(size);
      await page.goto('/streaming');
      await expect(rows(page)).toHaveCount(48);

      await row(page, 'src11').click();
      await panel(page).getByRole('radio', { name: 'Stream URL' }).click();
      const pullButton = panelButton(page, 'Pull');
      // Only RTSP and RTSPS URLs can be pulled.
      await panel(page).getByLabel('Stream URL', { exact: true }).fill('http://10.0.0.9/cam');
      await expect(pullButton).toBeDisabled();
      await panel(page).getByLabel('Stream URL', { exact: true }).fill('rtsp://10.0.0.9:554/cam');
      await panel(page).getByLabel('Username').fill('operator');
      const password = panel(page).getByLabel('Password');
      await password.fill('s3cret');
      await expect(pullButton).toBeEnabled();
      await pullButton.click();

      await expect(toast(page, 'src11 is pulling from rtsp://10.0.0.9:554/cam.')).toBeVisible();
      expect(mocked.calls.get('assign')).toEqual([
        {
          n: 11,
          kind: 'pull',
          url: 'rtsp://10.0.0.9:554/cam',
          username: 'operator',
          password: 's3cret',
        },
      ]);
      expect(await cells(page, 'src11')).toEqual(
        shownAt(size, [
          'src11',
          'URL',
          '⇠ RTSP · 10.0.0.9:554 · 1280×720 · 25 fps',
          'Live',
          '25 fps',
          'H.264',
        ]),
      );
      // The form is done with: nothing typed into it, the password least of all, is kept. The
      // pull's main action, Stop, takes the focus.
      await expect(panel(page).getByLabel('Username')).toHaveValue('');
      await expect(password).toHaveValue('');
      await expect(panel(page)).toContainText('Camera: rtsp://10.0.0.9:554/cam');
      const stop = panelButton(page, 'Stop');
      await expect(stop).toBeFocused();

      // Stop keeps the camera; Start pulls it again.
      await stop.click();
      await expect(panelButton(page, 'Start')).toBeVisible();
      expect(mocked.calls.get('stop')).toEqual([{ n: 11 }]);
      expect(await cells(page, 'src11')).toEqual(
        shownAt(size, ['src11', 'URL', '⇠ RTSP · 10.0.0.9:554 · stopped', 'Idle', '', '-']),
      );
      await panelButton(page, 'Start').click();
      await expect(panelButton(page, 'Stop')).toBeVisible();
      expect(mocked.calls.get('start')).toEqual([{ n: 11 }]);
      expect((await cells(page, 'src11'))[3]).toBe('Live');

      // Clear takes the camera away, and the slot is empty.
      await panelButton(page, 'Clear').click();
      await expect
        .poll(() => cells(page, 'src11'))
        .toEqual(shownAt(size, ['src11', '', 'Not assigned', 'Idle', '', '-']));
      expect(mocked.calls.get('clear')).toEqual([{ n: 11 }]);
      await expect(
        panel(page).getByRole('radio', { name: 'Stream URL', checked: true }),
      ).toBeVisible();
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
      expect(mocked.calls.get('assign')).toEqual([{ n: 9, kind: 'webcam' }]);
      await expect.poll(async () => (await cells(page, 'src9'))[1]).toBe('CAM');

      await file.click();
      await expect(panel(page).getByText('File: Not assigned')).toBeVisible();
      expect(mocked.calls.get('clear')).toEqual([{ n: 9 }]);
      expect((await cells(page, 'src9'))[1]).toBe('');
    });

    test(`the source switch asks before it stops a live slot, and Cancel changes nothing at ${name}`, async ({
      page,
    }) => {
      const mocked = await withMockedSlots(page);
      await page.setViewportSize(size);
      await page.goto('/streaming');
      await expect(rows(page)).toHaveCount(48);

      // src1 is streaming a file.
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
      expect(mocked.calls.get('assign')).toBeUndefined();
      expect((await cells(page, 'src1'))[3]).toBe('Live');

      await panel(page).getByRole('radio', { name: 'Camera' }).click();
      await question.getByRole('button', { name: 'Stop and switch' }).click();
      // Making the slot a webcam stops its file on the server: one request.
      await expect.poll(async () => (await cells(page, 'src1'))[1]).toBe('CAM');
      expect(mocked.calls.get('assign')).toEqual([{ n: 1, kind: 'webcam' }]);
      expect(mocked.calls.get('stop')).toBeUndefined();
      expect(await cells(page, 'src1')).toEqual(
        shownAt(size, ['src1', 'CAM', 'Select a camera', 'Idle', '', '-']),
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
        'The publisher and all readers will be disconnected',
      );
      // Escape asks nothing of the server, and the focus returns to where it was.
      await page.keyboard.press('Escape');
      await expect(confirmDialog(page)).toHaveCount(0);
      expect(mocked.calls.get('take-over')).toBeUndefined();
      await expect(takeOver).toBeFocused();

      await takeOver.click();
      await confirmDialog(page).getByRole('button', { name: 'Disconnect' }).click();
      await expect(toast(page, 'Disconnected the external stream on src4.')).toBeVisible();
      expect(mocked.calls.get('take-over')).toEqual([{ n: 4 }]);
      expect(await cells(page, 'src4')).toEqual(
        shownAt(size, ['src4', '', 'Not assigned', 'Idle', '', '-']),
      );
      await expect(panelButton(page, 'Start')).toBeVisible();
    });
  }

  test('a start at another rate shows the rendition’s encode, and goes live once it is done', async ({
    page,
  }) => {
    const mocked = await withMockedSlots(page);
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);

    await row(page, 'src2').click();
    await expect(panel(page)).toContainText('(rendition will be created on start)');
    await panelButton(page, 'Start').click();
    expect(mocked.calls.get('start')).toEqual([{ n: 2 }]);

    // The server encodes first; the job's events say how far it has got.
    await expect(panel(page)).toContainText('Encoding rendition…');
    await expect(panel(page)).toContainText('00:10 / 00:25');
    await expect
      .poll(() => cells(page, 'src2'))
      .toEqual(['src2', 'VID', 'cars.mp4', 'Encoding', 'encoding 40%', 'H.265']);
    await expect(panelButton(page, 'Cancel encoding')).toBeVisible();

    mocked.finishEncode();
    await expect(panelButton(page, 'Stop')).toBeVisible();
    await expect.poll(async () => (await cells(page, 'src2'))[3]).toBe('Live');
    await expect(panel(page)).toContainText('streaming rendition .renditions/x.mp4');
    await expect(panel(page)).not.toContainText('Encoding rendition…');
  });

  test('Cancel encoding stops the slot, which ends its encode', async ({ page }) => {
    const mocked = await withMockedSlots(page);
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);

    await row(page, 'src2').click();
    await panelButton(page, 'Start').click();
    await panelButton(page, 'Cancel encoding').click();

    await expect(toast(page, 'Cancelled encoding for src2.')).toBeVisible();
    expect(mocked.calls.get('stop')).toEqual([{ n: 2 }]);
    await expect(panelButton(page, 'Start')).toBeVisible();
    expect(await cells(page, 'src2')).toEqual([
      'src2',
      'VID',
      'cars.mp4',
      'Idle',
      '15 fps · rendition',
      'H.265',
    ]);
  });

  test('a pull that lost its credentials in a restart asks for its URL again before it starts', async ({
    page,
  }) => {
    const restarted =
      'Insight keeps no camera credentials across a restart; enter the stream URL again.';
    const mocked = await withMockedSlots(page, (slots) => {
      slots[13] = slot(14, {
        kind: 'pull',
        error: restarted,
        pull: pull({ status: 'needs_credentials', error: restarted }),
      });
    });
    await page.goto('/streaming');
    await expect(rows(page)).toHaveCount(48);

    expect(await cells(page, 'src14')).toEqual([
      'src14',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · stream URL needed again',
      'Needs URL',
      '',
      '-',
    ]);
    await row(page, 'src14').click();
    await expect(panelButton(page, 'Start')).toBeDisabled();
    await expect(
      panel(page).getByRole('radio', { name: 'Stream URL', checked: true }),
    ).toBeVisible();
    await expect(panel(page)).toContainText('Camera: rtsp://10.0.0.7:554/stream1');
    await expect(panel(page).getByText(restarted).first()).toBeVisible();

    await panel(page).getByLabel('Stream URL', { exact: true }).fill('rtsp://10.0.0.7:554/stream1');
    await panel(page).getByLabel('Password').fill('s3cret');
    await panelButton(page, 'Pull').click();
    await expect(panelButton(page, 'Stop')).toBeVisible();
    expect(mocked.calls.get('assign')).toEqual([
      { n: 14, kind: 'pull', url: 'rtsp://10.0.0.7:554/stream1', username: '', password: 's3cret' },
    ]);
    expect((await cells(page, 'src14'))[3]).toBe('Live');
  });

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
    // A webcam names no codec until a browser publishes it.
    expect(await cells(page, 'src3')).toEqual(['src3', 'CAM', 'Select a camera', 'Idle', '', '-']);
    expect(await cells(page, 'src4')).toEqual([
      'src4',
      'EXT',
      '⇢ RTSP · 192.168.1.20 · 1280×720 · 30 fps',
      'External',
      '30 fps',
      'AV1',
    ]);
    expect(await cells(page, 'src5')).toEqual([
      'src5',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · 1920×1080 · 25 fps',
      'Live',
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

  test('In use shows assigned and external slots only', async ({ page }) => {
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

  test('Start… starts the chosen count and reports what the server did', async ({ page }) => {
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
    await expect(toast(page, 'Started 1 source(s), 1 already running, 1 failed.')).toBeVisible();
    await expect(toast(page, 'Failed: src2')).toBeVisible();
    expect(mocked.calls.get('start-bulk')).toEqual([{ count: 3 }]);

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
      (url) => url.pathname === '/api/renditions',
      (route) =>
        route.fulfill({ json: { count: 0, bytes: 0, in_use: 0 } satisfies RenditionUsage }),
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
    expect(mocked.calls.get('reset')).toBeUndefined();

    await morePanel(page).getByRole('button', { name: 'Reset' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Reset' }).click();
    await expect(
      toast(page, 'Reset all source assignments. External stream(s) left running: src4.'),
    ).toBeVisible();
    // Every slot is unassigned now, and the side panel shows the first, as #170 did.
    await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('src1');
    await expect(morePanel(page)).toHaveCount(0);
    expect(mocked.calls.get('reset')).toEqual([{}]);
  });

  test('Stop all and Auto assign report what the server did', async ({ page }) => {
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
    expect(mocked.calls.get('stop-all')).toEqual([{}]);
    expect(mocked.calls.get('auto-assign')).toEqual([{}]);
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
