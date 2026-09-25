import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DASH_TABS,
  agoLabel,
  compareOverlay,
  compareSeriesAvailable,
  columnMeans,
  coreSummary,
  HEAT_COLUMNS,
  loadColor,
  scaleText,
  tightScale,
  elapsedPath,
  axisLabel,
  dashTabFrom,
  indexAt,
  lastNumber,
  linePath,
  metricsMatching,
  niceCeil,
  scaleFor,
  spanLabel,
  stackTotals,
  stackedPaths,
  sumSeries,
  thermalGroups,
  thermalMaxSeries,
  thresholdLines,
  valueNear
} from './dashboard.js'
import { compareTable, metricsModel } from './model.js'

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/metrics-live.json', import.meta.url), 'utf8'))

test('the dashboard has Sentinel ops view tabs, and a saved tab is trusted only when it exists', () => {
  assert.deepEqual(DASH_TABS.map((tab) => tab.label), ['Overview', 'Thermal', 'Power', 'System', 'Storage & Network', 'Runs'])
  assert.equal(dashTabFrom('power'), 'power')
  assert.equal(dashTabFrom('compare'), 'overview')
  assert.equal(dashTabFrom(null), 'overview')
})

test('scales stay fixed: percentages 0-100, temperatures 40-90, the rest a round number above the peak', () => {
  assert.deepEqual(scaleFor('%', [[12, 99]]), { min: 0, max: 100 })
  assert.deepEqual(scaleFor('C', [[66.8, 68.6]]), { min: 40, max: 90 })
  assert.deepEqual(scaleFor('C', [[35, 96.2]]), { min: 30, max: 100 }, 'a reading outside the band widens it')
  assert.deepEqual(scaleFor('W', [[10.2, 16.69]]), { min: 0, max: 20 })
  assert.deepEqual(scaleFor('MB', [[742.3]]), { min: 0, max: 1000 })
  assert.deepEqual(scaleFor('MB', [[520.7]], 1788), { min: 0, max: 1788 }, 'a known capacity is the ceiling')
  assert.deepEqual(scaleFor('MB/s', [[null, null]]), { min: 0, max: 1 })
  assert.deepEqual([niceCeil(0.37), niceCeil(18.36), niceCeil(816), niceCeil(3.4), niceCeil(0)], [0.4, 20, 1000, 4, 1])
})

test('derived series: the hottest sensor per sample, and summed traffic', () => {
  const model = {
    metrics: [
      { key: 'a', unit: 'C', group: 'MLA' },
      { key: 'b', unit: 'C', group: 'Board' },
      { key: 'rx', unit: 'MB/s', group: 'Network' },
      { key: 'tx', unit: 'MB/s', group: 'Network' }
    ],
    series: { a: [60, null, 70], b: [65, null, 62], rx: [1, 2, null], tx: [0.5, null, null] }
  }
  assert.deepEqual(thermalMaxSeries(model), [65, null, 70])
  assert.deepEqual(sumSeries(model, ['rx', 'tx']), [1.5, 2, null])
  assert.equal(lastNumber([1, 2, null]), 2)
  assert.equal(lastNumber([]), null)
})

test('a missing sample breaks the line instead of dropping to zero', () => {
  const path = linePath([50, null, 50, 100], { min: 0, max: 100 }, 300, 100)
  assert.equal(path.line, 'M0 50 M200 50 L300 0')
  assert.equal(path.area, 'M200 100 L200 50 L300 0 L300 100 Z', 'a lone point has a line start but no area')
  assert.deepEqual(path.last, { x: 300, y: 0 })
  assert.equal(linePath([1, null], { min: 0, max: 1 }, 10, 10).last, null, 'no newest point when the newest sample is missing')
  assert.equal(linePath([150], { min: 0, max: 100 }, 10, 10).line, 'M0 0', 'values beyond the scale are clamped to it')
})

test('stacked areas sit on each other and the top edge is the total', () => {
  const lists = [[1, 1], [2, null]]
  assert.deepEqual(stackTotals(lists), [3, 1])
  const [lower, upper] = stackedPaths(lists, { min: 0, max: 4 }, 10, 4)
  assert.equal(lower, 'M0 3 L10 3 L10 4 L0 4 Z')
  assert.equal(upper, 'M0 1 L10 3 L10 3 L0 3 Z')
})

test('time labels use board timestamps only', () => {
  const stamps = ['2026-09-25T00:08:37Z', '2026-09-25T00:12:37Z', '2026-09-25T00:16:35Z']
  assert.equal(spanLabel(stamps), '7 minutes ago')
  assert.equal(agoLabel(stamps, 1), '3 minutes 58 seconds ago')
  assert.equal(agoLabel(stamps, 2), 'Now')
  assert.equal(spanLabel(['x']), '')
  assert.equal(spanLabel([]), '')
  assert.deepEqual([indexAt(0, 240), indexAt(0.5, 240), indexAt(1.2, 240), indexAt(0.5, 0)], [0, 120, 239, -1])
})

test('the live board: thermal groups in Sentinel order, cores and rails by key, threshold lines', () => {
  const model = metricsModel(LIVE)
  const groups = thermalGroups(model)
  assert.deepEqual(groups.map((group) => [group.name, group.metrics.length]).sort(), [['APU', 2], ['Board', 3], ['CVU', 2], ['MLA', 8], ['TOP', 2]])
  assert.equal(metricsMatching(model, /^cpu_core_\d+_usage_pct$/).length, 16)
  assert.equal(metricsMatching(model, /^power_rail_/).length, 8)
  assert.deepEqual(thresholdLines({ warn: 70, critical: 85 }), [{ value: 70, tone: 'warn' }, { value: 85, tone: 'critical' }])
  assert.deepEqual(thresholdLines({ warn: null }), [])
  assert.deepEqual([axisLabel(100), axisLabel(2.5), axisLabel(1788), axisLabel(null)], ['100', '2.5', '1,788', ''])
})

// Two saved runs compared with raw=1 on the DevKit, 2026-09-25 (tes3 is the baseline).
const RAW = JSON.parse(readFileSync(new URL('./fixtures/compare-raw.json', import.meta.url), 'utf8'))

test('compare runs overlays one series per run over elapsed time, baseline first', () => {
  const overlay = compareOverlay(RAW, 'power')
  assert.equal(overlay.spec.label, 'Total power')
  assert.equal(overlay.unit, 'W')
  assert.deepEqual(overlay.lines.map((line) => [line.name, line.baseline]), [['tes3', true], ['insight-hw-1790177227', false]])
  assert.deepEqual(overlay.lines[0].points.map((point) => Math.round(point.t)), [0, 2, 4, 6], 'about two seconds apart, as recorded')
  assert.deepEqual(overlay.lines[1].points.map((point) => point.v), [8.53125, 8.53125, 8.53125, 8.875])
  assert.equal(Math.round(overlay.overlap), 6)
  // Sentinel's own summary and baseline delta, and each run's energy.
  const [base, other] = overlay.rows
  assert.deepEqual([base.samples, base.mean, base.energy], [4, 9.03125, 54.1891436875])
  assert.deepEqual([other.minimum, other.p95, other.maximum], [8.53125, 8.875, 8.875])
  assert.equal(Number(other.delta.toFixed(3)), -4.585)
})

test('compare runs offers only the series the runs recorded, and derives the thermal maximum', () => {
  assert.deepEqual(compareSeriesAvailable(RAW).map((entry) => entry.label),
    ['Total power', 'Thermal maximum', 'CPU utilization', 'CPU load', 'RAM used', 'MLA memory', 'EV74 CMA'])
  const thermal = compareOverlay(RAW, 'thermal')
  assert.equal(thermal.unit, 'C')
  const firstSample = RAW.sentinel.runs.find((run) => run.metadata.name === 'tes3').samples[0].values
  const hottest = Math.max(...Object.entries(firstSample).filter(([key]) => /^(rtsn_|lm96163_|eth_mdio_temp)/.test(key)).map(([, value]) => value))
  assert.equal(thermal.lines[0].points[0].v, hottest)
  assert.equal(thermal.rows[0].delta, 0, 'the baseline against itself')
  assert.equal(compareOverlay(RAW, 'nonsense').spec.id, 'power', 'an unknown series falls back to the first')
  assert.equal(compareOverlay({ sentinel: { runs: [] } }, 'power'), null)
})

test('the overlay path stays inside the common window and breaks on missing samples', () => {
  const points = [{ t: 0, v: 1 }, { t: 1, v: null }, { t: 2, v: 3 }, { t: 9, v: 5 }]
  assert.equal(elapsedPath(points, 4, { min: 0, max: 4 }, 100, 4), 'M0 3 M50 1 L225 0', 'the first point past the window carries the line to the edge')
  assert.equal(elapsedPath([{ t: 0, v: 1 }, { t: 9, v: 2 }, { t: 12, v: 3 }], 4, { min: 0, max: 4 }, 100, 4), 'M0 3 L225 2', 'and only the first')
  assert.deepEqual(valueNear(points, 1.2), { t: 2, v: 3 })
  assert.equal(valueNear([], 1), null)
})

test('the comparison table reads raw runs too, whose details sit under metadata', () => {
  const table = compareTable(RAW)
  assert.deepEqual(table.columns.map((column) => [column.label, column.baseline]), [['tes3', true], ['insight-hw-1790177227', false]])
  const power = table.rows.find((row) => row.key === 'power_current_watts')
  assert.deepEqual(power.cells.map((cell) => cell.value), [9.03125, 8.6171875])
})

test('the comparison scale is fitted to the runs, so a few percent is visible', () => {
  assert.deepEqual(tightScale([[8.53, 8.88], [9.03]]), { min: 8.4, max: 9.2 })
  assert.deepEqual(tightScale([[3, 3], [3]]), { min: 2.8, max: 3.2 }, 'equal readings still get a band around them')
  assert.deepEqual(tightScale([[null]]), { min: 0, max: 1 })
})

test('professional wording: whole-word durations, units as a reader says them', () => {
  assert.deepEqual([scaleText({ min: 40, max: 90 }, 'C'), scaleText({ min: 0, max: 100 }, '%'), scaleText({ min: 0, max: 1000 }, 'MB')],
    ['40–90 °C', '0–100%', '0–1,000 MB'])
  assert.equal(spanLabel(['2026-09-25T00:00:00Z', '2026-09-25T00:00:45Z']), '45 seconds ago')
  assert.equal(agoLabel(['2026-09-25T00:00:00Z', '2026-09-25T00:01:00Z'], 0), '1 minute ago')
})

test('per-core heatmap: column means over the window, a one-minute average per core', () => {
  const cores = [
    { key: 'c0', short: 'c0', label: 'CPU core 0 usage', warn: 80, critical: 95 },
    { key: 'c1', short: 'c1', label: 'CPU core 1 usage', warn: 80, critical: 95 },
    { key: 'c2', short: 'c2', label: 'CPU core 2 usage', warn: 80, critical: 95 }
  ]
  const summary = coreSummary(cores, { c0: [10, 30, 50, 70], c1: [90, 90], c2: [null] })
  assert.deepEqual(summary.rows.map((row) => [row.name, row.recent, row.tone]), [['c0', 40, 'ok'], ['c1', 90, 'warn'], ['c2', null, 'unavailable']])
  assert.equal(summary.average, 65, 'a core that did not report is left out of the average')
  assert.equal(summary.busiest.name, 'c1')
  // 240 samples make five per column; noise that averages 50 over five reads as a flat 50.
  const long = Array.from({ length: 240 }, (_, index) => [30, 70, 40, 60, 50][index % 5])
  const cells = coreSummary([cores[0]], { c0: long }).rows[0].cells
  assert.equal(cells.length, HEAT_COLUMNS)
  assert.ok(cells.every((value) => value === 50), 'each column is the mean of its samples, so alternating noise reads flat')
  assert.deepEqual(columnMeans([1, null, 3], 48), [1, null, 3], 'fewer samples than columns: one column each')
  assert.equal(loadColor(0), 'rgb(236 243 250)')
  assert.equal(loadColor(100), 'rgb(12 64 140)')
  assert.equal(loadColor(null), 'var(--surface-soft)')
  assert.deepEqual(coreSummary([], {}), { rows: [], average: null, busiest: null })
})
