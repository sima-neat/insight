import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { expect, Locator, Page, test } from '@playwright/test';

const deployed = !!process.env['INSIGHT_BASE_URL'];

const SLOTS = 16;
/** What Flask's `/api/viewer-url` answers on an SDK whose port map allows 16 channels. */
const VIEWER_URL_ANSWER = {
  url: `https://127.0.0.1:9900/viewer?src=${[...Array(SLOTS).keys()].join('%2C')}&max_channels=${SLOTS}`,
  max_video_channels: SLOTS,
  channel_limit_source: 'sdk-port-map',
  sdk_channel_limited: true,
};

const LAPTOP = { width: 1366, height: 768 };
const DESKTOP = { width: 1920, height: 1080 };
const TABLET = { width: 768, height: 1024 };

/**
 * The Viewer without vf: every offer gets vf's answer while no stream has arrived (503), and Flask
 * allows 16 channels. Resolves to the channels offered, in order, so a test can watch the retries.
 */
async function withoutVf(page: Page): Promise<number[]> {
  const offers: number[] = [];
  await page.route(
    (url) => url.pathname === '/api/viewer-url',
    (route) => route.fulfill({ json: VIEWER_URL_ANSWER }),
  );
  await page.route(
    (url) => url.pathname === '/api/vf/offer',
    (route) => {
      offers.push(Number(new URL(route.request().url()).searchParams.get('channel')));
      return route.fulfill({
        status: 503,
        contentType: 'text/plain',
        body: 'Video codec not available',
      });
    },
  );
  return offers;
}

const grid = (page: Page) => page.locator('app-viewer-page neat-tile-grid');
const tiles = (page: Page) => page.locator('app-viewer-tile');
const tile = (page: Page, channel: number) =>
  page.getByRole('group', { name: `Channel ${channel}`, exact: true });
const pageTools = (page: Page) => page.getByRole('group', { name: 'Page tools' });
const pageField = (page: Page) => page.getByRole('textbox', { name: 'Page' });
/** The page field's label, which ends in "of <page count>". */
const pageLabel = (page: Page) => page.locator('label').filter({ has: pageField(page) });
const sizeSlider = (page: Page) => page.getByRole('slider', { name: 'Tile size' });

/**
 * The tiles that reach outside the grid's box or are smaller than the kit's 64 px minimum, by
 * their accessible names: an empty list is a layout that holds.
 */
function misplacedTiles(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const area = document.querySelector('app-viewer-page neat-tile-grid')!.getBoundingClientRect();
    return [...document.querySelectorAll('app-viewer-tile')]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.width < 64 ||
          box.left < area.left - 0.5 ||
          box.right > area.right + 0.5 ||
          box.top < area.top - 0.5 ||
          box.bottom > area.bottom + 0.5
        );
      })
      .map((element) => element.getAttribute('aria-label') ?? element.outerHTML.slice(0, 60));
  });
}

/** How far the document and the shell's content area reach past their boxes. */
function pageOverflow(page: Page) {
  return page.evaluate(() =>
    [document.documentElement, document.querySelector('main')!].map((element) => ({
      horizontal: Math.max(0, element.scrollWidth - element.clientWidth),
      vertical: Math.max(0, element.scrollHeight - element.clientHeight),
    })),
  );
}

/**
 * The top bar's items that spill out of it, and how far the page tools overflow their region. With
 * `toolbarMayScroll` (Ruling R14: tablets) the tools may overflow and scroll sideways: whatever is
 * inside their region counts as clipped by it, so only the region itself has to stay in the bar.
 */
function topBarSpill(page: Page, toolbarMayScroll: boolean) {
  return page.evaluate((mayScroll) => {
    const bar = document.querySelector('header')!.getBoundingClientRect();
    const tools = document.querySelector('header [role="group"][aria-label="Page tools"]')!;
    const spilled = [...document.querySelectorAll('header *:not(svg *)')]
      .filter((element) => {
        if (mayScroll && tools.contains(element) && element !== tools) return false;
        const box = element.getBoundingClientRect();
        return (
          box.width > 0 &&
          (box.left < bar.left - 0.5 ||
            box.right > bar.right + 0.5 ||
            box.top < bar.top - 0.5 ||
            box.bottom > bar.bottom + 0.5)
        );
      })
      .map((element) => element.outerHTML.slice(0, 80));
    return { spilled, toolsOverflow: mayScroll ? 0 : tools.scrollWidth - tools.clientWidth };
  }, toolbarMayScroll);
}

/** The number of tile columns on screen. */
function columns(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Set(
        [...document.querySelectorAll('app-viewer-tile')].map((element) =>
          Math.round(element.getBoundingClientRect().left),
        ),
      ).size,
  );
}

/** The opacity an element is drawn with, its own times its ancestors' (as in shell.spec.ts). */
const renderedOpacity = (locator: Locator) =>
  locator.evaluate((element) => {
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    return opacity;
  });

test.describe('the Viewer without vf', () => {
  test('16 slots at 1366×768, 1920×1080 and 768×1024: every tile fully inside the grid, no page scroll', async ({
    page,
  }) => {
    await withoutVf(page);
    await page.setViewportSize(LAPTOP);
    await page.goto('/viewer');

    // One page, resized between the sizes: the grid repacks itself each time.
    for (const viewport of [LAPTOP, DESKTOP, TABLET]) {
      await page.setViewportSize(viewport);
      // Until a choice is made with the slider, all channels fit on one page.
      await expect(tiles(page)).toHaveCount(SLOTS);
      await expect(tile(page, SLOTS - 1)).toBeVisible();
      await expect.poll(() => misplacedTiles(page)).toEqual([]);
      expect(await pageOverflow(page)).toEqual([
        { horizontal: 0, vertical: 0 },
        { horizontal: 0, vertical: 0 },
      ]);
      // R14: the toolbar fits beside the title on a laptop and a desktop; a tablet scrolls it.
      expect(await topBarSpill(page, viewport === TABLET)).toEqual({
        spilled: [],
        toolsOverflow: 0,
      });
    }
  });

  test('the size slider changes tiles per page and the choice survives reload for the same count', async ({
    page,
  }) => {
    await withoutVf(page);
    await page.setViewportSize(LAPTOP);
    await page.goto('/viewer');
    await expect(tiles(page)).toHaveCount(SLOTS);
    await expect(pageLabel(page)).toContainText('of 1');

    // The slider's far end is one tile filling the area.
    await sizeSlider(page).focus();
    await page.keyboard.press('End');
    await expect(tiles(page)).toHaveCount(1);
    await expect(pageLabel(page)).toContainText(`of ${SLOTS}`);
    const chosen = await sizeSlider(page).getAttribute('aria-valuenow');

    await page.reload();
    await expect(tiles(page)).toHaveCount(1);
    await expect(sizeSlider(page)).toHaveAttribute('aria-valuenow', chosen!);

    // The choice belongs to 16 displayed channels: four still fit on one page.
    await page.goto('/viewer?src=0,1,2,3');
    await expect(tiles(page)).toHaveCount(4);
    await expect(pageLabel(page)).toContainText('of 1');

    await page.goto('/viewer');
    await expect(tiles(page)).toHaveCount(1);
  });

  test('bars off: no label, status or chip in any tile', async ({ page }) => {
    await withoutVf(page);
    await page.goto('/viewer');
    // With bars, a tile names its channel and says what it waits for.
    await expect(tile(page, 0)).toContainText('0');
    await expect(tile(page, 0)).toContainText('Waiting for stream');

    await pageTools(page).getByRole('switch', { name: 'Bars' }).click();

    await expect(tiles(page)).toHaveCount(SLOTS);
    await expect(tiles(page)).toHaveText(Array(SLOTS).fill(''));
    await expect(tiles(page).getByRole('button')).toHaveCount(0);
  });

  test('inspector open/close repacks without overflow and keeps the selected tile on screen', async ({
    page,
  }) => {
    await withoutVf(page);
    await page.setViewportSize(LAPTOP);
    await page.goto('/viewer');
    // A size chosen earlier for 16 channels, 400 px: three columns of three, on two pages.
    await page.evaluate(() =>
      localStorage.setItem(
        'neat-insight:viewer:layout',
        JSON.stringify({ tileWidths: { '16': 400 } }),
      ),
    );
    await page.reload();
    const channelField = pageTools(page).getByRole('textbox', { name: 'Go to channel' });
    await channelField.fill('15');
    await channelField.press('Enter');
    await tile(page, 15).click();
    await expect(tile(page, 15)).toHaveAttribute('aria-current', 'true');
    const columnsBefore = await columns(page);

    await pageTools(page).getByRole('button', { name: 'Inspector' }).click();
    await expect(page.locator('app-viewer-inspector')).toBeVisible();
    // The narrower area takes fewer columns, and the page moves to keep channel 15 in view.
    await expect.poll(() => columns(page)).toBeLessThan(columnsBefore);
    await expect(tile(page, 15)).toBeVisible();
    await expect.poll(() => misplacedTiles(page)).toEqual([]);
    expect(await pageOverflow(page)).toEqual([
      { horizontal: 0, vertical: 0 },
      { horizontal: 0, vertical: 0 },
    ]);

    await page.getByRole('button', { name: 'Close inspector' }).click();
    await expect(page.locator('app-viewer-inspector')).toHaveCount(0);
    await expect.poll(() => columns(page)).toBe(columnsBefore);
    await expect(tile(page, 15)).toBeVisible();
    await expect(tile(page, 15)).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => misplacedTiles(page)).toEqual([]);
  });

  test('kiosk: grid repacks to the full screen; the toolbar shows on pointer movement', async ({
    page,
  }) => {
    // The toolbar hides after 2.5 s without pointer activity. The clock is paused from before the
    // page loads, so that timer advances only when the test runs it (as in shell.spec.ts).
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1000);
    // Angular renders on timers, which are paused too: each look lets a little time pass for it.
    const settled = async <T>(measure: () => Promise<T>) => {
      await page.clock.runFor(100);
      return measure();
    };
    await withoutVf(page);
    await page.setViewportSize(LAPTOP);
    await page.goto('/viewer');
    await expect.poll(() => settled(() => tiles(page).count())).toBe(SLOTS);
    await expect(tile(page, 0)).toBeVisible();
    const tileBefore = (await tile(page, 0).boundingBox())!;

    await page.getByRole('button', { name: 'Kiosk mode' }).click();

    // The grid is inset by one tile gap, 8 px, from the screen's edges.
    await expect
      .poll(() => settled(() => grid(page).boundingBox()))
      .toEqual({ x: 8, y: 8, width: LAPTOP.width - 16, height: LAPTOP.height - 16 });
    await expect.poll(() => settled(() => misplacedTiles(page))).toEqual([]);
    const tileAfter = (await tile(page, 0).boundingBox())!;
    expect(tileAfter.width).toBeGreaterThan(tileBefore.width);
    await expect(tiles(page)).toHaveCount(SLOTS);

    const tools = pageTools(page);
    await expect.poll(() => renderedOpacity(tools)).toBe(1);
    await page.clock.runFor(3000);
    await expect.poll(() => renderedOpacity(tools)).toBe(0);
    await page.mouse.move(400, 300);
    await expect.poll(() => settled(() => renderedOpacity(tools))).toBe(1);
  });

  test('tiles show "Waiting for stream" while the offer returns 503', async ({ page }) => {
    const offers = await withoutVf(page);
    await page.goto('/viewer');

    await expect(tiles(page)).toHaveCount(SLOTS);
    await expect(tiles(page)).toContainText(Array(SLOTS).fill('Waiting for stream'));
    // vf has no stream yet, which may change any moment: each channel asks again every 2 s.
    await expect
      .poll(() => offers.filter((channel) => channel === 0).length, { timeout: 5000 })
      .toBeGreaterThanOrEqual(2);
  });
});

/** `scripts/vf-test-feed.sh`, which runs the test feed in the SDK container. */
const FEED = join(__dirname, '..', '..', 'scripts', 'vf-test-feed.sh');

/** Stops the feed on channel 0; returns once it is gone. */
function stopFeed(): void {
  execFileSync(FEED, ['stop', '0'], { stdio: 'inherit' });
}

/** Starts the feed on channel 0 again and leaves it running after the run, as the run found it. */
function startFeed(): void {
  spawn(FEED, ['0'], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * How many pixels of the tile's overlay canvas are drawn on. The canvas holds only what the kit
 * draws over the video (boxes and their captions, never the video itself), and only the count
 * leaves the page: this is no capture of the UI.
 */
const overlayInk = (channelTile: Locator) =>
  channelTile.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
    const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    let inked = 0;
    for (let alpha = 3; alpha < data.length; alpha += 4) if (data[alpha] > 0) inked++;
    return inked;
  });

/** The kit tile inside a channel's tile, whose `data-state` says whether it plays. */
const videoTile = (channelTile: Locator) => channelTile.locator('neat-video-tile');

test.describe('a deployed build with the test feed on channel 0', () => {
  test.skip(!deployed, 'needs INSIGHT_BASE_URL and scripts/vf-test-feed.sh 0 running');
  // In order, in one worker: one test stops the feed the others watch.
  test.describe.configure({ mode: 'default' });

  test('channel 0 plays: the bar reads "H.264 · 640×480 · 15", and detection boxes are drawn', async ({
    page,
  }) => {
    await page.goto('/viewer?src=0');
    const channel = tile(page, 0);

    await expect(channel).toContainText('H.264 · 640×480 · 15', { timeout: 15_000 });
    await expect(videoTile(channel)).toHaveAttribute('data-state', 'playing');
    await expect.poll(() => overlayInk(channel), { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test('detections from the feed reach the browser matched to their frames', async ({
    page,
    request,
  }) => {
    await page.goto('/viewer?src=0');
    await expect(videoTile(tile(page, 0))).toHaveAttribute('data-state', 'playing', {
      timeout: 15_000,
    });

    // The browser reports its frame matches to vf every second (Inv §2c), and vf matches the feed's
    // timestamps only while a viewer is bound to the channel.
    const timestampMatches = async () => {
      const response = await request.get('/api/egress/stats');
      const stats = (await response.json()) as {
        channels: {
          channel: number;
          peers: { browser?: { synchronization?: { timestamp_matches?: number } } }[];
        }[];
      };
      const peers = stats.channels.find((entry) => entry.channel === 0)?.peers ?? [];
      return Math.max(
        0,
        ...peers.map((peer) => peer.browser?.synchronization?.timestamp_matches ?? 0),
      );
    };
    await expect.poll(timestampMatches, { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test('stopping the feed turns the tile "stopped" within 3 s; restarting plays again without reload', async ({
    page,
  }) => {
    await page.goto('/viewer?src=0');
    const kitTile = videoTile(tile(page, 0));
    await expect(kitTile).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });

    stopFeed();
    try {
      await expect(kitTile).toHaveAttribute('data-state', 'stopped', { timeout: 3000 });
    } finally {
      startFeed();
    }
    await expect(kitTile).toHaveAttribute('data-state', 'playing', { timeout: 20_000 });
    await expect(tile(page, 0)).toContainText('H.264 · 640×480 · 15', { timeout: 10_000 });
  });
});
