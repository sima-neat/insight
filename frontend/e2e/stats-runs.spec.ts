import { expect, Locator, Page, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  LAPTOP,
  pageOverflow,
  PHONE,
  sidewaysOverflow,
  TABLET,
  topBarSpill,
  VIEWPORTS,
} from './layout';
import {
  advance,
  openStats,
  POLL_MS,
  SETTLE_MS,
  toast,
  toolButton,
  tools,
  viewTab,
} from './stats-page';

// Stats' Record, Runs and Compare against a fake board and Sentinel (`FakeStatsBackend`, whose
// runs are `runs.testing.ts`' fixtures) at a laptop's size, and their layout at every viewport.

/** The runs of the compare fixture: `tes3`, then the run of the detail fixture. */
const TES3 = '20260924T175231.958Z-tes3';
const HW = '20260923T152712.952Z-insight-hw-1790177227';

const runList = (page: Page) => page.getByRole('listbox', { name: 'Runs' });
const runRows = (page: Page) => runList(page).getByRole('option');
/** A run's row, by the name its first cell shows. */
const runRow = (page: Page, name: string) =>
  runRows(page).filter({ has: page.getByText(name, { exact: true }) });
/** A row's box, drawn by the list and hidden from screen readers: `aria-selected` says it. */
const checkBox = (row: Locator) => row.locator('[data-slot="select-list-check"]');
const selectionBar = (page: Page) => page.getByRole('group', { name: 'Selected runs' });
const runPanel = (page: Page) => page.getByRole('region', { name: 'Selected run' });
const compareView = (page: Page) => page.locator('app-stats-compare');
const chips = (page: Page) =>
  page.getByRole('list', { name: 'Compared runs' }).getByRole('listitem');
const summaryRows = (page: Page) =>
  page.getByRole('table', { name: 'Summary' }).locator('tbody').getByRole('row');
const compareAddress = (runs: string[], baseline: string) =>
  `/stats/runs/compare?runs=${runs.join(',')}&baseline=${baseline}`;

/** The runs and baseline the page's address names. */
function compareParams(page: Page): { runs: string | null; baseline: string | null } {
  const params = new URL(page.url()).searchParams;
  return { runs: params.get('runs'), baseline: params.get('baseline') };
}

test('Record starts a trace, the toolbar says Recording, and Stop ends the trace it shows', async ({
  page,
}) => {
  const backend = await openStats(page, LAPTOP, undefined, '/stats/runs');
  await expect(runRows(page)).toHaveCount(4);

  await toolButton(page, 'Record').click();
  const form = page.getByRole('dialog', { name: 'Start a trace' });
  const nameField = form.getByLabel('Name', { exact: true });
  // Each opening offers a name made from the time.
  await expect(nameField).toHaveValue(/^run-\d{4}-\d{2}-\d{2}-\d{4}$/);
  const name = await nameField.inputValue();
  await form.getByLabel('Note (optional)').fill('Compiler v3 on the YOLO pipeline');
  await form.getByLabel('Tags (optional, comma separated)').fill('yolo, compiler-v3');
  await form.getByRole('button', { name: 'Start', exact: true }).click();

  await expect(tools(page)).toContainText(`Recording · ${name}`);
  await expect(form).toBeHidden();
  expect(backend.starts).toEqual([
    { name, note: 'Compiler v3 on the YOLO pipeline', tags: ['yolo', 'compiler-v3'] },
  ]);
  const traceId = backend.trace!.metadata.id;
  // The list is read again and leads with the recording run, which has no box to tick.
  await expect(runRows(page)).toHaveCount(5);
  await expect(runRows(page).first()).toContainText(name);
  await expect(checkBox(runRows(page).first())).toHaveCount(0);

  await toolButton(page, 'Stop').click();
  await expect(toolButton(page, 'Record')).toBeVisible();
  await expect(tools(page)).not.toContainText('Recording');
  expect(backend.stops).toEqual([traceId]);
  // The trace is now a run, which can be ticked.
  await expect(checkBox(runRow(page, name))).toHaveCount(1);
});

test('Runs lists the board’s runs, the recording one without a box, and a run opens its grouped metrics in the panel', async ({
  page,
}) => {
  await openStats(page, LAPTOP, (fake) => fake.recording(), '/stats/runs');
  await expect(viewTab(page, 'Runs')).toHaveAttribute('aria-current', 'page');
  await expect(runRows(page)).toHaveCount(5);
  await expect(runRows(page).locator('.name')).toHaveText([
    'compiler-v2-bench',
    'tes3',
    'insight-hw-1790177227',
    'insight-hw-1790177178',
    'baseline-idle',
  ]);
  await expect(tools(page)).toContainText('Recording · compiler-v2-bench');
  const recording = runRow(page, 'compiler-v2-bench');
  await expect(checkBox(recording)).toHaveCount(0);
  await expect(recording).not.toHaveAttribute('aria-selected');
  await expect(checkBox(runRow(page, 'tes3'))).toHaveCount(1);
  await expect(runPanel(page)).toContainText('Select a run to see its detail.');

  await runRow(page, 'insight-hw-1790177227').click();
  await expect(
    runPanel(page).getByRole('heading', { name: 'insight-hw-1790177227' }),
  ).toBeVisible();
  const metrics = runPanel(page).getByRole('table', { name: 'Metrics of the run' });
  // The run's metrics under their groups, one heading row each.
  await expect(metrics.locator('th.group')).toHaveText(['CPU', 'Disk', 'Memory', 'Power', 'TOP']);
  await expect(metrics).toContainText('Current board power');
  await expect(runPanel(page)).toContainText('Insight hardware validation');
});

test('Delete asks, deletes the ticked runs by id and says how many went', async ({ page }) => {
  const backend = await openStats(page, LAPTOP, undefined, '/stats/runs');
  await expect(runRows(page)).toHaveCount(4);

  await checkBox(runRow(page, 'insight-hw-1790177178')).click();
  await checkBox(runRow(page, 'baseline-idle')).click();
  await expect(selectionBar(page)).toContainText('2 selected');
  await selectionBar(page).getByRole('button', { name: 'Delete' }).click();
  const question = page.getByRole('alertdialog');
  await expect(question).toContainText('Delete 2 runs?');
  await question.getByRole('button', { name: 'Delete' }).click();

  await expect(toast(page, 'Deleted 2 runs from the board.')).toBeVisible();
  expect(backend.deletes).toEqual([
    '20260923T152624.613Z-insight-hw-1790177178',
    '20260922T101530.004Z-baseline-idle',
  ]);
  await expect(runRows(page).locator('.name')).toHaveText(['tes3', 'insight-hw-1790177227']);
  await expect(selectionBar(page)).toBeHidden();
});

test('Compare opens the ticked runs, follows a new baseline, filters the per-metric table and exports it all as CSV', async ({
  page,
}) => {
  const backend = await openStats(page, LAPTOP, undefined, '/stats/runs');
  await checkBox(runRow(page, 'tes3')).click();
  await checkBox(runRow(page, 'insight-hw-1790177227')).click();
  await selectionBar(page).getByRole('button', { name: 'Compare' }).click();

  // The first run ticked is the baseline, and Sentinel is asked for it first.
  await expect(page).toHaveURL(/\/stats\/runs\/compare\?/);
  expect(compareParams(page)).toEqual({ runs: `${TES3},${HW}`, baseline: TES3 });
  await expect(viewTab(page, 'Runs')).toHaveAttribute('aria-current', 'page');
  await expect(compareView(page).getByRole('heading', { name: 'Comparison' })).toBeVisible();
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).first()).toContainText('tes3');
  await expect(chips(page).first()).toContainText('B');
  await expect(compareView(page).locator('neat-time-chart')).toBeVisible();
  await expect(summaryRows(page)).toHaveCount(2);
  await expect(summaryRows(page).first()).toContainText('Baseline');
  expect(backend.compares).toEqual([`${TES3},${HW}`]);

  await compareView(page).getByRole('combobox', { name: 'Baseline' }).click();
  await page.getByRole('option', { name: 'insight-hw-1790177227', exact: true }).click();
  await expect.poll(() => compareParams(page)).toEqual({ runs: `${TES3},${HW}`, baseline: HW });
  await expect(chips(page).first()).toContainText('insight-hw-1790177227');
  await expect(summaryRows(page).first()).toContainText('insight-hw-1790177227');
  expect(backend.compares).toEqual([`${TES3},${HW}`, `${HW},${TES3}`]);

  // The run totals and the four metrics; Changes only hides the samples (4 against 4) and CPU
  // usage, of which neither run took a reading.
  await compareView(page)
    .getByRole('button', { name: /^Per-metric comparison/ })
    .click();
  const table = compareView(page).getByRole('table', { name: 'Per-metric comparison' });
  await expect(table.locator('tbody').getByRole('row')).toHaveCount(7);
  await compareView(page).getByRole('switch', { name: 'Changes only' }).click();
  await expect(table.locator('tbody').getByRole('row')).toHaveCount(5);
  await expect(compareView(page).getByRole('status').filter({ hasText: 'Showing' })).toHaveText(
    'Showing 5 of 7 rows. Changes only hides 2 rows where no run differs from the baseline. ' +
      'Export CSV still writes all 7.',
  );

  const download = page.waitForEvent('download');
  await compareView(page).getByRole('button', { name: 'Export CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(
    /^sentinel-compare-insight-hw-1790177227-\d{4}-\d{2}-\d{2}\.csv$/,
  );
  const lines = (await readFile((await file.path())!, 'utf8')).trimEnd().split('\r\n');
  const baseline = 'insight-hw-1790177227 (baseline; Insight hardware validation)';
  expect(lines[0]).toBe(
    `metric_key,label,group,unit,${baseline} mean,${baseline} change vs baseline (%),` +
      'tes3 mean,tes3 change vs baseline (%)',
  );
  // Every row, whatever the table shows.
  expect(lines).toHaveLength(1 + 7);
});

test('a compare address opened directly asks Sentinel for its runs, the baseline first', async ({
  page,
}) => {
  const backend = await openStats(page, LAPTOP, undefined, compareAddress([HW, TES3], TES3));
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).first()).toContainText('tes3');
  await expect(summaryRows(page)).toHaveCount(2);
  expect(backend.compares).toEqual([`${TES3},${HW}`]);
});

test('a compare address naming a run the board no longer has says which, and asks Sentinel nothing', async ({
  page,
}) => {
  const backend = await openStats(
    page,
    LAPTOP,
    undefined,
    compareAddress([TES3, 'gone-run'], TES3),
  );
  const callout = compareView(page).getByRole('heading', {
    name: 'Some runs are no longer on the board',
  });
  await expect(callout).toBeVisible();
  await expect(compareView(page)).toContainText('The board’s run list no longer has gone-run.');
  await expect(compareView(page).getByRole('link', { name: 'Open Runs' })).toBeVisible();
  expect(backend.compares).toEqual([]);
});

test('the metrics are not polled while Runs shows, and are again on Live', async ({ page }) => {
  const backend = await openStats(page, LAPTOP);
  await expect(page.locator('main neat-chart-card[data-selectable]')).toHaveCount(6);
  await advance(page, POLL_MS);
  await expect.poll(() => backend.polls).toBe(2);

  await viewTab(page, 'Runs').click();
  await expect(page).toHaveURL(/\/stats\/runs$/);
  await expect(runRows(page)).toHaveCount(4);
  // A poll that left before the switch may still land.
  await page.waitForTimeout(SETTLE_MS);
  const polled = backend.polls;
  await advance(page, 10_000, 5);
  expect(backend.polls).toBe(polled);

  await viewTab(page, 'Live').click();
  await expect(page).toHaveURL(/\/stats$/);
  await expect
    .poll(async () => {
      await advance(page, POLL_MS);
      return backend.polls;
    })
    .toBeGreaterThan(polled);
});

test('the rail switches the views, Compare keeps Runs current, and back and forward keep the open child right', async ({
  page,
}) => {
  await openStats(page, LAPTOP);
  await expect(page.locator('main neat-chart-card[data-selectable]')).toHaveCount(6);
  await expect(viewTab(page, 'Live')).toHaveAttribute('aria-current', 'page');
  await expect(viewTab(page, 'Runs')).not.toHaveAttribute('aria-current');

  await viewTab(page, 'Runs').click();
  await expect(page).toHaveURL(/\/stats\/runs$/);
  await expect(viewTab(page, 'Runs')).toHaveAttribute('aria-current', 'page');
  await expect(viewTab(page, 'Live')).not.toHaveAttribute('aria-current');

  await checkBox(runRow(page, 'tes3')).click();
  await checkBox(runRow(page, 'insight-hw-1790177227')).click();
  await selectionBar(page).getByRole('button', { name: 'Compare' }).click();
  await expect(page).toHaveURL(/\/stats\/runs\/compare\?/);
  await expect(viewTab(page, 'Runs')).toHaveAttribute('aria-current', 'page');
  await expect(viewTab(page, 'Live')).not.toHaveAttribute('aria-current');

  await page.goBack();
  await expect(page).toHaveURL(/\/stats\/runs$/);
  await expect(viewTab(page, 'Runs')).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page).toHaveURL(/\/stats$/);
  await expect(viewTab(page, 'Live')).toHaveAttribute('aria-current', 'page');
  await expect(viewTab(page, 'Runs')).not.toHaveAttribute('aria-current');

  await page.goForward();
  await page.goForward();
  await expect(page).toHaveURL(/\/stats\/runs\/compare\?/);
  await expect(viewTab(page, 'Runs')).toHaveAttribute('aria-current', 'page');
});

test('a compare address opened directly keeps Runs current in the rail, and Runs leads back to the list', async ({
  page,
}) => {
  await openStats(page, LAPTOP, undefined, compareAddress([TES3, HW], TES3));
  await expect(viewTab(page, 'Runs')).toHaveAttribute('aria-current', 'page');
  await viewTab(page, 'Runs').click();
  await expect(page).toHaveURL(/\/stats\/runs$/);
});

for (const { name, size } of VIEWPORTS) {
  test(`Runs with a run's panel open fits the page and the top bar at ${name}`, async ({
    page,
  }) => {
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

/**
 * Neither the document nor the shell's content area overflows, and nothing spills out of the top
 * bar (where a tablet may scroll the page's tools sideways, R14).
 */
async function expectFits(page: Page, size: { width: number; height: number }): Promise<void> {
  expect(await pageOverflow(page)).toEqual([
    { horizontal: 0, vertical: 0 },
    { horizontal: 0, vertical: 0 },
  ]);
  expect(await topBarSpill(page, size === TABLET)).toEqual({ spilled: [], toolsOverflow: 0 });
}
