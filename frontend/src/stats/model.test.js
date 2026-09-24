import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOARD_PROBLEM_CODES,
  MAX_COMPARE_RUNS,
  MAX_POLL_MS,
  POLL_MS,
  compareHint,
  compareQuery,
  compareReady,
  compareTable,
  countsSummary,
  daemonFacts,
  daemonInfo,
  factRows,
  failureNotice,
  formatDelta,
  formatSeconds,
  formatValue,
  healthFacts,
  healthProblems,
  isStale,
  metricsModel,
  parseTags,
  pollDelay,
  runList,
  runSubtitle,
  sparkline,
  sparklineLabel,
  statusInfo,
  thresholdText,
  toggleSelection,
  traceModel,
  validateTrace
} from './model.js'

const daemon = (extra = {}) => ({
  installed: true,
  healthy: true,
  service: 'active',
  socket: true,
  socket_path: '/run/simaai-sentinel/api.sock',
  sima_cli: '/usr/bin/sima-cli',
  ...extra
})

const METRICS = {
  board: { label: 'sima@192.168.2.2', fingerprint: 'fp-1' },
  generation: 3,
  sampled_at: '2026-09-22T20:55:47Z',
  version: 'main:80ab7de4da31',
  counts: { total: 4, unavailable: 1, warn: 1, critical: 0 },
  highlights: ['power_current_watts', 'rtsn_0'],
  groups: [
    {
      name: 'MLA',
      metrics: [
        { key: 'rtsn_0', label: 'MLA RTSN-0', short: 'MLA-0', unit: 'C', group: 'MLA', warn: 70, critical: 85, value: 72, status: 'warn' }
      ]
    },
    {
      name: 'Power',
      metrics: [
        { key: 'power_current_watts', label: 'Current board power', short: 'Current', unit: 'W', group: 'Power', warn: null, critical: null, value: null, status: 'unavailable' }
      ]
    },
    { name: 'Empty', metrics: [] }
  ],
  history: {
    timestamps: ['2026-09-22T20:55:45Z', '2026-09-22T20:55:47Z'],
    series: { rtsn_0: [70, 72], power_current_watts: [null, null] }
  }
}

test('a value Sentinel could not measure never reads as zero', () => {
  assert.equal(formatValue(72, 'C'), '72 °C')
  assert.equal(formatValue(95.456, '%'), '95.5%')
  assert.equal(formatValue(7.126, 'W'), '7.13 W')
  assert.equal(formatValue(1234.5, 'MB'), '1235 MB')
  assert.equal(formatValue(null, 'W'), '—')
  assert.equal(formatValue(undefined, 'W'), '—')
  assert.equal(formatValue('72', 'C'), '—')
  assert.equal(formatValue(800, null), '800')
  assert.equal(formatDelta(-1.25, 'W'), '−1.25 W')
  assert.equal(formatDelta(2, 'W'), '+2 W')
  assert.equal(formatDelta(0, 'W'), '±0 W')
  assert.equal(formatDelta(null, 'W'), '')
})

test('durations read in the unit a developer expects', () => {
  assert.equal(formatSeconds(4.25), '4.3 s')
  assert.equal(formatSeconds(45.6), '46 s')
  assert.equal(formatSeconds(90), '1 min 30 s')
  assert.equal(formatSeconds(7500), '2 h 5 min')
  assert.equal(formatSeconds(null), '')
  assert.equal(formatSeconds(-1), '')
})

test('polling backs off while the board keeps failing and never runs away', () => {
  assert.equal(pollDelay(0), POLL_MS)
  assert.equal(pollDelay(1), 4000)
  assert.equal(pollDelay(3), 16000)
  assert.equal(pollDelay(99), MAX_POLL_MS)
  assert.equal(pollDelay(undefined), POLL_MS)
})

test('metric status ranks carry a tone and a readable label', () => {
  assert.deepEqual(statusInfo('critical'), { label: 'Critical', tone: 'periph-danger' })
  assert.equal(statusInfo('ok').label, 'Normal')
  assert.equal(statusInfo('unavailable').label, 'Not measured')
  assert.equal(statusInfo('nonsense').label, 'Not measured')
  assert.equal(thresholdText({ warn: 70, critical: 85, unit: 'C' }), 'warn at 70 °C, critical at 85 °C')
  assert.equal(thresholdText({ warn: null, critical: null }), '')
})

test('the metrics payload becomes highlights, groups and a summary line', () => {
  const model = metricsModel(METRICS)
  assert.deepEqual(model.groups.map((group) => group.name), ['MLA', 'Power'])
  assert.deepEqual(model.highlights.map((metric) => metric.key), ['power_current_watts', 'rtsn_0'])
  assert.equal(model.sampledAt, '2026-09-22T20:55:47Z')
  assert.deepEqual(model.series.rtsn_0, [70, 72])
  assert.equal(countsSummary(model.counts), '4 metrics · 1 warning · 1 not measured')
  assert.equal(countsSummary({ total: 1 }), '1 metric')
  assert.equal(countsSummary(null), '0 metrics')
})

test('a metrics payload with no highlights still leads with something', () => {
  const model = metricsModel({ ...METRICS, highlights: ['unknown_key'] })
  assert.deepEqual(model.highlights.map((metric) => metric.key), ['rtsn_0'])
  assert.deepEqual(metricsModel(null).groups, [])
  assert.deepEqual(metricsModel(null).highlights, [])
})

test('sparklines skip gaps, need two points, and describe themselves', () => {
  const spark = sparkline([70, null, 72], 100, 20)
  assert.equal(spark.count, 2)
  assert.deepEqual([spark.min, spark.max], [70, 72])
  assert.equal(spark.points, '0,19 100,1')
  assert.equal(sparkline([70], 100, 20), null)
  assert.equal(sparkline([null, null], 100, 20), null)
  assert.equal(sparkline([], 100, 20), null)
  const flat = sparkline([5, 5], 100, 20)
  assert.equal(flat.points, '0,19 100,19')
  assert.equal(sparklineLabel({ label: 'MLA RTSN-0', unit: 'C' }, spark), 'MLA RTSN-0: 2 recent samples, 70 °C to 72 °C')
  assert.equal(sparklineLabel({ label: 'x' }, null), '')
})

test('the daemon state says what is wrong and whether this page can install it', () => {
  const ready = daemonInfo({ available: true, version: 'main:80ab', status: { state: 'ready', error: null }, daemon: daemon() })
  assert.equal(ready.label, 'Running')
  assert.equal(ready.canInstall, false)
  assert.match(ready.installBlocked, /already running/)
  assert.deepEqual(daemonFacts(ready)[0], ['Service', 'active'])

  const missing = daemonInfo({
    available: false,
    status: { state: 'missing', error: { error: 'Sentinel is not installed on this board.', code: 'sentinel_missing', hint: 'Install it from this page.' } },
    daemon: daemon({ installed: false, healthy: false, service: 'inactive', socket: false })
  })
  assert.equal(missing.label, 'Not installed')
  assert.equal(missing.canInstall, true)
  assert.equal(missing.error.code, 'sentinel_missing')

  const noCli = daemonInfo({ status: { state: 'missing', error: null }, daemon: daemon({ healthy: false, sima_cli: null }) })
  assert.equal(noCli.canInstall, false)
  assert.match(noCli.installBlocked, /sima-cli was not found/)

  const unknown = daemonInfo(null)
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.canInstall, false)
})

test('health facts and the daemon collector errors stay readable', () => {
  const rows = healthFacts({ metric_count: 3, cached_samples: 240, latest_sample_at: new Date().toISOString() })
  assert.deepEqual(rows[0], ['Metrics', '3'])
  assert.deepEqual(rows[1], ['Cached samples', '240'])
  assert.equal(rows[2][0], 'Latest sample')
  assert.deepEqual(healthFacts(null), [])
  assert.deepEqual(healthProblems({ errors: ['pmbus read failed', { error: 'ev74 busy' }, null] }), ['pmbus read failed', 'ev74 busy'])
  assert.deepEqual(healthProblems(null), [])
})

test('every backend failure becomes a title, a sentence and a place to fix it', () => {
  const noBoard = failureNotice({ error: 'No board is selected.', code: 'no_target', hint: 'Enter the board address.' })
  assert.equal(noBoard.title, 'No board is selected')
  assert.equal(noBoard.hint, 'Enter the board address.')
  assert.equal(noBoard.board, true)
  assert.equal(noBoard.retryable, false)

  const unreachable = failureNotice({ error: 'ssh: connect failed', code: 'unreachable', hint: null })
  assert.equal(unreachable.board, true)
  assert.match(unreachable.hint, /Board panel/)

  const hostKey = failureNotice({ error: 'host key changed', code: 'host_key_changed', presented_fingerprint: 'SHA256:new' })
  assert.equal(hostKey.details.presented_fingerprint, 'SHA256:new')

  const stale = failureNotice({ error: 'Sentinel speaks schema 2', code: 'sentinel_schema' })
  assert.equal(stale.title, 'Sentinel and Insight speak different API versions')
  assert.equal(stale.board, false)

  const denied = failureNotice({ error: 'socket cannot be opened', code: 'sentinel_denied' })
  assert.equal(denied.daemon, true)

  const failed = failureNotice({ error: 'installer failed', code: 'sentinel_failed', detail: 'exit 1\nlog tail' })
  assert.equal(failed.detail, 'exit 1\nlog tail')

  assert.equal(failureNotice({ error: 'boom', code: 'unheard_of' }).title, 'Something went wrong')
  assert.equal(failureNotice(null), null)
  for (const code of ['no_target', 'unreachable', 'auth_failed', 'host_key_changed', 'timeout']) {
    assert.ok(BOARD_PROBLEM_CODES.has(code))
  }
})

test('a payload read before the board changed is stale', () => {
  assert.equal(isStale({ generation: 4 }, METRICS), true)
  assert.equal(isStale({ generation: 3 }, METRICS), false)
  assert.equal(isStale(null, METRICS), false)
  assert.equal(isStale({ generation: 4 }, { board: {} }), false)
})

test('the active trace and its running summary are read from the daemon body', () => {
  const model = traceModel({ sentinel: { trace: { name: 'baseline', started_at: '2026-09-22T20:50:00Z' }, summary: { samples: 12, peak_power_watts: 9.5 } } })
  assert.equal(model.active, true)
  assert.equal(model.name, 'baseline')
  assert.equal(model.startedAt, '2026-09-22T20:50:00Z')
  assert.deepEqual(model.facts, [['Samples', '12'], ['Peak power watts', '9.5']])
  const idle = traceModel({ sentinel: { trace: null, summary: null } })
  assert.equal(idle.active, false)
  assert.deepEqual(idle.facts, [])
  assert.equal(traceModel(null).active, false)
})

test('a trace request is checked here before it reaches the board', () => {
  assert.deepEqual(validateTrace({ name: '  baseline  ', note: ' before ', tags: 'compiler-v1, nms' }), {
    body: { name: 'baseline', note: 'before', tags: ['compiler-v1', 'nms'] }
  })
  assert.deepEqual(validateTrace({ name: 'bare' }), { body: { name: 'bare' } })
  assert.ok(validateTrace({ name: '   ' }).error)
  assert.ok(validateTrace({ name: 'x'.repeat(129) }).error)
  assert.ok(validateTrace({ name: 'x', note: 'n'.repeat(513) }).error)
  assert.ok(validateTrace({ name: 'x', tags: Array.from({ length: 17 }, (_, i) => `t${i}`) }).error)
  assert.deepEqual(parseTags(' a , ,b '), ['a', 'b'])
  assert.deepEqual(parseTags(''), [])
})

test('run summaries survive the field names the daemon happens to use', () => {
  const payload = {
    sentinel: {
      runs: [
        { id: 'r1', name: 'baseline', state: 'complete', started_at: '2026-09-22T20:00:00Z', ended_at: '2026-09-22T20:02:00Z', samples: 60, tags: ['v1'], note: 'before' },
        { run_id: 'r2', label: 'optimized', status: 'recording', start_time: '2026-09-22T20:10:00Z', duration_ms: 4500 },
        'r3',
        {}
      ]
    }
  }
  const runs = runList(payload)
  assert.deepEqual(runs.map((run) => run.label), ['baseline', 'optimized', 'r3'])
  assert.equal(runs[0].ref, 'baseline')
  assert.equal(runs[0].durationSec, 120)
  assert.deepEqual(runs[0].tags, ['v1'])
  assert.equal(runs[1].ref, 'optimized')
  assert.equal(runs[1].durationSec, 4.5)
  assert.equal(runs[2].ref, 'r3')
  assert.deepEqual(runList({ sentinel: { runs: [] } }), [])
  assert.deepEqual(runList(null), [])
  assert.match(runSubtitle(runs[0], Date.parse('2026-09-22T20:03:00Z')), /^Complete · started .* · 2 min 0 s · 60 samples$/)
  assert.equal(runSubtitle({ label: 'x' }, Date.now()), '')
})

test('an unknown body is flattened into bounded label/value rows, never raw JSON', () => {
  const rows = factRows({
    id: 'r1',
    samples: 60,
    healthy: true,
    tags: ['a', 'b'],
    stats: { power: { mean: 7.2 } },
    nested: { a: { b: { c: { d: 1 } } } },
    skipped: 'no'
  }, ['skipped'])
  assert.deepEqual(rows, [
    ['Id', 'r1'],
    ['Samples', '60'],
    ['Healthy', 'yes'],
    ['Tags', 'a, b'],
    ['Stats power mean', '7.2']
  ])
  assert.deepEqual(factRows(null), [])
  assert.ok(factRows(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]))).length <= 120)
})

test('compare selection is bounded and the query keeps the baseline first', () => {
  let selected = toggleSelection([], 'baseline')
  selected = toggleSelection(selected, 'optimized')
  assert.deepEqual(selected, ['baseline', 'optimized'])
  assert.deepEqual(toggleSelection(selected, 'baseline'), ['optimized'])
  const full = Array.from({ length: MAX_COMPARE_RUNS }, (_, i) => `r${i}`)
  assert.deepEqual(toggleSelection(full, 'extra'), full)
  assert.equal(compareReady(['a']), false)
  assert.equal(compareReady(['a', 'b']), true)
  assert.equal(compareReady(full.concat('x')), false)
  assert.equal(compareQuery(['baseline', 'a/b']), '/api/sentinel/compare?runs=baseline%2Ca%2Fb')
  assert.match(compareHint(['a']), /1 more run/)
  assert.match(compareHint(['a', 'b']), /against a/)
})

test('a comparison is tabled when the daemon reports per-run statistics', () => {
  const table = compareTable({
    sentinel: {
      runs: [{ name: 'baseline' }, { name: 'optimized' }],
      metrics: [
        { key: 'power_current_watts', label: 'Current board power', unit: 'W', runs: [{ mean: 7.2 }, { mean: 6.1, delta: -1.1, delta_pct: -15.3 }] },
        { key: 'rtsn_0', unit: 'C', runs: { baseline: 70, optimized: 68 } },
        { key: 'unmeasured', runs: [null, null] },
        'nonsense'
      ]
    }
  })
  assert.deepEqual(table.columns.map((column) => column.label), ['baseline', 'optimized'])
  assert.equal(table.columns[0].baseline, true)
  assert.deepEqual(table.rows.map((row) => row.key), ['power_current_watts', 'rtsn_0'])
  assert.deepEqual(table.rows[0].cells[1], { value: 6.1, delta: -1.1, deltaPct: -15.3, column: 'optimized' })
  assert.equal(table.rows[1].label, 'Rtsn 0')
  assert.equal(table.rows[1].cells[0].value, 70)
})

test('a comparison shape Insight does not know is reported, not guessed at', () => {
  assert.equal(compareTable({ sentinel: { runs: [{ name: 'a' }, { name: 'b' }], series: {} } }), null)
  assert.equal(compareTable({ sentinel: { runs: [{ name: 'a' }], metrics: [] } }), null)
  assert.equal(compareTable({ sentinel: { runs: ['a', 'b'], metrics: [{ key: 'x', runs: [null, null] }] } }), null)
  assert.equal(compareTable(null), null)
})
