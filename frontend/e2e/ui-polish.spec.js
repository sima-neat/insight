import { expect, test } from '@playwright/test'

// Dropdown arrows, the GenAI tooltips and the Source dialog's height (issue #231). Insight's API and
// the board behind /api/genai are answered here; no board is needed.
const LLAMA = 'Llama-3.2-3B-Instruct'
const TOOLBAR = [
  ['Export chat', 'No messages to export yet'],
  ['SiMaSentry apps', null],
  ['Benchmark', "This board's GenAI Studio doesn't offer the benchmark. Update Apps on the board."],
  ['Tutorial', null],
  ['Settings', null],
  ['Full screen', null]
]

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function seenIntros(page) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('neat-insight:onboarding-seen', '1')
      window.localStorage.setItem('neat-insight:genai-tutorial-seen', '1')
    } catch {}
  })
}

async function mockGenAI(page) {
  await page.route(/\/api\/genai\//, (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/genai\//, '')
    if (path === 'settings') return json(route, { url: 'https://192.168.1.20:5000' })
    if (path === 'health') return json(route, { ok: true, api_version: 1, model_server: { reachable: true }, features: {} })
    if (path === 'models/status') return json(route, { catalog: [{ name: LLAMA, type: 'chat', sizeBytes: 2_000_000_000 }], loaded: [LLAMA], maxResident: 1 })
    return json(route, { error: 'not part of this test' }, 404)
  })
  await seenIntros(page)
}

async function openGenAI(page) {
  await mockGenAI(page)
  await page.goto(new URL('/genai', test.info().project.use.baseURL).href)
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveValue(LLAMA)
  return page.getByRole('toolbar', { name: 'GenAI Studio tools' })
}

// A tooltip is wholly inside the window and next to its button.
async function expectTipBeside(page, button, tip) {
  const [b, t] = [await button.boundingBox(), await tip.boundingBox()]
  const view = page.viewportSize()
  expect(t.x).toBeGreaterThanOrEqual(0)
  expect(t.x + t.width).toBeLessThanOrEqual(view.width)
  expect(t.y).toBeGreaterThanOrEqual(0)
  expect(t.y + t.height).toBeLessThanOrEqual(view.height)
  expect(Math.min(Math.abs(t.y - (b.y + b.height)), Math.abs(b.y - (t.y + t.height)))).toBeLessThan(12)
}

test('the Model dropdown keeps the same space on both sides of its text and arrow', async ({ page }) => {
  await openGenAI(page)
  const style = await page.getByRole('combobox', { name: 'Model' }).evaluate((select) => {
    const css = getComputedStyle(select)
    return { appearance: css.appearance, left: css.paddingLeft, arrow: css.backgroundPositionX }
  })
  expect(style.appearance).toBe('none')
  expect(style.arrow).toBe(`calc(100% - ${style.left})`)
})

test('each toolbar button shows its label at once on hover, with the reason when disabled', async ({ page }) => {
  const toolbar = await openGenAI(page)
  for (const [label, reason] of TOOLBAR) {
    const button = toolbar.getByRole('button', { name: label, exact: true })
    await expect(button).not.toHaveAttribute('title')
    await button.hover()
    const tip = page.getByRole('tooltip').filter({ visible: true })
    await expect(tip).toHaveCount(1, { timeout: 500 })
    await expect(tip).toHaveText(`${label}${reason || ''}`)
    await expectTipBeside(page, button, tip)
  }
  await page.mouse.move(0, 0)
  await expect(page.getByRole('tooltip').filter({ visible: true })).toHaveCount(0)
})

test('the keyboard reaches each toolbar button, disabled ones too, and gets the same tooltip', async ({ page }) => {
  const toolbar = await openGenAI(page)
  await toolbar.getByRole('button', { name: 'Export chat' }).focus()
  await page.keyboard.press('Shift+Tab')
  for (const [label, reason] of TOOLBAR) {
    await page.keyboard.press('Tab')
    const button = toolbar.getByRole('button', { name: label, exact: true })
    await expect(button).toBeFocused()
    await expect(page.getByRole('tooltip').filter({ visible: true })).toHaveText(`${label}${reason || ''}`)
  }
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip').filter({ visible: true })).toHaveCount(0)
})

test('a disabled button does nothing when pressed; the buttons by the chat box say why', async ({ page }) => {
  const toolbar = await openGenAI(page)
  const benchmark = toolbar.getByRole('button', { name: 'Benchmark' })
  await expect(benchmark).toBeDisabled()
  await benchmark.click({ force: true })
  await expect(page.getByRole('dialog')).toHaveCount(0)

  const attach = page.getByRole('button', { name: 'Attach a picture' })
  await attach.hover()
  const tip = page.getByRole('tooltip').filter({ visible: true })
  await expect(tip).toHaveText('Attach a pictureNeeds a vision model')
  await expectTipBeside(page, attach, tip)

  const send = page.getByRole('button', { name: 'Send' })
  await send.hover()
  await expect(tip).toHaveText('SendType a question first')
})

test('the checkboxes on the left use the same tooltip, with a short label', async ({ page }) => {
  await openGenAI(page)
  const tip = page.getByRole('tooltip').filter({ visible: true })
  await page.getByText('Read replies aloud').hover()
  await expect(tip).toHaveText('Speak every reply')
  await page.getByText('Think first').hover()
  await expect(tip).toHaveText('Reason before answeringNeeds a reasoning model')
  await page.getByText('Use my documents').hover()
  await expect(tip).toContainText('Answer from documents')
  await expect(page.locator('.genai-check[title]')).toHaveCount(0)

  // Off, but the keyboard still reaches it, and pressing it changes nothing.
  const think = page.getByRole('checkbox', { name: 'Think first' })
  await page.mouse.move(0, 0)
  await page.getByRole('checkbox', { name: 'Read replies aloud' }).focus()
  await page.keyboard.press('Tab')
  await expect(think).toBeFocused()
  await expect(tip).toHaveText('Reason before answeringNeeds a reasoning model')
  await page.keyboard.press('Space')
  await expect(think).not.toBeChecked()
})

// The tab's entrance animation does this for a moment: `fixed` then measures from that element.
test('a tooltip stays beside its button under a moved parent, and follows it', async ({ page }) => {
  const toolbar = await openGenAI(page)
  await page.addStyleTag({ content: '.genai { transform: translateY(40px); }' })
  const button = toolbar.getByRole('button', { name: 'Settings' })
  // By keyboard: a moved button would slide out from under a hovering mouse.
  await toolbar.getByRole('button', { name: 'Full screen' }).focus()
  await page.keyboard.press('Shift+Tab')
  const tip = page.getByRole('tooltip').filter({ visible: true })
  await expect(tip).toHaveText('Settings')
  await expectTipBeside(page, button, tip)
  await page.addStyleTag({ content: '.genai { transform: translateY(0); }' })
  await expect.poll(async () => (await tip.boundingBox()).y - (await button.boundingBox()).y).toBeLessThan(60)
  await expectTipBeside(page, button, tip)
})

test('the tooltip goes away when its button opens something', async ({ page }) => {
  const toolbar = await openGenAI(page)
  await toolbar.getByRole('button', { name: 'SiMaSentry apps' }).click()
  await expect(page.getByRole('dialog', { name: 'SiMaSentry Solutions' })).toBeVisible()
  await expect(page.getByRole('tooltip').filter({ visible: true })).toHaveCount(0)
})

for (const height of [1080, 500]) {
  test(`the Source dialog does not move between its tabs in a ${height}px window`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height })
    const files = Array.from({ length: 30 }, (_, i) => ({ type: 'file', name: `clip-${i}.mp4`, path: `clip-${i}.mp4`, streamable: true }))
    await page.route(/\/api\/media-files(\?|$)/, (route) => json(route, files))
    await page.route(/\/api\/mediasrc/, (route) => json(route, []))
    await seenIntros(page)
    await page.goto(new URL('/streaming', test.info().project.use.baseURL).href)
    await page.getByTestId('source-file-1').click()

    const dialog = page.getByTestId('assign-dialog')
    const place = async () => ({
      dialog: await dialog.boundingBox(),
      tabs: await dialog.getByRole('tablist').boundingBox()
    })
    const first = await place()
    expect(first.dialog.y).toBeGreaterThanOrEqual(0)
    expect(first.dialog.y + first.dialog.height).toBeLessThanOrEqual(height)
    for (const tab of ['camera', 'stream', 'file', 'stream', 'camera']) {
      await dialog.getByTestId(`assign-tab-${tab}`).click()
      expect(await place()).toEqual(first)
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeInViewport({ ratio: 1 })
    }
  })
}

const setupSteps = () => [
  { id: 'install', state: 'done', warnings: [{ message: 'Two packages were skipped' }] },
  { id: 'prepare', state: 'done', warnings: [] },
  { id: 'start', state: 'done', warnings: [] }
]

async function openSetup(page, status) {
  await page.route(/\/api\/genai-setup(\?|$)/, (route) => json(route, status))
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('neat-insight:genai-setup-open', '1')
    } catch {}
  })
  await mockGenAI(page)
  await page.goto(new URL('/genai', test.info().project.use.baseURL).href)
}

test('the ready page puts the action beside the steps, and stacks them on a phone', async ({ page }) => {
  await openSetup(page, { active: false, generation: 1, target: { mode: 'ssh', host: '192.168.1.20' }, steps: setupSteps() })
  const ready = page.getByRole('region', { name: 'GenAI Studio is ready' })
  const open = ready.getByRole('button', { name: 'Open Studio' })
  const steps = ready.getByRole('list')
  await expect(open).toBeVisible()
  await expect(ready.getByText('Setup complete')).toHaveCount(0)
  await expect(ready.getByRole('listitem')).toHaveCount(3)
  const [wideButton, wideSteps] = [await open.boundingBox(), await steps.boundingBox()]
  expect(wideSteps.x).toBeGreaterThan(wideButton.x + wideButton.width)

  await page.setViewportSize({ width: 390, height: 844 })
  const [narrowButton, narrowSteps] = [await open.boundingBox(), await steps.boundingBox()]
  expect(narrowSteps.y).toBeGreaterThan(narrowButton.y + narrowButton.height)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
