import { expect, Page, test } from '@playwright/test';
import { VIEWPORTS } from './layout';
import {
  CONNECTED_BOARD,
  FakePeripheralsBackend,
  HOST_KEY_CHANGED_BOARD,
  UNCHECKED_BOARD,
} from './peripherals-mocks';
import { answerTopBar } from './top-bar';

// The top bar's pill and System Info, from a page that has nothing to do with the board.
test.beforeEach(({ page }) => answerTopBar(page));

const pill = (page: Page) => page.locator('app-board-pill button');
const boardDialog = (page: Page) => page.getByRole('dialog', { name: 'Board' });
const systemInfo = (page: Page) => page.getByRole('button', { name: 'System information' });
const systemInfoDialog = (page: Page) => page.getByRole('dialog', { name: 'System information' });
const confirmDialog = (page: Page) => page.getByRole('alertdialog');
const toast = (page: Page, text: string) =>
  page.locator('[data-slot="toast"]').filter({ hasText: text });

for (const { name, size } of VIEWPORTS) {
  test(`from Streaming, the pill opens the board dialog, and Change board saves the board at ${name}`, async ({
    page,
  }) => {
    const backend = new FakePeripheralsBackend();
    await backend.install(page);
    await page.setViewportSize(size);
    await page.goto('/streaming');
    await expect(pill(page)).toContainText('DevKit: 192.168.100.200');
    await expect(pill(page)).toContainText('Connected');
    // Already checked: the app does not connect to the board by itself.
    expect(backend.posted('/api/board/test')).toEqual([]);

    await pill(page).click();
    const dialog = boardDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Connected');
    await expect(dialog.getByRole('button', { name: 'Open shell' })).toBeVisible();

    await dialog.getByRole('button', { name: /^Change board/ }).click();
    await dialog.getByRole('textbox', { name: 'Host or IP address' }).fill('192.168.2.2');
    await dialog.getByRole('textbox', { name: 'User' }).fill('sima');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(
      toast(page, 'Board set to sima@192.168.2.2. Check again to test the connection.'),
    ).toBeVisible();
    expect(backend.posted('/api/board/select')).toEqual([
      { host: '192.168.2.2', port: 22, user: 'sima' },
    ]);
    // The pill follows the new board, which is not checked yet.
    await expect(pill(page)).toContainText('Board: 192.168.2.2');
    await expect(pill(page)).toContainText('Not checked');
    await expect(dialog.getByRole('button', { name: 'Check again' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(pill(page)).toBeFocused();
  });

  test(`a changed host key shows both fingerprints, and Trust new key asks first at ${name}`, async ({
    page,
  }) => {
    const backend = new FakePeripheralsBackend();
    backend.board = HOST_KEY_CHANGED_BOARD;
    await backend.install(page);
    await page.setViewportSize(size);
    await page.goto('/streaming');
    await expect(pill(page)).toContainText('Error');

    await pill(page).click();
    const dialog = boardDialog(page);
    await expect(dialog).toContainText('Connection failed');
    await expect(dialog).toContainText(
      '192.168.100.200 presented a different SSH host key than the one Insight trusted.',
    );
    const error = HOST_KEY_CHANGED_BOARD.status.error!;
    await expect(dialog).toContainText(`Expected${error['expected_fingerprint']}`);
    await expect(dialog).toContainText(`Presented${error['presented_fingerprint']}`);

    // The question first: cancelling it trusts nothing.
    const trust = dialog.getByRole('button', { name: 'Trust new key…' });
    await trust.click();
    await expect(confirmDialog(page)).toContainText('Trust the new host key?');
    await expect(confirmDialog(page)).toContainText(
      'Trust the new key only if 192.168.100.200 was reflashed or replaced.',
    );
    await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmDialog(page)).toHaveCount(0);
    expect(backend.posted('/api/board/trust-host-key')).toEqual([]);

    await trust.click();
    await confirmDialog(page).getByRole('button', { name: 'Trust new key', exact: true }).click();
    await expect(toast(page, 'Host key updated. Check again to connect.')).toBeVisible();
    expect(backend.posted('/api/board/trust-host-key')).toEqual([
      { fingerprint: error['presented_fingerprint'] },
    ]);
    await expect(dialog.getByText('Expected')).toHaveCount(0);
    await expect(pill(page)).toContainText('Not checked');
  });

  test(`a board that cannot be read shows Error in the pill, not Loading…, and the dialog retries at ${name}`, async ({
    page,
  }) => {
    const backend = new FakePeripheralsBackend();
    backend.boardFails = true;
    await backend.install(page);
    await page.setViewportSize(size);
    await page.goto('/streaming');
    await expect(pill(page)).toHaveText(/^\s*Board\s*Error\s*$/);
    await pill(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText(/^Could not read the board: /);

    await pill(page).click();
    const dialog = boardDialog(page);
    const retry = dialog.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    backend.boardFails = false;
    await retry.click();
    await expect(dialog).toContainText('Connected');
    await expect(pill(page)).toContainText('DevKit: 192.168.100.200');
    await expect(pill(page)).toContainText('Connected');
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

    // The next answer fails, as `neat` can (Inv-PB §4.5): the dialog says so above what it showed.
    await page.route(
      (url) => url.pathname === '/api/sysinfo',
      (route) => route.fulfill({ status: 502, json: { error: 'neat exited with status 1' } }),
    );
    await dialog.getByRole('button', { name: 'Refresh' }).click();
    await expect(dialog.getByText('Could not refresh: neat exited with status 1')).toBeVisible();
    await expect(dialog.getByText('The neat command is not installed here')).toBeVisible();
    await expect(dialog.getByText('https://127.0.0.1:9900', { exact: true })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(systemInfo(page)).toBeFocused();
  });
}

// The pill's last good state stays named while a later read fails (ruling Q4): on focus, the
// board is read again.
test('a read that fails after a good one keeps the board named, with Error and the board in the tooltip', async ({
  page,
}) => {
  const backend = new FakePeripheralsBackend();
  await backend.install(page);
  await page.goto('/streaming');
  await expect(pill(page)).toContainText('Connected');

  backend.boardFails = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(pill(page)).toContainText('Error');
  await expect(pill(page)).toContainText('DevKit: 192.168.100.200');
  await pill(page).hover();
  await expect(page.getByRole('tooltip')).toHaveText(
    new RegExp(`^${CONNECTED_BOARD.target!.label} — Could not read the board: `),
  );
});

// "Not checked" goes: a board never connected to is checked once when the app loads.
test('a board that was never checked is checked once as the app loads, and the pill shows the result', async ({
  page,
}) => {
  const backend = new FakePeripheralsBackend();
  backend.board = UNCHECKED_BOARD;
  await backend.install(page);
  await page.goto('/streaming');
  await expect(pill(page)).toContainText('Connected');
  expect(backend.posted('/api/board/test')).toEqual([{}]);
});

test('a failed check on load shows Error in the pill, with no toast', async ({ page }) => {
  const backend = new FakePeripheralsBackend();
  backend.board = UNCHECKED_BOARD;
  backend.checkFails = true;
  await backend.install(page);
  await page.goto('/streaming');
  await expect(pill(page)).toContainText('Error');
  expect(backend.posted('/api/board/test')).toHaveLength(1);
  await expect(page.locator('[data-slot="toast"]')).toHaveCount(0);
});
