// The DevKit / Host split and the All / Power / Thermal / System sections of the live
// metrics, checked against the 59-metric payload the Sentinel daemon returned on a Modalix
// DevKit (GET /api/sentinel/metrics, captured from the sandbox on 2026-09-24).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  STATS_TABS,
  isThermalMetric,
  metricAlert,
  metricSection,
  metricsModel,
  statsTabFrom
} from './model.js'

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/metrics-live.json', import.meta.url), 'utf8'))
const keysOf = (groups) => groups.flatMap((group) => group.metrics.map((metric) => metric.key))

test('the page opens on the DevKit, and a saved sub-tab is trusted only when it still exists', () => {
  assert.deepEqual(STATS_TABS.map((tab) => tab.label), ['DevKit', 'Host'])
  assert.equal(statsTabFrom(null), 'devkit')
  assert.equal(statsTabFrom('host'), 'host')
  assert.equal(statsTabFrom('devkit'), 'devkit')
  assert.equal(statsTabFrom('runs'), 'devkit')
  assert.equal(statsTabFrom(''), 'devkit')
})

test('a temperature is told by its unit first, and by its name only when it has no unit', () => {
  assert.equal(isThermalMetric({ key: 'rtsn_0', unit: 'C' }), true)
  assert.equal(isThermalMetric({ key: 'x', unit: '°C' }), true)
  assert.equal(isThermalMetric({ key: 'x', unit: ' celsius ' }), true)
  assert.equal(isThermalMetric({ key: 'soc_temp', label: 'SoC temp' }), true)
  assert.equal(isThermalMetric({ key: 'rtsn_3', unit: '' }), true)
  // A unit that is not a temperature wins over a name that looks like one.
  assert.equal(isThermalMetric({ key: 'disk_tempfs_used_pct', label: 'Tempfs used', unit: '%' }), false)
  assert.equal(isThermalMetric({ key: 'cpu_usage_pct', unit: '%' }), false)
  assert.equal(isThermalMetric(null), false)
  // A temperature filed under Power still reads as Thermal; watts outside Power read as Power.
  assert.equal(metricSection({ key: 'pmic_temp', unit: 'C' }, 'Power'), 'thermal')
  assert.equal(metricSection({ key: 'usb_watts', unit: 'W' }, 'Board'), 'power')
  assert.equal(metricSection({ key: 'rail', unit: 'A' }, 'Power Rail'), 'power')
  assert.equal(metricSection({ key: 'net_rx_mbps', unit: 'MB/s' }, 'Network'), 'system')
  assert.equal(metricSection({ key: 'mystery' }), 'system')
})

// The dashboard's Thermal, Power and System tabs, and their alert badges, sort metrics with
// metricSection; these hold it to the live board's 59 metrics.
function bySection(model) {
  const sections = { power: [], thermal: [], system: [] }
  for (const group of model.groups) for (const metric of group.metrics) sections[metricSection(metric, group.name)].push(metric)
  return sections
}

test('every live metric lands in exactly one of Power, Thermal and System', () => {
  const model = metricsModel(LIVE)
  const all = keysOf(model.groups)
  assert.equal(all.length, 59)
  assert.equal(LIVE.counts.total, 59)
  const sections = bySection(model)
  const placed = [...sections.power, ...sections.thermal, ...sections.system].map((metric) => metric.key)
  assert.deepEqual([...placed].sort(), [...all].sort())
  assert.equal(new Set(placed).size, placed.length)
  assert.deepEqual([sections.power.length, sections.thermal.length, sections.system.length], [11, 17, 31])
})

test('Thermal holds every temperature, wherever Sentinel grouped it', () => {
  const sections = bySection(metricsModel(LIVE))
  assert.deepEqual(
    [...new Set(sections.thermal.map((metric) => metric.group))].sort(),
    ['APU', 'Board', 'CVU', 'MLA', 'TOP']
  )
  assert.ok(sections.thermal.every((metric) => metric.unit === 'C' && isThermalMetric(metric)))
  for (const metric of [...sections.power, ...sections.system]) assert.notEqual(metric.unit, 'C', metric.key)
})

test('Power is the board power and the rails; MLA memory stays in System', () => {
  const sections = bySection(metricsModel(LIVE))
  assert.deepEqual(
    [...new Set(sections.power.map((metric) => metric.group))].sort(),
    ['Power', 'PowerRail']
  )
  assert.ok(sections.system.some((metric) => metric.key === 'mla_mem_allocated_mb'))
})
