import { expect, Page, test } from '@playwright/test';
import { VIEWPORTS } from './layout';
import {
  devkitPath,
  FakePeripheralsBackend,
  HOST_KEY_CHANGED_BOARD,
  UNCHECKED_BOARD,
} from './peripherals-mocks';
import { answerTopBar } from './top-bar';

// The rail's board block and System Info, from a page that has nothing to do with the board.
test.beforeEach(({ page }) => answerTopBar(page));

/**
 * The rail's board block; its name says the board, its address and its state. While a dialog is
 * open the page behind it is hidden from assistive technology, so the name is read from the label.
 */
const board = (page: Page) => page.locator('app-board-rail button');
const boardDialog = (page: Page) => page.getByRole('dialog', { name: 'Board' });
const systemInfo = (page: Page) => page.getByRole('button', { name: 'System information' });
const systemInfoDialog = (page: Page) => page.getByRole('dialog', { name: 'System information' });
const confirmDialog = (page: Page) => page.getByRole('alertdialog');
const toast = (page: Page, text: string) =>
  page.locator('[data-slot="toast"]').filter({ hasText: text });

for (const { name, size } of VIEWPORTS) {
  test(`from Streaming, the board block opens the board dialog, and Change board saves the board at ${name}`, async ({
    page,
  }) => {
    const backend = new FakePeripheralsBackend();
    await backend.install(page);
    await page.setViewportSize(size);
    await page.goto('/streaming');
    await expect(board(page)).toHaveAccessibleName('DevKit — 192.168.100.200 — Connected');
    // Already checked: the app does not connect to the board by itself.
    expect(backend.posted(devkitPath('check'))).toEqual([]);

    await board(page).click();
    const dialog = boardDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Connected');
    // Insight opens no shell: the dialog gives the ssh command, with Copy.
    await expect(dialog.getByText('ssh sima@192.168.100.200', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Copy the ssh command' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Open shell' })).toHaveCount(0);

    await dialog.getByRole('button', { name: /^Change board/ }).click();
    await dialog.getByRole('textbox', { name: 'Host or IP address' }).fill('192.168.2.2');
    await dialog.getByRole('textbox', { name: 'User' }).fill('sima');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(
      toast(page, 'Board set to sima@192.168.2.2. Check again to test the connection.'),
    ).toBeVisible();
    expect(backend.posted('/api/boards')).toEqual([
      { host: '192.168.2.2', port: 22, user: 'sima' },
    ]);
    await expect(dialog.getByRole('button', { name: 'Check again' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(board(page)).toBeFocused();
    // The block follows the new board, which is not checked yet. (The modal dialog takes the page
    // behind it out of the accessibility tree, so the name is read once it is closed.)
    await expect(board(page)).toHaveAccessibleName('Board — 192.168.2.2 — Not checked');
  });

  test(`a changed host key shows both fingerprints, and Trust new key asks first at ${name}`, async ({
    page,
  }) => {
    const backend = new FakePeripheralsBackend();
    backend.board = HOST_KEY_CHANGED_BOARD;
    await backend.install(page);
    await page.setViewportSize(size);
    await page.goto('/streaming');
    await expect(board(page)).toContainText('Error');

    await board(page).click();
    const dialog = boardDialog(page);
    await expect(dialog).toContainText('Connection failed');
    await expect(dialog).toContainText(
      '192.168.100.200 presented a different SSH host key than the one Insight trusts.',
    );
    const hostKey = HOST_KEY_CHANGED_BOARD.selected!.status.host_key!;
    await expect(dialog).toContainText(`Expected${hostKey.expected}`);
    await expect(dialog).toContainText(`Presented${hostKey.presented}`);

    // The question first: cancelling it trusts nothing.
    const trust = dialog.getByRole('button', { name: 'Trust new key…' });
    await trust.click();
    await expect(confirmDialog(page)).toContainText('Trust the new host key?');
    await expect(confirmDialog(page)).toContainText(
      'Trust the new key only if 192.168.100.200 was reflashed or replaced.',
    );
    await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmDialog(page)).toHaveCount(0);
    expect(backend.posted(devkitPath('trust-host-key'))).toEqual([]);

    await trust.click();
    await confirmDialog(page).getByRole('button', { name: 'Trust new key', exact: true }).click();
    await expect(toast(page, 'Host key updated. Check again to connect.')).toBeVisible();
    expect(backend.posted(devkitPath('trust-host-key'))).toEqual([
      { fingerprint: hostKey.presented },
    ]);
    await expect(dialog.getByText('Expected')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(board(page)).toHaveAccessibleName(/Not checked$/);
  });

  test(`a board that cannot be read shows Error in the board block, not Loading…, and the dialog retries at ${name}`, async ({
    page,
  }) => {
    const backend = new FakePeripheralsBackend();
    backend.boardFails = true;
    await backend.install(page);
    await page.setViewportSize(size);
    await page.goto('/streaming');
    await expect(board(page)).toHaveAccessibleName(/^Board — Could not read the board: /);
    await board(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText(/^Board — Could not read the board: /);

    await board(page).click();
    const dialog = boardDialog(page);
    const retry = dialog.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    backend.boardFails = false;
    await retry.click();
    await expect(dialog).toContainText('Connected');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(board(page)).toHaveAccessibleName('DevKit — 192.168.100.200 — Connected');
  });

  test(`System information says what is missing, keeps its data after a failed Refresh, and Escape closes it at ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.goto('/streaming');
    await systemInfo(page).click();
    const dialog = systemInfoDialog(page);
    await expect(dialog.getByText('The neat command is not installed here')).toBeVisible();
    await expect(dialog.getByText('https://127.0.0.1:9900', { exact: true })).toBeVisible();

    // The next answer fails: the dialog says so above what it showed.
    await page.route(
      (url) => url.pathname === '/api/system',
      (route) =>
        route.fulfill({
          status: 500,
          json: { error: { code: 'internal', message: 'Insight failed.' } },
        }),
    );
    await dialog.getByRole('button', { name: 'Refresh' }).click();
    await expect(dialog.getByText('Could not refresh: Insight failed.')).toBeVisible();
    await expect(dialog.getByText('The neat command is not installed here')).toBeVisible();
    await expect(dialog.getByText('https://127.0.0.1:9900', { exact: true })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(systemInfo(page)).toBeFocused();
  });
}

// The block's last good state stays named while a later read fails: on focus, the board is read
// again.
test('a read that fails after a good one keeps the board named, with Error and the board in the tooltip', async ({
  page,
}) => {
  const backend = new FakePeripheralsBackend();
  await backend.install(page);
  await page.goto('/streaming');
  await expect(board(page)).toHaveAccessibleName(/Connected$/);

  backend.boardFails = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(board(page)).toContainText('DevKit');
  await expect(board(page)).toContainText('Error');
  await board(page).hover();
  await expect(page.getByRole('tooltip')).toHaveText(
    /^DevKit — 192\.168\.100\.200 — Could not read the board: /,
  );
});

// "Not checked" goes: a board never connected to is checked once when the app loads.
test('a board that was never checked is checked once as the app loads, Checking… meanwhile, and the board block shows the result', async ({
  page,
}) => {
  const backend = new FakePeripheralsBackend();
  backend.board = UNCHECKED_BOARD;
  await backend.install(page);
  // The check is held open, as a slow SSH connection would: the block says it is checking.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname === devkitPath('check'),
    async (route) => {
      await held;
      await route.fallback();
    },
  );
  await page.goto('/streaming');
  await expect(board(page)).toContainText('Checking…');
  release();
  await expect(board(page)).toHaveAccessibleName(/Connected$/);
  expect(backend.posted(devkitPath('check'))).toEqual([{}]);
});

test('a failed check on load shows Error in the board block, with no toast', async ({ page }) => {
  const backend = new FakePeripheralsBackend();
  backend.board = UNCHECKED_BOARD;
  backend.checkFails = true;
  await backend.install(page);
  await page.goto('/streaming');
  await expect(board(page)).toContainText('Error');
  expect(backend.posted(devkitPath('check'))).toHaveLength(1);
  await expect(page.locator('[data-slot="toast"]')).toHaveCount(0);
});
