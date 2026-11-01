import { expect, test } from '@playwright/test'
import http from 'node:http'

// Previewing a browser camera in Media Sources (issue #222), on the page and inside frames set up
// like the Palette SDK editor tab's code-server webview. The cameras are Chrome's fake devices (the
// config asks for two). The library is answered here, and every request to /api/mediasrc is
// recorded: a preview must never assign, start or stop a Streaming slot.
//
// VS Code's webview (src/vs/workbench/contrib/webview/browser/webviewElement.ts and pre/index.html)
// is two same-origin frames, code-server serves them from its own origin, and neither delegates
// the camera; the extension's page then frames Insight, which is on another port.
const SDK_WEBVIEW_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads'
const SDK_WEBVIEW_ALLOW = 'cross-origin-isolated; autoplay; local-network-access; clipboard-read; clipboard-write'
// A 1x1 PNG, so the file preview has something to show.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const FILE = 'camera-preview-sample.png'

// The editor tab's pages, served from a real loopback port like code-server's, so Insight's frame is
// cross-origin to them as in the SDK (code-server and Insight listen on different ports).
let editorServer = null

test.afterEach(async () => {
  if (!editorServer) return
  await new Promise((resolve) => editorServer.close(resolve))
  editorServer = null
})

async function serveEditorTab(pages) {
  editorServer = http.createServer((req, res) => {
    const html = pages[new URL(req.url, 'http://editor').pathname]
    res.writeHead(html ? 200 : 404, { 'Content-Type': 'text/html' })
    res.end(html || '')
  })
  await new Promise((resolve) => editorServer.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${editorServer.address().port}/`
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function mockInsight(page) {
  const slotWrites = []
  await page.route(/\/api\/media-files(\?|$)/, (route) => json(route, [{ type: 'file', name: FILE, path: FILE, streamable: false }]))
  await page.route(/\/api\/media-info$/, (route) => json(route, { format: 'png', width: 1, height: 1 }))
  await page.route(new RegExp(`/media/${FILE}$`), (route) => route.fulfill({ contentType: 'image/png', body: PNG }))
  await page.route(/\/api\/mediasrc/, (route) => {
    const request = route.request()
    if (request.method() !== 'GET') {
      slotWrites.push(`${request.method()} ${new URL(request.url()).pathname}`)
      return json(route, { error: 'a camera preview must not change slots' }, 500)
    }
    return json(route, [])
  })
  return slotWrites
}

// Runs in every frame: records each stream the preview opens, and lets a test hold the next camera
// open (to see the loading state) or fail it with a given error name. Only the preview's requests
// (which name a device) are touched, not the Enable camera access probe.
function instrumentCameras() {
  const media = navigator.mediaDevices
  if (!media?.getUserMedia) return
  const original = media.getUserMedia.bind(media)
  window.__cameraStreams = []
  window.__cameraFault = null
  window.__cameraHold = null
  media.getUserMedia = async (constraints) => {
    if (!constraints?.video?.deviceId) return original(constraints)
    if (window.__cameraHold) await window.__cameraHold.promise
    if (window.__cameraFault) throw new DOMException('Injected by the test', window.__cameraFault)
    const stream = await original(constraints)
    window.__cameraStreams.push(stream)
    return stream
  }
}

// Opens Media Sources on the page, or in an SDK-like editor tab: code-server's page holding the
// webview frame and its content frame, with VS Code's sandbox and allow attributes, which holds
// Insight's frame. `allowCamera` adds allow="camera" to Insight's frame.
async function openMediaSources(page, { embedded = false, allowCamera = false } = {}) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('neat-insight:onboarding-seen', '1')
    } catch {}
  })
  await page.addInitScript(instrumentCameras)
  const url = new URL('/media', test.info().project.use.baseURL)
  if (!embedded) {
    await page.goto(url.href)
    return { ui: page, frame: () => page.mainFrame() }
  }
  const frame = (src, attrs = '') => '<!doctype html><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>' +
    `<iframe src="${src}"${attrs}></iframe>`
  const webview = ` sandbox="${SDK_WEBVIEW_SANDBOX}" allow="${SDK_WEBVIEW_ALLOW}"`
  const editor = await serveEditorTab({
    '/': frame('/webview', webview),
    '/webview': frame('/content', webview),
    '/content': frame(url.href, ` title="Insight"${allowCamera ? ' allow="camera"' : ''}`)
  })
  await page.goto(editor)
  // Insight's frame, found by origin: its path follows the selected tab.
  const insight = () => page.frames().find((f) => f.url().startsWith(`${url.origin}/`))
  await expect.poll(() => Boolean(insight())).toBe(true)
  return { ui: page.frameLocator('iframe').frameLocator('iframe').frameLocator('iframe'), frame: insight }
}

async function enableCameras(ui) {
  // The permission is pre-granted, so the list may already be there and the button says Refresh.
  await ui.getByRole('button', { name: /^(Enable camera access|Refresh cameras)$/ }).click()
}

const preview = (ui) => ui.getByTestId('camera-preview')
const rows = (ui) => ui.getByTestId('camera-row')

// The state of each preview stream's video track, in the order they were opened.
function trackStates(frame) {
  return frame.evaluate(() => window.__cameraStreams.map((s) => s.getVideoTracks().map((t) => t.readyState).join(',')))
}

function videoFacts(frame) {
  return frame.evaluate(() => {
    const video = document.querySelector('[data-testid="camera-preview-video"]')
    const track = video?.srcObject?.getVideoTracks?.()[0]
    return track ? { videoWidth: video.videoWidth, paused: video.paused, settings: track.getSettings(), label: track.label } : null
  })
}

async function expectLivePreview(ui, frame, label) {
  await expect(preview(ui)).toHaveAttribute('data-status', 'live')
  await expect(ui.getByTestId('camera-preview-name')).toHaveText(label)
  await expect.poll(async () => (await videoFacts(frame()))?.videoWidth || 0).toBeGreaterThan(0)
  const facts = await videoFacts(frame())
  expect(facts.label).toBe(label)
  expect(facts.paused).toBe(false)
  return facts
}

for (const mode of [{ name: 'on the page' }, { name: 'in an SDK editor tab frame that allows the camera', embedded: true, allowCamera: true }]) {
  test.describe(mode.name, () => {
    let slotWrites

    test.beforeEach(async ({ page }) => {
      slotWrites = await mockInsight(page)
    })

    test.afterEach(() => {
      expect(slotWrites, 'a camera preview must not assign, start or stop a Streaming slot').toEqual([])
    })

    test('selecting a camera previews it with its active settings and, separately, its capabilities', async ({ page }) => {
      const { ui, frame } = await openMediaSources(page, mode)
      await enableCameras(ui)
      await expect(rows(ui)).toHaveCount(2)
      const label = (await rows(ui).first().textContent()).trim()
      await rows(ui).first().click()
      await expect(rows(ui).first()).toHaveAttribute('aria-pressed', 'true')
      await expect(ui.getByRole('heading', { name: 'Selected Camera' })).toBeVisible()

      const { settings } = await expectLivePreview(ui, frame, label)
      const active = ui.getByTestId('camera-active-settings')
      await expect(active).toContainText(`${settings.width}×${settings.height}`)
      await expect(active).toContainText(`${Math.round(settings.frameRate)} fps`)
      await expect(active).not.toContainText('up to')
      await expect(ui.getByTestId('camera-capabilities')).toContainText('up to')
      await expect(preview(ui)).toContainText('does not assign a Streaming slot')
    })

    test('switching cameras releases the previous one, and leaving the tab releases the preview', async ({ page }) => {
      const { ui, frame } = await openMediaSources(page, mode)
      await enableCameras(ui)
      const labels = (await rows(ui).allTextContents()).map((t) => t.trim())
      await rows(ui).nth(0).click()
      await expectLivePreview(ui, frame, labels[0])
      await rows(ui).nth(1).click()
      await expectLivePreview(ui, frame, labels[1])
      await expect(rows(ui).nth(0)).toHaveAttribute('aria-pressed', 'false')
      expect(await trackStates(frame())).toEqual(['ended', 'live'])

      await ui.getByRole('tab', { name: 'Streaming', exact: true }).click()
      await expect.poll(() => trackStates(frame())).toEqual(['ended', 'ended'])
      await ui.getByRole('tab', { name: 'Media Sources', exact: true }).click()
      await expect(ui.getByRole('heading', { name: 'Selected Media' })).toBeVisible()
      await expect(preview(ui)).toHaveCount(0)
      expect(await trackStates(frame()), 'coming back does not reopen the camera').toHaveLength(2)
    })

    test('picking a file goes back to the file preview and releases the camera', async ({ page }) => {
      const { ui, frame } = await openMediaSources(page, mode)
      await enableCameras(ui)
      await rows(ui).first().click()
      await expect(preview(ui)).toHaveAttribute('data-status', 'live')
      await ui.locator(`[data-testid="library-file"][data-path="${FILE}"] .media-row-preview`).click()
      await expect(ui.getByRole('heading', { name: 'Selected Media' })).toBeVisible()
      await expect(ui.locator('.preview img')).toHaveAttribute('src', `/media/${FILE}`)
      await expect.poll(() => frame().evaluate(() => document.querySelector('.preview img')?.naturalWidth || 0)).toBe(1)
      await expect.poll(() => trackStates(frame())).toEqual(['ended'])
    })

    test('loading, denied, busy and disconnected cameras each say what to do', async ({ page }) => {
      const { ui, frame } = await openMediaSources(page, mode)
      await enableCameras(ui)
      const label = (await rows(ui).first().textContent()).trim()

      // Loading: the camera has not opened yet. Cancel stops it as soon as it does.
      await frame().evaluate(() => {
        let release
        window.__cameraHold = { promise: new Promise((resolve) => { release = resolve }), release }
      })
      await rows(ui).first().click()
      await expect(preview(ui)).toHaveAttribute('data-status', 'loading')
      await expect(ui.getByTestId('camera-preview-loading')).toContainText('allow camera access')
      await ui.getByRole('button', { name: 'Cancel' }).click()
      await expect(preview(ui)).toHaveCount(0)
      await frame().evaluate(() => { window.__cameraHold.release(); window.__cameraHold = null })
      await expect.poll(() => trackStates(frame())).toEqual(['ended'])

      for (const [fault, kind, retry] of [['NotAllowedError', 'denied', 'Try again'], ['NotReadableError', 'busy', 'Try again'], ['NotFoundError', 'disconnected', 'Refresh cameras']]) {
        await frame().evaluate((name) => { window.__cameraFault = name }, fault)
        await rows(ui).first().click()
        await expect(preview(ui)).toHaveAttribute('data-status', 'error')
        await expect(ui.getByTestId('camera-preview-error')).toHaveAttribute('data-kind', kind)
        await expect(ui.getByRole('alert').filter({ hasText: /camera/i }).first()).toBeAttached()
        await frame().evaluate(() => { window.__cameraFault = null })
        await preview(ui).getByRole('button', { name: retry }).click()
        await expectLivePreview(ui, frame, label)
        await ui.getByRole('button', { name: 'Stop preview' }).click()
        await expect(preview(ui)).toHaveCount(0)
      }

      // The camera going away mid-preview (the browser ends the track).
      await rows(ui).first().click()
      await expectLivePreview(ui, frame, label)
      await frame().evaluate(() => document.querySelector('[data-testid="camera-preview-video"]').srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended')))
      await expect(ui.getByTestId('camera-preview-error')).toHaveAttribute('data-kind', 'disconnected')
      await expect(ui.getByTestId('camera-preview-error')).toContainText('Refresh cameras')
      expect((await trackStates(frame())).every((state) => state === 'ended')).toBe(true)
    })
  })
}

test('in an SDK editor tab frame without allow="camera", Insight says the frame blocks the camera', async ({ page }) => {
  const slotWrites = await mockInsight(page)
  const { ui, frame } = await openMediaSources(page, { embedded: true, allowCamera: false })
  expect(await frame().evaluate(() => document.featurePolicy?.allowsFeature('camera'))).toBe(false)
  await enableCameras(ui)
  await expect(ui.locator('.camera-optin-error')).toContainText('embedded in a frame that does not allow camera access')
  await expect(ui.locator('.camera-optin-error')).toContainText('own browser tab')
  // Chrome still lists the cameras (the permission itself is granted); previewing one says the same.
  await rows(ui).first().click()
  await expect(ui.getByTestId('camera-preview-error')).toHaveAttribute('data-kind', 'blocked')
  await expect(preview(ui).getByRole('button', { name: 'Try again' })).toHaveCount(0)
  expect(await trackStates(frame())).toEqual([])
  expect(slotWrites).toEqual([])
})
