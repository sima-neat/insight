import { expect, test } from '@playwright/test'

import { deleteViaApi, openTab, releaseTestSources } from './insightApi.js'
import { seedTree } from './mediaFixture.js'

let tree

test.beforeAll(() => {
  tree = seedTree()
})

test.afterAll(async ({ request }) => {
  await releaseTestSources(request, tree.name)
  await deleteViaApi(request, tree.name)
  tree.cleanup()
})

const lib = {
  folder: (page, path) => page.locator(`[data-testid="library-folder"][data-path="${path}"]`),
  file: (page, path) => page.locator(`[data-testid="library-file"][data-path="${path}"]`),
  browser: (page) => page.getByTestId('library-browser'),
  breadcrumb: (page) => page.getByTestId('library-breadcrumb'),
}

test('1. root lists the test folder with its streamable count and hides unsupported files', async ({ page }) => {
  await openTab(page, '/media')
  const row = lib.folder(page, tree.name)
  await expect(row).toBeVisible()
  await expect(row.locator('.folder-count')).toHaveText('4')
  await expect(page.locator(`[data-testid="library-file"][data-path="${tree.name}/readme.md"]`)).toHaveCount(0)
})
