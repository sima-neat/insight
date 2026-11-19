import { expect, Locator, Page, test } from '@playwright/test';
import {
  LAPTOP,
  pageOverflow,
  PHONE,
  sidePanelToggle,
  TABLET,
  topBarSpill,
  VIEWPORTS,
} from './layout';
import type { BoardList } from '../src/app/api.generated';
import { FakePeripheralsBackend, HOST_KEY_CHANGED_BOARD } from './peripherals-mocks';
import { FakeStatsBackend } from './stats-mocks';
import { answerEmptyLibrary, answerSlots, answerTopBar, answerViewer, LONG_BOARD } from './top-bar';

// The rail's board block reads the board on every page.
test.beforeEach(({ page }) => answerTopBar(page));

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const railItem = (page: Page, label: string) =>
  nav(page).getByRole('link', { name: label, exact: true });
const exitKiosk = (page: Page) => page.getByRole('button', { name: 'Exit kiosk mode' });
/**
 * The opacity an element is drawn with, its own times its ancestors': the kit fades the exit
 * control together with the page toolbar beside it, on an ancestor of the button.
 */
const renderedOpacity = (locator: Locator) =>
  locator.evaluate((element) => {
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    return opacity;
  });

test('a deep link opens that page with its rail item current', async ({ page }) => {
  await page.goto('/viewer');

  await expect(page).toHaveTitle('Neat Insight · Viewer');
  await expect(railItem(page, 'Viewer')).toHaveAttribute('aria-current', 'page');
  // Exactly one item is current: the others must not claim it.
  await expect(nav(page).locator('[aria-current]')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1, name: 'Viewer' })).toBeVisible();
});

test('reload on a deep link stays on that page', async ({ page }) => {
  await page.goto('/stats');
  await page.reload();

  await expect(page).toHaveURL(/\/stats$/);
  await expect(page).toHaveTitle('Neat Insight · Stats');
  await expect(railItem(page, 'Stats')).toHaveAttribute('aria-current', 'page');
});

test.describe('old routes redirect', () => {
  const redirects = [
    { from: '/rtsp', to: '/streaming', title: 'Streaming' },
    { from: '/visualizer', to: '/stats', title: 'Stats' },
    { from: '/workspace', to: '/streaming', title: 'Streaming' },
    { from: '/', to: '/streaming', title: 'Streaming' },
  ];
  for (const { from, to, title } of redirects) {
    test(`${from} lands on ${to}`, async ({ page }) => {
      await page.goto(from);

      await expect(page).toHaveURL(new RegExp(`${to}$`));
      await expect(page).toHaveTitle(`Neat Insight · ${title}`);
      await expect(railItem(page, title)).toHaveAttribute('aria-current', 'page');
    });
  }
});

test.describe('kiosk mode', () => {
  test('?kiosk hides the chrome; pointer movement reveals exit; exit restores', async ({
    page,
  }) => {
    // The kit hides the exit button after 2.5 s without pointer activity. The clock is paused from
    // before the page loads, so that timer advances only when the test runs it: neither a slow
    // machine nor a fast one changes what the test sees.
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1000);
    await page.goto('/viewer?kiosk');

    await expect(nav(page)).toHaveCount(0);
    await expect(page.getByRole('banner')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Viewer' })).toHaveCount(0);
    // The page itself stays.
    await expect(page).toHaveTitle('Neat Insight · Viewer');
    await expect(page.locator('app-viewer-page neat-tile-grid')).toBeVisible();

    await expect.poll(() => renderedOpacity(exitKiosk(page))).toBe(1);
    await page.clock.runFor(3000);
    await expect.poll(() => renderedOpacity(exitKiosk(page))).toBe(0);

    // Angular schedules rendering on timers, which are paused too: let a little time pass for it,
    // far short of the idle timeout.
    await page.mouse.move(200, 200);
    await page.clock.runFor(100);
    await expect.poll(() => renderedOpacity(exitKiosk(page))).toBe(1);

    await exitKiosk(page).click();
    await page.clock.runFor(100); // rendering again, as above
    await expect(nav(page)).toBeVisible();
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(exitKiosk(page)).toHaveCount(0);
    await expect(railItem(page, 'Viewer')).toHaveAttribute('aria-current', 'page');
  });

  test('/?kiosk keeps kiosk across the redirect to Streaming', async ({ page }) => {
    await page.goto('/?kiosk');

    // The router writes the valueless flag back as `?kiosk=`, which the kit reads the same way.
    await expect(page).toHaveURL(/\/streaming\?kiosk=?$/);
    await expect(page).toHaveTitle('Neat Insight · Streaming');
    await expect(nav(page)).toHaveCount(0);
    await expect(exitKiosk(page)).toBeVisible();
  });

  test('the top bar button enters kiosk and moves focus to exit, and back on leaving', async ({
    page,
  }) => {
    await page.goto('/media');
    await page.getByRole('button', { name: 'Kiosk mode' }).click();

    await expect(nav(page)).toHaveCount(0);
    // First in the tab order and focused, so a keyboard user can leave straight away.
    await expect(exitKiosk(page)).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(nav(page)).toBeVisible();
    await expect(railItem(page, 'Media')).toHaveAttribute('aria-current', 'page');
    // The exit control is gone; focus returns to where kiosk mode was entered, not to <body>.
    await expect(page.getByRole('button', { name: 'Kiosk mode' })).toBeFocused();
  });
});

test.describe('under an OS dark preference', () => {
  test.use({ colorScheme: 'dark' });

  test('starts light; the dark toggle survives a reload', async ({ page }) => {
    const html = page.locator('html');
    // The rail's theme item says what a click does: Dark theme while light, Light theme while dark.
    const toDark = page.getByRole('button', { name: 'Dark theme' });
    const toLight = page.getByRole('button', { name: 'Light theme' });

    await page.goto('/');
    await expect(railItem(page, 'Streaming')).toBeVisible();
    await expect(html).not.toHaveClass(/neat-dark/);
    await expect(toDark).toBeVisible();
    await expect(toLight).toHaveCount(0);

    await toDark.click();
    await expect(html).toHaveClass(/neat-dark/);

    await page.reload();
    await expect(railItem(page, 'Streaming')).toBeVisible();
    await expect(html).toHaveClass(/neat-dark/);
    await expect(toLight).toBeVisible();
    await expect(toDark).toHaveCount(0);
  });
});

test('a rail tooltip shows on hover', async ({ page }) => {
  await page.goto('/viewer');
  const item = railItem(page, 'Media');
  await expect(item).toBeVisible();

  // The kit's tooltips never open on touch, so this is a mouse hover. That the tooltip appears
  // styled and beside the rail shows the kit's prebuilt stylesheet works without Tailwind in
  // the app.
  await item.hover();

  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveText('Media');
  await expect(tooltip).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const itemBox = (await item.boundingBox())!;
  const tooltipBox = (await tooltip.boundingBox())!;
  expect(tooltipBox.x).toBeGreaterThanOrEqual(itemBox.x + itemBox.width);
});

test('the kit font loads', async ({ page }) => {
  await page.goto('/');

  // `document.fonts.check` is true for a family that was never declared, so it cannot catch a
  // font file that failed to load, such as one shadowed by Flask's `/media/<path>` route. The
  // declared faces' status can.
  const faces = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((face) => face.family.replace(/["']/g, '') === 'Roboto')
      .map((face) => face.status);
  });
  expect(faces).toContain('loaded');
  expect(faces).not.toContain('error');
  expect(await page.evaluate(() => document.fonts.check('16px Roboto'))).toBe(true);
});

test('a page keeps the kit page inset from the content area', async ({ page }) => {
  // Media, a page that stays: an empty library, and slots that answer, so no notice sits on top.
  await answerEmptyLibrary(page);
  await answerSlots(page, 0);
  await page.goto('/media');
  const text = page.getByRole('navigation', { name: 'Current folder' });
  await expect(text).toBeVisible();

  // neat-page pads by default with --neat-space-6, Tailwind's spacing 6: 1.5rem, 24 px here.
  const content = (await page.getByRole('main').boundingBox())!;
  const box = (await text.boundingBox())!;
  expect(box.x - content.x).toBeCloseTo(24, 0);
  expect(box.y - content.y).toBeCloseTo(24, 0);
});

test('collapsed rail items are at least 40 px wide and tall', async ({ page }) => {
  await page.goto('/');
  const items = [
    ...(await nav(page).getByRole('link').all()),
    page.getByRole('button', { name: 'Show labels' }),
  ];
  expect(items.length).toBeGreaterThan(1);

  for (const item of items) {
    await expect(item).toBeVisible();
    const box = (await item.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(40);
  }
});

for (const { name, size } of VIEWPORTS) {
  test(`no page-level scrolling at ${name}`, async ({ page }) => {
    // All 48 slot rows are there to be measured: the page is a lazy route, and without an answer
    // for its slots it would show an empty list that cannot overflow.
    await answerSlots(page, 48);
    await page.setViewportSize(size);
    await page.goto('/streaming');
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(
      page.getByRole('listbox', { name: 'Streaming slots' }).getByRole('option'),
    ).toHaveCount(48);

    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return {
        horizontal: root.scrollWidth - root.clientWidth,
        vertical: root.scrollHeight - root.clientHeight,
      };
    });
    expect(overflow.horizontal).toBeLessThanOrEqual(0);
    expect(overflow.vertical).toBeLessThanOrEqual(0);

    // The top bar's own items (not the paths inside icons) must not spill out of it. Streaming's
    // page tools do not fit beside the title on a tablet, where they scroll sideways (R14).
    expect(await topBarSpill(page, size === TABLET)).toEqual({ spilled: [], toolsOverflow: 0 });
  });
}

// Every page holds its top bar without a spill, and the rail its board and System Info: Media,
// Streaming, Viewer and Peripherals check it in their own specs with their content, Stats here
// with its telemetry shown, which gives it the widest tools of any page: the update chip, Pause and
// the menu (the tablet scrolls them, R14). Stats' own spec holds its layout.
for (const { name, size } of VIEWPORTS) {
  test(`Stats fits with the board and System Info in the rail at ${name}`, async ({ page }) => {
    await new FakeStatsBackend().install(page);
    await page.setViewportSize(size);
    await page.goto('/stats');
    await expect(page.locator('app-board-rail button')).toHaveAccessibleName(/Connected$/);
    await expect(page.getByRole('button', { name: 'System information' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Page tools' })).toContainText('Live');

    expect(await pageOverflow(page)).toEqual([
      { horizontal: 0, vertical: 0 },
      { horizontal: 0, vertical: 0 },
    ]);
    expect(await topBarSpill(page, size === TABLET)).toEqual({ spilled: [], toolsOverflow: 0 });
  });
}

test.describe('phone width', () => {
  test.use({ viewport: PHONE });

  /**
   * The widest board block: a connection that failed, on a host name far past what the rail
   * shows.
   */
  const ERROR_BOARD: BoardList = {
    ...LONG_BOARD,
    selected: { ...LONG_BOARD.selected!, status: HOST_KEY_CHANGED_BOARD.selected!.status },
  };

  interface PhonePage {
    readonly path: string;
    /** The page's title, which the top bar's heading says. */
    readonly title: string;
    /** Answers what the page asks for, with `board` where the test chooses it. */
    answer(page: Page, board: BoardList | null): Promise<void>;
    /** Resolves once the page shows its content, with the board healthy. */
    shown(page: Page): Promise<void>;
  }

  /** `GET /api/boards`, when a test picks the board; each page's own mock answers it otherwise. */
  const answerBoard = (page: Page, board: BoardList | null) =>
    board &&
    page.route(
      (url) => url.pathname === '/api/boards',
      (route) => route.fulfill({ json: board }),
    );

  const PAGES: PhonePage[] = [
    {
      path: '/media',
      title: 'Media',
      answer: async (page, board) => {
        await answerEmptyLibrary(page);
        await answerSlots(page, 0);
        await answerBoard(page, board);
      },
      shown: (page) =>
        expect(page.getByRole('navigation', { name: 'Current folder' })).toBeVisible(),
    },
    {
      path: '/streaming',
      title: 'Streaming',
      answer: async (page, board) => {
        await answerSlots(page, 8);
        await answerBoard(page, board);
      },
      shown: (page) =>
        expect(
          page.getByRole('listbox', { name: 'Streaming slots' }).getByRole('option'),
        ).toHaveCount(8),
    },
    {
      path: '/viewer',
      title: 'Viewer',
      answer: async (page, board) => {
        await answerViewer(page);
        await answerBoard(page, board);
      },
      shown: (page) => expect(page.locator('app-viewer-page neat-tile-grid')).toBeVisible(),
    },
    {
      path: '/peripherals',
      title: 'Peripherals',
      answer: async (page, board) => {
        const backend = new FakePeripheralsBackend();
        if (board) backend.board = board;
        await backend.install(page);
      },
      shown: (page) =>
        expect(
          page
            .getByRole('listbox', { name: 'Devices' })
            .getByRole('group', { name: 'Cameras · 2' }),
        ).toBeVisible(),
    },
    {
      path: '/stats',
      title: 'Stats',
      answer: async (page, board) => {
        const backend = new FakeStatsBackend();
        if (board) backend.board = board;
        await backend.install(page);
      },
      shown: (page) => expect(page.locator('main neat-chart-card[data-selectable]')).toHaveCount(6),
    },
  ];

  const tools = (page: Page) => page.getByRole('group', { name: 'Page tools' });
  const asides = (page: Page) => page.locator('aside');

  /**
   * Where the side panel and the page body lie against the content area, in real boxes: jsdom has
   * none. The body is the aside's sibling, the other child of `neat-page`.
   */
  const panelGeometry = (page: Page) =>
    page.evaluate(() => {
      const main = document.querySelector('main')!.getBoundingClientRect();
      const aside = document.querySelector('aside')!;
      const panel = aside.getBoundingClientRect();
      return {
        inside:
          panel.left >= main.left - 0.5 &&
          panel.right <= main.right + 0.5 &&
          panel.top >= main.top - 0.5 &&
          panel.bottom <= main.bottom + 0.5,
        bodyWidth: aside.previousElementSibling!.getBoundingClientRect().width,
        mainClientWidth: document.querySelector('main')!.clientWidth,
      };
    });

  /**
   * What a person sees of the page tools on a phone, in real boxes and without scrolling: the group
   * is the top bar's own row under the logo, as wide as the bar inside its padding.
   */
  const toolsRow = (page: Page) =>
    page.evaluate(() => {
      const box = (element: Element) => element.getBoundingClientRect();
      const bar = document.querySelector('header')!;
      const tools = bar.querySelector('[role="group"][aria-label="Page tools"]')!;
      const [barBox, toolsBox, logoBox] = [bar, tools, bar.querySelector('neat-logo')!].map(box);
      const padding = getComputedStyle(bar);
      return {
        belowLogo: toolsBox.top >= logoBox.bottom - 0.5,
        spansBar:
          Math.abs(toolsBox.left - (barBox.left + parseFloat(padding.paddingLeft))) <= 0.5 &&
          Math.abs(toolsBox.right - (barBox.right - parseFloat(padding.paddingRight))) <= 0.5,
        scrollLeft: tools.scrollLeft,
      };
    });

  /**
   * Where the side-panel toggle sits on a phone, in real boxes: wholly inside the bar, level with
   * the logo on the first row, and after the kiosk button, so it is the row's last item.
   */
  const toggleRow = (page: Page) =>
    page.evaluate(() => {
      const box = (element: Element) => element.getBoundingClientRect();
      const bar = document.querySelector('header')!;
      const [barBox, toggleBox, kioskBox, logoBox] = [
        bar,
        bar.querySelector('button[aria-label="Side panel"]')!,
        bar.querySelector('button[aria-label="Kiosk mode"]')!,
        bar.querySelector('neat-logo')!,
      ].map(box);
      return {
        inside: toggleBox.right <= barBox.right + 0.5 && toggleBox.left >= barBox.left - 0.5,
        level: Math.abs(
          (toggleBox.top + toggleBox.bottom) / 2 - (logoBox.top + logoBox.bottom) / 2,
        ),
        afterKiosk: toggleBox.left >= kioskBox.right - 0.5,
      };
    });

  /**
   * The top bar's rows on a phone: the logo, the kiosk button and the page's side-panel toggle
   * share the first row (their vertical centres level), the tools are the second, and the bar is
   * those two and nothing else (a wrapped line of its own for the buttons would add one).
   */
  const topBarRows = (page: Page) =>
    page.evaluate(() => {
      const bar = document.querySelector('header')!;
      const box = (element: Element) => element.getBoundingClientRect();
      const first = [
        bar.querySelector('neat-logo')!,
        bar.querySelector('button[aria-label="Kiosk mode"]')!,
        bar.querySelector('button[aria-label="Side panel"]')!,
      ].map(box);
      const tools = box(bar.querySelector('[role="group"][aria-label="Page tools"]')!);
      const centres = first.map((item) => (item.top + item.bottom) / 2);
      const firstBottom = Math.max(...first.map((item) => item.bottom));
      return {
        centreSpread: Math.max(...centres) - Math.min(...centres),
        toolsBelow: tools.top >= firstBottom - 0.5,
        // Two rows and the bar's 1 px border: no third row between or after.
        extra: box(bar).height - (firstBottom - box(bar).top) - tools.height,
      };
    });

  /** Two rows, the first holding the logo, the kiosk button and the toggle side by side. */
  async function expectTwoRows(page: Page): Promise<void> {
    const rows = await topBarRows(page);
    expect(rows.centreSpread, JSON.stringify(rows)).toBeLessThanOrEqual(4);
    expect(rows.toolsBelow, JSON.stringify(rows)).toBe(true);
    expect(rows.extra, JSON.stringify(rows)).toBeLessThanOrEqual(2);
  }

  /** The panel floats over the page: the body keeps `main`'s whole width. */
  async function expectFloating(page: Page): Promise<void> {
    await expect(asides(page)).toBeVisible();
    const { inside, bodyWidth, mainClientWidth } = await panelGeometry(page);
    expect(inside).toBe(true);
    expect(bodyWidth).toBeCloseTo(mainClientWidth, 0);
  }

  for (const { path, answer } of PAGES) {
    test(`${path} holds its top bar and rail with the board in an error state, and no page scrolls sideways`, async ({
      page,
    }) => {
      await answer(page, ERROR_BOARD);
      await page.goto(path);

      await expect(page.locator('app-board-rail button')).toContainText('Error');
      await expect(page.getByRole('button', { name: 'System information' })).toBeVisible();
      await expect(tools(page)).toBeVisible();
      await expectTwoRows(page);
      expect(await topBarSpill(page, true)).toEqual({ spilled: [], toolsOverflow: 0 });
      expect(await pageOverflow(page)).toEqual([
        { horizontal: 0, vertical: 0 },
        { horizontal: 0, vertical: 0 },
      ]);
    });
  }

  /**
   * Whether the element is clipped to a 1 px line: there for screen readers, not for the eye. A
   * shown text line is taller; the width is not compared, since a flex item keeps its padding.
   */
  const visuallyHidden = (locator: Locator) =>
    locator.evaluate((element) => element.getBoundingClientRect().height <= 1);

  for (const { path, title, answer, shown } of PAGES) {
    test(`${path} starts without its side panel; the toggle floats it over the page and closes it`, async ({
      page,
    }) => {
      await answer(page, null);
      await page.goto(path);
      await shown(page);

      // The bar hides the page title and the app name from the eye, not from screen readers.
      const heading = page.getByRole('heading', { level: 1 });
      await expect(heading).toHaveCount(1);
      await expect(heading).toHaveText(title);
      expect(await visuallyHidden(heading)).toBe(true);
      const appName = page.locator('header').getByText('Neat Insight', { exact: true });
      await expect(appName).toBeAttached();
      expect(await visuallyHidden(appName)).toBe(true);

      // The collapsed rail keeps the board's name for screen readers: state and all.
      await expect(page.locator('app-board-rail button')).toHaveAccessibleName(
        'DevKit — 192.168.100.200 — Connected',
      );

      // The panel is open until closed on a wide screen, and nothing was stored: still none here.
      await expect(asides(page)).toHaveCount(0);
      expect(await topBarSpill(page, true)).toEqual({ spilled: [], toolsOverflow: 0 });
      expect(await pageOverflow(page)).toEqual([
        { horizontal: 0, vertical: 0 },
        { horizontal: 0, vertical: 0 },
      ]);

      // The tools are the bar's own row under the logo, as wide as the bar inside its padding.
      expect(await toolsRow(page)).toMatchObject({ belowLogo: true, spansBar: true });
      await expectTwoRows(page);

      await sidePanelToggle(page).click();
      await expectFloating(page);
      expect(await topBarSpill(page, true)).toEqual({ spilled: [], toolsOverflow: 0 });

      // The toggle stays in view over the open panel and closes it.
      await sidePanelToggle(page).click();
      await expect(asides(page)).toHaveCount(0);
    });
  }

  for (const { path, answer, shown } of PAGES) {
    test(`${path} ends the first row with the Side panel toggle, outside the tools and in view`, async ({
      page,
    }) => {
      await answer(page, null);
      await page.goto(path);
      await shown(page);

      // The toggle is the page's, drawn by the shell after the kiosk button, not among the tools.
      await expect(tools(page).getByRole('button', { name: 'Side panel' })).toHaveCount(0);
      const row = await toggleRow(page);
      expect(row, JSON.stringify(row)).toMatchObject({ inside: true, afterKiosk: true });
      expect(row.level).toBeLessThanOrEqual(4);
      expect(await toolsRow(page)).toMatchObject({ scrollLeft: 0 });
    });
  }

  test('Stats: a card opens the panel on that card’s area', async ({ page }) => {
    await new FakeStatsBackend().install(page);
    await page.goto('/stats');
    await expect(page.locator('main neat-chart-card[data-selectable]')).toHaveCount(6);
    await expect(asides(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Network', exact: true }).click();

    await expectFloating(page);
    const area = page.getByRole('region', { name: 'Stats area' });
    await expect(area.getByRole('heading', { level: 2 })).toHaveText('Storage & Network');
    // The toggle, still in the bar, closes it.
    await expect(sidePanelToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await sidePanelToggle(page).click();
    await expect(asides(page)).toHaveCount(0);
  });

  test('Streaming: selecting a slot opens the panel for that slot', async ({ page }) => {
    await answerSlots(page, 8);
    await page.goto('/streaming');
    const rows = page.getByRole('listbox', { name: 'Streaming slots' }).getByRole('option');
    await expect(rows).toHaveCount(8);
    await expect(asides(page)).toHaveCount(0);

    await rows.nth(2).click();

    await expectFloating(page);
    await expect(page.getByRole('region', { name: 'Selected slot' })).toContainText('3');
    await expect(sidePanelToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await sidePanelToggle(page).click();
    await expect(asides(page)).toHaveCount(0);
  });

  test('a panel opened here is closed after a reload, and nothing was stored', async ({ page }) => {
    await PAGES[0].answer(page, null);
    await page.goto('/media');
    await sidePanelToggle(page).click();
    await expect(asides(page)).toBeVisible();

    await page.reload();

    await expect(page.getByRole('navigation', { name: 'Current folder' })).toBeVisible();
    await expect(asides(page)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('neat-insight:media:aside'))).toBeNull();
  });

  test('a panel closed on a laptop stays closed after a visit at phone width', async ({ page }) => {
    await PAGES[0].answer(page, null);
    await page.setViewportSize(LAPTOP);
    await page.goto('/media');
    await expect(asides(page)).toBeVisible();
    await sidePanelToggle(page).click();
    await expect(asides(page)).toHaveCount(0);

    // Narrow, the panel opens and closes freely, and the laptop's choice is left alone.
    await page.setViewportSize(PHONE);
    await expect(asides(page)).toHaveCount(0);
    await sidePanelToggle(page).click();
    await expect(asides(page)).toBeVisible();

    await page.setViewportSize(LAPTOP);
    await expect(page.getByRole('navigation', { name: 'Current folder' })).toBeVisible();
    await expect(asides(page)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('neat-insight:media:aside'))).toBe(
      'closed',
    );
  });

  test('the expanded rail floats over the page, and following a link collapses it', async ({
    page,
  }) => {
    await PAGES[0].answer(page, null);
    await page.goto('/media');
    const main = page.getByRole('main');
    const railBox = async () => (await nav(page).boundingBox())!;
    // The rail's control says what a click does, and has no pressed state.
    const show = page.getByRole('button', { name: 'Show labels' });
    const collapse = page.getByRole('button', { name: 'Collapse' });
    const mainLeft = (await main.boundingBox())!.x;
    // Collapsed, the rail sits beside the page.
    const beside = await railBox();
    expect(beside.x + beside.width).toBeLessThanOrEqual(mainLeft);

    await show.click();
    await expect(collapse).toBeVisible();

    expect((await main.boundingBox())!.x).toBe(mainLeft);
    const expanded = await railBox();
    expect(expanded.x + expanded.width).toBeGreaterThan(mainLeft);

    await railItem(page, 'Streaming').click();

    await expect(page).toHaveURL(/\/streaming$/);
    await expect(show).toBeVisible();
    expect((await main.boundingBox())!.x).toBe(mainLeft);
    const collapsed = await railBox();
    expect(collapsed.x + collapsed.width).toBeLessThanOrEqual(mainLeft);
  });
});
