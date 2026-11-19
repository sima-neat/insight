import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, Locator, Page, test } from '@playwright/test';
import { LAPTOP, pageOverflow, sidePanelToggle, TABLET, topBarSpill, VIEWPORTS } from './layout';
import { answerTopBar, idleChannels, NO_VIDEO_YET, offeredChannel } from './top-bar';

// The rail's board block reads the board on every page.
test.beforeEach(({ page }) => answerTopBar(page));

const deployed = !!process.env['INSIGHT_BASE_URL'];

const SLOTS = 16;
/** What Insight's `/api/viewer-url` answers on an SDK whose port map allows 16 channels. */
const VIEWER_URL_ANSWER = {
  url: `https://127.0.0.1:9900/viewer?src=${[...Array(SLOTS).keys()].join('%2C')}&max_channels=${SLOTS}`,
  max_video_channels: SLOTS,
  channel_limit_source: 'sdk-port-map',
  sdk_channel_limited: true,
};

/**
 * The Viewer without video: every offer gets the server's answer while no stream has arrived (503
 * `no_video`), the channel list has no channel active, and 16 channels are allowed. Every API the
 * page calls is answered here, so whatever serves the app (the dev server, a deployed build) cannot
 * change what the tests see. Resolves to the channels offered, in order, so a test can watch the
 * retries.
 */
async function withoutVideo(page: Page): Promise<number[]> {
  const offers: number[] = [];
  await page.route(
    (url) => url.pathname === '/api/viewer-url',
    (route) => route.fulfill({ json: VIEWER_URL_ANSWER }),
  );
  await page.route(
    (url) => url.pathname === '/api/channels',
    (route) => route.fulfill({ json: idleChannels(SLOTS) }),
  );
  await page.route(
    (url) => offeredChannel(url) !== null,
    (route) => {
      offers.push(offeredChannel(new URL(route.request().url()))!);
      return route.fulfill(NO_VIDEO_YET);
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
/** A toolbar popover's panel, which lives in the overlay outside the toolbar while it is open. */
const popover = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });
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

/**
 * Measures with the page clock paused: Angular renders on timers, which are paused too, so each
 * look lets a little time pass for it first.
 */
async function settledLook<T>(page: Page, measure: () => Promise<T>): Promise<T> {
  await page.clock.runFor(100);
  return measure();
}

test.describe('the Viewer without video', () => {
  test('16 slots at 1366×768, 1920×1080 and 768×1024: every tile fully inside the grid, no page scroll', async ({
    page,
  }) => {
    await withoutVideo(page);
    await page.setViewportSize(LAPTOP);
    await page.goto('/viewer');

    // One page, resized between the sizes: the grid repacks itself each time.
    for (const { size } of VIEWPORTS) {
      await page.setViewportSize(size);
      // Until a choice is made with the slider, all channels fit on one page.
      await expect(tiles(page)).toHaveCount(SLOTS);
      await expect(tile(page, SLOTS - 1)).toBeVisible();
      await expect.poll(() => misplacedTiles(page)).toEqual([]);
      await expect
        .poll(() => pageOverflow(page))
        .toEqual([
          { horizontal: 0, vertical: 0 },
          { horizontal: 0, vertical: 0 },
        ]);
      // The toolbar fits beside the title on a laptop and a desktop; a tablet scrolls it.
      await expect
        .poll(() => topBarSpill(page, size === TABLET))
        .toEqual({
          spilled: [],
          toolsOverflow: 0,
        });
    }
  });

  test('the size slider changes tiles per page and the choice survives reload for the same count', async ({
    page,
  }) => {
    await withoutVideo(page);
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
    await withoutVideo(page);
    await page.goto('/viewer');
    // With bars, a tile names its channel and says what it waits for.
    await expect(tile(page, 0)).toContainText('0');
    await expect(tile(page, 0)).toContainText('Waiting for stream');

    await pageTools(page).getByRole('button', { name: 'View options' }).click();
    await popover(page, 'View options').getByRole('switch', { name: 'Bars' }).click();

    await expect(tiles(page)).toHaveCount(SLOTS);
    await expect(tiles(page)).toHaveText(Array(SLOTS).fill(''));
    await expect(tiles(page).getByRole('button')).toHaveCount(0);
  });

  test('inspector open/close repacks without overflow and keeps the selected tile on screen', async ({
    page,
  }) => {
    await withoutVideo(page);
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
    await pageTools(page).getByRole('button', { name: 'Go to channel' }).click();
    const channelField = popover(page, 'Go to channel').getByRole('textbox', { name: 'Channel' });
    await expect(channelField).toBeFocused();
    await channelField.fill('15');
    await channelField.press('Enter');
    await expect(popover(page, 'Go to channel')).toHaveCount(0);
    await tile(page, 15).click();
    await expect(tile(page, 15)).toHaveAttribute('aria-current', 'true');
    const columnsBefore = await columns(page);

    await sidePanelToggle(page).click();
    await expect(page.locator('app-viewer-inspector')).toBeVisible();
    // The narrower area takes fewer columns, and the page moves to keep channel 15 in view.
    await expect.poll(() => columns(page)).toBeLessThan(columnsBefore);
    await expect(tile(page, 15)).toBeVisible();
    await expect.poll(() => misplacedTiles(page)).toEqual([]);
    await expect
      .poll(() => pageOverflow(page))
      .toEqual([
        { horizontal: 0, vertical: 0 },
        { horizontal: 0, vertical: 0 },
      ]);

    await page.getByRole('button', { name: 'Close side panel' }).click();
    await expect(page.locator('app-viewer-inspector')).toHaveCount(0);
    await expect.poll(() => columns(page)).toBe(columnsBefore);
    await expect(tile(page, 15)).toBeVisible();
    await expect(tile(page, 15)).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => misplacedTiles(page)).toEqual([]);
  });

  test('a click into the empty space around the tiles deselects, as Escape does', async ({
    page,
  }) => {
    await withoutVideo(page);
    await page.setViewportSize(LAPTOP);
    await page.goto('/viewer');

    await tile(page, 3).click();
    await expect(tile(page, 3)).toHaveAttribute('aria-current', 'true');

    // The grid area's inset, which no tile covers.
    await page.locator('app-viewer-page .grid-area').click({ position: { x: 2, y: 2 } });
    await expect(tile(page, 3)).not.toHaveAttribute('aria-current', 'true');

    // The tile still selects, and a click in the inspector keeps the selection.
    await tile(page, 3).click();
    await sidePanelToggle(page).click();
    await page.locator('app-viewer-inspector').click({ position: { x: 4, y: 4 } });
    await expect(tile(page, 3)).toHaveAttribute('aria-current', 'true');
  });

  test('the inspector lists channel overrides, folded; bulk resets ask first and keep focus in the panel', async ({
    page,
  }) => {
    await withoutVideo(page);
    await page.setViewportSize(LAPTOP);
    await page.goto('/viewer');
    await page.evaluate(() => {
      const scope = (settings: object) => JSON.stringify({ version: 10, general: settings });
      localStorage.setItem('neat-insight:viewer:settings:channel:3', scope({ lineWidth: 6 }));
      localStorage.setItem(
        'neat-insight:viewer:settings:channel:7',
        scope({ lineWidth: 8, videoSyncBufferMs: 900 }),
      );
    });
    await page.reload();
    await sidePanelToggle(page).click();
    const inspector = page.locator('app-viewer-inspector');
    await inspector.getByRole('tab', { name: 'General' }).click();

    // Folded by default; a click shows the channels with their values.
    const note = inspector.getByRole('button', { name: 'Overridden on 2 channels' });
    await expect(note).toHaveAttribute('aria-expanded', 'false');
    await expect(inspector.getByText('Channel 3')).toHaveCount(0);
    await note.click();
    await expect(note).toHaveAttribute('aria-expanded', 'true');
    await expect(inspector.getByText('Channel 3')).toBeVisible();
    await expect(inspector.getByText('6 px')).toBeVisible();

    // The bulk reset asks, with Cancel focused; Escape changes nothing.
    const reset = inspector.getByRole('button', { name: /^Reset on 2 channels/ });
    await reset.click();
    const dialog = page.getByRole('alertdialog', { name: 'Reset Line width on 2 channels?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "They go back to the global value (3 px). This can't be undone.",
    );
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(reset).toBeFocused();
    await expect(note).toBeVisible();

    // Resetting the one setting leaves channel 7's sync buffer, so the footer stays.
    await reset.click();
    await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(note).toHaveCount(0);
    await expect(inspector.getByRole('slider', { name: 'Line width' })).toBeFocused();
    const footer = inspector.getByRole('button', { name: /^Reset all channels to global/ });
    await expect(footer).toBeVisible();

    await footer.click();
    const all = page.getByRole('alertdialog', { name: 'Reset all channels to global?' });
    await expect(all).toContainText(
      "1 setting on 1 channel goes back to the global values. Regions of interest are kept. This can't be undone.",
    );
    await all.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(footer).toHaveCount(0);
    await expect(inspector.getByRole('heading', { name: 'All channels' })).toBeFocused();
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.includes(':settings:channel:')),
      ),
    ).toEqual([]);
  });

  test('kiosk: grid repacks to the full screen; the toolbar shows on pointer movement', async ({
    page,
  }) => {
    // The toolbar hides after 2.5 s without pointer activity. The clock is paused from before the
    // page loads, so that timer advances only when the test runs it (as in shell.spec.ts).
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1000);
    const settled = <T>(measure: () => Promise<T>) => settledLook(page, measure);
    await withoutVideo(page);
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

  test('kiosk: View options opened from the floating toolbar stays open while the pointer rests on it', async ({
    page,
  }) => {
    // As in the test above, the clock is paused so that the idle timer runs only when told to.
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1000);
    const settled = <T>(measure: () => Promise<T>) => settledLook(page, measure);
    await withoutVideo(page);
    await page.setViewportSize(LAPTOP);
    // `?kiosk` turns kiosk mode on without asking for fullscreen, which Escape would leave.
    await page.goto('/viewer?kiosk');
    await expect.poll(() => settled(() => tiles(page).count())).toBe(SLOTS);
    // The bar shows on pointer movement, whether or not it has already gone idle.
    await page.mouse.move(400, 300);
    const tools = pageTools(page);
    await expect.poll(() => settled(() => renderedOpacity(tools))).toBe(1);

    await tools.getByRole('button', { name: 'View options' }).click();
    const panel = popover(page, 'View options');
    await expect.poll(() => settled(() => panel.isVisible())).toBe(true);

    // The pointer rests on the panel, outside the bar, for longer than the bar's idle time.
    const box = (await panel.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.clock.runFor(3000);
    await expect.poll(() => settled(() => panel.isVisible())).toBe(true);
    await expect.poll(() => settled(() => renderedOpacity(tools))).toBe(1);

    // Closed, the bar may hide again. (By the trigger rather than Escape: a key press leaves focus
    // visible on the trigger, which keeps the bar shown for keyboard users.)
    await tools.getByRole('button', { name: 'View options' }).click();
    await expect.poll(() => settled(() => panel.count())).toBe(0);
    await page.clock.runFor(3000);
    await expect.poll(() => settled(() => renderedOpacity(tools))).toBe(0);
  });

  test('tiles show "Waiting for stream" while the offer returns 503', async ({ page }) => {
    const offers = await withoutVideo(page);
    await page.goto('/viewer');

    await expect(tiles(page)).toHaveCount(SLOTS);
    await expect(tiles(page)).toContainText(Array(SLOTS).fill('Waiting for stream'));
    // The server has no stream yet, which may change any moment: each channel asks again every 2 s.
    await expect
      .poll(() => offers.filter((channel) => channel === 0).length, { timeout: 5000 })
      .toBeGreaterThanOrEqual(2);
  });
});

/** `scripts/test-feed.sh`, which runs the test feed in the SDK container. */
const FEED = join(__dirname, '..', '..', 'scripts', 'test-feed.sh');

/** Stops the feed on channel 0; returns once it is gone. */
function stopFeed(): void {
  execFileSync(FEED, ['stop', '0'], { stdio: 'inherit' });
}

/**
 * Starts the feed on channel 0 again and leaves it running after the run, as the run found it.
 * Resolves once the script runs, and rejects if it cannot be started. Its output (only its own, no
 * page content) goes to `log`; the run's teardown deletes the file with the rest of the output.
 */
async function startFeed(log: string): Promise<void> {
  const output = openSync(log, 'a');
  try {
    const feed = spawn(FEED, ['0'], { detached: true, stdio: ['ignore', output, output] });
    await once(feed, 'spawn');
    // Later errors (signalling the child) must not take the test runner down with them.
    feed.on('error', (error) => console.error(`test-feed: ${error.message}`));
    feed.unref();
  } finally {
    // The child has its own copy of the descriptor.
    closeSync(output);
  }
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

/** The status line of the test feed's stream: codec, size and a frame rate near its 15 fps. */
const FEED_STATUS = /H\.264 · 640×480 · 1[45]\.\d fps/;

/** The kit tile inside a channel's tile, whose `data-state` says whether it plays. */
const videoTile = (channelTile: Locator) => channelTile.locator('neat-video-tile');

test.describe('a deployed build with the test feed on channel 0', () => {
  test.skip(!deployed, 'needs INSIGHT_BASE_URL and scripts/test-feed.sh 0 running');
  // In order, in one worker: one test stops the feed the others watch.
  test.describe.configure({ mode: 'default' });

  test('channel 0 plays: the bar reads "H.264 · 640×480 · 15", and detection boxes are drawn', async ({
    page,
  }) => {
    await page.goto('/viewer?src=0');
    const channel = tile(page, 0);

    await expect(channel).toContainText(FEED_STATUS, { timeout: 15_000 });
    await expect(videoTile(channel)).toHaveAttribute('data-state', 'playing');
    await expect.poll(() => overlayInk(channel), { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test('detections from the feed are matched to their frames while the page watches', async ({
    page,
    request,
  }) => {
    // Channel 0 as Insight's server counts it (`/api/ingest/stats`): the browsers watching, and
    // the feed's messages it sent on to them (a running total). The feed's messages are all timed,
    // and a timed message is sent on only once it is matched to the frame its timestamp names.
    const channel0 = async () => {
      const response = await request.get('/api/ingest/stats?all=1');
      const answer = (await response.json()) as {
        channels: {
          channel: number;
          webrtc: { peer_count: number };
          metadata: { messages_forwarded: number };
        }[];
      };
      const entry = answer.channels.find((candidate) => candidate.channel === 0);
      return {
        viewers: entry?.webrtc.peer_count ?? 0,
        matched: entry?.metadata.messages_forwarded ?? 0,
      };
    };
    // Earlier tests (or another Viewer) may have watched channel 0: only what follows counts.
    const before = (await channel0()).matched;

    await page.goto('/viewer?src=0');
    await expect(videoTile(tile(page, 0))).toHaveAttribute('data-state', 'playing', {
      timeout: 15_000,
    });

    // The server matches the feed's timestamps only while a browser watches the channel.
    await expect
      .poll(
        async () => {
          const { viewers, matched } = await channel0();
          return viewers >= 1 && matched > before;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  test('a region drawn on channel 0 in the ROI tab is listed, survives reload and can be deleted', async ({
    page,
  }) => {
    await page.goto('/viewer?src=0');
    await expect(videoTile(tile(page, 0))).toHaveAttribute('data-state', 'playing', {
      timeout: 15_000,
    });
    await tile(page, 0).click();
    await sidePanelToggle(page).click();
    const inspector = page.locator('app-viewer-inspector');
    await inspector.getByRole('tab', { name: 'ROI' }).click();
    await expect(inspector.locator('neat-video-tile')).toHaveAttribute('data-state', 'playing', {
      timeout: 15_000,
    });
    await inspector.getByRole('radio', { name: 'Inclusion' }).click();

    // Three corners of a triangle on the preview's image, then the first again to close it.
    const image = (await inspector.locator('neat-roi-editor svg').boundingBox())!;
    const at = (x: number, y: number) =>
      [image.x + x * image.width, image.y + y * image.height] as const;
    for (const [x, y] of [at(0.2, 0.2), at(0.8, 0.2), at(0.5, 0.8), at(0.2, 0.2)]) {
      await page.mouse.click(x, y);
    }

    const row = inspector.locator('.regions li', { hasText: 'Inclusion 1' });
    await expect(row).toBeVisible();

    await page.reload();
    await tile(page, 0).click();
    await inspector.getByRole('tab', { name: 'ROI' }).click();
    await expect(row).toBeVisible();

    await inspector.getByRole('button', { name: 'Delete Inclusion 1' }).click();
    await expect(row).toHaveCount(0);
    await expect(inspector.getByText('No regions.')).toBeVisible();

    // Channel 0 now has a list of its own (an empty one), and can give it back like any channel.
    const useGlobal = inspector.getByRole('button', {
      name: 'Use the global regions on channel 0',
    });
    await expect(useGlobal).toBeVisible();
    await useGlobal.click();
    await expect(useGlobal).toHaveCount(0);
  });

  test('stopping the feed turns the tile "stopped" within 3 s; restarting plays again without reload', async ({
    page,
  }, testInfo) => {
    await page.goto('/viewer?src=0');
    const kitTile = videoTile(tile(page, 0));
    await expect(kitTile).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });

    const log = testInfo.outputPath('test-feed.log');
    // The feed comes back whatever happens here: the next run needs it as this one found it.
    try {
      stopFeed();
      await expect(kitTile).toHaveAttribute('data-state', 'stopped', { timeout: 3000 });
    } finally {
      await startFeed(log);
    }
    try {
      await expect(kitTile).toHaveAttribute('data-state', 'playing', { timeout: 20_000 });
    } catch (error) {
      // Why the restarted feed did not play, if the script said: it runs detached.
      console.error(`test-feed.sh output:\n${readFileSync(log, 'utf8')}`);
      throw error;
    }
    await expect(tile(page, 0)).toContainText(FEED_STATUS, { timeout: 10_000 });
  });
});
