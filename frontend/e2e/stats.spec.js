import { expect, test } from '@playwright/test'
import fs from 'node:fs'

// The Stats page for each Sentinel state the board can report (issue #258). The board selection
// and the Sentinel API are answered here from the unit-test fixtures, so no board is needed.
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`../src/stats/fixtures/${name}`, import.meta.url)))
const failures = fixture('install-failures.json')
const live = fixture('metrics-live.json')

const GENERATION = 1
const BOARD = {
  generation: GENERATION,
  target: { host: '192.168.2.2', port: 22, user: 'sima', source: 'manual', label: 'sima@192.168.2.2' },
  status: { state: 'connected', checked_at: null, error: null },
  board: { hostname: 'modalix', machine: 'modalix', build_version: '2.1.3', fingerprint: 'fp-1', label: 'sima@192.168.2.2' }
}
// The backend reports Sentinel available exactly when it answered a health read.
const RUNNING = {
  ...failures.daemon_absent.body,
  available: true,
  version: '1.0.0',
  health: { version: '1.0.0', errors: [] },
  daemon: { healthy: true, installed: true, service: 'active', socket: true, socket_path: '/run/simaai-sentinel/api.sock', sima_cli: '/usr/bin/sima-cli' },
  status: { state: 'ready', error: null }
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

// Answers the board selection and every Sentinel read, and counts them. `sentinel` is the
// GET /api/sentinel body; `metrics` is only read once Sentinel is available.
async function mockBoard(page, { board = BOARD, sentinel, sentinelStatus = 200, metrics = live }) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('neat-insight:onboarding-seen', '1')
    } catch {}
  })
  const calls = { board: 0, boardAfterSentinel: 0, sentinel: 0, metrics: 0 }
  await page.route(/\/api\/board$/, (route) => {
    calls.board += 1
    if (calls.sentinel > 0) calls.boardAfterSentinel += 1
    return json(route, board)
  })
  await page.route(/\/api\/sentinel(\?.*)?$/, (route) => {
    calls.sentinel += 1
    return json(route, sentinel, sentinelStatus)
  })
  await page.route(/\/api\/sentinel\/metrics/, (route) => {
    calls.metrics += 1
    return json(route, metrics)
  })
  await page.route(/\/api\/sentinel\/runs$/, (route) => json(route, { generation: GENERATION, sentinel: { runs: [] } }))
  await page.route(/\/api\/sentinel\/traces/, (route) => json(route, { generation: GENERATION, sentinel: { trace: null } }))
  return calls
}

async function openStats(page) {
  await page.goto(new URL('/stats', test.info().project.use.baseURL).href)
  return page.getByRole('tabpanel', { name: 'DevKit' })
}

test('with no board selected the DevKit tab asks for one', async ({ page }) => {
  await mockBoard(page, {
    board: { generation: GENERATION, target: null, status: { state: 'unknown', checked_at: null, error: null } },
    sentinel: { code: 'no_target', error: 'No board is selected.', hint: "Enter the board's address.", generation: GENERATION },
    sentinelStatus: 409
  })
  const devkit = await openStats(page)
  await expect(devkit.getByText('Select a board to see its telemetry')).toBeVisible()
  await expect(devkit.getByRole('button', { name: 'Choose a board' })).toBeVisible()
  await expect(devkit.getByRole('region', { name: 'Sentinel daemon' })).toHaveCount(0)
})

test('a board without Sentinel offers to install it', async ({ page }) => {
  await mockBoard(page, { sentinel: failures.daemon_absent.body })
  const daemon = (await openStats(page)).getByRole('region', { name: 'Sentinel daemon' })
  await expect(daemon.getByText('Not installed', { exact: true })).toBeVisible()
  await expect(daemon.getByRole('button', { name: 'Install Sentinel' })).toBeEnabled()
  await expect(daemon.getByText('sima-cli neat install sentinel')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Sentinel', exact: true })).toHaveCount(0)
})

test('a stopped Sentinel says how to start it', async ({ page }) => {
  await mockBoard(page, { sentinel: failures.daemon_stopped.body })
  const daemon = (await openStats(page)).getByRole('region', { name: 'Sentinel daemon' })
  await expect(daemon.getByText('Installed but stopped', { exact: true })).toBeVisible()
  await expect(daemon.getByText('sudo systemctl start simaai-sentinel')).toBeVisible()
})

test('a running Sentinel shows live metrics in every view, and Pause and Resume control polling', async ({ page }) => {
  const calls = await mockBoard(page, { sentinel: RUNNING })
  const devkit = await openStats(page)
  const sentinel = devkit.getByRole('region', { name: 'Sentinel', exact: true })
  await expect(sentinel.getByText('LIVE', { exact: true })).toBeVisible()
  await expect(devkit.getByRole('region', { name: 'Sentinel daemon' })).toHaveCount(0)
  await expect(devkit.getByRole('tabpanel', { name: 'Overview' }).getByRole('figure', { name: /^CPU usage/ })).toBeVisible()

  // A view that throws while rendering takes its panel down with it.
  const views = sentinel.getByRole('tablist', { name: 'Sentinel views' })
  for (const name of ['Thermal', 'Power', 'System', 'Storage & Network', 'Runs', 'Overview']) {
    await views.getByRole('tab', { name }).click()
    await expect(views.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
    await expect(devkit.getByRole('tabpanel', { name })).toBeVisible()
  }

  await expect.poll(() => calls.metrics, { timeout: 10_000 }).toBeGreaterThan(1)
  await sentinel.getByRole('button', { name: 'Pause updates' }).click()
  await expect(sentinel.getByRole('button', { name: 'Resume updates' })).toBeVisible()
  await expect(sentinel.getByText('PAUSED', { exact: true })).toBeVisible()
  const atPause = calls.metrics
  await page.waitForTimeout(5_000) // metrics are polled every 2 s while live
  expect(calls.metrics).toBe(atPause)

  await sentinel.getByRole('button', { name: 'Resume updates' }).click()
  await expect(sentinel.getByText('LIVE', { exact: true })).toBeVisible()
  await expect.poll(() => calls.metrics, { timeout: 10_000 }).toBeGreaterThan(atPause)
})

test('a Sentinel answer from another board generation is not shown', async ({ page }) => {
  const calls = await mockBoard(page, { sentinel: { ...failures.daemon_absent.body, generation: GENERATION + 1 } })
  const devkit = await openStats(page)
  // The page reads the board twice on load anyway. Only a rejected Sentinel answer makes it read
  // the board again after that answer arrived, to learn which selection is current.
  await expect.poll(() => calls.boardAfterSentinel).toBeGreaterThan(0)
  await expect(devkit.getByText('Checking Sentinel on the board…')).toBeHidden()
  await expect(devkit.getByRole('region', { name: 'Sentinel daemon' })).toHaveCount(0)
  await expect(devkit.getByText('Not installed', { exact: true })).toHaveCount(0)
})

test('the Host tab shows host readings and the DevKit state is kept on the way back', async ({ page }) => {
  const calls = await mockBoard(page, { sentinel: failures.daemon_absent.body })
  // Answered here too: a live /api/metrics reports nothing when a legacy REMOTE_DEVKIT is set but
  // not connected, and the panel then shows a notice instead of readings.
  await page.route(/\/api\/metrics(\?.*)?$/, (route) => json(route, {
    cpu_load: 12.5,
    memory: { total: 16_000_000_000, used: 6_400_000_000, percent: 40 },
    mla_allocated_bytes: 0,
    disk: { mount: '/home/sima', total: 500_000_000_000, used: 100_000_000_000, free: 400_000_000_000, percent: 20 },
    temperature_celsius_avg: null,
    REMOTE: false,
    pipeline_status: {}
  }))
  const devkit = await openStats(page)
  await expect(devkit.getByText('Not installed', { exact: true })).toBeVisible()
  const sentinelReads = calls.sentinel

  const source = page.getByRole('tablist', { name: 'Stats source' })
  await source.getByRole('tab', { name: 'Host' }).click()
  const host = page.getByRole('tabpanel', { name: 'Host' })
  const readings = host.getByRole('list', { name: 'Insight host readings' })
  await expect(readings.getByRole('listitem').filter({ hasText: 'CPU load' })).toContainText('12.5')
  await expect(readings.getByRole('listitem').filter({ hasText: 'Disk' })).toContainText('/home/sima')
  await expect(devkit).toBeHidden()

  await source.getByRole('tab', { name: 'DevKit' }).click()
  await expect(devkit.getByText('Not installed', { exact: true })).toBeVisible()
  // Kept, not read again.
  expect(calls.sentinel).toBe(sentinelReads)
})
