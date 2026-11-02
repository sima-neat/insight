import { Page } from '@playwright/test';
import { FakeStatsBackend } from './stats-mocks';

// Driving Stats against a fake board and Sentinel (`FakeStatsBackend`), for the Stats e2e. Time is
// the page's clock, which only the tests move on (`advance`) where they wait for a poll (2 s
// apart) or for the polls to stay away; see `holdClock` for the slice that lets the page render.

export const POLL_MS = 2000;
/** Real time let pass after a clock step, so that answers land and the polls they schedule get a turn. */
export const SETTLE_MS = 250;
/**
 * The page's clock stands still but for a slice of `FAKE_SLICE_MS` every `REAL_SLICE_MS` of real
 * time: a tenth of real speed, so a poll (2 s of page time) is 20 s of real time away however
 * slow the machine is, which makes the counts of requests exact. Not paused outright because
 * Angular renders on timers (and the lazy routes load on them): a stopped clock stops the page.
 */
const FAKE_SLICE_MS = 5;
const REAL_SLICE_MS = 50;

export const tools = (page: Page) => page.getByRole('group', { name: 'Page tools' });
export const toolButton = (page: Page, name: string) => tools(page).getByRole('button', { name });
/**
 * The page's views are its rail item's children (Live, Runs), links in the rail while it is
 * expanded; the open one carries `aria-current="page"`.
 */
export const viewTabs = (page: Page) => page.getByRole('navigation', { name: 'Main' });
export const viewTab = (page: Page, name: string) =>
  viewTabs(page).getByRole('link', { name, exact: true });
export const rail = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });
export const toast = (page: Page, text: string) =>
  page.locator('[data-slot="toast"]').filter({ hasText: text });

/**
 * Opens Stats at `path` (Live unless given) on a fake board and Sentinel; `setUp` changes the fake
 * before the page loads.
 */
export async function openStats(
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
export async function advance(page: Page, ms: number, steps = 1): Promise<void> {
  for (let step = 0; step < steps; step++) {
    await page.clock.runFor(ms / steps);
    await page.waitForTimeout(SETTLE_MS);
  }
}
