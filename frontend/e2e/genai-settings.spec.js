import { expect, test } from '@playwright/test'

// GenAI Studio's Settings page: its tabs and the model catalog. The board behind Insight's
// /api/genai relay is answered here; no board is needed.
const QWEN = 'Qwen3-0.6B-Autoround-a16w4'
const LLAMA = 'Llama-3.2-3B-Instruct'
const WHISPER = 'whisper-small-a16w8'
const VISION_REPO = 'simaai/Qwen3-VL-4B-Instruct-Autoround-a16w4'
const SPEECH_REPO = 'simaai/whisper-medium-a16w8'

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

// A board with a chat model in use, another on disk and a speech model, that can keep two chat
// models loaded. `hub` is what Hugging Face answers; `searches` and `cards` count what was asked.
async function mockBoard(page, { hub = true, maxResident = 2, offered = 0, loaded = [QWEN] } = {}) {
  const board = {
    catalog: [
      { name: QWEN, type: 'chat', sizeBytes: 893_000_000 },
      { name: LLAMA, type: 'chat', sizeBytes: 3_700_000_000 },
      { name: WHISPER, type: 'asr', activeAsr: true, sizeBytes: 1_300_000_000 }
    ],
    loaded,
    posts: [],
    hub,
    statusDelay: 0,
    hubEnabled: true,
    searches: 0,
    cards: 0,
    finishDownload: null
  }
  await page.route(/\/api\/genai\//, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api\/genai\//, '')
    if (request.method() === 'POST') {
      if (path === 'models/hub/download') {
        const repoId = request.postDataJSON().repoId
        // The board can list a model before its download ends.
        const model = { name: repoId.split('/')[1], type: 'asr', sizeBytes: 2_400_000_000, complete: false, incompleteReason: 'download is incomplete' }
        board.catalog.push(model)
        await new Promise((resolve) => { board.finishDownload = resolve })
        model.complete = true
        delete model.incompleteReason
        const lines = [{ state: 'downloading', repoId, pct: 40 }, { state: 'done', repoId, name: repoId.split('/')[1] }]
        return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lines.map((l) => JSON.stringify(l)).join('\n') + '\n' })
      }
      board.posts.push(path)
      if (path === 'settings') {
        board.url = request.postDataJSON().url
        return json(route, { url: board.url })
      }
      return json(route, { ok: true })
    }
    if (path === 'settings') return json(route, { url: board.url || 'https://192.168.1.20:5000' })
    if (path === 'health') return json(route, { ok: true, api_version: 1, model_server: { reachable: true }, features: { rag: true, benchmark: true } })
    if (path === 'models/status') {
      await new Promise((resolve) => setTimeout(resolve, board.statusDelay))
      return json(route, {
        catalog: board.catalog,
        loaded: board.loaded,
        resident: board.loaded,
        maxResident,
        asrModel: WHISPER,
        hubEnabled: board.hubEnabled,
        disk: { freeBytes: 459_000_000_000, totalBytes: 512_000_000_000 }
      })
    }
    if (path === 'rag/status') return json(route, { enabled: true, database: true, service: 'ok', meta: { chunks: 8, input: '/x/neat.md' } })
    if (path === 'models/hub/search') {
      board.searches += 1
      if (!board.hub) return json(route, { enabled: false, results: [] })
      return json(route, {
        enabled: true,
        results: [
          { repoId: `simaai/${QWEN}`, org: 'simaai', type: 'llm', sizeBytes: null },
          { repoId: VISION_REPO, org: 'simaai', type: 'vlm', sizeBytes: null },
          { repoId: SPEECH_REPO, org: 'simaai', type: 'asr', sizeBytes: null },
          { repoId: 'florianvoss/experiment', org: 'florianvoss', type: 'llm', sizeBytes: null },
          ...Array.from({ length: offered }, (_, i) => ({ repoId: `simaai/extra-${i}`, org: 'simaai', type: 'llm', sizeBytes: null }))
        ]
      })
    }
    if (path === 'models/hub/card') {
      board.cards += 1
      const repoId = url.searchParams.get('repoId')
      return json(route, { enabled: true, repoId, sizeBytes: 4_200_000_000, card: `# Title\n\nThis is the card of **${repoId}**.\n` })
    }
    return json(route, { error: 'not part of this test' }, 404)
  })
  return board
}

async function openGenAI(page) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('neat-insight:onboarding-seen', '1')
      window.localStorage.setItem('neat-insight:genai-tutorial-seen', '1')
    } catch {}
  })
  await page.goto('/genai')
  await expect(modelMenu(page)).toBeEnabled()
}

const modelMenu = (page) => page.locator('.genai-model-picker select')
const settingsButton = (page) => page.getByRole('button', { name: 'Settings', exact: true })
const row = (page, name) => page.getByRole('article', { name, exact: true })

test('Settings opens over the chat, and its close button and Esc return to it', async ({ page }) => {
  await mockBoard(page)
  await openGenAI(page)
  await expect(page.getByRole('region', { name: 'Chat' })).toBeVisible()

  await settingsButton(page).click()
  const dialog = page.getByRole('dialog', { name: 'GenAI settings' })
  await expect(dialog).toBeVisible()
  await expect(page.locator('.genai-chat')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeFocused()
  await expect(page.getByRole('tab', { name: /Models/ })).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(settingsButton(page)).toBeFocused()

  await settingsButton(page).click()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('the Model menu\'s Manage models opens the catalog and keeps the model', async ({ page }) => {
  await mockBoard(page)
  await openGenAI(page)
  const menu = modelMenu(page)
  const before = await menu.inputValue()

  await menu.selectOption({ label: 'Manage models' })
  await expect(page.getByRole('tab', { name: /Models/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { name: 'Model catalog' })).toBeVisible()
  await expect(menu).toHaveValue(before)
})

test('the first look fills the catalog, cards fill in by row, and a reload needs no sync', async ({ page }) => {
  const board = await mockBoard(page)
  await openGenAI(page)
  await settingsButton(page).click()

  await expect(page.getByText('3 models on this DevKit')).toBeVisible()
  await expect(page.getByText('459 GB free of 512 GB on the DevKit')).toBeVisible()
  await expect(page.getByText('Up to 2 chat models can stay loaded.')).toBeVisible()
  await expect(page.getByText('Qwen3 0.6B in use')).toBeVisible()

  const vision = row(page, 'Qwen3 VL 4B')
  await vision.scrollIntoViewIfNeeded()
  await expect(vision).toContainText('4.2 GB')
  await expect(vision).toContainText('Not downloaded')
  await expect(row(page, 'Qwen3 0.6B')).toContainText('In use')
  await expect(row(page, 'Llama 3.2 3B')).toContainText('On DevKit')
  await expect(row(page, 'Whisper small')).toContainText('In use')

  await vision.getByRole('button', { name: 'Show details for Qwen3 VL 4B' }).click()
  await expect(vision).toContainText(`This is the card of ${VISION_REPO}.`)
  await expect(vision.getByRole('link', { name: 'Model card on Hugging Face' })).toHaveAttribute('href', `https://huggingface.co/${VISION_REPO}`)

  expect(board.searches).toBe(1)

  await page.reload()
  await settingsButton(page).click()
  await row(page, 'Qwen3 VL 4B').scrollIntoViewIfNeeded()
  await expect(row(page, 'Qwen3 VL 4B')).toContainText('4.2 GB')
  expect(board.searches).toBe(1)

  await page.getByRole('button', { name: 'Sync catalog' }).click()
  await expect.poll(() => board.searches).toBe(2)
})

test('a board that keeps one chat model says the same thing in its row and its summary', async ({ page }) => {
  await mockBoard(page, { maxResident: 1 })
  await openGenAI(page)
  await settingsButton(page).click()

  await expect(page.getByText('One chat model runs at a time.')).toBeVisible()
  await expect(page.getByText('Qwen3 0.6B in use')).toBeVisible()
  await expect(row(page, 'Qwen3 0.6B')).toContainText('In use')
})

test('search and the filters narrow the list, and Clear filters brings it back', async ({ page }) => {
  await mockBoard(page)
  await openGenAI(page)
  await settingsButton(page).click()
  await expect(row(page, 'Whisper medium')).toBeVisible()
  const count = page.getByText(/^Showing /)
  await expect(count).toHaveText('Showing all 6 models · Search filters this saved catalog')

  await page.getByLabel('Search all models').fill('whisper')
  await expect(count).toHaveText('Showing 2 of 6 models · Search filters this saved catalog')
  await expect(row(page, 'Whisper medium')).toBeVisible()
  await expect(row(page, 'Whisper small')).toBeVisible()
  await expect(row(page, 'Qwen3 VL 4B')).toHaveCount(0)

  await page.getByLabel('Filter by model type').selectOption({ label: 'Vision' })
  await expect(page.getByText('No models match these filters')).toBeVisible()

  await page.getByRole('button', { name: 'Clear filters' }).first().click()
  await expect(count).toHaveText('Showing all 6 models · Search filters this saved catalog')
})

test('the catalog has its own search, which leaves the board\'s list alone', async ({ page }) => {
  await mockBoard(page)
  await openGenAI(page)
  await settingsButton(page).click()
  const onBoard = page.getByLabel('Models on this DevKit')
  const offered = page.getByLabel('Models to download')
  await expect(offered.getByRole('article', { name: 'Whisper medium' })).toBeVisible()

  await page.getByLabel('Search model catalog').fill('whisper')
  await expect(offered.getByRole('article')).toHaveCount(1)
  await expect(offered.getByRole('article', { name: 'Whisper medium' })).toBeVisible()
  await expect(onBoard.getByRole('article')).toHaveCount(3)

  await page.getByLabel('Search model catalog').fill('nothing like this')
  await expect(page.getByText('No models match these filters')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.getByLabel('Search model catalog')).toHaveValue('')
  await expect(offered.getByRole('article', { name: 'Whisper medium' })).toBeVisible()
})

test('a dialog covers the whole window, above Insight\'s header', async ({ page }) => {
  await mockBoard(page)
  await openGenAI(page)
  await page.waitForTimeout(600)
  await settingsButton(page).click()
  await page.waitForTimeout(600)
  const box = await page.getByRole('dialog', { name: 'GenAI settings' }).boundingBox()
  expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, 1920, 1080])
})

test('Settings, Benchmark, SiMaSentry and each of its apps are one dialog size', async ({ page }) => {
  await mockBoard(page)
  await openGenAI(page)
  await page.waitForTimeout(600)
  // The dialog's card: from the top of its first part to the bottom of its last.
  const card = () => page.locator('[role="dialog"]').last().evaluate((dialog) => {
    const parts = [...dialog.children].map((el) => el.getBoundingClientRect())
    const edges = [parts[0].left, parts[0].right, parts[0].top, parts[parts.length - 1].bottom]
    return edges.map(Math.round)
  })

  await settingsButton(page).click()
  const size = await card()
  await page.getByRole('tab', { name: 'Documents' }).click()
  expect(await card()).toEqual(size)
  await page.getByRole('button', { name: 'Close settings' }).click()

  await page.getByRole('button', { name: 'Benchmark' }).click()
  expect(await card()).toEqual(size)
  await page.getByRole('dialog', { name: 'Benchmark' }).getByRole('button', { name: 'Close' }).click()

  await page.getByRole('button', { name: 'SiMaSentry apps' }).click()
  const solutions = page.getByRole('dialog', { name: 'SiMaSentry Solutions' })
  expect(await card()).toEqual(size)
  for (const app of ['SiMaSentry-Med', 'SiMaSentry-Safe', 'SiMaSentry-Sec']) {
    await solutions.getByRole('button', { name: new RegExp(app) }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Open anyway' }).click()
    await expect(solutions.locator(`iframe[title="${app}"]`)).toHaveCount(1)
    expect(await solutions.evaluate((dialog) => {
      const parts = [...dialog.children].map((el) => el.getBoundingClientRect())
      return [parts[0].left, parts[0].right, parts[0].top, parts[parts.length - 1].bottom].map(Math.round)
    })).toEqual(size)
    await solutions.getByRole('button', { name: 'Back' }).click()
  }
})

test('the board\'s models and the ones to download are separate lists, and only rows in view read a card', async ({ page }) => {
  const board = await mockBoard(page, { offered: 60 })
  await openGenAI(page)
  await settingsButton(page).click()

  const onBoard = page.getByLabel('Models on this DevKit')
  const offered = page.getByLabel('Models to download')
  await expect(offered.getByRole('article', { name: 'Whisper medium' })).toBeVisible()
  await expect(onBoard.getByRole('article', { name: 'Llama 3.2 3B' })).toBeVisible()
  await expect(onBoard.getByRole('article', { name: 'Whisper medium' })).toHaveCount(0)
  await expect(page.getByText('Models from simaai on Hugging Face')).toBeVisible()
  await expect(page.getByText('florianvoss on Hugging Face')).toHaveCount(0)

  const list = await offered.evaluate((el) => ({ scrolls: el.scrollHeight > el.clientHeight, overflow: getComputedStyle(el).overflowY }))
  expect(list).toEqual({ scrolls: true, overflow: 'auto' })
  await expect(page.getByRole('button', { name: 'Sync catalog' })).toBeEnabled()
  await expect.poll(() => board.cards).toBeGreaterThan(0)
  await page.waitForTimeout(500)
  expect(board.cards).toBeLessThan(30)
  expect(board.searches).toBe(1)
})

test('the list stays put while a model operation refreshes the board', async ({ page }) => {
  const board = await mockBoard(page)
  await openGenAI(page)
  await settingsButton(page).click()
  await expect(page.getByText('3 models on this DevKit')).toBeVisible()

  board.statusDelay = 1500
  await page.getByRole('button', { name: 'Unload Qwen3 0.6B' }).click()
  await page.waitForTimeout(700)
  // Read now, not with a retrying expect: the slow answer would cover the gap.
  expect(await page.getByText('No models on this DevKit yet').count()).toBe(0)
  expect(await page.getByLabel('Models on this DevKit').getByRole('article', { name: 'Llama 3.2 3B' }).count()).toBe(1)
})

test('rows already in view read their cards once Hugging Face can be reached', async ({ page }) => {
  const board = await mockBoard(page)
  board.hubEnabled = false
  await page.addInitScript((repoId) => {
    window.localStorage.setItem('neat-insight:genai-model-catalog', JSON.stringify({ syncedAt: 1, models: [{ repoId, org: 'simaai', type: 'asr' }] }))
  }, SPEECH_REPO)
  await openGenAI(page)
  await settingsButton(page).click()
  await row(page, 'Whisper medium').scrollIntoViewIfNeeded()
  await expect(row(page, 'Whisper medium')).toContainText('—')
  expect(board.cards).toBe(0)

  board.hubEnabled = true
  await expect(row(page, 'Whisper medium')).toContainText('4.2 GB', { timeout: 30_000 })
})

test('another board refreshes the saved catalog', async ({ page }) => {
  const board = await mockBoard(page)
  await openGenAI(page)
  await settingsButton(page).click()
  await expect(row(page, 'Whisper medium')).toBeVisible()
  expect(board.searches).toBe(1)

  await page.getByRole('tab', { name: 'Connection' }).click()
  await page.getByLabel('GenAI Studio address').fill('https://192.168.1.30:5000')
  await page.getByRole('button', { name: 'Save address' }).click()
  await expect.poll(() => board.posts).toContain('settings')
  await page.getByRole('tab', { name: /Models/ }).click()
  await expect.poll(() => board.searches).toBe(2)
})

test('Load on a loaded model makes it answer, without loading anything', async ({ page }) => {
  const board = await mockBoard(page, { loaded: [QWEN, LLAMA] })
  await openGenAI(page)
  await settingsButton(page).click()
  await expect(page.getByText('Qwen3 0.6B in use')).toBeVisible()

  await row(page, 'Llama 3.2 3B').getByRole('button', { name: 'Load Llama 3.2 3B', exact: true }).click()
  await expect(page.getByText('Llama 3.2 3B in use')).toBeVisible()
  await expect(row(page, 'Qwen3 0.6B').getByRole('button', { name: 'Load Qwen3 0.6B', exact: true })).toBeVisible()
  expect(board.posts).toEqual([])
})

test('actions are Load, Unload and Download; the speech model in use can\'t be unloaded', async ({ page }) => {
  await mockBoard(page)
  await openGenAI(page)
  await settingsButton(page).click()

  await expect(row(page, 'Qwen3 0.6B').getByRole('button', { name: 'Unload Qwen3 0.6B' })).toBeEnabled()
  await expect(row(page, 'Llama 3.2 3B').getByRole('button', { name: 'Load Llama 3.2 3B' })).toBeEnabled()
  await expect(row(page, 'Whisper small').getByRole('button', { name: 'Unload Whisper small' })).toBeDisabled()
  await expect(row(page, 'Whisper medium').getByRole('button', { name: 'Download Whisper medium' })).toBeEnabled()
})

test('a download shows in its row, and the model lands on the board', async ({ page }) => {
  const board = await mockBoard(page)
  await openGenAI(page)
  await settingsButton(page).click()
  await row(page, 'Whisper medium').getByRole('button', { name: 'Download Whisper medium' }).click()

  await expect(row(page, 'Whisper medium')).toContainText('Downloading to DevKit')
  await expect(row(page, 'Qwen3 VL 4B').getByRole('button', { name: 'Download Qwen3 VL 4B' })).toBeDisabled()
  await page.waitForResponse((r) => r.url().endsWith('/models/status'))
  await page.waitForTimeout(300)
  await expect(row(page, 'Whisper medium')).toContainText('Downloading to DevKit')
  await expect(row(page, 'Whisper medium').getByRole('button', { name: 'Load Whisper medium' })).toHaveCount(0)

  board.finishDownload()
  await expect(row(page, 'Whisper medium')).toContainText('On DevKit')
  await expect(row(page, 'Whisper medium').getByRole('button', { name: 'Load Whisper medium' })).toBeEnabled()
  await expect(page.getByText('4 models on this DevKit')).toBeVisible()
  await expect(row(page, 'Qwen3 VL 4B').getByRole('button', { name: 'Download Qwen3 VL 4B' })).toBeEnabled()
})

test('a reload during a download shows it unfinished, and it can\'t be loaded', async ({ page }) => {
  const board = await mockBoard(page)
  board.catalog.push({ name: 'whisper-medium-a16w8', type: 'asr', complete: false, incompleteReason: 'download is incomplete' })
  await openGenAI(page)
  await settingsButton(page).click()

  await expect(row(page, 'Whisper medium')).toContainText('Download incomplete')
  await expect(page.getByRole('button', { name: 'Load Whisper medium' })).toBeDisabled()
})

test('with Hugging Face out of reach the saved catalog stays and downloads wait', async ({ page }) => {
  const board = await mockBoard(page)
  await openGenAI(page)
  await settingsButton(page).click()
  await row(page, 'Qwen3 VL 4B').scrollIntoViewIfNeeded()
  await expect(row(page, 'Qwen3 VL 4B')).toContainText('4.2 GB')

  board.hub = false
  await page.getByRole('button', { name: 'Sync catalog' }).click()
  await expect(page.getByText("The board can't reach Hugging Face.")).toBeVisible()
  await expect(row(page, 'Qwen3 VL 4B')).toContainText('4.2 GB')
  await expect(page.getByRole('button', { name: 'Download Qwen3 VL 4B' })).toBeDisabled()
})

test('a switch in Settings and its checkbox in the header are one setting', async ({ page }) => {
  await mockBoard(page)
  await openGenAI(page)
  await settingsButton(page).click()

  await page.getByRole('tab', { name: 'Replies & voice' }).click()
  await expect(page.getByText('Speech recognition is using')).toContainText('Whisper small')
  await page.getByRole('switch', { name: 'Read replies aloud' }).check()
  await expect(page.getByRole('checkbox', { name: 'Read replies aloud' })).toBeChecked()

  await page.getByRole('tab', { name: 'Documents' }).click()
  await expect(page.getByText('neat.md')).toBeVisible()
  await expect(page.getByText('8 searchable sections')).toBeVisible()
  await page.getByRole('switch', { name: /Use my documents/ }).check()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByRole('checkbox', { name: 'Use my documents' })).toBeChecked()
})

test('the arrow keys move between the tabs', async ({ page }) => {
  await mockBoard(page)
  await openGenAI(page)
  await settingsButton(page).click()
  await page.getByRole('tab', { name: /Models/ }).focus()

  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('tab', { name: 'Connection' })).toBeFocused()
  await expect(page.getByRole('tabpanel', { name: 'Connection' })).toContainText('GenAI Studio address')
  await page.keyboard.press('Home')
  await expect(page.getByRole('tab', { name: /Models/ })).toBeFocused()
})

test('Connection holds the address, and restart commands behind Troubleshooting', async ({ page }) => {
  await mockBoard(page)
  await openGenAI(page)
  await settingsButton(page).click()
  await page.getByRole('tab', { name: 'Connection' }).click()

  await expect(page.getByLabel('GenAI Studio address')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save address' })).toBeVisible()
  await page.getByText('Troubleshooting').click()
  await expect(page.getByRole('button', { name: 'Copy restart commands' })).toBeVisible()
})
