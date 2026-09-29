import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'

import { openTab, sourceByIndex } from './insightApi.js'

// A test publisher fills src45 so src46 can pull it back through the Stream URL tab (issue #127).
const PUBLISH_BASE = process.env.INSIGHT_RTSP_PUBLISH_BASE || 'rtsp://127.0.0.1:8554'
const PULL_BASE = process.env.INSIGHT_RTSP_PULL_BASE || 'rtsp://127.0.0.1:8554'
// The folder-navigation suite uses INSIGHT_TEST_SLOT (default 48); stay clear of it.
const CAMERA_SLOT = 45
const SLOT = 46
let publisher

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  publisher = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '15', '-pix_fmt', 'yuv420p',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', `${PUBLISH_BASE}/src${CAMERA_SLOT}`], { stdio: 'ignore' })
})

test.afterAll(async ({ request }) => {
  await request.post('/api/mediasrc/stop', { data: { index: SLOT } }).catch(() => {})
  if (publisher && publisher.exitCode === null) publisher.kill('SIGTERM')
})

test('pull a stream into a slot through the dialog, watch it go live, then stop it', async ({ page, request }) => {
  await expect.poll(async () => (await sourceByIndex(request, CAMERA_SLOT)).state, { timeout: 20_000 }).toBe('external')
  await openTab(page, '/streaming')
  await page.getByTestId(`source-file-${SLOT}`).click()
  const dialog = page.getByTestId('assign-dialog')
  await dialog.getByTestId('assign-tab-stream').click()
  await expect(dialog.getByTestId('pull-submit')).toBeDisabled()
  await dialog.getByTestId('pull-url').fill(`${PULL_BASE}/src${CAMERA_SLOT}`)
  await dialog.getByTestId('pull-submit').click()
  await expect(dialog).toHaveCount(0)

  await expect.poll(async () => {
    const src = await sourceByIndex(request, SLOT)
    return `${src.state}:${src.pull?.status}`
  }, { timeout: 20_000 }).toBe('pulled:live')
  const row = page.locator('.source-row.pulled').filter({ hasText: `src${SLOT}` })
  await expect(row.locator('.src-state')).toHaveText('Pulled')
  await expect(row.locator('.pull-chip')).toContainText('320×240')
  await row.click()
  await expect(page.locator('.kv-table')).toContainText(`${PULL_BASE}/src${CAMERA_SLOT}`)
  const slot = await sourceByIndex(request, SLOT)
  expect(JSON.stringify(slot)).not.toContain('password')

  await page.getByRole('button', { name: `Stop src${SLOT}` }).click()
  await expect.poll(async () => (await sourceByIndex(request, SLOT)).state, { timeout: 20_000 }).toBe('stopped')
  await expect(page.getByTestId(`source-file-${SLOT}`)).toBeVisible()
})

test('an unreachable camera still configures the pull and the row says Unreachable until stopped', async ({ page }) => {
  await openTab(page, '/streaming')
  await page.getByTestId(`source-file-${SLOT}`).click()
  const dialog = page.getByTestId('assign-dialog')
  await dialog.getByTestId('assign-tab-stream').click()
  await dialog.getByTestId('pull-url').fill('rtsp://127.0.0.1:1/nothing-listens-here')
  await dialog.getByTestId('pull-submit').click()
  // Unreachable still configures the pull: the dialog closes and the row says why.
  await expect(dialog).toHaveCount(0)
  const row = page.locator('.source-row.pulled').filter({ hasText: `src${SLOT}` })
  await expect(row.locator('.src-state')).toHaveText('Unreachable', { timeout: 15_000 })
  await page.getByRole('button', { name: `Stop src${SLOT}` }).click()
  await expect(page.getByTestId(`source-file-${SLOT}`)).toBeVisible()
})
