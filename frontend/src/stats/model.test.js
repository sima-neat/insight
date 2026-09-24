import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  BOARD_PROBLEM_CODES,
  HOST_POLL_MS,
  MAX_COMPARE_RUNS,
  MAX_POLL_MS,
  NAME_LIMIT,
  POLL_MS,
  compareIncludes,
  compareQuery,
  compareReady,
  compareTable,
  createRequestGuard,
  daemonBusy,
  daemonFacts,
  daemonInfo,
  daemonNoticeNeeded,
  definitionsByKey,
  deletePrompt,
  deleteRunQuery,
  deleteStops,
  deleteSummary,
  deltaAbsenceText,
  factRows,
  failureNotice,
  formatBytes,
  formatPercentDelta,
  formatSeconds,
  formatValue,
  hostNotice,
  healthFacts,
  healthProblems,
  hostMetricsModel,
  isStale,
  metricsModel,
  missingSelection,
  parseTags,
  payloadBoardLabel,
  pollDelay,
  runDetail,
  runList,
  runSubtitle,
  sparkline,
  sparklineLabel,
  staleFlags,
  staleNote,
  statusInfo,
  statusOf,
  telemetryVisible,
  thresholdText,
  toggleSelection,
  traceModel,
  uncomparableRefs,
  validateTrace
} from './model.js'

// The comparison Sentinel main:80ab7de4da31 returned on a Modalix DevKit, trimmed to six
// metrics; every value kept is exactly as the daemon sent it.
const COMPARE = JSON.parse(readFileSync(new URL('./fixtures/compare-shape.json', import.meta.url), 'utf8'))
// The same run read back from /api/sentinel/runs/<name>, trimmed to those six metrics.
const RUN = JSON.parse(readFileSync(new URL('./fixtures/run-detail-shape.json', import.meta.url), 'utf8'))
// Every answer POST /api/sentinel/install and GET /api/sentinel can give when Sentinel is
// not usable, captured from neat_insight.sentinel.api itself rather than written by hand.
// The install path has never been run against a board — the daemon was already there and
// removing it would take the board off stock software — so these are what the UI is built
// against.
const INSTALL = JSON.parse(readFileSync(new URL('./fixtures/install-failures.json', import.meta.url), 'utf8'))

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

test('the daemon section appears only when it has something to say', () => {
  const ready = { state: 'ready' }
  // The normal case: a working daemon renders nothing, and the telemetry below is the proof.
  assert.equal(daemonNoticeNeeded(ready), false)
  assert.equal(daemonNoticeNeeded(ready, { error: null, health: null, install: null }), false)
  // Not ready is the whole point of the section: it carries the reason and the Install button.
  assert.equal(daemonNoticeNeeded({ state: 'missing' }), true)
  assert.equal(daemonNoticeNeeded({ state: 'unknown' }), true)
  assert.equal(daemonNoticeNeeded(null), true)
  // A working daemon can still have something to report.
  assert.equal(daemonNoticeNeeded(ready, { error: { message: 'Sentinel could not be installed' } }), true)
  assert.equal(daemonNoticeNeeded(ready, { health: { errors: ['power collector: read failed'] } }), true)
  assert.equal(daemonNoticeNeeded(ready, { install: { log: 'sima-cli neat install sentinel\n' } }), true)
  assert.equal(daemonNoticeNeeded(ready, { install: { log: '' } }), false)
})

test('a value Sentinel could not measure never reads as zero', () => {
  assert.equal(formatValue(72, 'C'), '72 °C')
  assert.equal(formatValue(95.456, '%'), '95.5%')
  assert.equal(formatValue(7.126, 'W'), '7.13 W')
  assert.equal(formatValue(1234.5, 'MB'), '1235 MB')
  assert.equal(formatValue(null, 'W'), '—')
  assert.equal(formatValue(undefined, 'W'), '—')
  assert.equal(formatValue('72', 'C'), '—')
  assert.equal(formatValue(800, null), '800')
  assert.equal(formatPercentDelta(-1.507232237109984), '−1.51%')
  assert.equal(formatPercentDelta(12.753877670471164), '+12.8%')
  assert.equal(formatPercentDelta(0), '±0%')
  // A change too small to print must not round to 0%, which would read as no change.
  assert.equal(formatPercentDelta(-0.0002595591909001994), '−<0.01%')
  assert.equal(formatPercentDelta(null), '—')
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
  // The counts still reach the group chips, which carry the warnings and criticals.
  assert.deepEqual([model.counts.total, model.counts.warn, model.counts.unavailable], [4, 1, 1])
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
  assert.equal(model.payload.sentinel.trace.name, 'baseline')
  assert.equal(traceModel(null).payload, null)
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

test('a run carries the energy Sentinel measured for it, not only its duration', () => {
  // /api/sentinel/runs on the DevKit, verbatim: every entry reports energy_joules, and
  // Sentinel is power telemetry, so that is the number a run is judged on. It was only
  // reachable by selecting two runs and comparing them.
  const runs = runList({
    sentinel: {
      runs: [
        {
          id: '20260923T152712.952Z-insight-hw-1790177227',
          name: 'insight-hw-1790177227',
          started_at: '2026-09-23T15:27:12.952702307Z',
          ended_at: '2026-09-23T15:27:19.620064802Z',
          duration_ms: 6667,
          energy_joules: 51.533604984375,
          samples: 4
        },
        { id: 'r2', name: 'no-energy', duration_ms: 1000, samples: 2 }
      ]
    }
  })
  assert.equal(runs[0].energyJoules, 51.533604984375)
  assert.match(runSubtitle(runs[0], Date.parse('2026-09-23T15:28:00Z')), / · 6.7 s · 51.5 J · 4 samples$/)
  // A daemon that reports no energy says nothing about it rather than reading as 0 J.
  assert.equal(runs[1].energyJoules, null)
  assert.equal(runSubtitle(runs[1], Date.now()), '1 s · 2 samples')
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
})

test('the captured comparison is read as a table of metrics against the baseline', () => {
  const table = compareTable({ sentinel: COMPARE })
  assert.deepEqual(table.columns.map((column) => [column.label, column.baseline]), [
    ['insight-hw-1790177227', true],
    ['insight-hw-1790177178', false]
  ])
  // The note is what tells two runs of the same workload apart, and /compare sends one
  // per run. The runs table shows it; the comparison dropped it.
  assert.deepEqual(table.columns.map((column) => column.note), [
    'Insight hardware validation',
    'Insight hardware validation'
  ])
  assert.deepEqual(compareTable({ sentinel: { ...COMPARE, runs: COMPARE.runs.map(({ note, ...rest }) => rest) } })
    .columns.map((column) => column.note), ['', ''])
  assert.equal(table.baselineId, COMPARE.baseline_id)
  assert.equal(table.baselineLabel, 'insight-hw-1790177227')
  assert.equal(table.generatedAt, '2026-09-23T15:27:56.138344320Z')
  assert.equal(table.statistic, 'mean')

  // The run scalars Sentinel reports alongside the metric summaries, which carry no delta.
  // A duration arrives in milliseconds and is read in seconds, as everywhere else here.
  const duration = table.rows.find((row) => row.key === 'duration_ms')
  assert.equal(duration.label, 'Duration')
  assert.equal(duration.unit, 's')
  assert.deepEqual(duration.cells.map((cell) => cell.value), [6.667, 34.379])
  assert.deepEqual(duration.cells.map((cell) => cell.deltaPct), [null, null])
  assert.equal(formatValue(duration.cells[1].value, duration.unit), '34.4 s')
  const energy = table.rows.find((row) => row.key === 'energy_joules')
  assert.equal(energy.label, 'Energy')
  assert.equal(formatValue(energy.cells[1].value, energy.unit), '275 J')

  // A metric cell carries the mean, because that is the statistic the delta is measured on.
  const power = table.rows.find((row) => row.key === 'power_current_watts')
  assert.equal(power.cells[0].value, COMPARE.summaries[COMPARE.baseline_id].metrics.power_current_watts.mean)
  assert.equal(power.cells[1].deltaPct, -0.35731427657192105)
  assert.equal(power.cells[0].baseline, true)
  // The baseline is what the rest are measured against, so it shows no change of its own.
  assert.equal(power.cells[0].deltaPct, null)

  // A metric whose baseline mean was 0: Sentinel sends no delta, because there is no
  // percentage change from 0. The baseline did measure it, so it is not "never measured".
  const idle = table.rows.find((row) => row.key === 'cpu_core_11_usage_pct')
  assert.deepEqual(idle.cells.map((cell) => cell.value), [0, 0])
  assert.equal(idle.cells[1].deltaPct, null)
  assert.equal(formatPercentDelta(idle.cells[1].deltaPct), '—')
})

test('a change Sentinel withholds says which of its four reasons applies', () => {
  const table = compareTable({ sentinel: COMPARE })

  // The case that made the old wording wrong. cpu_core_13_usage_pct came back with a
  // null delta although the baseline measured it four times: its mean was 0, and the
  // other run averaged 5.9%. Reading that em dash as "the baseline never measured it"
  // hides the one change in the table that went from nothing to something.
  const busy = table.rows.find((row) => row.key === 'cpu_core_13_usage_pct')
  assert.equal(COMPARE.summaries[COMPARE.baseline_id].metrics.cpu_core_13_usage_pct.count, 4)
  assert.deepEqual(busy.cells.map((cell) => cell.value), [0, 5.91190441525744])
  assert.equal(busy.cells[1].deltaPct, null)
  assert.equal(busy.cells[1].deltaAbsence, 'baseline_zero')
  assert.match(deltaAbsenceText('baseline_zero'), /no percentage change from 0/)

  // A run scalar has no delta because the daemon publishes none, which is a different
  // statement from the baseline having measured 0.
  assert.equal(table.rows.find((row) => row.key === 'energy_joules').cells[1].deltaAbsence, 'not_published')
  // The baseline carries the others' changes, so it never claims a reason of its own.
  assert.equal(table.rows.find((row) => row.key === 'power_current_watts').cells[0].deltaAbsence, null)
  assert.equal(table.rows.find((row) => row.key === 'power_current_watts').cells[1].deltaAbsence, null)

  // A metric this comparison's baseline has no value for at all: the one case the old
  // wording described, and now the only one that claims it.
  const partial = JSON.parse(JSON.stringify(COMPARE))
  const others = Object.keys(partial.summaries).filter((id) => id !== partial.baseline_id)
  delete partial.summaries[partial.baseline_id].metrics.rtsn_6
  for (const id of Object.keys(partial.baseline_deltas_pct)) delete partial.baseline_deltas_pct[id].rtsn_6
  const rtsn = compareTable({ sentinel: partial }).rows.find((row) => row.key === 'rtsn_6')
  assert.equal(rtsn.cells[0].value, null)
  assert.equal(rtsn.cells[1].value, partial.summaries[others[0]].metrics.rtsn_6.mean)
  assert.equal(rtsn.cells[1].deltaAbsence, 'no_baseline')

  // No legend under the table: each “—” carries its own reason, shown on hover.
  for (const reason of ['not_published', 'baseline_zero', 'no_baseline', 'no_value']) {
    assert.ok(deltaAbsenceText(reason).length > 0, reason)
  }
})

test('a run the daemon listed but summarised nothing for is marked, not read as empty', () => {
  const partial = JSON.parse(JSON.stringify(COMPARE))
  const other = Object.keys(partial.summaries).find((id) => id !== partial.baseline_id)
  delete partial.summaries[other]
  const table = compareTable({ sentinel: partial })
  assert.deepEqual(table.columns.map((column) => column.summarised), [true, false])
  // Its cells are empty, and empty because there is no value, not because of a baseline.
  const power = table.rows.find((row) => row.key === 'power_current_watts')
  assert.equal(power.cells[1].value, null)
  assert.equal(power.cells[1].deltaAbsence, 'no_value')
  // The daemon still published a change for that run. A change printed beside an em dash
  // would describe a number this table does not show, so it is withheld with the value.
  assert.equal(partial.baseline_deltas_pct[other].power_current_watts, -0.35731427657192105)
  assert.equal(power.cells[1].deltaPct, null)
})

test('a comparison is labelled from the board definitions, and never from invented ones', () => {
  const definitions = definitionsByKey({
    groups: [{ name: 'Power', metrics: [{ key: 'power_current_watts', label: 'Current board power', unit: 'W', group: 'Power' }] }]
  })
  const table = compareTable({ sentinel: COMPARE }, definitions)
  const power = table.rows.find((row) => row.key === 'power_current_watts')
  assert.equal(power.label, 'Current board power')
  assert.equal(power.unit, 'W')
  assert.equal(formatValue(power.cells[0].value, power.unit), '8.62 W')
  // A key no definition names keeps its key, with no unit invented for it.
  const rtsn = table.rows.find((row) => row.key === 'rtsn_6')
  assert.equal(rtsn.label, 'Rtsn 6')
  assert.equal(rtsn.unit, null)
  assert.equal(compareTable({ sentinel: COMPARE }).rows.find((row) => row.key === 'power_current_watts').unit, null)
})

test('a comparison shape Insight does not know is reported, not guessed at', () => {
  // The fallback the view still needs: null here means "list the values as they came".
  assert.equal(compareTable({ sentinel: { runs: [{ name: 'a' }, { name: 'b' }], series: {} } }), null)
  assert.equal(compareTable({ sentinel: { runs: [COMPARE.runs[0]], summaries: COMPARE.summaries } }), null)
  assert.equal(compareTable({ sentinel: { ...COMPARE, summaries: {} } }), null)
  assert.equal(compareTable({ sentinel: { ...COMPARE, runs: [] } }), null)
  assert.equal(compareTable({ sentinel: {} }), null)
  assert.equal(compareTable(null), null)
})

test('the captured run is read from its own metadata, definitions and samples', () => {
  const run = runDetail({ generation: 4, sentinel: RUN })
  assert.equal(run.sampleCount, 4)
  assert.equal(run.metricCount, 6)
  assert.equal(run.firstSampleAt, '2026-09-23T15:27:13.270295197Z')
  assert.equal(run.lastSampleAt, '2026-09-23T15:27:19.270569777Z')
  assert.equal(run.metadata.id, '20260923T152712.952Z-insight-hw-1790177227')
  assert.deepEqual(run.undefinedKeys, [])
  assert.deepEqual(run.extras, [])

  // Every metadata field the daemon sent, including the nested system block.
  const facts = Object.fromEntries(run.facts)
  assert.equal(facts.Name, 'insight-hw-1790177227')
  assert.equal(facts['Sample interval ms'], '1989')
  assert.equal(facts['Sentinel version'], 'main:80ab7de4da31')
  assert.equal(facts['System hostname'], 'modalix')

  // Labels, units and groups come from the definitions the run itself carries.
  assert.deepEqual(run.metrics.map((metric) => metric.group), ['CPU', 'CPU', 'Disk', 'Memory', 'Power', 'TOP'])
  const power = run.metrics.find((metric) => metric.key === 'power_current_watts')
  assert.equal(power.label, 'Current board power')
  assert.equal(power.unit, 'W')
  assert.equal(formatValue(power.maximum, power.unit), '8.88 W')
  assert.equal(power.count, 4)
  const cpu = run.metrics.find((metric) => metric.key === 'cpu_core_0_usage_pct')
  assert.deepEqual([cpu.warn, cpu.critical], [80, 95])
  assert.equal(cpu.status, 'ok')
  assert.equal(run.crossed, 0)
})

test('a run is summarised with the same numbers the daemon computes for it', () => {
  // The captured run is the comparison's baseline, so Sentinel's own summary of it is
  // known: the statistics computed here from its samples must be exactly those.
  const run = runDetail({ sentinel: RUN })
  assert.equal(run.metadata.id, COMPARE.baseline_id)
  const daemon = COMPARE.summaries[COMPARE.baseline_id].metrics
  for (const metric of run.metrics) {
    assert.equal(metric.mean, daemon[metric.key].mean, `${metric.key} mean`)
    assert.equal(metric.minimum, daemon[metric.key].minimum, `${metric.key} minimum`)
    assert.equal(metric.maximum, daemon[metric.key].maximum, `${metric.key} maximum`)
    assert.equal(metric.count, daemon[metric.key].count, `${metric.key} count`)
  }
})

test('a run ranks its metrics against the thresholds it recorded, not today\'s', () => {
  assert.equal(statusOf(90, 80, 95), 'warn')
  assert.equal(statusOf(95, 80, 95), 'critical')
  assert.equal(statusOf(12, 80, 95), 'ok')
  assert.equal(statusOf(null, 80, 95), 'unavailable')
  assert.equal(statusOf(1e6, null, null), 'ok')

  // Thresholds and values here are not from the board; they exercise the ranking.
  const hot = runDetail({
    sentinel: {
      metadata: { id: 'r1' },
      metrics: [
        { key: 'rtsn_6', label: 'TOP RTSN-6', group: 'TOP', unit: 'C', warn: 70, critical: 85 },
        { key: 'ghost', label: 'Never measured', group: 'TOP', unit: 'C', warn: 70, critical: 85 }
      ],
      samples: [
        { timestamp: '2026-09-23T15:27:14Z', values: { rtsn_6: 40, ghost: null } },
        { timestamp: '2026-09-23T15:27:16Z', values: { rtsn_6: 88, ghost: null } }
      ]
    }
  })
  const [ghost, rtsn] = hot.metrics
  assert.equal(rtsn.status, 'critical')
  assert.equal(rtsn.maximum, 88)
  assert.equal(rtsn.mean, 64)
  // A metric the run defined but never measured stays empty, never zero.
  assert.equal(ghost.status, 'unavailable')
  assert.deepEqual([ghost.count, ghost.mean, ghost.maximum], [0, null, null])
  assert.equal(formatValue(ghost.mean, ghost.unit), '—')
  assert.equal(hot.crossed, 1)
})

test('a run body without the three documented keys falls back instead of guessing', () => {
  assert.equal(runDetail({ sentinel: { run: { id: 'r1' } } }), null)
  assert.equal(runDetail({ sentinel: {} }), null)
  assert.equal(runDetail(null), null)
  // Metrics as a map, samples absent, and a field beyond the three: all still reported.
  const odd = runDetail({ sentinel: { metadata: null, metrics: { power_current_watts: { unit: 'W' } }, retention: 'kept' } })
  assert.equal(odd.metricCount, 1)
  assert.equal(odd.sampleCount, 0)
  assert.deepEqual(odd.metrics, [])
  assert.deepEqual(odd.facts, [])
  assert.deepEqual(odd.extras, [['Retention', 'kept']])
  // A value with no definition of its own is counted rather than passed over silently.
  const extra = runDetail({
    sentinel: { metadata: {}, metrics: [{ key: 'rtsn_6' }], samples: [{ timestamp: 't', values: { rtsn_6: 1, mystery_metric: 2 } }] }
  })
  assert.deepEqual(extra.undefinedKeys, ['mystery_metric'])
})

test('every payload is judged stale on its own generation, not just the metrics', () => {
  const board = { generation: 4 }
  const onA = (extra = {}) => ({ generation: 3, board: { label: 'sima@192.168.2.2' }, ...extra })
  const onB = (extra = {}) => ({ generation: 4, board: { label: 'sima@10.0.0.9' }, ...extra })
  const flags = staleFlags(board, {
    metrics: onA(),
    traces: onA({ sentinel: { trace: { name: 'baseline' } } }),
    runs: onA({ sentinel: { runs: [{ name: 'baseline' }] } }),
    detail: onA({ sentinel: { run: { id: 'r1' } } }),
    compare: onA({ sentinel: { runs: ['baseline'] } }),
    install: onB({ log: 'installed' })
  })
  assert.deepEqual(flags, { metrics: true, traces: true, runs: true, detail: true, compare: true, install: false })
  // Nothing is dropped: the caller still has the values to render under the label.
  assert.deepEqual(staleFlags(board, {}), {})
  assert.deepEqual(staleFlags(null, { compare: onA() }), { compare: false })
  assert.equal(payloadBoardLabel(onA()), 'sima@192.168.2.2')
  assert.equal(payloadBoardLabel({}), '')
  assert.equal(
    staleNote('These runs', 'sima@192.168.2.2'),
    'These runs below: read from sima@192.168.2.2, not from the board selected now.'
  )
  assert.equal(
    staleNote('This comparison'),
    'This comparison below: read from a board that is no longer selected, not from the board selected now.'
  )
})

test('a failure that lands after a board switch carries the generation it was issued under', () => {
  const notice = failureNotice({ error: 'ssh: connect failed', code: 'unreachable' }, 3)
  assert.equal(notice.generation, 3)
  assert.equal(isStale({ generation: 4 }, notice), true)
  assert.equal(isStale({ generation: 3 }, notice), false)
  // Without a generation - no board state yet - a failure is never labelled stale.
  assert.equal(isStale({ generation: 4 }, failureNotice({ error: 'boom', code: 'timeout' })), false)
})

test('the request guard admits one call per key until it ends', () => {
  const guard = createRequestGuard()
  assert.equal(guard.begin('state'), true)
  assert.equal(guard.running('state'), true)
  assert.equal(guard.begin('state'), false)
  assert.equal(guard.begin('runs'), true)
  guard.end('state')
  assert.equal(guard.running('state'), false)
  assert.equal(guard.begin('state'), true)
  guard.end('missing')
})

test('the daemon panel is busy during the first check, before any state exists', () => {
  assert.equal(daemonBusy({ installBusy: false, stateBusy: true }), true)
  assert.equal(daemonBusy({ installBusy: true, stateBusy: false }), true)
  assert.equal(daemonBusy({ installBusy: false, stateBusy: false }), false)
  assert.equal(daemonBusy(), false)
})

test('byte sizes read in the unit that fits', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(2048), '2 kB')
  assert.equal(formatBytes(8 * 1024 ** 3), '8 GB')
  assert.equal(formatBytes(1536 * 1024 ** 2), '1.5 GB')
  assert.equal(formatBytes(null), '')
  assert.equal(formatBytes(-1), '')
})

test('the Insight host snapshot is modelled apart from the board telemetry', () => {
  const model = hostMetricsModel({
    cpu_load: 12.5,
    memory: { total: 16 * 1024 ** 3, used: 8 * 1024 ** 3, percent: 50 },
    disk: { mount: '/home/docker', total: 100 * 1024 ** 3, used: 91 * 1024 ** 3, free: 9 * 1024 ** 3, percent: 91 },
    temperature_celsius_avg: null,
    REMOTE: false
  })
  assert.equal(model.source, 'local')
  assert.equal(model.offline, false)
  assert.deepEqual(model.rows.map((row) => [row.key, row.value]), [['cpu_load', 12.5], ['memory', 50], ['disk', 91]])
  assert.equal(model.rows[1].detail, '8 GB of 16 GB')
  assert.equal(model.rows[2].detail, '91 GB of 100 GB · /home/docker')
  assert.equal(HOST_POLL_MS >= 10000, true)
})

test('a host reading the endpoint does not give stays absent instead of reading as zero', () => {
  const partial = hostMetricsModel({ cpu_load: 5, memory: {}, disk: null, temperature_celsius_avg: 46.5, REMOTE: false })
  assert.deepEqual(partial.rows.map((row) => [row.key, row.value]), [['cpu_load', 5], ['memory', null], ['disk', null], ['temperature', 46.5]])
  assert.equal(partial.rows[1].detail, '')

  const offline = hostMetricsModel({ cpu_load: '', memory: {}, disk: {}, temperature_celsius_avg: 0, REMOTE: true })
  assert.equal(offline.source, 'remote')
  assert.equal(offline.offline, true)
  assert.deepEqual(offline.rows, [])
  assert.match(offline.sourceLabel, /REMOTE_DEVKIT/)

  const nothing = hostMetricsModel(null)
  assert.equal(nothing.empty, true)
  assert.deepEqual(nothing.rows.map((row) => row.value), [null, null, null])
})

test('a selected run that has left the board is named, not left stuck in the selection', () => {
  // The board's two saved runs, then one of them deleted on the board and the list
  // refreshed. `insight-hw-1790177178` keeps its place in the selection with no row and
  // no checkbox to clear it, and every Compare fails on it.
  const runs = runList({
    sentinel: {
      runs: [
        { id: '20260923T152712.952Z-insight-hw-1790177227', name: 'insight-hw-1790177227' },
        { id: '20260923T152624.613Z-insight-hw-1790177178', name: 'insight-hw-1790177178' }
      ]
    }
  })
  const selected = runs.map((run) => run.ref)
  assert.deepEqual(missingSelection(selected, runs), [])

  const left = runs.slice(0, 1)
  assert.deepEqual(missingSelection(selected, left), ['insight-hw-1790177178'])
  // What the daemon answers for that selection, captured from the DevKit.
  const refused = failureNotice({
    error: "unknown run 'insight-hw-1790177178'",
    code: 'not_found',
    hint: 'List runs and use a name or id Sentinel reports.'
  })
  assert.equal(refused.title, 'That run is not on this board')
  assert.equal(refused.board, false)
  assert.equal(refused.daemon, false)
  assert.equal(refused.retryable, true)

  // A run is selectable by name or by id, so both must count as still being on the board.
  assert.deepEqual(missingSelection(['20260923T152624.613Z-insight-hw-1790177178'], runs), [])
  // Runs not read yet is not the same as every run having gone.
  assert.deepEqual(missingSelection(selected, []), [])
  assert.deepEqual(missingSelection([], runs), [])
})

test('the empty and refused states Sentinel actually returns are read as such', () => {
  // /api/sentinel/runs on a board whose daemon runs but has recorded nothing.
  assert.deepEqual(runList({ generation: 1, sentinel: { runs: [] } }), [])

  // Comparing one run, verbatim from the DevKit: a 400 the page must not read as a
  // comparison, since selecting a second run is the fix.
  const single = failureNotice({
    error: 'Comparing needs at least two runs.',
    code: 'invalid_request',
    hint: 'Pass `runs=<baseline>,<other>`; the first run is the baseline.'
  })
  assert.equal(single.title, 'The request was rejected')
  assert.equal(single.board, false)
  assert.equal(compareReady(['only-one']), false)

  // A board that has been left: /api/sentinel answers 502 with the board's own hint.
  const gone = failureNotice({
    error: 'The board could not be reached.',
    code: 'unreachable',
    hint: 'Check that the board is powered on and on the network, and that `ssh -p 22 sima@192.168.2.254` works from this machine.'
  })
  assert.equal(gone.board, true)
  assert.match(gone.hint, /ssh -p 22 sima@192\.168\.2\.254/)
  // Its answer is the Board panel's problem, so the daemon panel must not claim it.
  assert.equal(gone.daemon, false)
  assert.equal(daemonInfo(null).state, 'unknown')
  assert.equal(daemonInfo(null).available, false)

  // A daemon that is not installed: the page offers to install it and nothing else.
  const missing = daemonInfo({
    available: false,
    status: { state: 'missing', error: { error: 'Sentinel is not installed on this board.', code: 'sentinel_missing' } },
    daemon: { installed: false, healthy: false, service: 'inactive', socket: false, sima_cli: '/usr/bin/sima-cli' }
  })
  assert.equal(missing.available, false)
  assert.equal(missing.canInstall, true)
  assert.equal(failureNotice(missing.error).daemon, true)
})

test('a run whose name holds a comma is named, not sent into a 404', () => {
  // /api/sentinel/compare splits its runs on commas after decoding, so the query for a run
  // named `before, after` is indistinguishable from two runs. Driven against the sandbox:
  //   GET /api/sentinel/compare?runs=before%2C%20after,insight-hw-1790177227
  //   404 {"code":"not_found","error":"unknown run 'before'", ...}
  const selected = ['before, after', 'insight-hw-1790177227']
  assert.deepEqual(uncomparableRefs(selected), ['before, after'])
  assert.equal(compareReady(selected), false, 'Compare must not be offered for a query that cannot say what it means')
  assert.deepEqual(uncomparableRefs(['insight-hw-1790177227', 'insight-hw-1790177178']), [])
  assert.equal(compareReady(['insight-hw-1790177227', 'insight-hw-1790177178']), true)

  // And Insight stops recording such a name in the first place.
  assert.match(validateTrace({ name: 'before, after' }).error, /cannot contain a comma/)
  assert.equal(validateTrace({ name: 'before, after' }).body, undefined)
  assert.deepEqual(validateTrace({ name: 'before-after' }).body, { name: 'before-after' })
})

test('a host snapshot with no readings says so instead of showing three em dashes', () => {
  // /api/metrics answering with nothing measurable: the rows are all null, and before the
  // panel had a sentence for it they rendered as three labels against three “—”.
  const empty = hostMetricsModel({ REMOTE: false })
  assert.equal(empty.empty, true)
  assert.match(hostNotice(empty, true), /no CPU, memory or disk reading/)
  // Before the first answer the same model means "not read yet", not "measured nothing".
  assert.equal(hostNotice(hostMetricsModel(null), false), 'Reading this machine…')
  // A configured but disconnected remote DevKit keeps its own sentence.
  assert.match(hostNotice(hostMetricsModel({ REMOTE: true, memory: {}, disk: {} }), true), /not connected/)
  // A machine Insight can read has rows, so it has no notice.
  assert.equal(hostNotice(hostMetricsModel({ REMOTE: false, cpu_load: 2.9, memory: { percent: 37.3 }, disk: { percent: 3.4 } }), true), '')
})

test('a daemon that is not there offers the one thing that fixes it', () => {
  const absent = INSTALL.daemon_absent
  assert.equal(absent.status, 200, 'a board without Sentinel is not itself a failure')
  const info = daemonInfo(absent.body)
  assert.equal(info.state, 'missing')
  assert.equal(info.label, 'Not installed')
  assert.equal(info.available, false)
  assert.equal(info.canInstall, true)
  assert.equal(info.installBlocked, '')
  assert.equal(failureNotice(info.error).title, 'Sentinel is not running on this board')
  assert.match(failureNotice(info.error).hint, /sima-cli neat install sentinel/)

  // An installed unit that is not running is a different sentence and a different fix.
  const stopped = daemonInfo(INSTALL.daemon_stopped.body)
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.label, 'Installed but stopped')
  assert.equal(failureNotice(stopped.error).title, 'The Sentinel service is stopped')
})

test('an install this page cannot run says so before it is attempted', () => {
  // `sima-cli` is what the installer runs; without it the button is dead, and the reason
  // has to be on the page rather than only in the tooltip of a disabled button.
  const info = daemonInfo(INSTALL.sima_cli_missing_state.body)
  assert.equal(info.simaCli, null)
  assert.equal(info.canInstall, false)
  assert.match(info.installBlocked, /sima-cli was not found on the board/)

  // A healthy daemon is never reinstalled from here: the installer restarts it.
  const healthy = daemonInfo({ available: true, status: { state: 'ready' }, daemon: { installed: true, healthy: true, service: 'active', socket: true, sima_cli: '/usr/bin/sima-cli' } })
  assert.equal(healthy.canInstall, false)
  assert.match(healthy.installBlocked, /would restart it and end a trace in flight/)

  // And a board that has not answered at all cannot be installed onto either.
  assert.equal(daemonInfo(null).canInstall, false)
  assert.match(daemonInfo(null).installBlocked, /state is unknown/)
})

test('an install that is refused or fails is titled as an install, not as a read', () => {
  const notice = (name) => failureNotice(INSTALL[name].body, 7, { action: 'install' })

  // Refused: Sentinel is already running, and reinstalling would end a trace in flight.
  const refused = notice('already_installed')
  assert.equal(INSTALL.already_installed.status, 409)
  assert.equal(refused.title, 'Sentinel is already installed')
  assert.match(refused.hint, /would end a trace in flight/)
  assert.equal(refused.detail, '')

  // `sima-cli` missing: nothing was read, so "Sentinel could not answer" is not the failure.
  const noCli = notice('sima_cli_missing')
  assert.equal(noCli.code, 'sentinel_failed')
  assert.equal(noCli.title, 'Sentinel could not be installed')
  assert.match(noCli.message, /`sima-cli` was not found on the board/)
  assert.match(noCli.hint, /Install sima-cli on the board/)

  // The board refusing sudo is not Sentinel refusing this user.
  const sudo = notice('sudo_denied')
  assert.equal(sudo.code, 'sentinel_denied')
  assert.equal(sudo.title, 'Installing Sentinel needs sudo on the board')
  assert.equal(sudo.detail, 'sudo: a password is required')
  assert.match(sudo.hint, /in a shell on the board/)

  // Failing part way: the installer's own output is what says why, and it is kept.
  const failed = notice('installer_failed')
  assert.equal(failed.title, 'Sentinel could not be installed')
  assert.match(failed.message, /failed on the board \(exit 1\)/)
  assert.match(failed.detail, /vulcan: not found/)

  // Finishing with the service still down is a failure too, not a successful install.
  const down = notice('installer_left_it_down')
  assert.equal(down.title, 'Sentinel could not be installed')
  assert.match(down.message, /the simaai-sentinel service is inactive/)
  assert.match(down.hint, /systemctl status simaai-sentinel/)

  // Every one of them is the daemon's problem to fix, never the Board panel's, and every
  // one of them is worth retrying once the board has been put right.
  for (const name of ['already_installed', 'sima_cli_missing', 'sudo_denied', 'installer_failed']) {
    assert.equal(notice(name).board, false, name)
    assert.equal(notice(name).retryable, true, name)
    assert.equal(notice(name).action, 'install', name)
    assert.equal(notice(name).generation, 7, name)
  }

  // An installer that runs past its 15-minute budget is not an unresponsive board.
  const slow = failureNotice({ code: 'timeout', error: 'The board took too long to answer.' }, null, { action: 'install' })
  assert.equal(slow.title, 'The installer did not finish in time')
  assert.match(slow.hint, /as long as it needs/)
  // The same code read from the board keeps the reading title and the reading fix.
  assert.equal(failureNotice({ code: 'timeout', error: 'The board took too long to answer.' }).title, 'The board took too long to answer')
  assert.equal(failureNotice({ code: 'timeout', error: 'x' }).action, 'read')
})

test('a board that goes away mid-view keeps what it already gave, and says why', () => {
  // The poll fails, /api/sentinel fails behind it, and the daemon state is set back to
  // null. Hiding the panels on that alone drops the samples, the trace and the runs that
  // were on screen a second ago — and the failure's own sentence, which lives in them.
  const info = daemonInfo(null)
  assert.equal(info.available, false)
  assert.equal(telemetryVisible(info, { metrics: METRICS, traces: null, runs: null }), true)
  assert.equal(telemetryVisible(info, { metrics: null, traces: { sentinel: {} }, runs: null }), true)
  assert.equal(telemetryVisible(info, { metrics: null, traces: null, runs: { sentinel: { runs: [] } } }), true)

  // Nothing read yet and nothing answering: there is nothing to keep.
  assert.equal(telemetryVisible(info, { metrics: null, traces: null, runs: null }), false)
  assert.equal(telemetryVisible(info, {}), false)
  // A working daemon shows the panels whether or not anything has been read.
  assert.equal(telemetryVisible({ available: true }, {}), true)

  // The failure the panels then carry is the board's, and the Board panel owns the fix.
  const gone = failureNotice({ code: 'unreachable', error: 'The board could not be reached.' })
  assert.equal(gone.board, true)
  assert.equal(gone.retryable, true)
})

test('a run of one sample is a moment, not a range of no length', () => {
  const one = {
    generation: 1,
    sentinel: {
      metadata: { id: 'r1', name: 'one-shot' },
      metrics: [{ key: 'power_current_watts', label: 'Current board power', unit: 'W', group: 'Power', warn: 20, critical: 30 }],
      samples: [{ timestamp: '2026-09-23T15:27:12.952702307Z', values: { power_current_watts: 7.7 } }]
    }
  }
  const run = runDetail(one)
  assert.equal(run.sampleCount, 1)
  assert.equal(run.single, true)
  assert.equal(run.sampledAt, '2026-09-23T15:27:12.952702307Z')
  // Mean, minimum and maximum are all that one value, and it is ranked on its own.
  assert.deepEqual(
    [run.metrics[0].mean, run.metrics[0].minimum, run.metrics[0].maximum, run.metrics[0].status],
    [7.7, 7.7, 7.7, 'ok']
  )
  // One point draws no sparkline rather than a flat line implying a measured trend.
  assert.equal(sparkline([7.7]), null)

  // The real four-sample run from the board is a range, and keeps both ends of it.
  const many = runDetail({ sentinel: RUN })
  assert.equal(many.single, false)
  assert.equal(many.sampledAt, null)
  assert.ok(many.firstSampleAt && many.lastSampleAt && many.firstSampleAt !== many.lastSampleAt)

  // A run with no samples at all is neither a moment nor a range.
  const none = runDetail({ sentinel: { metadata: { id: 'r0' }, metrics: [], samples: [] } })
  assert.equal(none.sampleCount, 0)
  assert.equal(none.single, false)
  assert.equal(none.sampledAt, null)
})

test('a metric only one run of a comparison measured is placed on the right side', () => {
  // Two runs where each measured something the other did not. Both directions have to be
  // told apart: a missing baseline value and a missing value in this run are different
  // statements, and neither is "Sentinel publishes no change for it".
  const table = compareTable({
    sentinel: {
      baseline_id: 'base',
      runs: [{ id: 'base', name: 'baseline' }, { id: 'other', name: 'after' }],
      summaries: {
        base: { metrics: { shared: { mean: 10 }, baseline_only: { mean: 4 } } },
        other: { metrics: { shared: { mean: 12 }, other_only: { mean: 9 } } }
      },
      baseline_deltas_pct: { other: { shared: 20, other_only: null } }
    }
  })
  const rowOf = (key) => table.rows.find((row) => row.key === key)
  assert.deepEqual(table.rows.map((row) => row.key), ['baseline_only', 'other_only', 'shared'])

  // Measured only by the baseline: the other column has no value, so no change either.
  assert.deepEqual(rowOf('baseline_only').cells.map((cell) => [cell.value, cell.deltaPct, cell.deltaAbsence]),
    [[4, null, null], [null, null, 'no_value']])
  // Measured only by the other run: there is a value, but nothing to measure it against.
  assert.deepEqual(rowOf('other_only').cells.map((cell) => [cell.value, cell.deltaPct, cell.deltaAbsence]),
    [[null, null, null], [9, null, 'no_baseline']])
  // Measured by both: the daemon's change is shown and no reason is needed.
  assert.deepEqual(rowOf('shared').cells.map((cell) => [cell.value, cell.deltaPct, cell.deltaAbsence]),
    [[10, null, null], [12, 20, null]])

})

test('a run name long enough to break the tables is carried intact and wrapped', () => {
  // Sentinel keeps a name of up to 128 characters, and nothing makes it breakable text.
  const name = 'a'.repeat(NAME_LIMIT)
  const runs = runList({ sentinel: { runs: [{ id: 'id-1', name }, { id: 'id-2', name: 'short' }] } })
  assert.equal(runs[0].label, name)
  assert.equal(runs[0].ref, name, 'the name is the reference, so it must not be shortened')
  assert.equal(validateTrace({ name }).body.name, name)
  assert.match(validateTrace({ name: `${name}a` }).error, /at most 128 characters/)

  // It survives the compare query and the selection whole.
  assert.equal(compareQuery([name, 'short']), `/api/sentinel/compare?runs=${encodeURIComponent(`${name},short`)}`)
  assert.deepEqual(missingSelection([name], runs), [])
  assert.deepEqual(uncomparableRefs([name]), [])

  // The cells that carry it are header cells, which do not wrap the way `td` already does.
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.stats-run-table tbody th,\n\.stats-compare-table thead th \{\n\s*overflow-wrap: anywhere;/)
})

test('a delete names one run and the board generation its list came from', () => {
  assert.equal(deleteRunQuery('baseline', 3), '/api/sentinel/runs/baseline?generation=3')
  assert.equal(deleteRunQuery("x'; rm -rf /?a=b#c", 0), "/api/sentinel/runs/x'%3B%20rm%20-rf%20%2F%3Fa%3Db%23c?generation=0")
  // Without a generation the backend deletes on whatever board is selected, so none is invented.
  assert.equal(deleteRunQuery('a/b'), '/api/sentinel/runs/a%2Fb')
  assert.equal(deleteRunQuery('a', '3'), '/api/sentinel/runs/a')
  assert.equal(deletePrompt(1), 'Delete 1 run?')
  assert.equal(deletePrompt(3), 'Delete 3 runs?')
})

test('a failure about the board stops the remaining deletes; one about the run does not', () => {
  const notice = (code) => failureNotice({ code, error: 'x' }, 1, { action: 'delete' })
  for (const code of ['unreachable', 'timeout', 'tool_missing', 'sentinel_denied', 'stale_snapshot', 'network']) {
    assert.equal(deleteStops(notice(code)), true, code)
  }
  for (const code of ['not_found', 'trace_conflict', 'sentinel_failed', 'invalid_request']) {
    assert.equal(deleteStops(notice(code)), false, code)
  }
  assert.equal(deleteStops(null), false)
})

test('delete failures are titled for deleting, not for reading or starting a trace', () => {
  const notice = (code) => failureNotice({ code, error: 'x' }, 1, { action: 'delete' })
  assert.equal(notice('trace_conflict').title, 'That run is still recording')
  assert.equal(notice('stale_snapshot').title, 'The selected board changed')
  assert.equal(notice('sentinel_failed').title, 'Sentinel did not delete the run')
  assert.equal(notice('unreachable').title, 'The board could not be reached')
  // Reading keeps its own wording.
  assert.equal(failureNotice({ code: 'trace_conflict', error: 'x' }).title, 'That trace cannot start')
})

test('the delete summary keeps what was deleted and names what failed and why', () => {
  const conflict = failureNotice({ code: 'trace_conflict', error: "cannot delete active run 'b'" }, 1, { action: 'delete' })
  const summary = deleteSummary([
    { ref: 'a', deleted: { id: '20260924T175231.958Z-a', name: 'a' } },
    { ref: 'b', notice: conflict },
    { ref: 'c', skipped: true }
  ])
  assert.deepEqual(summary.deleted, ['a'])
  assert.deepEqual(summary.failed.map((result) => [result.ref, result.notice.message]), [['b', "cannot delete active run 'b'"]])
  assert.deepEqual(summary.skipped, ['c'])
  assert.deepEqual([...summary.gone].sort(), ['20260924T175231.958Z-a', 'a'])
  assert.equal(summary.status, 'Deleted 1 run from the board.')
  assert.equal(summary.title, '2 of 3 runs were not deleted')

  const one = deleteSummary([{ ref: 'b', notice: conflict }])
  assert.equal(one.title, 'Run b was not deleted')
  assert.equal(one.status, '')
  assert.equal(one.gone.size, 0)

  const clean = deleteSummary([{ ref: 'a', deleted: { id: 'i-a', name: 'a' } }, { ref: 'i-b', deleted: { id: 'i-b', name: 'b' } }])
  assert.equal(clean.title, '')
  assert.equal(clean.status, 'Deleted 2 runs from the board.')
  assert.deepEqual([...clean.gone].sort(), ['a', 'b', 'i-a', 'i-b'])
})

test('a comparison that included a deleted run is recognised by its id or name', () => {
  const compare = { sentinel: { runs: [{ id: 'i-a', name: 'a' }, { id: 'i-b', name: 'b' }] } }
  assert.equal(compareIncludes(compare, new Set(['a'])), true)
  assert.equal(compareIncludes(compare, new Set(['i-b'])), true)
  assert.equal(compareIncludes(compare, new Set(['c'])), false)
  assert.equal(compareIncludes(compare, new Set()), false)
  assert.equal(compareIncludes(null, new Set(['a'])), false)
  assert.equal(compareIncludes({ sentinel: { runs: ['a'] } }, new Set(['a'])), false)
})
