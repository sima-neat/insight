import { expect, Page, test } from '@playwright/test';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const railItem = (page: Page, label: string) =>
  nav(page).getByRole('link', { name: label, exact: true });
const exitKiosk = (page: Page) => page.getByRole('button', { name: 'Exit kiosk mode' });

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
    await expect(page.getByText('The Viewer arrives with plan 2.')).toBeVisible();

    await expect(exitKiosk(page)).toHaveCSS('opacity', '1');
    await page.clock.runFor(3000);
    await expect(exitKiosk(page)).toHaveCSS('opacity', '0');

    // Angular schedules rendering on timers, which are paused too: let a little time pass for it,
    // far short of the idle timeout.
    await page.mouse.move(200, 200);
    await page.clock.runFor(100);
    await expect(exitKiosk(page)).toHaveCSS('opacity', '1');

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
    const toggle = page.getByRole('button', { name: 'Dark mode' });

    await page.goto('/');
    await expect(railItem(page, 'Streaming')).toBeVisible();
    await expect(html).not.toHaveClass(/neat-dark/);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await toggle.click();
    await expect(html).toHaveClass(/neat-dark/);

    await page.reload();
    await expect(railItem(page, 'Streaming')).toBeVisible();
    await expect(html).toHaveClass(/neat-dark/);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
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
  await page.goto('/media');
  const text = page.getByText('Media arrives with plan 3.');
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

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 768, height: 1024 },
  { width: 1920, height: 1080 },
]) {
  test(`no page-level scrolling at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/streaming');
    await expect(page.getByRole('banner')).toBeVisible();

    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return {
        horizontal: root.scrollWidth - root.clientWidth,
        vertical: root.scrollHeight - root.clientHeight,
      };
    });
    expect(overflow.horizontal).toBeLessThanOrEqual(0);
    expect(overflow.vertical).toBeLessThanOrEqual(0);

    // The top bar's own items (not the paths inside icons) must not spill out of it.
    const spilled = await page.evaluate(() => {
      const bar = document.querySelector('header')!.getBoundingClientRect();
      return [...document.querySelectorAll('header *:not(svg *)')]
        .filter((el) => {
          const box = el.getBoundingClientRect();
          return (
            box.width > 0 &&
            (box.left < bar.left - 0.5 ||
              box.right > bar.right + 0.5 ||
              box.top < bar.top - 0.5 ||
              box.bottom > bar.bottom + 0.5)
          );
        })
        .map((el) => el.outerHTML.slice(0, 80));
    });
    expect(spilled).toEqual([]);
  });
}
