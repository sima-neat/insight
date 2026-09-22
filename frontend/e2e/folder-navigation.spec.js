import { expect, test } from '@playwright/test'

import { deleteViaApi, openTab, releaseTestSources } from './insightApi.js'
import { seedTree } from './mediaFixture.js'

let tree

test.beforeAll(() => {
  tree = seedTree()
})

test.afterAll(async ({ request }) => {
  if (!tree) return
  try {
    try {
      await releaseTestSources(request, tree.name)
    } finally {
      await deleteViaApi(request, tree.name)
    }
  } finally {
    tree.cleanup()
  }
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

test('2. entering three levels deep updates the breadcrumb and hides notes.txt', async ({ page }) => {
  await openTab(page, '/media')
  await lib.folder(page, tree.name).click()
  await lib.folder(page, `${tree.name}/30FPS`).click()
  await lib.folder(page, `${tree.name}/30FPS/indoor`).click()
  await expect(lib.browser(page)).toHaveAttribute('data-folder', `${tree.name}/30FPS/indoor`)
  await expect(lib.breadcrumb(page)).toContainText('Media Root')
  await expect(lib.breadcrumb(page).locator('.crumb-current')).toHaveText('indoor')
  await expect(lib.file(page, `${tree.name}/30FPS/indoor/lobby.mp4`)).toBeVisible()
  await expect(lib.file(page, `${tree.name}/30FPS/indoor/notes.txt`)).toHaveCount(0)
  await expect(page.getByTestId('library-hidden-note')).toContainText('1 file hidden')
  await lib.folder(page, `${tree.name}/30FPS/indoor/cam-a`).click()
  await expect(lib.file(page, `${tree.name}/30FPS/indoor/cam-a/deep.mp4`)).toBeVisible()
})

test('3. Back goes up one level, Root returns to Media Root, breadcrumb segments jump', async ({ page }) => {
  await openTab(page, '/media')
  await lib.folder(page, tree.name).click()
  await lib.folder(page, `${tree.name}/30FPS`).click()
  await lib.folder(page, `${tree.name}/30FPS/indoor`).click()
  await lib.folder(page, `${tree.name}/30FPS/indoor/cam-a`).click()
  await page.getByRole('button', { name: 'Back to parent folder' }).click()
  await expect(lib.browser(page)).toHaveAttribute('data-folder', `${tree.name}/30FPS/indoor`)
  await page.getByRole('button', { name: 'Back to parent folder' }).click()
  await expect(lib.browser(page)).toHaveAttribute('data-folder', `${tree.name}/30FPS`)
  await lib.folder(page, `${tree.name}/30FPS/indoor`).click()
  await page.getByRole('button', { name: 'Go to Media Root' }).click()
  await expect(lib.browser(page)).toHaveAttribute('data-folder', '')
  await expect(page.getByRole('button', { name: 'Back to parent folder' })).toBeDisabled()
  await lib.folder(page, tree.name).click()
  await lib.folder(page, `${tree.name}/30FPS`).click()
  await lib.folder(page, `${tree.name}/30FPS/indoor`).click()
  await lib.breadcrumb(page).getByRole('button', { name: tree.name }).click()
  await expect(lib.browser(page)).toHaveAttribute('data-folder', tree.name)
})

test('4. the filter searches the current folder and its subfolders only', async ({ page }) => {
  await openTab(page, '/media')
  await lib.folder(page, tree.name).click()
  await lib.folder(page, `${tree.name}/30FPS`).click()
  const filter = page.getByRole('textbox', { name: 'Filter files in the current folder and its subfolders' })
  await filter.fill('deep')
  const hit = lib.file(page, `${tree.name}/30FPS/indoor/cam-a/deep.mp4`)
  await expect(hit).toBeVisible()
  await expect(hit.locator('.media-name')).toHaveText('indoor/cam-a/deep.mp4')
  await filter.fill('drone')
  await expect(page.locator('[data-testid="library-file"]')).toHaveCount(0)
  await expect(lib.browser(page).locator('.empty')).toHaveText('No files match the filter.')
  await filter.fill('')
  await expect(lib.folder(page, `${tree.name}/30FPS/indoor`)).toBeVisible()
  await expect(lib.browser(page)).toHaveAttribute('data-folder', `${tree.name}/30FPS`)
})

test('5. selecting a nested file shows its full relative path and loads the preview', async ({ page }) => {
  await openTab(page, '/media')
  await lib.folder(page, tree.name).click()
  await lib.folder(page, `${tree.name}/30FPS`).click()
  await lib.folder(page, `${tree.name}/30FPS/indoor`).click()
  const path = `${tree.name}/30FPS/indoor/lobby.mp4`
  await lib.file(page, path).locator('.media-row-preview').click()
  await expect(lib.file(page, path)).toHaveClass(/active/)
  const selected = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Selected Media' }) })
  await expect(selected.locator('.section-note')).toHaveText(path)
  await expect(selected.locator('video')).toHaveAttribute('src', `/media/${path}`)
  await expect(selected.locator('.kv-table')).toContainText('Filename')
})

test('10. an empty folder says so, and a folder with only unsupported files explains the hiding', async ({ page }) => {
  await openTab(page, '/media')
  await lib.folder(page, tree.name).click()
  await lib.folder(page, `${tree.name}/empty`).click()
  await expect(page.getByTestId('library-empty')).toHaveText('This folder is empty.')
  await page.getByRole('button', { name: 'Back to parent folder' }).click()
  await lib.folder(page, `${tree.name}/30FPS`).click()
  await lib.folder(page, `${tree.name}/30FPS/indoor`).click()
  await expect(page.getByTestId('library-hidden-note')).toHaveText('1 file hidden because Insight cannot stream it.')
})
