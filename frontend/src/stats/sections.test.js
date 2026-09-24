// The DevKit / Host split and the Overview / Power / Thermal / System sections of the live
// metrics, checked against the 59-metric payload the Sentinel daemon returned on a Modalix
// DevKit (GET /api/sentinel/metrics, captured from the sandbox on 2026-09-24).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  METRIC_SECTIONS,
  STATS_TABS,
  isThermalMetric,
  metricAlert,
  metricSection,
  metricSectionFrom,
  metricSectionTabs,
  metricSections,
  metricsModel,
  statsTabFrom,
  thermalSummary
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

test('the live metrics open on Overview and name the three sections a reader looks for', () => {
  assert.deepEqual(METRIC_SECTIONS.map((section) => section.label), ['Overview', 'Power', 'Thermal', 'System'])
  assert.equal(metricSectionFrom(undefined), 'overview')
  assert.equal(metricSectionFrom('thermal'), 'thermal')
  assert.equal(metricSectionFrom('Board'), 'overview')
})

test('every live metric lands in exactly one of Power, Thermal and System', () => {
  const model = metricsModel(LIVE)
  const all = keysOf(model.groups)
  assert.equal(all.length, 59)
  assert.equal(LIVE.counts.total, 59)
  const sections = metricSections(model.groups)
  const placed = [...keysOf(sections.power), ...keysOf(sections.thermal), ...keysOf(sections.system)]
  // Total: nothing is left out. Disjoint: nothing is shown twice.
  assert.equal(placed.length, all.length)
  assert.deepEqual([...placed].sort(), [...all].sort())
  assert.equal(new Set(placed).size, placed.length)
  assert.deepEqual(
    [keysOf(sections.power).length, keysOf(sections.thermal).length, keysOf(sections.system).length],
    [11, 17, 31]
  )
  // And the section a metric is drawn in is the one metricSection names for it.
  for (const id of ['power', 'thermal', 'system']) {
    for (const group of sections[id]) for (const metric of group.metrics) assert.equal(metricSection(metric, group.name), id)
  }
})

test('Thermal holds every temperature, wherever Sentinel grouped it', () => {
  const sections = metricSections(metricsModel(LIVE).groups)
  assert.deepEqual(
    sections.thermal.map((group) => [group.name, group.metrics.map((metric) => metric.label)]),
    [
      ['APU', ['APU RTSN-4', 'APU RTSN-11']],
      ['Board', ['LM96163 temp1', 'LM96163 temp2', 'ETH/MDIO temp1']],
      ['CVU', ['CVU RTSN-5', 'CVU RTSN-12']],
      ['MLA', ['MLA RTSN-0', 'MLA RTSN-1', 'MLA RTSN-2', 'MLA RTSN-3', 'MLA RTSN-7', 'MLA RTSN-8', 'MLA RTSN-9', 'MLA RTSN-10']],
      ['TOP', ['TOP RTSN-6', 'TOP RTSN-13']]
    ]
  )
  // Every one of them is in Celsius, and nothing in Celsius is left elsewhere.
  for (const group of [...sections.power, ...sections.system]) {
    for (const metric of group.metrics) assert.notEqual(metric.unit, 'C', metric.key)
  }
  assert.ok(sections.thermal.every((group) => group.metrics.every((metric) => metric.unit === 'C')))
})

test('Power is the board power and the rails; System keeps Sentinel group names as sub-headings', () => {
  const sections = metricSections(metricsModel(LIVE).groups)
  assert.deepEqual(sections.power.map((group) => [group.name, group.metrics.length]), [['Power', 3], ['PowerRail', 8]])
  // MLA keeps its memory in System once its eight sensors went to Thermal; Board, APU, CVU
  // and TOP held nothing but sensors, so System does not show them empty.
  assert.deepEqual(
    sections.system.map((group) => [group.name, group.metrics.length]),
    [['CPU', 19], ['Disk', 2], ['DiskIO', 2], ['EV74', 3], ['MLA', 1], ['Memory', 2], ['Network', 2]]
  )
  assert.deepEqual(sections.system.find((group) => group.name === 'MLA').metrics.map((metric) => metric.key), ['mla_mem_allocated_mb'])
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

test('the section tabs carry their size and anything past a threshold', () => {
  const groups = metricsModel(LIVE).groups.map((group) => ({
    ...group,
    metrics: group.metrics.map((metric) => {
      if (metric.key === 'rtsn_0') return { ...metric, status: 'critical' }
      if (metric.key === 'rtsn_1' || metric.key === 'cpu_usage_pct') return { ...metric, status: 'warn' }
      return metric
    })
  }))
  const tabs = metricSectionTabs(metricSections(groups))
  assert.deepEqual(tabs.map((tab) => [tab.id, tab.count]), [['overview', undefined], ['power', 11], ['thermal', 17], ['system', 31]])
  // A critical outranks a warning on the same tab, so a hot sensor shows from Overview.
  assert.deepEqual(tabs[2].alert, { tone: 'critical', count: 1 })
  assert.deepEqual(tabs[3].alert, { tone: 'warn', count: 1 })
  assert.equal(tabs[1].alert, null)
  assert.equal(metricAlert([]), null)
  assert.deepEqual(metricSectionTabs(null).map((tab) => tab.count), [undefined, 0, 0, 0])
})

test('the thermal line names the hottest sensor and the limits every sensor shares', () => {
  const sections = metricSections(metricsModel(LIVE).groups)
  const summary = thermalSummary(sections.thermal)
  assert.equal(summary.count, 17)
  assert.equal(summary.reporting, 17)
  assert.equal(summary.hottest.key, 'lm96163_temp2')
  assert.equal(summary.limits, 'warn at 70 °C, critical at 85 °C')
  // A sensor that did not report is counted but never the hottest, and limits that differ are not claimed.
  const partial = thermalSummary([
    { name: 'MLA', metrics: [{ key: 'a', unit: 'C', value: null, warn: 70, critical: 85 }, { key: 'b', unit: 'C', value: 40, warn: 60, critical: 85 }] }
  ])
  assert.deepEqual([partial.count, partial.reporting, partial.hottest.key], [2, 1, 'b'])
  assert.equal(partial.limits, 'critical at 85 °C')
  const none = thermalSummary([])
  assert.deepEqual([none.count, none.hottest, none.limits], [0, null, ''])
})
