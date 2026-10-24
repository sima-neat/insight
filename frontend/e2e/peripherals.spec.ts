import { expect, Page, test } from '@playwright/test';
import { pageOverflow, TABLET, topBarSpill, VIEWPORTS } from './layout';
import { BOARD_UNREACHABLE, C270, FakePeripheralsBackend, IMX477, YETI } from './peripherals-mocks';
import { answerTopBar } from './top-bar';

// The top bar's pill reads the board on every page; the backend below answers it for these tests.
test.beforeEach(({ page }) => answerTopBar(page));

const PREVIEW_URL = '/api/peripherals/cameras/preview';
const REFRESH_URL = '/api/peripherals/refresh';
const MIC_TEST_URL = '/api/peripherals/microphones/test';

const devices = (page: Page) => page.getByRole('listbox', { name: 'Devices' });
const device = (page: Page, name: string) =>
  devices(page).getByRole('option', { name: new RegExp(`^${escape(name)} `) });
const panel = (page: Page) => page.getByRole('region', { name: 'Selected device' });
const panelTitle = (page: Page) => panel(page).getByRole('heading', { level: 2 });
const tool = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Page tools' }).getByRole('button', { name });
const rail = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });
const toast = (page: Page, text: string) =>
  page.locator('[data-slot="toast"]').filter({ hasText: text });

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Picks `option` in the side panel's select labelled `label`. */
async function choose(page: Page, label: string, option: string): Promise<void> {
  await panel(page).getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/**
 * Counts the plays and the ends of every `<audio>` in the page. Media events do not bubble, so
 * they are caught on the way down.
 */
async function countPlayback(
  page: Page,
): Promise<() => Promise<{ played: number; ended: number }>> {
  await page.addInitScript(() => {
    const counts = { played: 0, ended: 0 };
    (window as unknown as { playback: typeof counts }).playback = counts;
    document.addEventListener('playing', () => counts.played++, true);
    document.addEventListener('ended', () => counts.ended++, true);
  });
  return () =>
    page.evaluate(() => ({
      ...(window as unknown as { playback: { played: number; ended: number } }).playback,
    }));
}

for (const { name, size } of VIEWPORTS) {
  test(`the devices are grouped by kind, and the camera preview restarts on a new mode and stops while the page is away at ${name}`, async ({
    page,
  }) => {
    const backend = new FakePeripheralsBackend();
    await backend.install(page);
    await page.setViewportSize(size);
    await page.goto('/peripherals');

    // The board's first scan runs by itself; then the list is grouped, with a muted heading for
    // the kind that has no devices.
    await expect(
      toast(page, 'Scan complete: 2 cameras, 1 microphone on sima@192.168.100.200.'),
    ).toBeVisible();
    await expect(devices(page).getByRole('group', { name: 'Cameras · 2' })).toBeVisible();
    await expect(devices(page).getByRole('group', { name: 'Microphones · 1' })).toBeVisible();
    await expect(devices(page).getByRole('group', { name: 'LiDAR · none found' })).toBeVisible();
    // Each row: name, connection and state chip. Beside the side panel on a tablet the list is
    // too narrow for the connection, which the panel's Details name too.
    const connection = (text: string) => (size === TABLET ? '' : `${text}\\s*`);
    await expect(
      devices(page).getByRole('group', { name: 'Cameras · 2' }).getByRole('option'),
    ).toHaveText([
      new RegExp(`imx477@1a\\s*${connection('MIPI CSI')}Available$`),
      new RegExp(`^HD Webcam C270\\s*${connection('USB 2\\.0')}Unsupported$`),
    ]);
    await expect(device(page, YETI.name)).toContainText('Available');
    await expect(tool(page, 'Refresh')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Page tools' })).toContainText('Scanned just now');

    // The first camera is selected; its preview starts in its default mode.
    await expect(panelTitle(page)).toHaveText(IMX477.name);
    await panel(page).getByRole('button', { name: 'Start preview' }).click();
    await expect(
      panel(page).getByRole('img', { name: `Live preview of ${IMX477.name}` }),
    ).toBeVisible();
    await expect(panel(page)).toContainText('Live preview · 1920×1080 · NV12');
    await expect(device(page, IMX477.name)).toContainText('Previewing');
    expect(backend.posted(PREVIEW_URL)).toEqual([
      { id: IMX477.id, format: 'NV12', width: 1920, height: 1080, fps: 30 },
    ]);

    // Another resolution restarts the preview on it: a stop, then a start.
    await choose(page, 'Resolution', '1280×720');
    await expect(panel(page)).toContainText('Live preview · 1280×720 · NV12');
    expect(backend.postedPaths().slice(-2)).toEqual([`${PREVIEW_URL}/p1/stop`, PREVIEW_URL]);
    expect(backend.posted(PREVIEW_URL).at(-1)).toEqual({
      id: IMX477.id,
      format: 'NV12',
      width: 1280,
      height: 720,
      fps: 60,
    });

    // Leaving the page stops the preview…
    await rail(page, 'Streaming').click();
    await expect(page).toHaveTitle('Neat Insight · Streaming');
    await expect.poll(() => backend.postedPaths().at(-1)).toBe(`${PREVIEW_URL}/p2/stop`);

    // …and coming back starts it again, in the mode it had. The board is not scanned again.
    const leftAt = backend.postedPaths().length;
    await rail(page, 'Peripherals').click();
    await expect(panel(page)).toContainText('Live preview · 1280×720 · NV12');
    expect(backend.posted(PREVIEW_URL).at(-1)).toEqual({
      id: IMX477.id,
      format: 'NV12',
      width: 1280,
      height: 720,
      fps: 60,
    });

    // Exactly once (Review Focus 2): leaving again ends the visit with its stop, and between the
    // two stops the page asked for one start and nothing else.
    await rail(page, 'Streaming').click();
    await expect.poll(() => backend.postedPaths().at(-1)).toBe(`${PREVIEW_URL}/p3/stop`);
    expect(backend.postedPaths().slice(leftAt)).toEqual([PREVIEW_URL, `${PREVIEW_URL}/p3/stop`]);
    expect(backend.posted(REFRESH_URL)).toHaveLength(1);
  });

  test(`a preview whose stream another tab holds shows as running there, with Stop at ${name}`, async ({
    page,
  }) => {
    const backend = new FakePeripheralsBackend();
    backend.streamTaken = true;
    await backend.install(page);
    await page.setViewportSize(size);
    await page.goto('/peripherals');
    await device(page, C270.name).click();
    await expect(panelTitle(page)).toHaveText(C270.name);

    await panel(page).getByRole('button', { name: 'Start preview' }).click();
    await expect(panel(page)).toContainText('This preview is showing in another tab or window.');
    await expect(panel(page).getByRole('img')).toHaveCount(0);

    // Stop is this tab's too: it stops the preview the other tab shows.
    await panel(page).getByRole('button', { name: 'Stop preview' }).click();
    await expect(panel(page).getByRole('button', { name: 'Start preview' })).toBeVisible();
    expect(backend.postedPaths().at(-1)).toBe(`${PREVIEW_URL}/p1/stop`);
  });

  test(`the first scan runs by itself once per board: a failed one is not repeated on the next visit at ${name}`, async ({
    page,
  }) => {
    const backend = new FakePeripheralsBackend();
    backend.scanFailure = BOARD_UNREACHABLE;
    await backend.install(page);
    await page.setViewportSize(size);
    await page.goto('/peripherals');
    await expect(page.getByText('Could not connect to 192.168.100.200:22')).toBeVisible();
    expect(backend.posted(REFRESH_URL)).toHaveLength(1);

    await rail(page, 'Streaming').click();
    await expect(page).toHaveTitle('Neat Insight · Streaming');
    await rail(page, 'Peripherals').click();
    await expect(
      devices(page).getByRole('group', { name: 'Cameras · not scanned yet' }),
    ).toBeVisible();
    // The page has read the board and the snapshot again, and decided not to scan.
    await expect(page.getByText('Could not connect to 192.168.100.200:22')).toBeVisible();
    expect(backend.posted(REFRESH_URL)).toHaveLength(1);

    // Refresh is the way to try again.
    backend.scanFailure = null;
    await tool(page, 'Refresh').click();
    await expect(devices(page).getByRole('group', { name: 'Cameras · 2' })).toBeVisible();
    expect(backend.posted(REFRESH_URL)).toHaveLength(2);
  });

  test(`the microphone test records, plays the recording back by itself, and plays it again on Replay at ${name}`, async ({
    page,
  }) => {
    const playback = await countPlayback(page);
    const backend = new FakePeripheralsBackend();
    await backend.install(page);
    await page.setViewportSize(size);
    await page.goto('/peripherals');
    await device(page, YETI.name).click();
    await expect(panelTitle(page)).toHaveText(YETI.name);
    await expect(panel(page)).toContainText('S24_3LE · 2 ch · 24-bit');

    const button = panel(page).getByRole('button', { name: /Test microphone|Stop recording/ });
    await button.click();
    await expect(button).toHaveText('Stop recording');
    await expect(panel(page)).toContainText(/Recording · 0:0\d/);
    await expect(device(page, YETI.name)).toContainText('Testing');
    // The button and caption change as the start is sent, before it reaches the board.
    await expect.poll(() => backend.posted(MIC_TEST_URL)).toEqual([{ id: YETI.id }]);

    await button.click();
    await expect.poll(() => backend.posted(`${MIC_TEST_URL}/stop`)).toEqual([{ token: 't1' }]);
    // The recording plays once by itself; then Replay offers it again.
    const replay = panel(page).getByRole('button', { name: 'Replay' });
    await expect(replay).toBeVisible();
    await expect(button).toHaveText('Test microphone');
    expect(await playback()).toEqual({ played: 1, ended: 1 });

    await replay.click();
    await expect.poll(playback).toEqual({ played: 2, ended: 2 });
    await expect(replay).toBeVisible();
    // Replay plays what was recorded: nothing more is asked of the board.
    expect(backend.posted(MIC_TEST_URL)).toHaveLength(1);
  });

  test(`keyboard only: arrows move through the devices across the kind headings at ${name}`, async ({
    page,
  }) => {
    const backend = new FakePeripheralsBackend();
    await backend.install(page);
    await page.setViewportSize(size);
    await page.goto('/peripherals');
    await expect(devices(page).getByRole('group', { name: 'Cameras · 2' })).toBeVisible();

    await devices(page).focus();
    await expect(device(page, IMX477.name)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(panelTitle(page)).toHaveText(C270.name);
    // From the last camera to the microphone: the heading between them is not a stop.
    await page.keyboard.press('ArrowDown');
    await expect(device(page, YETI.name)).toHaveAttribute('aria-selected', 'true');
    await expect(panelTitle(page)).toHaveText(YETI.name);
    // The last device stays selected: LiDAR's heading has no devices to move to.
    await page.keyboard.press('ArrowDown');
    await expect(panelTitle(page)).toHaveText(YETI.name);
    await page.keyboard.press('ArrowUp');
    await expect(panelTitle(page)).toHaveText(C270.name);
    await page.keyboard.press('Home');
    await expect(panelTitle(page)).toHaveText(IMX477.name);
    await expect(devices(page)).toBeFocused();
  });
}

// Final review I-1 (Review Focus 3): a Start refused because another camera's preview runs takes
// that preview up, its camera selected, rather than stopping it or ending idle.
test("a Start refused for another camera's preview selects that camera and shows its preview, stopping nothing", async ({
  page,
}) => {
  const backend = new FakePeripheralsBackend();
  await backend.install(page);
  await page.goto('/peripherals');
  await expect(panelTitle(page)).toHaveText(IMX477.name);

  for (const viewing of [false, true]) {
    // A client of the API previews the webcam after this page read the preview.
    backend.startElsewhere(C270, { format: 'MJPG', width: 1280, height: 720, fps: 30 }, viewing);
    await device(page, IMX477.name).click();
    await expect(panelTitle(page)).toHaveText(IMX477.name);
    const before = backend.postedPaths().length;
    await panel(page).getByRole('button', { name: 'Start preview' }).click();

    await expect(panelTitle(page)).toHaveText(C270.name);
    await expect(device(page, C270.name)).toHaveAttribute('aria-selected', 'true');
    await expect(device(page, C270.name)).toContainText('Previewing');
    if (viewing) {
      await expect(panel(page)).toContainText('This preview is showing in another tab or window.');
    } else {
      await expect(
        panel(page).getByRole('img', { name: `Live preview of ${C270.name}` }),
      ).toBeVisible();
      await expect(panel(page)).toContainText('Live preview · 1280×720 · MJPG · 30 fps');
    }
    const stop = panel(page).getByRole('button', { name: 'Stop preview' });
    await expect(stop).toBeVisible();
    // The refused start is all the page sent: nothing stopped the other preview.
    expect(backend.postedPaths().slice(before)).toEqual([PREVIEW_URL]);
    // Stopped by hand for the next round.
    await stop.click();
    await expect(panel(page).getByRole('button', { name: 'Start preview' })).toBeVisible();
  }
});

test('Peripherals fits at 1366×768, 1920×1080 and 768×1024 with the side panel open and closed, beside the pill and System Info', async ({
  page,
}) => {
  const backend = new FakePeripheralsBackend();
  await backend.install(page);
  await page.goto('/peripherals');
  await expect(devices(page).getByRole('group', { name: 'Cameras · 2' })).toBeVisible();
  await expect(page.locator('app-board-pill button')).toContainText('Connected');
  await expect(page.getByRole('button', { name: 'System information' })).toBeVisible();

  for (const { size } of VIEWPORTS) {
    await page.setViewportSize(size);
    for (const sidePanel of [true, false]) {
      await expect(panel(page)).toHaveCount(sidePanel ? 1 : 0);
      await expect
        .poll(() => pageOverflow(page))
        .toEqual([
          { horizontal: 0, vertical: 0 },
          { horizontal: 0, vertical: 0 },
        ]);
      // R14: the page tools fit beside the title on a laptop and a desktop; a tablet scrolls them.
      await expect
        .poll(() => topBarSpill(page, size === TABLET))
        .toEqual({ spilled: [], toolsOverflow: 0 });
      await tool(page, 'Side panel').click();
    }
  }
});
