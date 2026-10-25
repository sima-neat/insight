import { expect, Locator, Page, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { pageOverflow, TABLET, topBarSpill, VIEWPORTS } from './layout';
import { FakeStatsBackend, NO_BOARD, SENTINEL_FAILED, STATS_BOARD } from './stats-mocks';

// Stats against a fake board and Sentinel (`FakeStatsBackend`), at every viewport. Time is the
// page's clock, which only the tests move on (`advance`) where they wait for a poll (2 s apart) or
// for the polls to stay away; see `holdClock` for the slice that lets the page render.

const POLL_MS = 2000;
/** Real time let pass after a clock step, so that answers land and the polls they schedule get a turn. */
const SETTLE_MS = 250;
/**
 * The page's clock stands still but for a slice of `FAKE_SLICE_MS` every `REAL_SLICE_MS` of real
 * time: a tenth of real speed, so a poll (2 s of page time) is 20 s of real time away however
 * slow the machine is, which makes the counts of requests exact. Not paused outright because
 * Angular renders on timers (and the lazy routes load on them): a stopped clock stops the page.
 */
const FAKE_SLICE_MS = 5;
const REAL_SLICE_MS = 50;
const BOARD_LABEL = STATS_BOARD.target!.label;

const tools = (page: Page) => page.getByRole('group', { name: 'Page tools' });
const toolButton = (page: Page, name: string) => tools(page).getByRole('button', { name });
const rail = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });
const toast = (page: Page, text: string) =>
  page.locator('[data-slot="toast"]').filter({ hasText: text });
const panel = (page: Page) => page.getByRole('region', { name: 'Stats area' });
/** The side panel's own scroll container: the panel sits inside it, beside the page's body. */
const aside = (page: Page) => panel(page).locator('xpath=ancestor::aside');
const panelTitle = (page: Page) => panel(page).getByRole('heading', { level: 2 });
/** The overview cards; the Power area's tiles in the side panel are chart cards too. */
const cards = (page: Page) => page.locator('main neat-chart-card[data-selectable]');
/** An overview card; its heading is a button, which `aria-current` marks while it is chosen. */
const card = (page: Page, heading: string) =>
  cards(page).filter({ has: page.getByRole('button', { name: heading, exact: true }) });
const cardButton = (page: Page, heading: string) =>
  card(page, heading).getByRole('button', { name: heading, exact: true });

/** Opens Stats on a fake board and Sentinel; `setUp` changes the fake before the page loads. */
async function openStats(
  page: Page,
  size: { width: number; height: number },
  setUp: (backend: FakeStatsBackend) => void = () => undefined,
): Promise<FakeStatsBackend> {
  const backend = new FakeStatsBackend();
  setUp(backend);
  await backend.install(page);
  await holdClock(page);
  await page.setViewportSize(size);
  await page.goto('/stats');
  return backend;
}

/** Stops the page's clock but for a slice at a time (`FAKE_SLICE_MS`), until the page closes. */
async function holdClock(page: Page): Promise<void> {
  const start = Date.parse('2026-10-24T10:05:00Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 1000);
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    page.clock
      .runFor(FAKE_SLICE_MS)
      .catch(() => undefined)
      .finally(() => (running = false));
  }, REAL_SLICE_MS);
  page.on('close', () => clearInterval(timer));
}

/**
 * Moves the page's clock on by `ms`, in `steps` steps with real time to settle after each. A poll
 * is scheduled only once its predecessor's answer has landed, and one clock step fires a due
 * timer once, so a loop that should not be running needs several steps to show itself.
 */
async function advance(page: Page, ms: number, steps = 1): Promise<void> {
  for (let step = 0; step < steps; step++) {
    await page.clock.runFor(ms / steps);
    await page.waitForTimeout(SETTLE_MS);
  }
}

for (const { name, size } of VIEWPORTS) {
  test(`six cards show the board's readings, and a click on Board power opens its area and marks it at ${name}`, async ({
    page,
  }) => {
    await openStats(page, size);

    await expect(cards(page)).toHaveCount(6);
    await expect(cards(page).getByRole('button')).toHaveText([
      'Thermal max',
      'Board power',
      'CPU usage',
      'Linux memory',
      'MLA memory',
      'Network',
    ]);
    // The readings of the captured Modalix answer, worded as the cards word them.
    await expect(card(page, 'Thermal max')).toContainText(/66\.3\s*°C/);
    await expect(card(page, 'Thermal max')).toContainText('Hottest sensor: Board LM96-2');
    await expect(card(page, 'Board power')).toContainText(/11\.6\s*W/);
    await expect(card(page, 'CPU usage')).toContainText(/37\.5\s*%/);
    await expect(card(page, 'Linux memory')).toContainText(/21\.3\s*%/);
    await expect(card(page, 'MLA memory')).toContainText(/742\s*MB/);
    await expect(card(page, 'Network')).toContainText(/2\.82\s*MB\/s/);
    // The chip beside the update state says the board is read.
    await expect(tools(page)).toContainText('Live');

    // Until a card is chosen the panel is the Thermal area and no card is marked.
    await expect(panelTitle(page)).toHaveText('Thermal');
    await expect(cards(page).locator('[aria-current="true"]')).toHaveCount(0);

    await cardButton(page, 'Board power').click();
    await expect(panelTitle(page)).toHaveText('Power');
    await expect(cardButton(page, 'Board power')).toHaveAttribute('aria-current', 'true');
    await expect(cards(page).locator('[aria-current="true"]')).toHaveCount(1);
    // The rails' legend lists each rail with its watts.
    const rails = panel(page).locator('neat-stacked-chart');
    await expect(rails).toContainText('SoC and DDR VDD');
    await expect(rails).toContainText('4.75 W');
    await expect(rails).toContainText('MLA 0.68V');
    await expect(rails).toContainText('1.50 W');

    // A click on a card's plot opens its area too.
    await card(page, 'Network').locator('neat-time-chart .plot').click();
    await expect(panelTitle(page)).toHaveText('Storage & Network');
    await expect(cardButton(page, 'Network')).toHaveAttribute('aria-current', 'true');
    await expect(cardButton(page, 'Board power')).not.toHaveAttribute('aria-current', 'true');
  });

  test(`the polls ask for the full window, then only what is new, stop while Stats is away and start over on return at ${name}`, async ({
    page,
  }) => {
    const backend = await openStats(page, size);
    await expect(cards(page)).toHaveCount(6);
    await cardButton(page, 'Board power').click();
    await expect(panelTitle(page)).toHaveText('Power');

    expect(backend.queries).toEqual([{ history: 240 }]);
    await advance(page, POLL_MS);
    await expect.poll(() => backend.polls).toBe(2);
    // The second poll holds the first answer's newest sample and the history it is of.
    expect(backend.queries[1]).toEqual({ history: 240, after: backend.answered[0], epoch: 1 });

    // Leaving Stats stops every request to the board, however long the page is away.
    await rail(page, 'Streaming').click();
    await expect(page).toHaveURL(/\/streaming$/);
    await expect(page).toHaveTitle('Neat Insight · Streaming');
    // A request that left before the page did may still be on its way.
    await page.waitForTimeout(SETTLE_MS);
    const sent = backend.sentinelRequests.length;
    await advance(page, 180_000, 6);
    expect(backend.sentinelRequests).toHaveLength(sent);

    // Coming back reads the window again, in full, and finds the panel as it was left.
    await rail(page, 'Stats').click();
    await expect(cards(page)).toHaveCount(6);
    expect(backend.queries.at(-1)).toEqual({ history: 240 });
    await expect(panelTitle(page)).toHaveText('Power');
    await expect(cardButton(page, 'Board power')).toHaveAttribute('aria-current', 'true');
  });

  test(`Pause stops the metric requests and says Paused, and Resume starts them again at ${name}`, async ({
    page,
  }) => {
    const backend = await openStats(page, size);
    // The first answer schedules the next poll, which the clock step below fires; "Live" alone
    // can show before that answer has landed.
    await expect(cards(page)).toHaveCount(6);
    await expect(tools(page)).toContainText('Live');
    await advance(page, POLL_MS);
    await expect.poll(() => backend.polls).toBe(2);

    await toolButton(page, 'Pause').click();
    await expect(tools(page)).toContainText('Paused');
    await expect(toolButton(page, 'Resume')).toBeVisible();
    // A poll that left before the click may still land.
    await page.waitForTimeout(SETTLE_MS);
    const paused = backend.polls;
    await advance(page, 60_000, 6);
    expect(backend.polls).toBe(paused);

    await toolButton(page, 'Resume').click();
    await expect.poll(() => backend.polls).toBe(paused + 1);
    await expect(tools(page)).toContainText('Live');
    await expect(toolButton(page, 'Pause')).toBeVisible();
    // The poll after the resumed one is scheduled when its answer lands, which may be after the
    // first step: step again until it is fired.
    await expect
      .poll(async () => {
        await advance(page, POLL_MS);
        return backend.polls;
      })
      .toBeGreaterThanOrEqual(paused + 2);
  });

  test(`a poll that fails with 502 shows why and not updating, and Retry in the top bar polls again at ${name}`, async ({
    page,
  }) => {
    const backend = await openStats(page, size);
    await expect(cards(page)).toHaveCount(6);

    backend.metricsFailure = SENTINEL_FAILED;
    await advance(page, POLL_MS);
    const failure = page.getByRole('heading', { level: 2, name: 'Sentinel could not answer' });
    await expect(failure).toBeVisible();
    await expect(page.getByText('Sentinel did not answer within 5 s.')).toBeVisible();
    await expect(tools(page)).toContainText('Not updating');
    // The values it last read stay on the page under the failure.
    await expect(cards(page)).toHaveCount(6);

    const polled = backend.polls;
    backend.metricsFailure = null;
    await toolButton(page, 'Retry').click();
    await expect.poll(() => backend.polls).toBe(polled + 1);
    await expect(failure).toBeHidden();
    await expect(tools(page)).toContainText('Live');
    await expect(toolButton(page, 'Pause')).toBeVisible();
  });

  test(`without Sentinel, Install Sentinel posts with the generation, goes on across a visit to Streaming and says when it is done at ${name}`, async ({
    page,
  }) => {
    const backend = await openStats(page, size, (fake) => (fake.sentinel = 'missing'));
    await expect(
      page.getByRole('heading', { level: 2, name: `Sentinel is not installed on ${BOARD_LABEL}` }),
    ).toBeVisible();
    // Nothing is polled while there is no Sentinel to ask.
    expect(backend.polls).toBe(0);
    // Nor are the toolbar's update controls shown.
    await expect(toolButton(page, 'Pause')).toBeHidden();

    const release = backend.holdInstall();
    await page.getByRole('button', { name: 'Install Sentinel' }).click();
    const installing = page.getByRole('button', { name: 'Installing…' });
    await expect(installing).toBeVisible();
    expect(backend.installs).toEqual([String(STATS_BOARD.generation)]);

    // The install belongs to no page: leaving Stats and coming back still finds it running.
    await rail(page, 'Streaming').click();
    await expect(page).toHaveURL(/\/streaming$/);
    await rail(page, 'Stats').click();
    await expect(installing).toBeVisible();
    expect(backend.installs).toHaveLength(1);

    release();
    await expect(toast(page, `Sentinel installed on ${BOARD_LABEL}.`)).toBeVisible();
    // The page now shows the board's telemetry, and the installer's log was not asked for twice.
    await expect(cards(page)).toHaveCount(6);
    await expect(tools(page)).toContainText('Live');
    expect(backend.installs).toHaveLength(1);
  });

  test(`with no board selected, Choose a board opens the board dialog at ${name}`, async ({
    page,
  }) => {
    const backend = await openStats(page, size, (fake) => (fake.board = NO_BOARD));
    await expect(
      page.getByRole('heading', { level: 2, name: 'Select a board to see its telemetry' }),
    ).toBeVisible();
    expect(backend.sentinelRequests).toEqual([]);

    await page.getByRole('button', { name: 'Choose a board' }).click();
    await expect(page.getByRole('dialog', { name: 'Board' })).toBeVisible();
  });

  test(`the keyboard reaches the Thermal max chart, reads its samples and moves through the thermal groups at ${name}`, async ({
    page,
  }) => {
    await openStats(page, size);
    await expect(cards(page)).toHaveCount(6);

    // From the card's heading, the next stop is its chart.
    await cardButton(page, 'Thermal max').focus();
    await page.keyboard.press('Tab');
    const chart = card(page, 'Thermal max').getByRole('group', { name: /^Thermal max: / });
    await expect(chart).toBeFocused();
    const spoken = card(page, 'Thermal max').locator('neat-time-chart [aria-live="polite"]');
    const readout = card(page, 'Thermal max').locator('neat-time-chart .readout');
    // Focus shows the newest sample and says nothing: only a key press is announced.
    await expect(readout).toContainText('just now');
    await expect(spoken).toHaveText('');

    // The kit says "just now" under 10 s, so the samples are told apart five steps back (10 s),
    // and at the oldest one the window holds (58 s).
    await page.keyboard.press('ArrowLeft');
    await expect(spoken).toContainText('just now');
    for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft');
    await expect(readout).toContainText('10 s ago');
    await expect(spoken).toContainText('10 s ago');
    await page.keyboard.press('Home');
    await expect(readout).toContainText('58 s ago');
    await expect(spoken).toContainText('58 s ago');
    await page.keyboard.press('End');
    await expect(readout).toContainText('just now');
    await expect(spoken).toContainText('just now');

    // The thermal groups are tabs, and the arrow keys move between them.
    const groups = panel(page).getByRole('tablist', { name: 'Thermal sensor groups' });
    const tabs = groups.getByRole('tab');
    await expect(tabs).toHaveCount(5);
    const first = tabs.nth(0);
    await first.focus();
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(first).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('ArrowLeft');
    await expect(first).toBeFocused();
    await expect(first).toHaveAttribute('aria-selected', 'true');
  });

  test(`the More actions menu exports the session as CSV at ${name}`, async ({ page }) => {
    await openStats(page, size);
    await expect(cards(page)).toHaveCount(6);

    await toolButton(page, 'More actions').click();
    // The menu leads with what is known of Sentinel.
    await expect(page.getByText('Sentinel main:80ab7de4da31')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^sentinel-session-\d{4}-\d{2}-\d{2}-\d{6}\.csv$/);
    const lines = (await readFile((await file.path())!, 'utf8')).trimEnd().split('\r\n');
    expect(lines[0].split(',')[0]).toBe('timestamp');
    // A header and a row for each sample the window holds.
    expect(lines).toHaveLength(1 + 30);
  });

  test(`System information shows This computer with its CPU, Memory and Disk at ${name}`, async ({
    page,
  }) => {
    await openStats(page, size);
    await page.getByRole('button', { name: 'System information' }).click();
    const dialog = page.getByRole('dialog', { name: 'System information' });
    await expect(dialog.getByRole('heading', { name: 'This computer' })).toBeVisible();
    const terms = dialog.locator('dt');
    await expect(terms.filter({ hasText: /^CPU$/ })).toBeVisible();
    await expect(terms.filter({ hasText: /^Memory$/ })).toBeVisible();
    await expect(terms.filter({ hasText: /^Disk$/ })).toBeVisible();
  });

  test(`Stats fits the page and the top bar with its side panel open, and the panel itself does not scroll sideways at ${name}`, async ({
    page,
  }) => {
    await openStats(page, size);
    await expect(cards(page)).toHaveCount(6);
    await expect(panel(page)).toBeVisible();

    // The Thermal area, with its group tabs (a strip that scrolls inside itself), and then the
    // Storage & Network area, with the table of every metric.
    await expect(panelTitle(page)).toHaveText('Thermal');
    await expectFits(page);
    await cardButton(page, 'Network').click();
    await expect(panelTitle(page)).toHaveText('Storage & Network');
    await expect(panel(page).getByRole('table')).toBeVisible();
    await expectFits(page);

    // With the panel closed the cards have the page.
    await page.getByRole('button', { name: 'Side panel' }).click();
    await expect(panel(page)).toBeHidden();
    await expectFits(page);

    /**
     * Neither the document nor the shell's content area overflows, nothing spills out of the top
     * bar (where a tablet may scroll the page's tools sideways, R14) and the side panel does not
     * scroll sideways: its content (the thermal tab strip, the metrics table) fits its width.
     */
    async function expectFits(page: Page): Promise<void> {
      expect(await pageOverflow(page)).toEqual([
        { horizontal: 0, vertical: 0 },
        { horizontal: 0, vertical: 0 },
      ]);
      expect(await topBarSpill(page, size === TABLET)).toEqual({ spilled: [], toolsOverflow: 0 });
      if (await panel(page).isVisible()) {
        expect(await sidewaysOverflow(aside(page))).toBeLessThanOrEqual(0);
      }
    }
  });
}

/** How far an element's content reaches past its right edge. */
function sidewaysOverflow(element: Locator): Promise<number> {
  return element.evaluate((node) => node.scrollWidth - node.clientWidth);
}
