import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DASH_TABS,
  agoLabel,
  axisLabel,
  dashTabFrom,
  downsample,
  heatColor,
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
  thresholdLines
} from './dashboard.js'
import { metricsModel } from './model.js'

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/metrics-live.json', import.meta.url), 'utf8'))

test('the dashboard has Sentinel ops view tabs, and a saved tab is trusted only when it exists', () => {
  assert.deepEqual(DASH_TABS.map((tab) => tab.label), ['Overview', 'Thermal', 'Power', 'System', 'Storage/Net', 'Runs'])
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
  assert.equal(spanLabel(stamps), '7m ago')
  assert.equal(agoLabel(stamps, 1), '3m 58s ago')
  assert.equal(agoLabel(stamps, 2), 'now')
  assert.equal(spanLabel(['x']), '')
  assert.equal(spanLabel([]), '')
  assert.deepEqual([indexAt(0, 240), indexAt(0.5, 240), indexAt(1.2, 240), indexAt(0.5, 0)], [0, 120, 239, -1])
})

test('heatmap cells: buckets keep their peak, colours run from teal to red', () => {
  assert.deepEqual(downsample([1, 5, 2, 8, null, null], 3), [5, 8, null])
  assert.deepEqual(downsample([1, 2], 5), [1, 2])
  assert.equal(heatColor(0), 'hsl(175 70% 88%)')
  assert.equal(heatColor(100), 'hsl(5 70% 48%)')
  assert.equal(heatColor(null), 'var(--line)')
})

test('the live board: thermal groups in Sentinel order, cores and rails by key, threshold lines', () => {
  const model = metricsModel(LIVE)
  const groups = thermalGroups(model)
  assert.deepEqual(groups.map((group) => [group.name, group.metrics.length]).sort(), [['APU', 2], ['Board', 3], ['CVU', 2], ['MLA', 8], ['TOP', 2]])
  assert.equal(metricsMatching(model, /^cpu_core_\d+_usage_pct$/).length, 16)
  assert.equal(metricsMatching(model, /^power_rail_/).length, 8)
  assert.deepEqual(thresholdLines({ warn: 70, critical: 85 }), [{ value: 70, tone: 'warn' }, { value: 85, tone: 'critical' }])
  assert.deepEqual(thresholdLines({ warn: null }), [])
  assert.deepEqual([axisLabel(100), axisLabel(2.5), axisLabel(1788), axisLabel(null)], ['100', '2.5', '1.8k', ''])
})
