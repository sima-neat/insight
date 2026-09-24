import { expect, test } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

import { deleteViaApi, openTab, releaseTestSources, sourceByIndex } from './insightApi.js'
import { seedTree, makeVideo, TREE } from './mediaFixture.js'

test.describe.serial('folder navigation', () => {
  let tree

  const SLOT = Number.parseInt(process.env.INSIGHT_TEST_SLOT || '48', 10) // a high slot, unlikely to be in use on a dev instance
  if (!Number.isInteger(SLOT) || SLOT < 1) throw new Error('INSIGHT_TEST_SLOT must be a positive integer')

  const lib = {
    folder: (page, path) => page.locator(`[data-testid="library-folder"][data-path="${path}"]`),
    file: (page, path) => page.locator(`[data-testid="library-file"][data-path="${path}"]`),
    browser: (page) => page.getByTestId('library-browser'),
    breadcrumb: (page) => page.getByTestId('library-breadcrumb'),
  }

  const assign = {
    folder: (page, p) => page.locator(`[data-testid="assign-folder"][data-path="${p}"]`),
    file: (page, p) => page.locator(`[data-testid="assign-file"][data-path="${p}"]`),
  }

  test.beforeAll(() => {
    tree = seedTree()
  })

  // The suite drives one slot end to end, so refuse to run when somebody else is using it.
  test.beforeAll(async ({ request }) => {
    const src = await sourceByIndex(request, SLOT)
    if (!(src && !src.file && src.state !== 'playing')) {
      throw new Error(`slot ${SLOT} is in use (file="${src?.file}", state=${src?.state}); free it or set INSIGHT_TEST_SLOT to a free slot`)
    }
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
      try {
        tree.cleanup()
      } catch (err) {
        console.warn('fixture cleanup failed', err)
      }
    }
  })

  async function navigateAssignTo(page, folderPath) {
    const segments = folderPath.split('/').reduce((acc, seg) => [...acc, acc.length ? `${acc.at(-1)}/${seg}` : seg], [])
    for (const segment of segments) await assign.folder(page, segment).click()
  }

  async function assignViaDialog(page, filePath) {
    await page.getByTestId(`source-file-${SLOT}`).click()
    const dialog = page.getByTestId('assign-dialog')
    await expect(dialog).toBeVisible()
    const root = dialog.getByRole('button', { name: 'Go to Media Root' })
    if (await root.isEnabled()) await root.click()
    await expect(dialog.getByTestId('assign-browser')).toHaveAttribute('data-folder', '')
    await navigateAssignTo(page, filePath.split('/').slice(0, -1).join('/'))
    await assign.file(page, filePath).locator('.media-row-preview').click()
    await expect(page.getByTestId('assign-picked')).toHaveText(filePath)
    await dialog.getByRole('button', { name: 'Assign' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId(`source-file-${SLOT}`)).toHaveText(filePath)
  }

  test('1. root lists the test folder with its streamable count and greys out unsupported files', async ({ page }) => {
    await openTab(page, '/media')
    const row = lib.folder(page, tree.name)
    await expect(row).toBeVisible()
    await expect(row.locator('.folder-count')).toHaveText(String(TREE.videos.length))
    await row.click()
    const readme = lib.file(page, `${tree.name}/readme.md`)
    await expect(readme).toHaveAttribute('data-streamable', 'false')
    await expect(readme).toHaveClass(/unsupported/)
  })

  test('2. entering three levels deep updates the breadcrumb and greys out notes.txt', async ({ page }) => {
    await openTab(page, '/media')
    await lib.folder(page, tree.name).click()
    await lib.folder(page, `${tree.name}/30FPS`).click()
    await lib.folder(page, `${tree.name}/30FPS/indoor`).click()
    await expect(lib.browser(page)).toHaveAttribute('data-folder', `${tree.name}/30FPS/indoor`)
    await expect(lib.breadcrumb(page)).toContainText('Media Root')
    await expect(lib.breadcrumb(page).locator('.crumb-current')).toHaveText('indoor')
    await expect(lib.file(page, `${tree.name}/30FPS/indoor/lobby.mp4`)).toBeVisible()
    await expect(lib.file(page, `${tree.name}/30FPS/indoor/notes.txt`)).toHaveAttribute('data-streamable', 'false')
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

  test('10. an empty folder says so, and the assign dialog explains the files it hides', async ({ page }) => {
    await openTab(page, '/media')
    await lib.folder(page, tree.name).click()
    await lib.folder(page, `${tree.name}/empty`).click()
    await expect(page.getByTestId('library-empty')).toHaveText('This folder is empty.')

    await openTab(page, '/streaming')
    await page.getByTestId(`source-file-${SLOT}`).click()
    const dialog = page.getByTestId('assign-dialog')
    await expect(dialog).toBeVisible()
    await navigateAssignTo(page, `${tree.name}/30FPS/indoor`)
    await expect(page.getByTestId('assign-hidden-note')).toHaveText('1 file hidden because Insight cannot stream it.')
    await expect(assign.file(page, `${tree.name}/30FPS/indoor/notes.txt`)).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
  })

  test('6. an upload through the import dialog lands at the media root', async ({ page, request }) => {
    const uploadName = `${tree.name}-upload.mp4`
    const local = path.join(os.tmpdir(), uploadName)
    makeVideo(local)
    try {
      await openTab(page, '/media')
      await page.getByRole('button', { name: 'Import Media' }).click()
      await page.locator('input[type="file"]').setInputFiles(local)
      await expect(lib.file(page, uploadName)).toBeVisible({ timeout: 90_000 })
      await expect(lib.browser(page)).toHaveAttribute('data-folder', '')
    } finally {
      fs.rmSync(local, { force: true })
      const r = await request.post('/api/delete-media', { data: { path: uploadName } })
      if (!r.ok()) console.warn(`cleanup of ${uploadName} failed: ${r.status()}`)
    }
  })

  test('7. the assign dialog navigates folders and stores the nested relative path', async ({ page, request }) => {
    await openTab(page, '/streaming')
    const deep = `${tree.name}/30FPS/indoor/cam-a/deep.mp4`
    await assignViaDialog(page, deep)
    expect((await sourceByIndex(request, SLOT)).file).toBe(deep)
  })

  test('8. start, stop, start again, then reassign while playing keeps the source live on the new file', async ({ page, request }) => {
    test.setTimeout(300_000)
    await openTab(page, '/streaming')
    const deep = `${tree.name}/30FPS/indoor/cam-a/deep.mp4`
    const drone = `${tree.name}/120FPS-720p-h264/drone.mp4`
    if ((await sourceByIndex(request, SLOT)).file !== deep) await assignViaDialog(page, deep)

    await page.getByRole('button', { name: `Start src${SLOT}` }).click()
    await expect.poll(async () => (await sourceByIndex(request, SLOT)).state, { timeout: 60_000 }).toBe('playing')
    await page.getByRole('button', { name: `Stop src${SLOT}` }).click()
    await expect.poll(async () => (await sourceByIndex(request, SLOT)).state, { timeout: 30_000 }).toBe('stopped')
    await page.getByRole('button', { name: `Start src${SLOT}` }).click()
    await expect.poll(async () => (await sourceByIndex(request, SLOT)).state, { timeout: 60_000 }).toBe('playing')

    await assignViaDialog(page, drone) // the assign endpoint restarts a playing source
    await expect.poll(async () => {
      const src = await sourceByIndex(request, SLOT)
      return `${src.state}:${src.file}`
    }, { timeout: 60_000 }).toBe(`playing:${drone}`)

    await page.getByRole('button', { name: `Stop src${SLOT}` }).click()
    await expect.poll(async () => (await sourceByIndex(request, SLOT)).state, { timeout: 30_000 }).toBe('stopped')
  })

  test('9. deleting a nested file removes it from the list and decrements the folder count', async ({ page }) => {
    await openTab(page, '/media')
    const nested = TREE.videos.filter((v) => v.startsWith('30FPS/')).length
    const target = `${tree.name}/30FPS/highway.mp4`
    await lib.folder(page, tree.name).click()
    await expect(lib.folder(page, `${tree.name}/30FPS`).locator('.folder-count')).toHaveText(String(nested))
    await lib.folder(page, `${tree.name}/30FPS`).click()
    await lib.file(page, target).locator('.media-row-preview').click()
    await page.getByRole('button', { name: 'Delete Selected' }).click()
    await page.getByRole('dialog', { name: 'Confirm deletion' }).getByRole('button', { name: 'Delete' }).click()
    await expect(lib.file(page, target)).toHaveCount(0)
    await expect(lib.browser(page)).toHaveAttribute('data-folder', `${tree.name}/30FPS`)
    await page.getByRole('button', { name: 'Back to parent folder' }).click()
    await expect(lib.folder(page, `${tree.name}/30FPS`).locator('.folder-count')).toHaveText(String(nested - 1))
  })
})
