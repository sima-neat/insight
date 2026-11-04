import { expect, test } from '@playwright/test'

// Changing the board in Insight's header with the GenAI tab open. The tab's address may follow the
// board, so until it is read again nothing is sent, and what belongs to the old board goes. Insight's
// API and the board behind /api/genai are answered here; no board is needed.
const LLAMA = 'Llama-3.2-3B-Instruct'
const REPLY = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n'

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

// `settings` decides how the address read answers once the board has changed.
async function mockInsight(page, { studioUp = true, settings }) {
  let changed = false
  await page.route(/\/api\/peripherals$/, (route) => json(route, {}))
  await page.route(/\/api\/board(\/.*)?$/, (route) => {
    if (route.request().method() === 'GET') return json(route, { generation: 1, target: null })
    changed = true
    return json(route, { generation: 2, target: null })
  })
  await page.route(/\/api\/genai\//, (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/genai\//, '')
    if (path === 'settings') return changed ? settings(route) : json(route, { url: 'https://192.168.1.20:5000' })
    if (path === 'health') {
      return json(route, studioUp ? { ok: true, api_version: 1, model_server: { reachable: true }, features: {} } : { ok: false, reachable: false })
    }
    if (path === 'models/status') return json(route, { catalog: [{ name: LLAMA, type: 'chat' }], loaded: [LLAMA], maxResident: 1 })
    if (path === 'v1/chat/completions') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: REPLY })
    return json(route, { error: 'not part of this test' }, 404)
  })
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('neat-insight:onboarding-seen', '1')
      window.localStorage.setItem('neat-insight:genai-tutorial-seen', '1')
    } catch {}
  })
}

async function chatOnce(page) {
  await page.goto('/genai')
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveValue(LLAMA)
  await page.getByRole('textbox', { name: 'Message' }).fill('Hi')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Hello')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export chat' })).toBeEnabled()
}

async function changeBoard(page) {
  await page.locator('.board-trigger').click()
  const host = page.getByRole('form', { name: 'Board connection' }).getByRole('textbox').first()
  await host.fill('192.168.1.30')
  await host.press('Enter')
}

test('nothing is sent until the address is read, and a configured address keeps the conversation', async ({ page }) => {
  let answer
  const held = new Promise((resolve) => { answer = resolve })
  await mockInsight(page, {
    settings: async (route) => {
      await held
      return json(route, { url: 'https://192.168.1.20:5000' })
    }
  })
  await chatOnce(page)
  await page.getByRole('textbox', { name: 'Message' }).fill('Still there?')
  await changeBoard(page)
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled()

  answer()
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled()
  await expect(page.getByText('Hello')).toBeVisible()
})

test('an address that moved with the board drops the conversation', async ({ page }) => {
  await mockInsight(page, { settings: (route) => json(route, { url: 'https://192.168.1.30:5000' }) })
  await chatOnce(page)
  await changeBoard(page)
  await expect(page.getByText('Hello')).toHaveCount(0)
})

test('an address that cannot be read drops the conversation too', async ({ page }) => {
  await mockInsight(page, { settings: (route) => route.abort() })
  await chatOnce(page)
  await changeBoard(page)
  await expect(page.getByText('Hello')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Export chat' })).toBeDisabled()
})

test('a setup request left on the old board does not hold the new board\'s buttons', async ({ page }) => {
  let answer
  const held = new Promise((resolve) => { answer = resolve })
  const steps = ['install', 'prepare', 'start'].map((id) => ({ id, state: 'pending', warnings: [] }))
  const status = { active: false, generation: 99, target: { mode: 'ssh', host: '192.168.1.20' }, steps }
  await mockInsight(page, { studioUp: false, settings: (route) => json(route, { url: 'https://192.168.1.20:5000' }) })
  await page.route(/\/api\/genai-setup(\/.*)?(\?.*)?$/, async (route) => {
    if (route.request().method() === 'POST') await held
    return json(route, status)
  })
  await page.goto('/genai')
  const install = page.getByRole('button', { name: 'Install GenAI Studio' })
  await install.click()
  await expect(page.getByRole('button', { name: 'Starting…' })).toBeDisabled()

  await changeBoard(page)
  await expect(install).toBeEnabled()
  answer()
  await expect(install).toBeEnabled()
})
