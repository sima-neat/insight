import { expect, test } from '@playwright/test'

// GenAI Studio's confirmations (issue #221), each on the page itself and inside a frame sandboxed
// like the Palette SDK editor tab's webview: no allow-modals, so the browser's confirm() answers no
// at once there. The board behind Insight's /api/genai relay is answered here; no board is needed.
const SDK_WEBVIEW_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads'

const LLAMA = 'Llama-3.2-3B-Instruct'
const LLAMA_1B = 'Llama-3.2-1B-Instruct'
// Another build of LLAMA: the tab shows both as Llama 3.2 3B.
const LLAMA_AWQ = 'Llama-3.2-3B-Instruct-AWQ'
const QWEN = 'Qwen2.5-VL-3B-Instruct'

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

// A board with one chat model loaded, a vision model on disk, and documents. `posts` records what
// the tab asked the board to do.
async function mockBoard(page) {
  const board = {
    catalog: [
      { name: LLAMA, type: 'chat', sizeBytes: 2_000_000_000 },
      { name: LLAMA_1B, type: 'chat', sizeBytes: 1_000_000_000 },
      { name: LLAMA_AWQ, type: 'chat', sizeBytes: 2_000_000_000 },
      { name: QWEN, type: 'vlm', supportsVision: true, estimatedLoadS: 90, sizeBytes: 3_200_000_000 }
    ],
    loaded: [LLAMA],
    posts: []
  }
  await page.route(/\/api\/genai\//, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api\/genai\//, '')
    if (request.method() === 'POST') {
      board.posts.push({ path, body: request.postDataJSON() })
      if (path === 'models/load') board.loaded = [request.postDataJSON().name]
      if (path === 'models/delete') board.catalog = board.catalog.filter((m) => m.name !== request.postDataJSON().name)
      if (path === 'rag/clear') return route.fulfill({ status: 200, contentType: 'text/plain', body: '✅ Documents cleared.\n' })
      return json(route, { ok: true })
    }
    if (path === 'settings') return json(route, { url: 'https://192.168.1.20:5000' })
    if (path === 'health') return json(route, { ok: true, api_version: 1, model_server: { reachable: true }, features: { rag: true } })
    if (path === 'models/status') return json(route, { catalog: board.catalog, loaded: board.loaded, maxResident: 1 })
    if (path === 'rag/status') return json(route, { database: true, service: 'ok', sections: 3 })
    return json(route, { error: 'not part of this test' }, 404)
  })
  return board
}

// Opens the GenAI tab on the page, or inside the SDK-like sandboxed frame. Returns where its UI is.
async function openGenAI(page, embedded) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('neat-insight:onboarding-seen', '1')
      window.localStorage.setItem('neat-insight:genai-tutorial-seen', '1')
    } catch {}
  })
  const url = new URL('/genai', test.info().project.use.baseURL).href
  if (!embedded) {
    await page.goto(url)
    return page
  }
  // The editor tab: the webview's document (outer, sandboxed) holds Insight's frame (inner), as
  // code-server's does. Served from Insight's own origin, so the browser keeps Insight's storage.
  const editor = new URL('/__sdk-editor-tab', url).href
  const inner = '<style>html,body{margin:0;height:100%}</style>' +
    `<iframe src="${url}" title="Insight" style="border:0;width:100%;height:100%"></iframe>`
  await page.route(editor, (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><style>html,body{margin:0;height:100%}</style>' +
      `<iframe sandbox="${SDK_WEBVIEW_SANDBOX}" srcdoc='${inner}' style="border:0;width:100%;height:100%"></iframe>`
  }))
  await page.goto(editor)
  return page.frameLocator('iframe').frameLocator('iframe')
}

async function insightFrame(page) {
  await expect.poll(() => page.frames().some((f) => f.url().endsWith('/genai'))).toBe(true)
  return page.frames().find((f) => f.url().endsWith('/genai'))
}

for (const embedded of [false, true]) {
  test.describe(embedded ? 'in a sandboxed SDK editor tab' : 'on the page', () => {
    let board
    let ui
    const nativeDialogs = []

    test.beforeEach(async ({ page }) => {
      nativeDialogs.length = 0
      // A native dialog would show here; the tab must ask in the page instead.
      page.on('dialog', (dialog) => {
        nativeDialogs.push(dialog.message())
        dialog.dismiss().catch(() => {})
      })
      board = await mockBoard(page)
      ui = await openGenAI(page, embedded)
      await expect(ui.getByRole('combobox', { name: 'Model' })).toHaveValue(LLAMA)
    })

    test.afterEach(() => {
      expect(nativeDialogs).toEqual([])
    })

    if (embedded) {
      test('the frame blocks the browser confirm(), as the SDK tab does', async ({ page }) => {
        const frame = await insightFrame(page)
        expect(await frame.evaluate(() => window.confirm('probe'))).toBe(false)
      })
    }

    test('switching the chat model asks first; Cancel and Esc keep the current one', async () => {
      const picker = ui.getByRole('combobox', { name: 'Model' })
      const ask = ui.getByRole('alertdialog', { name: 'Load the model' })

      // selectOption doesn't focus the menu; a person choosing from it does.
      await picker.focus()
      await picker.selectOption(QWEN)
      await expect(ask).toContainText('Load Qwen2.5 VL 3B? It takes about 1 min 30 s. Llama 3.2 3B is unloaded first.')
      await expect(ask.getByRole('button', { name: 'Load' })).toBeFocused()
      await ask.getByRole('button', { name: 'Cancel' }).click()
      await expect(ask).toHaveCount(0)
      await expect(picker).toHaveValue(LLAMA)
      await expect(picker).toBeFocused()

      await picker.selectOption(QWEN)
      await expect(ask).toBeVisible()
      await ask.press('Escape')
      await expect(ask).toHaveCount(0)
      await expect(picker).toHaveValue(LLAMA)
      expect(board.posts).toEqual([])

      await picker.selectOption(QWEN)
      await ask.getByRole('button', { name: 'Load' }).click()
      await expect(ask).toHaveCount(0)
      await expect.poll(() => board.posts).toEqual([{ path: 'models/load', body: { name: QWEN } }])
      await expect(picker).toHaveValue(QWEN)
    })

    test('a load question is asked again when the board changes what the load unloads', async () => {
      const picker = ui.getByRole('combobox', { name: 'Model' })
      const ask = ui.getByRole('alertdialog', { name: 'Load the model' })

      await picker.selectOption(QWEN)
      await expect(ask).toContainText('Llama 3.2 3B is unloaded first.')
      // Another client loads a different model while the question is open; the status poll sees it.
      board.loaded = [LLAMA_1B]
      await expect(picker).toHaveValue(LLAMA_1B)

      await ask.getByRole('button', { name: 'Load' }).click()
      await expect(ask).toContainText('Llama 3.2 1B is unloaded first.')
      expect(board.posts).toEqual([])

      await ask.getByRole('button', { name: 'Load' }).click()
      await expect(ask).toHaveCount(0)
      await expect.poll(() => board.posts).toEqual([{ path: 'models/load', body: { name: QWEN } }])
    })

    test('a load question is asked again when another build of the same model is loaded', async ({ page }) => {
      const picker = ui.getByRole('combobox', { name: 'Model' })
      const ask = ui.getByRole('alertdialog', { name: 'Load the model' })
      const question = 'Load Qwen2.5 VL 3B? It takes about 1 min 30 s. Llama 3.2 3B is unloaded first.'

      await picker.selectOption(QWEN)
      await expect(ask).toContainText(question)
      // Another client swaps in another build; the question reads the same, but the load would
      // unload a different model than the one the user was asked about.
      board.loaded = [LLAMA_AWQ]
      await expect(picker).toHaveValue(LLAMA_AWQ)

      await ask.getByRole('button', { name: 'Load' }).click()
      // The question closes and opens again; give a load sent by mistake time to arrive.
      await page.waitForTimeout(500)
      await expect(ask).toContainText(question)
      expect(board.posts).toEqual([])

      await ask.getByRole('button', { name: 'Load' }).click()
      await expect(ask).toHaveCount(0)
      await expect.poll(() => board.posts).toEqual([{ path: 'models/load', body: { name: QWEN } }])
    })

    test('loading from the Settings model list asks the same question as the menu', async () => {
      await ui.getByRole('button', { name: 'Settings', exact: true }).click()
      const load = ui.getByRole('button', { name: 'Load Qwen2.5 VL 3B' })
      const ask = ui.getByRole('alertdialog', { name: 'Load the model' })

      await load.click()
      await expect(ask).toContainText('Load Qwen2.5 VL 3B? It takes about 1 min 30 s. Llama 3.2 3B is unloaded first.')
      await ask.getByRole('button', { name: 'Cancel' }).click()
      await expect(ask).toHaveCount(0)
      await expect(load).toBeFocused()
      expect(board.posts).toEqual([])

      await load.click()
      await ask.getByRole('button', { name: 'Load' }).click()
      await expect(ask).toHaveCount(0)
      await expect.poll(() => board.posts).toEqual([{ path: 'models/load', body: { name: QWEN } }])
    })

    test('deleting a model asks first, with Cancel focused; a click outside cancels', async () => {
      await ui.getByRole('button', { name: 'Settings', exact: true }).click()
      const remove = ui.getByRole('button', { name: 'Delete Qwen2.5 VL 3B' })
      const ask = ui.getByRole('alertdialog', { name: 'Delete the model' })

      await remove.click()
      await expect(ask).toContainText('Delete Qwen2.5 VL 3B (3.2 GB) from the board? Its files are removed; download it again to use it.')
      await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused()
      // Tab stays inside the dialog.
      await ask.press('Tab')
      await expect(ask.getByRole('button', { name: 'Delete' })).toBeFocused()
      await ask.press('Tab')
      await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused()
      await ask.click({ position: { x: 100, y: 100 } })
      await expect(ask).toHaveCount(0)
      await expect(remove).toBeFocused()
      expect(board.posts).toEqual([])

      await remove.click()
      await ask.getByRole('button', { name: 'Delete' }).click()
      await expect.poll(() => board.posts).toEqual([{ path: 'models/delete', body: { name: QWEN } }])
    })

    test('clearing the documents asks first', async () => {
      await ui.getByRole('button', { name: 'Settings', exact: true }).click()
      const clear = ui.getByRole('region', { name: 'Documents' }).getByRole('button', { name: 'Clear' })
      const ask = ui.getByRole('alertdialog', { name: 'Clear the documents' })

      await clear.click()
      await expect(ask).toContainText('Remove all documents from the board? Use my documents then finds nothing until you upload or reset.')
      await ask.getByRole('button', { name: 'Cancel' }).click()
      await expect(ask).toHaveCount(0)
      expect(board.posts).toEqual([])

      await clear.click()
      await ask.getByRole('button', { name: 'Clear' }).click()
      await expect.poll(() => board.posts.map((p) => p.path)).toEqual(['rag/clear'])
    })

    test('opening a SiMaSentry app the model cannot serve asks first; Esc keeps Solutions open', async () => {
      await ui.getByRole('button', { name: 'SiMaSentry Solutions' }).click()
      const solutions = ui.getByRole('dialog', { name: 'SiMaSentry Solutions' })
      const ask = ui.getByRole('alertdialog', { name: 'Open SiMaSentry-Med' })

      await solutions.getByRole('button', { name: /SiMaSentry-Med/ }).click()
      await expect(ask).toContainText("Llama 3.2 3B doesn't see images, so the SiMaSentry-Med picture features won't work. Open it anyway?")
      // Dark text on the white card.
      const ink = 'rgb(15, 29, 43)'
      await expect(ask.getByRole('heading', { name: 'Open SiMaSentry-Med' })).toHaveCSS('color', ink)
      await expect(ask.getByRole('button', { name: 'Cancel' })).toHaveCSS('color', ink)
      await ask.press('Escape')
      await expect(ask).toHaveCount(0)
      await expect(solutions).toBeVisible()
      await expect(solutions.locator('iframe')).toHaveCount(0)

      await solutions.getByRole('button', { name: /SiMaSentry-Med/ }).click()
      await ask.getByRole('button', { name: 'Open anyway' }).click()
      await expect(solutions.locator('iframe[title="SiMaSentry-Med"]')).toHaveCount(1)
    })
  })
}
