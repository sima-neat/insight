import { expect, Locator, Page, test } from '@playwright/test';
import {
  LAPTOP,
  pageOverflow,
  PHONE,
  sidePanelToggle,
  sidewaysOverflow,
  TABLET,
  topBarSpill,
  VIEWPORTS,
} from './layout';
import { FakeStatsBackend } from './stats-mocks';

// Stats' Live, Runs and Compare views against a fake board and Sentinel (`FakeStatsBackend`, whose
// runs are `runs.testing.ts`' fixtures): one flow through the three views and away from the page,
// and their layout at every viewport. What each view does in each case is held by the unit specs
// (`src/app/pages/stats/`, `src/app/stats/`).
//
// Time is the page's clock, which only the tests move on (`advance`) where they wait for a poll
// (2 s apart) or for the polls to stay away; see `holdClock` for the slice that lets the page
// render.

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

/** The runs of the compare fixture: `tes3`, then the run of the detail fixture. */
const TES3 = '20260924T175231.958Z-tes3';
const HW = '20260923T152712.952Z-insight-hw-1790177227';

/**
 * Opens Stats at `path` (Live unless given) on a fake board and Sentinel; `setUp` changes the fake
 * before the page loads.
 */
async function openStats(
  page: Page,
  size: { width: number; height: number },
  setUp: (backend: FakeStatsBackend) => void = () => undefined,
  path = '/stats',
): Promise<FakeStatsBackend> {
  const backend = new FakeStatsBackend();
  setUp(backend);
  await backend.install(page);
  await holdClock(page);
  await page.setViewportSize(size);
  await page.goto(path);
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

const tools = (page: Page) => page.getByRole('group', { name: 'Page tools' });
/**
 * A rail link: a page, or one of Stats' views (Live, Runs), which are its rail item's children and
 * links in the rail while it shows its labels; the open one carries `aria-current="page"`.
 */
const rail = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });

const areaPanel = (page: Page) => page.getByRole('region', { name: 'Stats area' });
const areaTitle = (page: Page) => areaPanel(page).getByRole('heading', { level: 2 });
/** The overview cards; the Power area's tiles in the side panel are chart cards too. */
const cards = (page: Page) => page.locator('main neat-chart-card[data-selectable]');
/** An overview card; its heading is a button, which `aria-current` marks while it is chosen. */
const card = (page: Page, heading: string) =>
  cards(page).filter({ has: page.getByRole('button', { name: heading, exact: true }) });
const cardButton = (page: Page, heading: string) =>
  card(page, heading).getByRole('button', { name: heading, exact: true });

const runRows = (page: Page) => page.getByRole('listbox', { name: 'Runs' }).getByRole('option');
/** A run's row, by the name its first cell shows. */
const runRow = (page: Page, name: string) =>
  runRows(page).filter({ has: page.getByText(name, { exact: true }) });
/** A row's box, drawn by the list and hidden from screen readers: `aria-selected` says it. */
const checkBox = (row: Locator) => row.locator('[data-slot="select-list-check"]');
const runPanel = (page: Page) => page.getByRole('region', { name: 'Selected run' });
const compareView = (page: Page) => page.locator('app-stats-compare');
const chips = (page: Page) =>
  page.getByRole('list', { name: 'Compared runs' }).getByRole('listitem');
const summaryRows = (page: Page) =>
  page.getByRole('table', { name: 'Summary' }).locator('tbody').getByRole('row');
const compareAddress = (runs: string[], baseline: string) =>
  `/stats/runs/compare?runs=${runs.join(',')}&baseline=${baseline}`;

/**
 * Neither the document nor the shell's content area overflows, and nothing spills out of the top
 * bar (where a tablet may scroll the page's tools sideways).
 */
async function expectFits(page: Page, size: { width: number; height: number }): Promise<void> {
  expect(await pageOverflow(page)).toEqual([
    { horizontal: 0, vertical: 0 },
    { horizontal: 0, vertical: 0 },
  ]);
  expect(await topBarSpill(page, size === TABLET)).toEqual({ spilled: [], toolsOverflow: 0 });
}

test('Live polls the board’s readings, Runs and Compare read its runs, and leaving Stats stops every request to the board', async ({
  page,
}) => {
  const backend = await openStats(page, LAPTOP);
  // The views are in the rail while it shows its labels.
  await page.getByRole('button', { name: 'Show labels' }).click();

  // Live: the six cards with the readings of the captured Modalix answer, as the cards word them.
  await expect(cards(page).getByRole('button')).toHaveText([
    'Thermal max',
    'Board power (Estimated)',
    'CPU usage',
    'Linux memory',
    'Accelerator memory',
    'Network',
  ]);
  await expect(card(page, 'Thermal max')).toContainText(/66\.3\s*°C/);
  await expect(card(page, 'Board power (Estimated)')).toContainText(/11\.6\s*W/);
  await expect(card(page, 'Network')).toContainText(/2\.82\s*MB\/s/);
  await expect(tools(page)).toContainText('Live');
  await cardButton(page, 'Board power (Estimated)').click();
  await expect(areaTitle(page)).toHaveText('Power');
  await expect(areaPanel(page).locator('neat-stacked-chart')).toContainText('SoC and DDR VDD');

  // The polls ask for the whole cache, then for what came after the first answer's newest sample.
  expect(backend.queries).toEqual([null]);
  await advance(page, POLL_MS);
  await expect.poll(() => backend.polls).toBe(2);
  expect(backend.queries[1]).toBe(backend.answered[0]);

  // Runs: the board's runs, one opened in the panel with its grouped metrics.
  await rail(page, 'Runs').click();
  await expect(page).toHaveURL(/\/stats\/runs$/);
  await expect(runRows(page)).toHaveCount(4);
  await runRow(page, 'insight-hw-1790177227').click();
  const metrics = runPanel(page).getByRole('table', { name: 'Metrics of the run' });
  await expect(metrics.locator('th.group')).toHaveText(['CPU', 'Disk', 'Memory', 'Power', 'TOP']);

  // Compare: the ticked runs, the first ticked the baseline, which Sentinel is asked for first.
  await checkBox(runRow(page, 'tes3')).click();
  await checkBox(runRow(page, 'insight-hw-1790177227')).click();
  await page
    .getByRole('group', { name: 'Selected runs' })
    .getByRole('button', { name: 'Compare' })
    .click();
  await expect(page).toHaveURL(/\/stats\/runs\/compare\?/);
  const params = new URL(page.url()).searchParams;
  expect([params.get('runs'), params.get('baseline')]).toEqual([`${TES3},${HW}`, TES3]);
  await expect(rail(page, 'Runs')).toHaveAttribute('aria-current', 'page');
  await expect(chips(page)).toHaveCount(2);
  await expect(summaryRows(page)).toHaveCount(2);
  expect(backend.compares).toEqual([`${TES3},${HW}`]);

  // Leaving Stats stops every request to the board, however long the page is away.
  await rail(page, 'Streaming').click();
  await expect(page).toHaveURL(/\/streaming$/);
  // A request that left before the page did may still be on its way.
  await page.waitForTimeout(SETTLE_MS);
  const sent = backend.sentinelRequests.length;
  await advance(page, 180_000, 6);
  expect(backend.sentinelRequests).toHaveLength(sent);

  // Coming back reads the whole cache again, and finds the panel as it was left.
  await rail(page, 'Stats').click();
  await expect(cards(page)).toHaveCount(6);
  expect(backend.queries.at(-1)).toBeNull();
  await expect(areaTitle(page)).toHaveText('Power');
  await expect(cardButton(page, 'Board power (Estimated)')).toHaveAttribute('aria-current', 'true');
});

for (const { name, size } of VIEWPORTS) {
  test(`Live fits the page and the top bar with its side panel open and closed, and the panel itself does not scroll sideways at ${name}`, async ({
    page,
  }) => {
    await openStats(page, size);
    await expect(cards(page)).toHaveCount(6);
    await expect(areaPanel(page)).toBeVisible();
    /** The panel fits as well: its content (the thermal tab strip, the metrics table) fits its width. */
    const expectLiveFits = async () => {
      await expectFits(page, size);
      if (await areaPanel(page).isVisible()) {
        expect(
          await sidewaysOverflow(areaPanel(page).locator('xpath=ancestor::aside')),
        ).toBeLessThanOrEqual(0);
      }
    };

    // The Thermal area, with its group tabs (a strip that scrolls inside itself), and then the
    // Storage & Network area, with the table of every metric.
    await expect(areaTitle(page)).toHaveText('Thermal');
    await expectLiveFits();
    await cardButton(page, 'Network').click();
    await expect(areaTitle(page)).toHaveText('Storage & Network');
    await expect(areaPanel(page).getByRole('table')).toBeVisible();
    await expectLiveFits();

    // With the panel closed the cards have the page.
    await sidePanelToggle(page).click();
    await expect(areaPanel(page)).toBeHidden();
    await expectLiveFits();
  });

  test(`Runs with a run's panel open fits the page and the top bar at ${name}`, async ({
    page,
  }) => {
    // A trace recording: the toolbar names it, which makes it its widest.
    await openStats(page, size, (fake) => fake.recording(), '/stats/runs');
    await runRow(page, 'insight-hw-1790177227').click();
    await expect(runPanel(page).getByRole('table', { name: 'Metrics of the run' })).toBeVisible();
    await expectFits(page, size);
    // The panel's metrics table fits its width.
    expect(
      await sidewaysOverflow(runPanel(page).locator('xpath=ancestor::aside')),
    ).toBeLessThanOrEqual(0);
  });

  test(`Compare with its per-metric comparison open fits the page and the top bar at ${name}`, async ({
    page,
  }) => {
    await openStats(page, size, undefined, compareAddress([TES3, HW], TES3));
    await expect(compareView(page).locator('neat-time-chart')).toBeVisible();
    await expect(summaryRows(page)).toHaveCount(2);
    await expectFits(page, size);
    await compareView(page)
      .getByRole('button', { name: /^Per-metric comparison/ })
      .click();
    await expect(
      compareView(page).getByRole('table', { name: 'Per-metric comparison' }),
    ).toBeVisible();
    await expectFits(page, size);
  });
}

test('the comparison header fits a phone: the baseline and Export CSV wrap, nothing leaves the page', async ({
  page,
}) => {
  await openStats(page, PHONE, undefined, compareAddress([TES3, HW], TES3));
  const exportCsv = compareView(page).getByRole('button', { name: 'Export CSV' });
  await expect(exportCsv).toBeVisible();
  // The page scrolls down on a phone; only sideways must stay at nothing.
  expect((await pageOverflow(page)).map((overflow) => overflow.horizontal)).toEqual([0, 0]);
  const box = (await exportCsv.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
});
