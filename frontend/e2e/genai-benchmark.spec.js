import { expect, test } from '@playwright/test'

// The Benchmark page for someone who has never used it (issue #234). The board behind Insight's
// /api/genai relay is answered here; no board is needed.
const LLAMA = 'Llama-3.2-3B-Instruct'
const QWEN = 'Qwen2.5-VL-3B-Instruct'

const stat = (mean) => ({ mean, median: mean, min: mean, max: mean, stdev: 0.3, p90: mean + 0.4 })
const summary = { count: 5, errors: 0, tps: stat(14.2), ttftMs: stat(820), tokens: stat(128) }

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

// `posts` records what the tab asked the board to do. A run answers "running" once, then its result;
// holdRun keeps it running until a stop.
async function mockBoard(page, { loaded = [LLAMA], holdRun = false } = {}) {
  const board = { loaded, posts: [], polls: 0, stopped: false }
  await page.route(/\/api\/genai\//, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api\/genai\//, '')
    if (request.method() === 'POST') {
      board.posts.push({ path, body: request.postDataJSON() })
      if (path === 'models/load') board.loaded = [request.postDataJSON().name]
      if (path === 'benchmark/run') board.polls = 0
      if (path === 'benchmark/stop') board.stopped = true
      if (path === 'benchmark/run') return json(route, { running: true, done: 0, total: 5 })
      return json(route, { ok: true })
    }
    if (path === 'benchmark/status') {
      board.polls += 1
      if (board.polls < 2 || (holdRun && !board.stopped)) {
        return json(route, { running: true, done: 2, total: 5, current: { tokens: 64, tps: 14.2, text: '## How it works\n\nA **transformer** generates text ![a picture](https://example.com/a.png)' } })
      }
      return json(route, { running: false, done: 5, total: 5, summary, prompt: 'standard', runs: [{ ttftMs: 820, tps: 14.2, tokens: 128 }] })
    }
    if (path === 'settings') return json(route, { url: 'https://192.168.1.20:5000' })
    if (path === 'health') return json(route, { ok: true, api_version: 1, model_server: { reachable: true }, features: { benchmark: true, rag: true } })
    if (path === 'models/status') {
      return json(route, {
        catalog: [{ name: LLAMA, type: 'chat' }, { name: QWEN, type: 'vlm', supportsVision: true, estimatedLoadS: 90 }],
        loaded: board.loaded,
        maxResident: 1
      })
    }
    if (path === 'rag/status') return json(route, { database: true, service: 'ok', sections: 3 })
    if (path === 'rag/inspect') return json(route, { exists: true, meta: { input: 'guide.md' }, documents: [{ text: 'A section', metadata: { heading: 'Intro' } }] })
    return json(route, { error: 'not part of this test' }, 404)
  })
  return board
}

async function openBenchmark(page) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('neat-insight:onboarding-seen', '1')
      window.localStorage.setItem('neat-insight:genai-tutorial-seen', '1')
    } catch {}
  })
  await page.goto('/genai')
  await page.getByRole('button', { name: 'Benchmark' }).click()
  return page.getByRole('dialog', { name: 'Benchmark' })
}

const posted = (board, path) => board.posts.filter((p) => p.path === path)

let nativeDialogs

test.beforeEach(({ page }) => {
  nativeDialogs = []
  page.on('dialog', (dialog) => {
    nativeDialogs.push(dialog.message())
    dialog.dismiss().catch(() => {})
  })
})

test.afterEach(() => {
  expect(nativeDialogs).toEqual([])
})

test('the defaults run without changing anything, and each number is explained', async ({ page }) => {
  const board = await mockBoard(page)
  const panel = await openBenchmark(page)
  await expect(panel.getByText('How long you wait before the reply starts.')).toBeVisible()
  await expect(panel.getByLabel('Runs')).toBeHidden()

  await panel.getByRole('button', { name: 'Run benchmark' }).click()
  await expect(panel.getByRole('heading', { name: 'Results', exact: true })).toBeVisible()
  expect(posted(board, 'models/load')).toEqual([])
  expect(posted(board, 'benchmark/run')).toEqual([{ path: 'benchmark/run', body: { model: LLAMA, num_samples: 5, max_new_tokens: 128, prompt: '' } }])

  await expect(panel.locator('.genai-bench-number').first()).toHaveText('820 ms')
  await expect(panel.getByText('Feels instant', { exact: true })).toBeVisible()
  await expect(panel.getByText('14.2 tokens/s')).toBeVisible()
  await expect(panel.getByText('Faster than you can read')).toBeVisible()
  await expect(panel.getByText('About 11 words a second.')).toBeVisible()

  await panel.getByText('All numbers').click()
  const row = panel.getByRole('row', { name: /Llama 3.2 3B/ })
  await expect(row).toHaveText(/14\.2\s*14\.6\s*0\.30\s*820 ms\s*128\s*5/)
  await expect(panel.getByRole('term').first()).toBeHidden()
  await panel.getByText('What these numbers mean').click()
  for (const term of ['Average speed', 'Top speed (p90)', 'Variation (σ)', 'First word', 'Reply length', 'Runs']) {
    await expect(panel.getByRole('term').filter({ hasText: term })).toBeVisible()
  }
  await expect(panel.getByRole('button', { name: 'Download CSV' })).toBeEnabled()
  await expect(panel.getByRole('button', { name: 'Download JSON' })).toBeEnabled()
})

test('a run that swaps the loaded model says so first', async ({ page }) => {
  const board = await mockBoard(page)
  const panel = await openBenchmark(page)
  await panel.getByRole('checkbox', { name: /Llama 3.2 3B/ }).uncheck()
  await panel.getByRole('checkbox', { name: /Qwen2.5 VL 3B/ }).check()
  await panel.getByRole('button', { name: 'Run benchmark' }).click()

  const question = page.getByRole('alertdialog', { name: 'Swap the loaded model?' })
  await expect(question).toContainText('This test loads Qwen2.5 VL 3B, which takes about 1 min 30 s and unloads Llama 3.2 3B.')
  await question.getByRole('button', { name: 'Cancel' }).click()
  await expect(question).toBeHidden()
  expect(board.posts).toEqual([])

  // Esc answers the question and leaves the page open.
  await panel.getByRole('button', { name: 'Run benchmark' }).click()
  await page.keyboard.press('Escape')
  await expect(question).toBeHidden()
  await expect(panel).toBeVisible()
  expect(board.posts).toEqual([])

  await panel.getByRole('button', { name: 'Run benchmark' }).click()
  await question.getByRole('button', { name: 'Load and run' }).click()
  await expect(panel.getByRole('heading', { name: 'Results', exact: true })).toBeVisible()
  expect(board.posts.map((p) => p.path)).toEqual(['models/load', 'benchmark/run'])
  expect(board.posts[0].body).toEqual({ name: QWEN })
})

test('with no model loaded, the default still runs after saying it loads first', async ({ page }) => {
  const board = await mockBoard(page, { loaded: [] })
  const panel = await openBenchmark(page)
  await expect(panel.getByRole('checkbox', { name: /Llama 3.2 3B/ })).toBeChecked()
  await panel.getByRole('button', { name: 'Run benchmark' }).click()
  await page.getByRole('alertdialog', { name: 'Load the model first?' }).getByRole('button', { name: 'Load and run' }).click()
  await expect(panel.getByRole('heading', { name: 'Results', exact: true })).toBeVisible()
  expect(board.posts.map((p) => p.path)).toEqual(['models/load', 'benchmark/run'])
})

test('advanced options reach the board, and Change models goes back to them', async ({ page }) => {
  const board = await mockBoard(page)
  const panel = await openBenchmark(page)
  await panel.getByText('Advanced options').click()
  await panel.getByLabel('Runs').fill('3')
  await panel.getByLabel('Output tokens').fill('64')
  await panel.getByLabel('Prompt').fill('Say hello')
  await expect(panel.getByText('3 runs · 64 tokens · your prompt')).toBeVisible()
  await panel.getByRole('button', { name: 'Run benchmark' }).click()
  await expect(panel.getByRole('heading', { name: 'Results', exact: true })).toBeVisible()
  expect(posted(board, 'benchmark/run')[0].body).toEqual({ model: LLAMA, num_samples: 3, max_new_tokens: 64, prompt: 'Say hello' })

  await panel.getByRole('button', { name: 'Change models' }).click()
  await expect(panel.getByRole('heading', { name: 'How fast is a model on this board?' })).toBeVisible()
  await expect(panel.getByRole('checkbox', { name: /Llama 3.2 3B/ })).toBeChecked()
})

test('running shows progress and the reply, and Stop ends it', async ({ page }) => {
  const board = await mockBoard(page, { holdRun: true })
  const panel = await openBenchmark(page)
  await panel.getByRole('button', { name: 'Run benchmark' }).click()
  await expect(panel.getByRole('heading', { name: 'Testing 1 model' })).toBeVisible()
  await expect(panel.getByText('Testing Llama 3.2 3B')).toBeVisible()
  await expect(panel.getByText('Model 1 of 1')).toBeVisible()
  await expect(panel.getByRole('progressbar', { name: 'Benchmark progress' })).toHaveAttribute('aria-valuenow', '40')
  // The reply reads like the chat's: rendered Markdown, and no image fetched from what the model wrote.
  await expect(panel.getByText("The model's reply so far")).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'How it works' })).toBeVisible()
  await expect(panel.locator('.genai-bench-text strong')).toHaveText('transformer')
  await expect(panel.locator('.genai-bench-text')).not.toContainText('**')
  await expect(panel.locator('.genai-bench-text img')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Close' })).toBeDisabled()

  await panel.getByRole('button', { name: 'Stop' }).click()
  await expect(panel.getByRole('button', { name: 'Run benchmark' })).toBeVisible()
  await expect(panel.getByText('Benchmark stopped.')).toBeVisible()
  expect(posted(board, 'benchmark/stop').length).toBeGreaterThan(0)
})

// Documents shares the panel's rules, so the Benchmark page's own look must stay on the Benchmark page.
test('the Documents panel keeps its own layout', async ({ page }) => {
  await mockBoard(page)
  await openBenchmark(page)
  await page.getByRole('dialog', { name: 'Benchmark' }).getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('region', { name: 'Documents' }).getByRole('button', { name: 'View documents' }).click()

  const panel = page.getByRole('dialog', { name: 'Documents on the board' })
  await expect(panel.locator('.genai-bench-body')).toHaveCSS('max-width', '1000px')
  await expect(panel.locator('.genai-bench-top p')).toHaveCSS('font-size', '13px')
  await expect(panel.locator('.genai-bench-top p')).toHaveCSS('margin-top', '0px')
  await expect(panel.getByRole('region', { name: 'Summary' })).toHaveCSS('border-top-width', '1px')
  await expect(panel.getByRole('region', { name: 'Sections' })).toHaveCSS('padding-top', '16px')
  await expect(panel.locator('.genai-bench-results-head')).toHaveCSS('display', 'flex')
})
