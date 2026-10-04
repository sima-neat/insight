import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { apiError } from '../peripherals/model.js'
import {
  BOARD_PROBLEM_CODES, HOST_POLL_MS, MAX_COMPARE_RUNS, MAX_POLL_MS, NAME_LIMIT, POLL_MS, compareIncludes, compareQuery,
  compareReady, compareTable, createRequestGuard, daemonBusy, daemonFacts, daemonInfo, daemonNoticeNeeded, definitionsByKey,
  deletePrompt, deleteRunQuery, deleteStops, deleteSummary, deltaAbsenceText, factRows, failureNotice, formatBytes,
  formatPercentDelta, formatSeconds, formatTimeRange, formatValue, healthFacts, healthProblems, hostMetricsModel, hostNotice,
  installQuery, isStale, metricsModel, missingSelection, parseTags, payloadBoardLabel, pollDelay, runActionRef, runDetail,
  runList, runSubtitle, selectionChange, sessionCsv, sessionCsvFilename, sparkline, sparklineLabel, staleFlags, staleNote,
  startTraceQuery, statusInfo, statusOf, stopTraceQuery, telemetryVisible, thresholdText, toggleSelection, traceModel,
  uncomparableRefs, validateTrace
} from './model.js'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
// The comparison Sentinel main:80ab7de4da31 returned on a Modalix DevKit, trimmed to six metrics, values verbatim.
const COMPARE = fixture('compare-shape')
// The same run read back from /api/sentinel/runs/<name>, trimmed to those six metrics.
const RUN = fixture('run-detail-shape')
// What POST /api/sentinel/install and GET /api/sentinel answer when Sentinel is unusable, captured from neat_insight.sentinel.api.
const INSTALL = fixture('install-failures')
const daemon = (extra = {}) => ({
  installed: true, healthy: true, service: 'active', socket: true, socket_path: '/run/simaai-sentinel/api.sock', sima_cli: '/usr/bin/sima-cli', ...extra
})
const METRICS = {
  board: { label: 'sima@192.168.2.2', fingerprint: 'fp-1' }, generation: 3, sampled_at: '2026-09-22T20:55:47Z', version: 'main:80ab7de4da31',
  counts: { total: 4, unavailable: 1, warn: 1, critical: 0 }, highlights: ['power_current_watts', 'rtsn_0'],
  groups: [
    { name: 'MLA', metrics: [{ key: 'rtsn_0', label: 'MLA RTSN-0', short: 'MLA-0', unit: 'C', group: 'MLA', warn: 70, critical: 85, value: 72, status: 'warn' }] },
    { name: 'Power', metrics: [{ key: 'power_current_watts', label: 'Current board power', short: 'Current', unit: 'W', group: 'Power', warn: null, critical: null, value: null, status: 'unavailable' }] },
    { name: 'Empty', metrics: [] }
  ],
  history: { timestamps: ['2026-09-22T20:55:45Z', '2026-09-22T20:55:47Z'], series: { rtsn_0: [70, 72], power_current_watts: [null, null] } }
}
const rowOf = (table, key) => table.rows.find((row) => row.key === key)
const copy = (value) => JSON.parse(JSON.stringify(value))

test('the daemon section appears only when it has something to say, and is busy during the first check', () => {
  const ready = { state: 'ready' }
  const cases = [
    [ready, undefined, false], // a working daemon renders nothing; the telemetry below is the proof
    [ready, { error: null, health: null, install: null }, false],
    [{ state: 'missing' }, undefined, true],
    [{ state: 'unknown' }, undefined, false], // no panel flashes while the first read is out
    [{ state: 'unknown' }, { error: { message: 'Sentinel did not answer' } }, true],
    [null, undefined, true],
    [ready, { error: { message: 'Sentinel could not be installed' } }, true],
    [ready, { health: { errors: ['power collector: read failed'] } }, true],
    [ready, { install: { log: 'sima-cli neat install sentinel\n' } }, true],
    [ready, { install: { log: '' } }, false]
  ]
  for (const [state, extra, needed] of cases) assert.equal(daemonNoticeNeeded(state, extra), needed, JSON.stringify([state, extra]))
  assert.deepEqual([{ installBusy: false, stateBusy: true }, { installBusy: true, stateBusy: false }, { installBusy: false, stateBusy: false }, undefined].map(daemonBusy),
    [true, true, false, false])
})

test('values, changes, durations, sizes, time ranges and statuses read as a developer expects; polling backs off', () => {
  assert.deepEqual([[72, 'C'], [95.456, '%'], [7.126, 'W'], [1234.5, 'MB'], [null, 'W'], [undefined, 'W'], ['72', 'C'], [800, null]].map(([v, u]) => formatValue(v, u)),
    ['72 °C', '95.5%', '7.13 W', '1235 MB', '—', '—', '—', '800'])
  // A change too small to print must not round to 0%, which would read as no change.
  assert.deepEqual([-1.507232237109984, 12.753877670471164, 0, -0.0002595591909001994, null].map(formatPercentDelta), ['−1.51%', '+12.8%', '±0%', '−<0.01%', '—'])
  assert.deepEqual([4.25, 45.6, 90, 7500, null, -1].map(formatSeconds), ['4.3 s', '46 s', '1 min 30 s', '2 h 5 min', '', ''])
  assert.deepEqual([0, 2048, 8 * 1024 ** 3, 1536 * 1024 ** 2, null, -1].map(formatBytes), ['0 B', '2 kB', '8 GB', '1.5 GB', '', ''])
  assert.equal(formatTimeRange('2026-09-24T17:52:33Z', '2026-09-24T17:52:39Z', 'en-US'), 'Sep 24, 2026, 17:52:33–17:52:39')
  assert.equal(formatTimeRange('2026-09-24T23:59:50Z', '2026-09-25T00:00:10Z', 'en-US'), 'Sep 24, 2026, 23:59:50 – Sep 25, 2026, 00:00:10')
  assert.equal(formatTimeRange('x', '2026-09-24T17:52:39Z'), '')
  assert.deepEqual(statusInfo('critical'), { label: 'Critical', tone: 'periph-danger' })
  assert.deepEqual(['ok', 'unavailable', 'nonsense'].map((status) => statusInfo(status).label), ['Normal', 'Not measured', 'Not measured'])
  assert.equal(thresholdText({ warn: 70, critical: 85, unit: 'C' }), 'warn at 70 °C, critical at 85 °C')
  assert.equal(thresholdText({ warn: null, critical: null }), '')
  // Polling backs off while the board keeps failing and never runs away.
  assert.deepEqual([0, 1, 3, 99, undefined].map(pollDelay), [POLL_MS, 4000, 16000, MAX_POLL_MS, POLL_MS])
})

test('the metrics payload becomes highlights, groups and a summary line, and still leads with something', () => {
  const model = metricsModel(METRICS)
  assert.deepEqual(model.groups.map((group) => group.name), ['MLA', 'Power'])
  assert.deepEqual(model.highlights.map((metric) => metric.key), ['power_current_watts', 'rtsn_0'])
  assert.equal(model.sampledAt, '2026-09-22T20:55:47Z')
  assert.deepEqual(model.series.rtsn_0, [70, 72])
  // The counts still reach the group chips, which carry the warnings and criticals.
  assert.deepEqual([model.counts.total, model.counts.warn, model.counts.unavailable], [4, 1, 1])
  assert.deepEqual(metricsModel({ ...METRICS, highlights: ['unknown_key'] }).highlights.map((metric) => metric.key), ['rtsn_0'])
  assert.deepEqual([metricsModel(null).groups, metricsModel(null).highlights], [[], []])
})

test('sparklines skip gaps, need two points, and describe themselves', () => {
  const spark = sparkline([70, null, 72], 100, 20)
  assert.deepEqual([spark.count, spark.min, spark.max, spark.points], [2, 70, 72, '0,19 100,1'])
  for (const values of [[70], [null, null], []]) assert.equal(sparkline(values, 100, 20), null)
  assert.equal(sparkline([5, 5], 100, 20).points, '0,19 100,19')
  assert.equal(sparklineLabel({ label: 'MLA RTSN-0', unit: 'C' }, spark), 'MLA RTSN-0: 2 recent samples, 70 °C to 72 °C')
  assert.equal(sparklineLabel({ label: 'x' }, null), '')
})

test('the daemon state says what is wrong and whether this page can install it; health stays readable', () => {
  const ready = daemonInfo({ available: true, version: 'main:80ab', status: { state: 'ready', error: null }, daemon: daemon() })
  assert.deepEqual([ready.label, ready.canInstall], ['Running', false])
  assert.match(ready.installBlocked, /already running/)
  assert.deepEqual(daemonFacts(ready)[0], ['Service', 'active'])
  const missing = daemonInfo({
    available: false, daemon: daemon({ installed: false, healthy: false, service: 'inactive', socket: false }),
    status: { state: 'missing', error: { error: 'Sentinel is not installed on this board.', code: 'sentinel_missing', hint: 'Install it from this page.' } }
  })
  assert.deepEqual([missing.label, missing.canInstall, missing.error.code], ['Not installed', true, 'sentinel_missing'])
  const noCli = daemonInfo({ status: { state: 'missing', error: null }, daemon: daemon({ healthy: false, sima_cli: null }) })
  assert.equal(noCli.canInstall, false)
  assert.match(noCli.installBlocked, /sima-cli was not found/)
  assert.deepEqual([daemonInfo(null).state, daemonInfo(null).canInstall], ['unknown', false])
  const rows = healthFacts({ metric_count: 3, cached_samples: 240, latest_sample_at: new Date().toISOString() })
  assert.deepEqual(rows.slice(0, 2), [['Metrics', '3'], ['Cached samples', '240']])
  assert.equal(rows[2][0], 'Latest sample')
  assert.deepEqual(healthFacts(null), [])
  assert.deepEqual(healthProblems({ errors: ['pmbus read failed', { error: 'ev74 busy' }, null] }), ['pmbus read failed', 'ev74 busy'])
  assert.deepEqual(healthProblems(null), [])
})

test('every backend failure becomes a title, a sentence and a place to fix it', () => {
  const noBoard = failureNotice({ error: 'No board is selected.', code: 'no_target', hint: 'Enter the board address.' })
  assert.deepEqual([noBoard.title, noBoard.hint, noBoard.board, noBoard.retryable], ['No board is selected', 'Enter the board address.', true, false])
  const unreachable = failureNotice({ error: 'ssh: connect failed', code: 'unreachable', hint: null })
  assert.equal(unreachable.board, true)
  assert.match(unreachable.hint, /Board panel/)
  assert.equal(failureNotice({ error: 'host key changed', code: 'host_key_changed', presented_fingerprint: 'SHA256:new' }).details.presented_fingerprint, 'SHA256:new')
  const schema = failureNotice({ error: 'Sentinel speaks schema 2', code: 'sentinel_schema' })
  assert.deepEqual([schema.title, schema.board], ['Sentinel and Insight speak different API versions', false])
  assert.equal(failureNotice({ error: 'socket cannot be opened', code: 'sentinel_denied' }).daemon, true)
  assert.equal(failureNotice({ error: 'installer failed', code: 'sentinel_failed', detail: 'exit 1\nlog tail' }).detail, 'exit 1\nlog tail')
  // A run too long to read is named as that, not as Sentinel failing to answer.
  const tooLarge = failureNotice({ error: 'larger than the 12 MiB Insight reads', code: 'response_too_large', limit_bytes: 12582912 })
  assert.deepEqual([tooLarge.title, tooLarge.board, tooLarge.daemon], ['Sentinel answered with more than Insight reads', false, false])
  assert.equal(failureNotice({ error: 'boom', code: 'unheard_of' }).title, 'Something went wrong')
  assert.equal(failureNotice(null), null)
  // A failure carries the generation of the board that answered it, not the one it was sent to.
  assert.equal(failureNotice(apiError({ error: 'no active trace', code: 'trace_conflict', generation: 4 }, 409), 3).generation, 4)
  assert.equal(failureNotice(apiError({ error: 'no board', code: 'no_target' }, 409), 3).generation, 3)
  for (const code of ['no_target', 'unreachable', 'auth_failed', 'host_key_changed', 'timeout']) assert.ok(BOARD_PROBLEM_CODES.has(code))
})

test('a payload read before the board changed is stale', () => {
  assert.deepEqual([[{ generation: 4 }, METRICS], [{ generation: 3 }, METRICS], [null, METRICS], [{ generation: 4 }, { board: {} }]].map(([b, p]) => isStale(b, p)),
    [true, false, false, false])
})

test('a failure that lands after a board switch carries the generation it was issued under', () => {
  const notice = failureNotice({ error: 'ssh: connect failed', code: 'unreachable' }, 3)
  assert.equal(notice.generation, 3)
  assert.deepEqual([isStale({ generation: 4 }, notice), isStale({ generation: 3 }, notice)], [true, false])
  // Without a generation - no board state yet - a failure is never labelled stale.
  assert.equal(isStale({ generation: 4 }, failureNotice({ error: 'boom', code: 'timeout' })), false)
})

test('every payload is judged stale on its own generation, not just the metrics', () => {
  const board = { generation: 4 }
  const onA = (extra = {}) => ({ generation: 3, board: { label: 'sima@192.168.2.2' }, ...extra })
  const onB = (extra = {}) => ({ generation: 4, board: { label: 'sima@10.0.0.9' }, ...extra })
  const flags = staleFlags(board, {
    metrics: onA(), traces: onA({ sentinel: { trace: { name: 'baseline' } } }), runs: onA({ sentinel: { runs: [{ name: 'baseline' }] } }),
    detail: onA({ sentinel: { run: { id: 'r1' } } }), compare: onA({ sentinel: { runs: ['baseline'] } }), install: onB({ log: 'installed' })
  })
  assert.deepEqual(flags, { metrics: true, traces: true, runs: true, detail: true, compare: true, install: false })
  // Nothing is dropped: the caller still has the values to render under the label.
  assert.deepEqual(staleFlags(board, {}), {})
  assert.deepEqual(staleFlags(null, { compare: onA() }), { compare: false })
  assert.deepEqual([payloadBoardLabel(onA()), payloadBoardLabel({})], ['sima@192.168.2.2', ''])
  assert.equal(staleNote('These runs', 'sima@192.168.2.2'), 'These runs below: read from sima@192.168.2.2, not from the board selected now.')
  assert.equal(staleNote('This comparison'), 'This comparison below: read from a board that is no longer selected, not from the board selected now.')
})

test('the active trace and its running summary are read from the daemon body', () => {
  const model = traceModel({ sentinel: { trace: { name: 'baseline', started_at: '2026-09-22T20:50:00Z' }, summary: { samples: 12, peak_power_watts: 9.5 } } })
  assert.deepEqual([model.active, model.name, model.startedAt], [true, 'baseline', '2026-09-22T20:50:00Z'])
  assert.deepEqual(model.facts, [['Samples', '12'], ['Peak power watts', '9.5']])
  assert.equal(model.payload.sentinel.trace.name, 'baseline')
  const idle = traceModel({ sentinel: { trace: null, summary: null } })
  assert.deepEqual([idle.active, idle.facts], [false, []])
  assert.deepEqual([traceModel(null).payload, traceModel(null).active], [null, false])
})

test('a trace request is checked here before it reaches the board', () => {
  assert.deepEqual(validateTrace({ name: '  baseline  ', note: ' before ', tags: 'compiler-v1, nms' }), {
    body: { name: 'baseline', note: 'before', tags: ['compiler-v1', 'nms'] }
  })
  assert.deepEqual(validateTrace({ name: 'bare' }), { body: { name: 'bare' } })
  for (const form of [{ name: '   ' }, { name: 'x'.repeat(129) }, { name: 'x', note: 'n'.repeat(513) }, { name: 'x', tags: Array.from({ length: 17 }, (_, i) => `t${i}`) }]) {
    assert.ok(validateTrace(form).error)
  }
  assert.deepEqual([parseTags(' a , ,b '), parseTags('')], [['a', 'b'], []])
})

test('a run whose name holds a comma is named, not sent into a 404', () => {
  // /api/sentinel/compare splits its runs on commas after decoding, so `before, after` reads as two runs (a 404).
  const selected = ['before, after', 'insight-hw-1790177227']
  assert.deepEqual(uncomparableRefs(selected), ['before, after'])
  assert.equal(compareReady(selected), false, 'Compare must not be offered for a query that cannot say what it means')
  assert.deepEqual(uncomparableRefs(['insight-hw-1790177227', 'insight-hw-1790177178']), [])
  assert.equal(compareReady(['insight-hw-1790177227', 'insight-hw-1790177178']), true)
  assert.match(validateTrace({ name: 'before, after' }).error, /cannot contain a comma/)
  assert.equal(validateTrace({ name: 'before, after' }).body, undefined)
  assert.deepEqual(validateTrace({ name: 'before-after' }).body, { name: 'before-after' })
})

test('run summaries survive the daemon field names and carry the energy Sentinel measured', () => {
  const runs = runList({ sentinel: { runs: [
    { id: 'r1', name: 'baseline', state: 'complete', started_at: '2026-09-22T20:00:00Z', ended_at: '2026-09-22T20:02:00Z', samples: 60, tags: ['v1'], note: 'before' },
    { run_id: 'r2', label: 'optimized', status: 'recording', start_time: '2026-09-22T20:10:00Z', duration_ms: 4500 }, 'r3', {}
  ] } })
  assert.deepEqual(runs.map((run) => run.label), ['baseline', 'optimized', 'r3'])
  assert.deepEqual(runs.map((run) => run.ref), ['baseline', 'optimized', 'r3'])
  assert.deepEqual([runs[0].durationSec, runs[1].durationSec, runs[0].tags], [120, 4.5, ['v1']])
  assert.deepEqual([runList({ sentinel: { runs: [] } }), runList(null)], [[], []])
  assert.match(runSubtitle(runs[0], Date.parse('2026-09-22T20:03:00Z')), /^Complete · started .* · 2 min 0 s · 60 samples$/)
  assert.equal(runSubtitle({ label: 'x' }, Date.now()), '')
  // /api/sentinel/runs on the DevKit, verbatim: energy is the number a run is judged on.
  const measured = runList({ sentinel: { runs: [
    { id: '20260923T152712.952Z-insight-hw-1790177227', name: 'insight-hw-1790177227', started_at: '2026-09-23T15:27:12.952702307Z', ended_at: '2026-09-23T15:27:19.620064802Z', duration_ms: 6667, energy_joules: 51.533604984375, samples: 4 },
    { id: 'r2', name: 'no-energy', duration_ms: 1000, samples: 2 }
  ] } })
  assert.equal(measured[0].energyJoules, 51.533604984375)
  assert.match(runSubtitle(measured[0], Date.parse('2026-09-23T15:28:00Z')), / · 6.7 s · 51.5 J · 4 samples$/)
  // A daemon that reports no energy says nothing about it rather than reading as 0 J.
  assert.equal(measured[1].energyJoules, null)
  assert.equal(runSubtitle(measured[1], Date.now()), '1 s · 2 samples')
})

test('an unknown body is flattened into bounded label/value rows, never raw JSON', () => {
  const rows = factRows({ id: 'r1', samples: 60, healthy: true, tags: ['a', 'b'], stats: { power: { mean: 7.2 } }, nested: { a: { b: { c: { d: 1 } } } }, skipped: 'no' }, ['skipped'])
  assert.deepEqual(rows, [['Id', 'r1'], ['Samples', '60'], ['Healthy', 'yes'], ['Tags', 'a, b'], ['Stats power mean', '7.2']])
  assert.deepEqual(factRows(null), [])
  assert.ok(factRows(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]))).length <= 120)
})

test('compare selection is bounded and the query keeps the baseline first', () => {
  const selected = toggleSelection(toggleSelection([], 'baseline'), 'optimized')
  assert.deepEqual(selected, ['baseline', 'optimized'])
  assert.deepEqual(toggleSelection(selected, 'baseline'), ['optimized'])
  const full = Array.from({ length: MAX_COMPARE_RUNS }, (_, i) => `r${i}`)
  assert.deepEqual(toggleSelection(full, 'extra'), full)
  assert.deepEqual([['a'], ['a', 'b'], full.concat('x')].map(compareReady), [false, true, false])
  assert.equal(compareQuery(['baseline', 'a/b']), '/api/sentinel/compare?runs=baseline%2Ca%2Fb')
})

test('the captured comparison is read as a table of metrics against the baseline', () => {
  const table = compareTable({ sentinel: COMPARE })
  assert.deepEqual(table.columns.map((column) => [column.label, column.baseline]), [['insight-hw-1790177227', true], ['insight-hw-1790177178', false]])
  // The note tells two runs of the same workload apart, and /compare sends one per run.
  assert.deepEqual(table.columns.map((column) => column.note), ['Insight hardware validation', 'Insight hardware validation'])
  assert.deepEqual(compareTable({ sentinel: { ...COMPARE, runs: COMPARE.runs.map(({ note, ...rest }) => rest) } }).columns.map((column) => column.note), ['', ''])
  assert.deepEqual([table.baselineId, table.baselineLabel, table.generatedAt, table.statistic],
    [COMPARE.baseline_id, 'insight-hw-1790177227', '2026-09-23T15:27:56.138344320Z', 'mean'])
  // Run scalars carry no delta; a duration arrives in milliseconds and is read in seconds.
  const duration = rowOf(table, 'duration_ms')
  assert.deepEqual([duration.label, duration.unit], ['Duration', 's'])
  assert.deepEqual(duration.cells.map((cell) => [cell.value, cell.deltaPct]), [[6.667, null], [34.379, null]])
  assert.equal(formatValue(duration.cells[1].value, duration.unit), '34.4 s')
  const energy = rowOf(table, 'energy_joules')
  assert.equal(energy.label, 'Energy')
  assert.equal(formatValue(energy.cells[1].value, energy.unit), '275 J')
  // A metric cell carries the mean, the statistic the delta is measured on; the baseline shows no change of its own.
  const power = rowOf(table, 'power_current_watts')
  assert.equal(power.cells[0].value, COMPARE.summaries[COMPARE.baseline_id].metrics.power_current_watts.mean)
  assert.deepEqual([power.cells[0].baseline, power.cells[0].deltaPct, power.cells[1].deltaPct], [true, null, -0.35731427657192105])
  // A baseline mean of 0: Sentinel sends no delta, but the metric was measured.
  const idle = rowOf(table, 'cpu_core_11_usage_pct')
  assert.deepEqual(idle.cells.map((cell) => cell.value), [0, 0])
  assert.equal(idle.cells[1].deltaPct, null)
  assert.equal(formatPercentDelta(idle.cells[1].deltaPct), '—')
})

test('a change Sentinel withholds says which of its four reasons applies', () => {
  const table = compareTable({ sentinel: COMPARE })
  // cpu_core_13: the baseline measured it four times at a mean of 0 and the other run averaged 5.9%.
  const busy = rowOf(table, 'cpu_core_13_usage_pct')
  assert.equal(COMPARE.summaries[COMPARE.baseline_id].metrics.cpu_core_13_usage_pct.count, 4)
  assert.deepEqual(busy.cells.map((cell) => cell.value), [0, 5.91190441525744])
  assert.deepEqual([busy.cells[1].deltaPct, busy.cells[1].deltaAbsence], [null, 'baseline_zero'])
  assert.match(deltaAbsenceText('baseline_zero'), /no percentage change from 0/)
  // A run scalar has no delta because none is published; the baseline never claims a reason of its own.
  assert.equal(rowOf(table, 'energy_joules').cells[1].deltaAbsence, 'not_published')
  assert.deepEqual(rowOf(table, 'power_current_watts').cells.map((cell) => cell.deltaAbsence), [null, null])
  // A metric this comparison's baseline has no value for at all.
  const partial = copy(COMPARE)
  const others = Object.keys(partial.summaries).filter((id) => id !== partial.baseline_id)
  delete partial.summaries[partial.baseline_id].metrics.rtsn_6
  for (const id of Object.keys(partial.baseline_deltas_pct)) delete partial.baseline_deltas_pct[id].rtsn_6
  const rtsn = rowOf(compareTable({ sentinel: partial }), 'rtsn_6')
  assert.deepEqual([rtsn.cells[0].value, rtsn.cells[1].value, rtsn.cells[1].deltaAbsence], [null, partial.summaries[others[0]].metrics.rtsn_6.mean, 'no_baseline'])
  for (const reason of ['not_published', 'baseline_zero', 'no_baseline', 'no_value']) assert.ok(deltaAbsenceText(reason).length > 0, reason)
})

test('a metric only one run of a comparison measured is placed on the right side', () => {
  // Two runs where each measured something the other did not: both directions are told apart.
  const sided = compareTable({
    sentinel: {
      baseline_id: 'base',
      runs: [{ id: 'base', name: 'baseline' }, { id: 'other', name: 'after' }],
      summaries: { base: { metrics: { shared: { mean: 10 }, baseline_only: { mean: 4 } } }, other: { metrics: { shared: { mean: 12 }, other_only: { mean: 9 } } } },
      baseline_deltas_pct: { other: { shared: 20, other_only: null } }
    }
  })
  const cells = (key) => rowOf(sided, key).cells.map((cell) => [cell.value, cell.deltaPct, cell.deltaAbsence])
  assert.deepEqual(sided.rows.map((row) => row.key), ['baseline_only', 'other_only', 'shared'])
  assert.deepEqual(cells('baseline_only'), [[4, null, null], [null, null, 'no_value']])
  assert.deepEqual(cells('other_only'), [[null, null, null], [9, null, 'no_baseline']])
  assert.deepEqual(cells('shared'), [[10, null, null], [12, 20, null]])
})

test('a run the daemon listed but summarised nothing for is marked, not read as empty', () => {
  const partial = copy(COMPARE)
  const other = Object.keys(partial.summaries).find((id) => id !== partial.baseline_id)
  delete partial.summaries[other]
  const table = compareTable({ sentinel: partial })
  assert.deepEqual(table.columns.map((column) => column.summarised), [true, false])
  const power = rowOf(table, 'power_current_watts')
  assert.deepEqual([power.cells[1].value, power.cells[1].deltaAbsence], [null, 'no_value'])
  // The daemon still published a change; printed beside an em dash it would describe a number not shown.
  assert.equal(partial.baseline_deltas_pct[other].power_current_watts, -0.35731427657192105)
  assert.equal(power.cells[1].deltaPct, null)
})

test('a comparison is labelled from the board definitions only, and an unknown shape is reported, not guessed at', () => {
  const definitions = definitionsByKey({ groups: [{ name: 'Power', metrics: [{ key: 'power_current_watts', label: 'Current board power', unit: 'W', group: 'Power' }] }] })
  const table = compareTable({ sentinel: COMPARE }, definitions)
  const power = rowOf(table, 'power_current_watts')
  assert.deepEqual([power.label, power.unit, formatValue(power.cells[0].value, power.unit)], ['Current board power', 'W', '8.62 W'])
  // A key no definition names keeps its key, with no unit invented for it.
  assert.deepEqual([rowOf(table, 'rtsn_6').label, rowOf(table, 'rtsn_6').unit], ['Rtsn 6', null])
  assert.equal(rowOf(compareTable({ sentinel: COMPARE }), 'power_current_watts').unit, null)
  // null here means "list the values as they came".
  for (const sentinel of [{ runs: [{ name: 'a' }, { name: 'b' }], series: {} }, { runs: [COMPARE.runs[0]], summaries: COMPARE.summaries },
    { ...COMPARE, summaries: {} }, { ...COMPARE, runs: [] }, {}]) {
    assert.equal(compareTable({ sentinel }), null)
  }
  assert.equal(compareTable(null), null)
})

test('the captured run is read from its own metadata, definitions and samples, with the daemon\'s own statistics', () => {
  const run = runDetail({ generation: 4, sentinel: RUN })
  assert.deepEqual([run.sampleCount, run.metricCount, run.firstSampleAt, run.lastSampleAt, run.metadata.id],
    [4, 6, '2026-09-23T15:27:13.270295197Z', '2026-09-23T15:27:19.270569777Z', '20260923T152712.952Z-insight-hw-1790177227'])
  assert.deepEqual([run.undefinedKeys, run.extras], [[], []])
  // Every metadata field the daemon sent, including the nested system block.
  const facts = Object.fromEntries(run.facts)
  assert.deepEqual([facts.Name, facts['Sample interval ms'], facts['Sentinel version'], facts['System hostname']],
    ['insight-hw-1790177227', '1989', 'main:80ab7de4da31', 'modalix'])
  // Labels, units and groups come from the definitions the run itself carries.
  assert.deepEqual(run.metrics.map((metric) => metric.group), ['CPU', 'CPU', 'Disk', 'Memory', 'Power', 'TOP'])
  const power = run.metrics.find((metric) => metric.key === 'power_current_watts')
  assert.deepEqual([power.label, power.unit, formatValue(power.maximum, power.unit), power.count], ['Current board power', 'W', '8.88 W', 4])
  const cpu = run.metrics.find((metric) => metric.key === 'cpu_core_0_usage_pct')
  assert.deepEqual([cpu.warn, cpu.critical, cpu.status, run.crossed], [80, 95, 'ok', 0])
  // The captured run is the comparison's baseline: the statistics computed here must be Sentinel's own.
  assert.equal(run.metadata.id, COMPARE.baseline_id)
  const daemonStats = COMPARE.summaries[COMPARE.baseline_id].metrics
  for (const metric of run.metrics) {
    for (const stat of ['mean', 'minimum', 'maximum', 'count']) assert.equal(metric[stat], daemonStats[metric.key][stat], `${metric.key} ${stat}`)
  }
})

test('a run ranks its metrics against the thresholds it recorded, not today\'s', () => {
  assert.deepEqual([[90, 80, 95], [95, 80, 95], [12, 80, 95], [null, 80, 95], [1e6, null, null]].map((args) => statusOf(...args)),
    ['warn', 'critical', 'ok', 'unavailable', 'ok'])
  // Thresholds and values here are not from the board; they exercise the ranking.
  const hot = runDetail({
    sentinel: {
      metadata: { id: 'r1' },
      metrics: [
        { key: 'rtsn_6', label: 'TOP RTSN-6', group: 'TOP', unit: 'C', warn: 70, critical: 85 },
        { key: 'ghost', label: 'Never measured', group: 'TOP', unit: 'C', warn: 70, critical: 85 }
      ],
      samples: [{ timestamp: '2026-09-23T15:27:14Z', values: { rtsn_6: 40, ghost: null } }, { timestamp: '2026-09-23T15:27:16Z', values: { rtsn_6: 88, ghost: null } }]
    }
  })
  const [ghost, rtsn] = hot.metrics
  assert.deepEqual([rtsn.status, rtsn.maximum, rtsn.mean], ['critical', 88, 64])
  // A metric the run defined but never measured stays empty, never zero.
  assert.deepEqual([ghost.status, ghost.count, ghost.mean, ghost.maximum, formatValue(ghost.mean, ghost.unit)], ['unavailable', 0, null, null, '—'])
  assert.equal(hot.crossed, 1)
})

test('a run body without the three documented keys falls back instead of guessing', () => {
  for (const payload of [{ sentinel: { run: { id: 'r1' } } }, { sentinel: {} }, null]) assert.equal(runDetail(payload), null)
  // Metrics as a map, samples absent, and a field beyond the three: all still reported.
  const odd = runDetail({ sentinel: { metadata: null, metrics: { power_current_watts: { unit: 'W' } }, retention: 'kept' } })
  assert.deepEqual([odd.metricCount, odd.sampleCount, odd.metrics, odd.facts, odd.extras], [1, 0, [], [], [['Retention', 'kept']]])
  // A value with no definition of its own is counted rather than passed over silently.
  const extra = runDetail({ sentinel: { metadata: {}, metrics: [{ key: 'rtsn_6' }], samples: [{ timestamp: 't', values: { rtsn_6: 1, mystery_metric: 2 } }] } })
  assert.deepEqual(extra.undefinedKeys, ['mystery_metric'])
})

test('a run of one sample is a moment, not a range of no length', () => {
  const run = runDetail({ generation: 1, sentinel: {
    metadata: { id: 'r1', name: 'one-shot' }, samples: [{ timestamp: '2026-09-23T15:27:12.952702307Z', values: { power_current_watts: 7.7 } }],
    metrics: [{ key: 'power_current_watts', label: 'Current board power', unit: 'W', group: 'Power', warn: 20, critical: 30 }]
  } })
  assert.deepEqual([run.sampleCount, run.single, run.sampledAt], [1, true, '2026-09-23T15:27:12.952702307Z'])
  const [metric] = run.metrics
  assert.deepEqual([metric.mean, metric.minimum, metric.maximum, metric.status], [7.7, 7.7, 7.7, 'ok'])
  // One point draws no sparkline rather than a flat line implying a measured trend.
  assert.equal(sparkline([7.7]), null)
  // The real four-sample run is a range and keeps both ends; a run with no samples is neither.
  const many = runDetail({ sentinel: RUN })
  assert.deepEqual([many.single, many.sampledAt], [false, null])
  assert.ok(many.firstSampleAt && many.lastSampleAt && many.firstSampleAt !== many.lastSampleAt)
  const none = runDetail({ sentinel: { metadata: { id: 'r0' }, metrics: [], samples: [] } })
  assert.deepEqual([none.sampleCount, none.single, none.sampledAt], [0, false, null])
})

test('the request guard admits one call per key until it ends', () => {
  const guard = createRequestGuard()
  guard.switchTo(1)
  const state = guard.begin('state')
  assert.ok(state)
  assert.equal(guard.running('state'), true)
  assert.equal(guard.begin('state'), null)
  assert.ok(guard.begin('runs'))
  guard.end(state)
  assert.equal(guard.running('state'), false)
  assert.ok(guard.begin('state'))
  guard.end(null)
})

test('requests out before the first board arrives belong to that board', () => {
  // The board state loading is not a switch: the check already out went to this board.
  const fresh = createRequestGuard()
  const early = fresh.begin('state')
  assert.equal(early.generation, null)
  assert.equal(fresh.switchTo(7), false)
  assert.equal(fresh.current(early), true)
  assert.equal(fresh.begin('state'), null)
})

test('a board switch is not blocked by a request still out to the previous board', () => {
  // Board A's /api/sentinel is slow; the masthead selects board B meanwhile.
  const guard = createRequestGuard()
  guard.switchTo(3)
  const onA = guard.begin('state')
  assert.equal(guard.switchTo(4), true)
  const onB = guard.begin('state')
  assert.equal(onB.generation, 4)
  // When A finally answers, its state is dropped, not applied as B's; A's request ending does not end B's.
  assert.deepEqual([guard.current(onA), guard.current(onB)], [false, true])
  guard.end(onA)
  assert.equal(guard.running('state'), true)
  assert.equal(guard.begin('state'), null)
})

test('every board-scoped answer is judged against the board it was asked of', () => {
  // An active-trace read for A landing after the reset for B must not bring back A's trace, whose Stop would stop B's.
  const guard = createRequestGuard()
  guard.switchTo(3)
  const tickets = ['traces', 'runs', 'metrics', 'compare', 'trace-action', 'install', 'delete'].map((key) => guard.begin(key))
  guard.switchTo(4)
  for (const ticket of tickets) assert.equal(guard.current(ticket), false, ticket.key)
  for (const ticket of tickets) assert.ok(guard.begin(ticket.key), ticket.key)
  // Selecting the same board again is not a switch and cancels nothing.
  const kept = guard.begin('host')
  assert.equal(guard.switchTo(4), false)
  assert.equal(guard.current(kept), true)
})

test('an answer read from another board is refused even while its ticket is current', () => {
  // Another client switched Insight from A to B: asked under A's generation, answered from B.
  const guard = createRequestGuard()
  guard.switchTo(3)
  const runs = guard.begin('runs')
  assert.equal(guard.current(runs, { generation: 4, board: { label: 'B' } }), false)
  assert.equal(guard.current(runs, { generation: 3, board: { label: 'A' } }), true)
  // An answer without a generation (an empty body) is judged by its ticket alone.
  assert.deepEqual([guard.current(runs, {}), guard.current(runs)], [true, true])
  // A request out before the page knew its board has nothing to compare with.
  assert.equal(createRequestGuard().current(createRequestGuard().begin('state'), { generation: 9 }), true)
})

test('opening another run supersedes the read of the one opened before it', () => {
  const guard = createRequestGuard()
  guard.switchTo(1)
  const runA = guard.begin('run', { supersede: true })
  const runB = guard.begin('run', { supersede: true })
  assert.ok(runB)
  assert.deepEqual([guard.current(runA), guard.current(runB)], [false, true])
  guard.end(runA)
  assert.equal(guard.running('run'), true)
  // Closing the run, or deleting it, cancels its read outright.
  guard.cancel('run')
  assert.deepEqual([guard.current(runB), guard.running('run')], [false, false])
  guard.cancel('never-started')
})

test('a selection change cancels the comparison still out for the previous selection', () => {
  const guard = createRequestGuard()
  guard.switchTo(3)
  const asked = guard.begin('compare')
  // A/B is being compared; the user unticks B and ticks C.
  let change = selectionChange(guard, ['a', 'b'], (current) => toggleSelection(current, 'b'))
  assert.deepEqual(change, { next: ['a'], changed: true, cancelled: true })
  change = selectionChange(guard, change.next, (current) => toggleSelection(current, 'c'))
  assert.deepEqual(change, { next: ['a', 'c'], changed: true, cancelled: false })
  assert.equal(guard.current(asked, { generation: 3 }), false, "A/B's answer is not applied")
  assert.ok(guard.begin('compare'), 'A/C can be compared at once')
  // Clearing, and dropping runs that left the list, are changes too; an unchanged selection is not.
  assert.equal(selectionChange(guard, ['a', 'c'], []).cancelled, true)
  const kept = guard.begin('compare')
  assert.deepEqual(selectionChange(guard, ['a', 'c'], (current) => current.filter((ref) => ref !== 'z')), { next: ['a', 'c'], changed: false, cancelled: false })
  assert.equal(guard.current(kept), true)
})

test('the Insight host snapshot is modelled apart from the board telemetry, and an absent reading stays absent', () => {
  const model = hostMetricsModel({
    cpu_load: 12.5, memory: { total: 16 * 1024 ** 3, used: 8 * 1024 ** 3, percent: 50 }, temperature_celsius_avg: null, REMOTE: false,
    disk: { mount: '/home/docker', total: 100 * 1024 ** 3, used: 91 * 1024 ** 3, free: 9 * 1024 ** 3, percent: 91 }
  })
  assert.deepEqual([model.source, model.offline], ['local', false])
  assert.deepEqual(model.rows.map((row) => [row.key, row.value]), [['cpu_load', 12.5], ['memory', 50], ['disk', 91]])
  assert.deepEqual([model.rows[1].detail, model.rows[2].detail], ['8 GB of 16 GB', '91 GB of 100 GB · /home/docker'])
  assert.equal(HOST_POLL_MS >= 10000, true)
  const partial = hostMetricsModel({ cpu_load: 5, memory: {}, disk: null, temperature_celsius_avg: 46.5, REMOTE: false })
  assert.deepEqual(partial.rows.map((row) => [row.key, row.value]), [['cpu_load', 5], ['memory', null], ['disk', null], ['temperature', 46.5]])
  assert.equal(partial.rows[1].detail, '')
  const offline = hostMetricsModel({ cpu_load: '', memory: {}, disk: {}, temperature_celsius_avg: 0, REMOTE: true })
  assert.deepEqual([offline.source, offline.offline, offline.rows], ['remote', true, []])
  assert.match(offline.sourceLabel, /REMOTE_DEVKIT/)
  const nothing = hostMetricsModel(null)
  assert.equal(nothing.empty, true)
  assert.deepEqual(nothing.rows.map((row) => row.value), [null, null, null])
})

test('a host snapshot with no readings says so instead of showing three em dashes', () => {
  const empty = hostMetricsModel({ REMOTE: false })
  assert.equal(empty.empty, true)
  assert.match(hostNotice(empty, true), /no CPU, memory or disk reading/)
  // Before the first answer the same model means "not read yet", not "measured nothing".
  assert.equal(hostNotice(hostMetricsModel(null), false), 'Reading this machine…')
  assert.match(hostNotice(hostMetricsModel({ REMOTE: true, memory: {}, disk: {} }), true), /not connected/)
  assert.equal(hostNotice(hostMetricsModel({ REMOTE: false, cpu_load: 2.9, memory: { percent: 37.3 }, disk: { percent: 3.4 } }), true), '')
})

test('a selected run that has left the board is named, not left stuck in the selection', () => {
  const runs = runList({ sentinel: { runs: [
    { id: '20260923T152712.952Z-insight-hw-1790177227', name: 'insight-hw-1790177227' }, { id: '20260923T152624.613Z-insight-hw-1790177178', name: 'insight-hw-1790177178' }
  ] } })
  const selected = runs.map((run) => run.ref)
  assert.deepEqual(missingSelection(selected, runs), [])
  assert.deepEqual(missingSelection(selected, runs.slice(0, 1)), ['insight-hw-1790177178'])
  // What the daemon answers for that selection, captured from the DevKit.
  const refused = failureNotice({ error: "unknown run 'insight-hw-1790177178'", code: 'not_found', hint: 'List runs and use a name or id Sentinel reports.' })
  assert.deepEqual([refused.title, refused.board, refused.daemon, refused.retryable], ['That run is not on this board', false, false, true])
  // A run is selectable by name or by id; runs not read yet is not every run having gone, but an empty list is.
  assert.deepEqual(missingSelection(['20260923T152624.613Z-insight-hw-1790177178'], runs), [])
  assert.deepEqual([missingSelection(selected, null), missingSelection(selected, undefined)], [[], []])
  assert.deepEqual(missingSelection(selected, []), selected)
  assert.deepEqual([missingSelection([], runs), missingSelection([], [])], [[], []])
})

test('the empty and refused states Sentinel actually returns are read as such', () => {
  assert.deepEqual(runList({ generation: 1, sentinel: { runs: [] } }), [])
  // Comparing one run, verbatim from the DevKit: a 400 the page must not read as a comparison.
  const single = failureNotice({ error: 'Comparing needs at least two runs.', code: 'invalid_request', hint: 'Pass `runs=<baseline>,<other>`; the first run is the baseline.' })
  assert.deepEqual([single.title, single.board, compareReady(['only-one'])], ['The request was rejected', false, false])
  // A board that has been left: /api/sentinel answers 502 with the board's own hint, which the Board panel owns.
  const gone = failureNotice({ error: 'The board could not be reached.', code: 'unreachable',
    hint: 'Check that the board is powered on and on the network, and that `ssh -p 22 sima@192.168.2.254` works from this machine.' })
  assert.deepEqual([gone.board, gone.daemon], [true, false])
  assert.match(gone.hint, /ssh -p 22 sima@192\.168\.2\.254/)
  assert.deepEqual([daemonInfo(null).state, daemonInfo(null).available], ['unknown', false])
  const missing = daemonInfo({ available: false, daemon: daemon({ installed: false, healthy: false, service: 'inactive', socket: false }),
    status: { state: 'missing', error: { error: 'Sentinel is not installed on this board.', code: 'sentinel_missing' } } })
  assert.deepEqual([missing.available, missing.canInstall, failureNotice(missing.error).daemon], [false, true, true])
})

test('a daemon that is not there offers the one install that fixes it, and an install this page cannot run says why', () => {
  const absent = INSTALL.daemon_absent
  assert.equal(absent.status, 200, 'a board without Sentinel is not itself a failure')
  const info = daemonInfo(absent.body)
  assert.deepEqual([info.state, info.label, info.available, info.canInstall, info.installBlocked], ['missing', 'Not installed', false, true, ''])
  assert.equal(failureNotice(info.error).title, 'Sentinel is not running on this board')
  assert.match(failureNotice(info.error).hint, /sima-cli neat install sentinel/)
  // An installed unit that is not running is a different sentence and a different fix.
  const stopped = daemonInfo(INSTALL.daemon_stopped.body)
  assert.deepEqual([stopped.state, stopped.label, failureNotice(stopped.error).title], ['stopped', 'Installed but stopped', 'The Sentinel service is stopped'])
  // Without sima-cli the button is dead, and the reason is on the page rather than in a tooltip.
  const noCli = daemonInfo(INSTALL.sima_cli_missing_state.body)
  assert.deepEqual([noCli.simaCli, noCli.canInstall], [null, false])
  assert.match(noCli.installBlocked, /sima-cli was not found on the board/)
  // A healthy daemon is never reinstalled from here: the installer restarts it.
  const healthy = daemonInfo({ available: true, status: { state: 'ready' }, daemon: daemon() })
  assert.equal(healthy.canInstall, false)
  assert.match(healthy.installBlocked, /would restart it and end a trace in flight/)
  assert.equal(daemonInfo(null).canInstall, false)
  assert.match(daemonInfo(null).installBlocked, /state is unknown/)
})

test('an install that is refused or fails is titled as an install, not as a read', () => {
  const notice = (name) => failureNotice(INSTALL[name].body, 7, { action: 'install' })
  const refused = notice('already_installed')
  assert.equal(INSTALL.already_installed.status, 409)
  assert.deepEqual([refused.title, refused.detail], ['Sentinel is already installed', ''])
  assert.match(refused.hint, /would end a trace in flight/)
  const noCli = notice('sima_cli_missing')
  assert.deepEqual([noCli.code, noCli.title], ['sentinel_failed', 'Sentinel could not be installed'])
  assert.match(noCli.message, /`sima-cli` was not found on the board/)
  assert.match(noCli.hint, /Install sima-cli on the board/)
  // The board refusing sudo is not Sentinel refusing this user.
  const sudo = notice('sudo_denied')
  assert.deepEqual([sudo.code, sudo.title, sudo.detail], ['sentinel_denied', 'Installing Sentinel needs sudo on the board', 'sudo: a password is required'])
  assert.match(sudo.hint, /in a shell on the board/)
  const failed = notice('installer_failed')
  assert.equal(failed.title, 'Sentinel could not be installed')
  assert.match(failed.message, /failed on the board \(exit 1\)/)
  assert.match(failed.detail, /vulcan: not found/)
  // Finishing with the service still down is a failure too.
  const down = notice('installer_left_it_down')
  assert.equal(down.title, 'Sentinel could not be installed')
  assert.match(down.message, /the simaai-sentinel service is inactive/)
  assert.match(down.hint, /systemctl status simaai-sentinel/)
  for (const name of ['already_installed', 'sima_cli_missing', 'sudo_denied', 'installer_failed']) {
    assert.deepEqual([notice(name).board, notice(name).retryable, notice(name).action, notice(name).generation], [false, true, 'install', 7], name)
  }
  // An installer past its 15-minute budget is not an unresponsive board; read from the board, the code keeps its reading title.
  const slow = failureNotice({ code: 'timeout', error: 'The board took too long to answer.' }, null, { action: 'install' })
  assert.equal(slow.title, 'The installer did not finish in time')
  assert.match(slow.hint, /as long as it needs/)
  assert.equal(failureNotice({ code: 'timeout', error: 'The board took too long to answer.' }).title, 'The board took too long to answer')
  assert.equal(failureNotice({ code: 'timeout', error: 'x' }).action, 'read')
})

test('a board that goes away mid-view keeps what it already gave, and says why', () => {
  const info = daemonInfo(null)
  assert.equal(info.available, false)
  for (const read of [{ metrics: METRICS, traces: null, runs: null }, { metrics: null, traces: { sentinel: {} }, runs: null }, { metrics: null, traces: null, runs: { sentinel: { runs: [] } } }]) {
    assert.equal(telemetryVisible(info, read), true)
  }
  // Nothing read yet and nothing answering: there is nothing to keep. A working daemon shows the panels regardless.
  assert.deepEqual([telemetryVisible(info, { metrics: null, traces: null, runs: null }), telemetryVisible(info, {}), telemetryVisible({ available: true }, {})], [false, false, true])
  const gone = failureNotice({ code: 'unreachable', error: 'The board could not be reached.' })
  assert.deepEqual([gone.board, gone.retryable], [true, true])
})

test('a run name long enough to break the tables is carried intact and wrapped', () => {
  const name = 'a'.repeat(NAME_LIMIT)
  const runs = runList({ sentinel: { runs: [{ id: 'id-1', name }, { id: 'id-2', name: 'short' }] } })
  assert.equal(runs[0].label, name)
  assert.equal(runs[0].ref, name, 'the name is the reference, so it must not be shortened')
  assert.equal(validateTrace({ name }).body.name, name)
  assert.match(validateTrace({ name: `${name}a` }).error, /at most 128 characters/)
  assert.equal(compareQuery([name, 'short']), `/api/sentinel/compare?runs=${encodeURIComponent(`${name},short`)}`)
  assert.deepEqual([missingSelection([name], runs), uncomparableRefs([name])], [[], []])
  // The cells that carry it are header cells, which do not wrap the way `td` already does.
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.stats-run-table tbody th,\n\.stats-compare-table thead th \{\n\s*overflow-wrap: anywhere;/)
})

test('a delete names one run and the board generation its list came from', () => {
  assert.equal(deleteRunQuery('baseline', 3), '/api/sentinel/runs/baseline?generation=3')
  assert.equal(deleteRunQuery("x'; rm -rf /?a=b#c", 0), "/api/sentinel/runs/x'%3B%20rm%20-rf%20%2F%3Fa%3Db%23c?generation=0")
  // Without a generation the backend acts on whatever board is selected, so none is invented.
  assert.deepEqual([deleteRunQuery('a/b'), deleteRunQuery('a', '3')], ['/api/sentinel/runs/a%2Fb', '/api/sentinel/runs/a'])
  assert.deepEqual([deletePrompt(1), deletePrompt(3)], ['Delete 1 run?', 'Delete 3 runs?'])
})

test('stopping a trace names the board generation the trace was read under', () => {
  assert.deepEqual([3, 0, undefined, '3'].map((generation) => stopTraceQuery(generation)),
    ['/api/sentinel/traces/stop?generation=3', '/api/sentinel/traces/stop?generation=0', '/api/sentinel/traces/stop', '/api/sentinel/traces/stop'])
})

test('installing and starting a trace name the board generation they were offered under', () => {
  // Without a generation the backend acts on whatever board is selected, so none is invented.
  assert.deepEqual([3, 0, undefined].map((generation) => installQuery(generation)), ['/api/sentinel/install?generation=3', '/api/sentinel/install?generation=0', '/api/sentinel/install'])
  assert.deepEqual([3, 0, '3'].map((generation) => startTraceQuery(generation)), ['/api/sentinel/traces?generation=3', '/api/sentinel/traces?generation=0', '/api/sentinel/traces'])
})

test('stopping a trace names the trace on screen, so a trace that replaced it is not stopped', () => {
  const shown = traceModel({ generation: 3, sentinel: { trace: { id: 'trace a/1', name: 'baseline' } } })
  assert.equal(shown.id, 'trace a/1')
  assert.equal(stopTraceQuery(3, shown.id), '/api/sentinel/traces/stop?generation=3&trace_id=trace%20a%2F1')
  assert.equal(stopTraceQuery(null, 'trace-a'), '/api/sentinel/traces/stop?trace_id=trace-a')
  // A trace without an id stops as before, without trace_id.
  assert.equal(traceModel({ sentinel: { trace: { name: 'baseline' } } }).id, '')
  assert.equal(stopTraceQuery(3, ''), '/api/sentinel/traces/stop?generation=3')
})

test('opening or deleting a run uses its stable id, not a name another run has as its id', () => {
  // Run A is named "x"; run B's id is "x". The backend resolves "x" by id first, to B.
  const rows = runList({ sentinel: { runs: [{ id: 'a1', name: 'x' }, { id: 'x', name: 'y' }, { name: 'no-id' }] } })
  assert.deepEqual(rows.map((run) => run.ref), ['x', 'y', 'no-id'], 'the list and Compare keep the names')
  assert.deepEqual(['x', 'y', 'no-id', 'gone'].map((ref) => runActionRef(rows, ref)), ['a1', 'x', 'no-id', 'gone'])
  assert.equal(runActionRef(null, 'x'), 'x')
})

test('a failure about the board stops the remaining deletes; one about the run does not', () => {
  const notice = (code) => failureNotice({ code, error: 'x' }, 1, { action: 'delete' })
  for (const code of ['unreachable', 'timeout', 'tool_missing', 'sentinel_denied', 'stale_snapshot', 'network']) assert.equal(deleteStops(notice(code)), true, code)
  for (const code of ['not_found', 'trace_conflict', 'sentinel_failed', 'invalid_request']) assert.equal(deleteStops(notice(code)), false, code)
  assert.equal(deleteStops(null), false)
})

test('delete failures are titled for deleting, not for reading or starting a trace', () => {
  const notice = (code) => failureNotice({ code, error: 'x' }, 1, { action: 'delete' })
  assert.deepEqual(['trace_conflict', 'stale_snapshot', 'sentinel_failed', 'unreachable'].map((code) => notice(code).title),
    ['That run is still recording', 'The selected board changed', 'Sentinel did not delete the run', 'The board could not be reached'])
  // Reading keeps its own wording.
  assert.equal(failureNotice({ code: 'trace_conflict', error: 'x' }).title, 'That trace cannot start')
})

test('the delete summary keeps what was deleted and names what failed and why', () => {
  const conflict = failureNotice({ code: 'trace_conflict', error: "cannot delete active run 'b'" }, 1, { action: 'delete' })
  const summary = deleteSummary([{ ref: 'a', deleted: { id: '20260924T175231.958Z-a', name: 'a' } }, { ref: 'b', notice: conflict }, { ref: 'c', skipped: true }])
  assert.deepEqual(summary.deleted, ['a'])
  assert.deepEqual(summary.failed.map((result) => [result.ref, result.notice.message]), [['b', "cannot delete active run 'b'"]])
  assert.deepEqual(summary.skipped, ['c'])
  assert.deepEqual([...summary.gone].sort(), ['20260924T175231.958Z-a', 'a'])
  assert.deepEqual([summary.status, summary.title], ['Deleted 1 run from the board.', '2 of 3 runs were not deleted'])
  const one = deleteSummary([{ ref: 'b', notice: conflict }])
  assert.deepEqual([one.title, one.status, one.gone.size], ['Run b was not deleted', '', 0])
  const clean = deleteSummary([{ ref: 'a', deleted: { id: 'i-a', name: 'a' } }, { ref: 'i-b', deleted: { id: 'i-b', name: 'b' } }])
  assert.deepEqual([clean.title, clean.status], ['', 'Deleted 2 runs from the board.'])
  assert.deepEqual([...clean.gone].sort(), ['a', 'b', 'i-a', 'i-b'])
})

test('a comparison that included a deleted run is recognised by its id or name', () => {
  const compare = { sentinel: { runs: [{ id: 'i-a', name: 'a' }, { id: 'i-b', name: 'b' }] } }
  assert.deepEqual([['a'], ['i-b'], ['c'], []].map((gone) => compareIncludes(compare, new Set(gone))), [true, true, false, false])
  assert.equal(compareIncludes(null, new Set(['a'])), false)
  assert.equal(compareIncludes({ sentinel: { runs: ['a'] } }, new Set(['a'])), false)
  // The view asks for raw=1, where each run's identity is under metadata.
  const raw = { sentinel: { runs: [{ metadata: { id: 'i-a', name: 'a' }, metrics: [], samples: [] }] } }
  assert.deepEqual([['a'], ['i-a'], ['c']].map((gone) => compareIncludes(raw, new Set(gone))), [true, true, false])
})

test('the session exports as CSV: a row per sample, a column per metric, empty where the board took no reading', () => {
  const model = {
    metrics: [{ key: 'power_current_watts', label: 'Current board power', unit: 'W' }, { key: 'rtsn_0', label: 'MLA RTSN-0', unit: 'C' }, { key: 'cpu_load_1', label: 'CPU load 1m', unit: 'load' }],
    timestamps: ['2026-09-25T18:40:00Z', '2026-09-25T18:40:02Z'],
    series: { power_current_watts: [12.5, 13], rtsn_0: [55.1, null], cpu_load_1: [6.01, 6.2] }
  }
  assert.equal(sessionCsv(model), ['timestamp,Current board power (W),MLA RTSN-0 (°C),CPU load 1m', '2026-09-25T18:40:00Z,12.5,55.1,6.01', '2026-09-25T18:40:02Z,13,,6.2', ''].join('\r\n'))
  assert.equal(sessionCsv({ metrics: [], timestamps: [] }), '')
  assert.equal(sessionCsvFilename(new Date(2026, 8, 25, 18, 4, 5)), 'sentinel-session-2026-09-25-180405.csv')
})
