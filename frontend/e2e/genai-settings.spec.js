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
async function mockBoard(page, { hub = true, maxResident = 2, offered = 0 } = {}) {
  const board = {
    catalog: [
      { name: QWEN, type: 'chat', sizeBytes: 893_000_000 },
      { name: LLAMA, type: 'chat', sizeBytes: 3_700_000_000 },
      { name: WHISPER, type: 'asr', activeAsr: true, sizeBytes: 1_300_000_000 }
    ],
    loaded: [QWEN],
    hub,
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
        await new Promise((resolve) => { board.finishDownload = resolve })
        const repoId = request.postDataJSON().repoId
        board.catalog.push({ name: repoId.split('/')[1], type: 'asr', sizeBytes: 2_400_000_000 })
        const lines = [{ state: 'downloading', repoId, pct: 40 }, { state: 'done', repoId, name: repoId.split('/')[1] }]
        return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lines.map((l) => JSON.stringify(l)).join('\n') + '\n' })
      }
      return json(route, { ok: true })
    }
    if (path === 'settings') return json(route, { url: 'https://192.168.1.20:5000' })
    if (path === 'health') return json(route, { ok: true, api_version: 1, model_server: { reachable: true }, features: { rag: true } })
    if (path === 'models/status') {
      return json(route, {
        catalog: board.catalog,
        loaded: board.loaded,
        resident: board.loaded,
        maxResident,
        asrModel: WHISPER,
        hubEnabled: true,
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

test('Settings takes the chat\'s place and Back to chat returns to it', async ({ page }) => {
  await mockBoard(page)
  await openGenAI(page)
  await expect(page.getByRole('region', { name: 'Chat' })).toBeVisible()

  await settingsButton(page).click()
  await expect(page.getByRole('region', { name: 'GenAI settings' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Chat' })).toBeHidden()
  await expect(page.getByRole('tab', { name: /Models/ })).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('button', { name: 'Back to chat' }).click()
  await expect(page.getByRole('region', { name: 'GenAI settings' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Chat' })).toBeVisible()
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

  await page.getByLabel('Search saved model catalog').fill('whisper')
  await expect(count).toHaveText('Showing 2 of 6 models · Search filters this saved catalog')
  await expect(row(page, 'Whisper medium')).toBeVisible()
  await expect(row(page, 'Whisper small')).toBeVisible()
  await expect(row(page, 'Qwen3 VL 4B')).toHaveCount(0)

  await page.getByLabel('Filter by model type').selectOption({ label: 'Vision' })
  await expect(page.getByText('No models match these filters')).toBeVisible()

  await page.getByRole('button', { name: 'Clear filters' }).first().click()
  await expect(count).toHaveText('Showing all 6 models · Search filters this saved catalog')
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

  board.finishDownload()
  await expect(row(page, 'Whisper medium')).toContainText('On DevKit')
  await expect(row(page, 'Whisper medium').getByRole('button', { name: 'Load Whisper medium' })).toBeEnabled()
  await expect(page.getByText('4 models on this DevKit')).toBeVisible()
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
  await page.getByRole('checkbox', { name: 'Use my documents' }).check()
  await expect(page.getByRole('switch', { name: /Use my documents/ })).toBeChecked()
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
