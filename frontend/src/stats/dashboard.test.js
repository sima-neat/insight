import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DASH_TABS, HEAT_COLUMNS, agoLabel, axisLabel, columnMeans, compareOverlay, compareSeriesAvailable, coreSummary, currentTotal, currentValue, dashTabFrom,
  elapsedPath, fixedValue, indexAt, linePath, loadColor, metricsMatching, niceCeil, scaleFor, scaleText, spanLabel,
  stackTotals, stackedPaths, thermalGroups, thermalMaxSeries, thresholdLines, tightScale, valueNear, windowPoints
} from './dashboard.js'
import { STATS_TABS, compareTable, isThermalMetric, metricSection, metricsModel, statsTabFrom } from './model.js'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
// The 59 metrics a Modalix DevKit's Sentinel returned (GET /api/sentinel/metrics, 2026-09-24), less descriptions and history.
const LIVE = fixture('metrics-live')
// Two saved runs compared with raw=1 on the DevKit, 2026-09-25 (tes3 is the baseline), trimmed to the fields and series
// Compare Runs reads and two of the seventeen temperature sensors; values verbatim.
const RAW = fixture('compare-raw')

test('the page opens on the DevKit and the dashboard on Overview; a saved tab is trusted only when it exists', () => {
  assert.deepEqual(STATS_TABS.map((tab) => tab.label), ['DevKit', 'Host'])
  assert.deepEqual([null, 'host', 'devkit', 'runs', ''].map(statsTabFrom), ['devkit', 'host', 'devkit', 'devkit', 'devkit'])
  assert.deepEqual(DASH_TABS.map((tab) => tab.label), ['Overview', 'Thermal', 'Power', 'System', 'Storage & Network', 'Runs'])
  assert.deepEqual(['power', 'compare', null].map(dashTabFrom), ['power', 'overview', 'overview'])
})

test('a temperature is told by its unit first, and by its name only when it has no unit', () => {
  const thermal = [{ key: 'rtsn_0', unit: 'C' }, { key: 'x', unit: '°C' }, { key: 'x', unit: ' celsius ' }, { key: 'soc_temp', label: 'SoC temp' }, { key: 'rtsn_3', unit: '' }]
  for (const metric of thermal) assert.equal(isThermalMetric(metric), true, JSON.stringify(metric))
  for (const metric of [{ key: 'disk_tempfs_used_pct', label: 'Tempfs used', unit: '%' }, { key: 'cpu_usage_pct', unit: '%' }, null]) {
    assert.equal(isThermalMetric(metric), false, JSON.stringify(metric))
  }
  const sections = [[{ key: 'pmic_temp', unit: 'C' }, 'Power'], [{ key: 'usb_watts', unit: 'W' }, 'Board'], [{ key: 'rail', unit: 'A' }, 'Power Rail'],
    [{ key: 'net_rx_mbps', unit: 'MB/s' }, 'Network'], [{ key: 'mystery' }]]
  assert.deepEqual(sections.map(([metric, group]) => metricSection(metric, group)), ['thermal', 'power', 'power', 'system', 'system'])
})

test('every live metric lands in exactly one of Power, Thermal and System, by the dashboard\'s rules', () => {
  const model = metricsModel(LIVE)
  const sections = { power: [], thermal: [], system: [] }
  for (const group of model.groups) for (const metric of group.metrics) sections[metricSection(metric, group.name)].push(metric)
  const all = model.groups.flatMap((group) => group.metrics.map((metric) => metric.key))
  assert.deepEqual([all.length, LIVE.counts.total], [59, 59])
  const placed = [...sections.power, ...sections.thermal, ...sections.system].map((metric) => metric.key)
  assert.deepEqual([...placed].sort(), [...all].sort())
  assert.equal(new Set(placed).size, placed.length)
  assert.deepEqual([sections.power.length, sections.thermal.length, sections.system.length], [11, 17, 31])
  const groupsOf = (metrics) => [...new Set(metrics.map((metric) => metric.group))].sort()
  assert.deepEqual(groupsOf(sections.thermal), ['APU', 'Board', 'CVU', 'MLA', 'TOP'])
  assert.ok(sections.thermal.every((metric) => metric.unit === 'C' && isThermalMetric(metric)))
  for (const metric of [...sections.power, ...sections.system]) assert.notEqual(metric.unit, 'C', metric.key)
  assert.deepEqual(groupsOf(sections.power), ['Power', 'PowerRail'])
  assert.ok(sections.system.some((metric) => metric.key === 'mla_mem_allocated_mb'))
})

test('the live board: thermal groups in Sentinel order, cores and rails by key, threshold lines', () => {
  const model = metricsModel(LIVE)
  assert.deepEqual(thermalGroups(model).map((group) => [group.name, group.metrics.length]).sort(), [['APU', 2], ['Board', 3], ['CVU', 2], ['MLA', 8], ['TOP', 2]])
  assert.equal(metricsMatching(model, /^cpu_core_\d+_usage_pct$/).length, 16)
  assert.equal(metricsMatching(model, /^power_rail_/).length, 8)
  assert.deepEqual(thresholdLines({ warn: 70, critical: 85 }), [{ value: 70, tone: 'warn' }, { value: 85, tone: 'critical' }])
  assert.deepEqual(thresholdLines({ warn: null }), [])
  assert.deepEqual([100, 2.5, 1788, null].map(axisLabel), ['100', '2.5', '1,788', ''])
})

test('scales stay fixed: percentages 0-100, temperatures 40-90, the rest a round number above the peak', () => {
  assert.deepEqual(scaleFor('%', [[12, 99]]), { min: 0, max: 100 })
  assert.deepEqual(scaleFor('C', [[66.8, 68.6]]), { min: 40, max: 90 })
  assert.deepEqual(scaleFor('C', [[35, 96.2]]), { min: 30, max: 100 }, 'a reading outside the band widens it')
  assert.deepEqual(scaleFor('W', [[10.2, 16.69]]), { min: 0, max: 20 })
  assert.deepEqual(scaleFor('MB', [[742.3]]), { min: 0, max: 1000 })
  assert.deepEqual(scaleFor('MB', [[520.7]], 1788), { min: 0, max: 1788 }, 'a known capacity is the ceiling')
  assert.deepEqual(scaleFor('MB/s', [[null, null]]), { min: 0, max: 1 })
  assert.deepEqual([0.37, 18.36, 816, 3.4, 0].map(niceCeil), [0.4, 20, 1000, 4, 1])
  assert.deepEqual(tightScale([[8.53, 8.88], [9.03]]), { min: 8.4, max: 9.2 })
  assert.deepEqual(tightScale([Array.from({ length: 150000 }, (_, index) => index % 2)]), { min: -1, max: 2 })
  assert.deepEqual(tightScale([[3, 3], [3]]), { min: 2.8, max: 3.2 }, 'equal readings still get a band around them')
  assert.deepEqual(tightScale([[null]]), { min: 0, max: 1 })
})

test('a missing sample breaks the line instead of dropping to zero; stacked areas and derived series', () => {
  const path = linePath([50, null, 50, 100], { min: 0, max: 100 }, 300, 100)
  assert.equal(path.line, 'M0 50 M200 50 L300 0')
  assert.equal(path.area, 'M200 100 L200 50 L300 0 L300 100 Z', 'a lone point has a line start but no area')
  assert.deepEqual(path.last, { x: 300, y: 0 })
  assert.equal(linePath([1, null], { min: 0, max: 1 }, 10, 10).last, null, 'no newest point when the newest sample is missing')
  assert.equal(linePath([150], { min: 0, max: 100 }, 10, 10).line, 'M0 0', 'values beyond the scale are clamped to it')
  const stacks = [[1, 1, 1, 1, 1], [2, 2, null, 2, 2]]
  assert.deepEqual(stackTotals(stacks), [3, 3, null, 3, 3])
  assert.deepEqual(stackedPaths(stacks, { min: 0, max: 4 }, 40, 4),
    ['M0 3 L10 3 L10 4 L0 4 Z M30 3 L40 3 L40 4 L30 4 Z', 'M0 1 L10 1 L10 3 L0 3 Z M30 1 L40 1 L40 3 L30 3 Z'])
  const model = {
    metrics: [{ key: 'a', unit: 'C', group: 'MLA' }, { key: 'b', unit: 'C', group: 'Board' }, { key: 'rx', unit: 'MB/s', group: 'Network' }, { key: 'tx', unit: 'MB/s', group: 'Network' }],
    series: { a: [60, null, 70], b: [65, null, 62], rx: [1, 2, null], tx: [0.5, null, null] }
  }
  assert.deepEqual(thermalMaxSeries(model), [65, null, 70])
  assert.deepEqual([currentTotal([1, 2]), currentTotal([1, null]), currentTotal([])], [3, null, null])
  assert.deepEqual([currentValue([1, 2]), currentValue([1, 2, null]), currentValue([])], [2, null, null])
})

test('time labels use board timestamps only, in whole words; figures in a row share their decimals', () => {
  const stamps = ['2026-09-25T00:08:37Z', '2026-09-25T00:12:37Z', '2026-09-25T00:16:35Z']
  assert.equal(spanLabel(stamps), '7 minutes ago')
  assert.deepEqual([agoLabel(stamps, 1), agoLabel(stamps, 2)], ['3 minutes 58 seconds ago', 'Now'])
  assert.deepEqual([spanLabel(['x']), spanLabel([])], ['', ''])
  assert.deepEqual([indexAt(0, 240), indexAt(0.5, 240), indexAt(1.2, 240), indexAt(0.5, 0)], [0, 120, 239, -1])
  assert.equal(spanLabel(['2026-09-25T00:00:00Z', '2026-09-25T00:00:45Z']), '45 seconds ago')
  assert.equal(agoLabel(['2026-09-25T00:00:00Z', '2026-09-25T00:01:00Z'], 0), '1 minute ago')
  assert.deepEqual([scaleText({ min: 40, max: 90 }, 'C'), scaleText({ min: 0, max: 100 }, '%'), scaleText({ min: 0, max: 1000 }, 'MB')], ['40–90 °C', '0–100%', '0–1,000 MB'])
  assert.deepEqual([fixedValue(12, 'W', 1), fixedValue(13.66, 'W', 1), fixedValue(0.5625, 'W', 2), fixedValue(null, 'W', 1), fixedValue(55.12, 'C', 1)],
    ['12.0 W', '13.7 W', '0.56 W', '—', '55.1 °C'])
})

test('per-core heatmap: column means over the window, a one-minute average per core', () => {
  const cores = [0, 1, 2].map((n) => ({ key: `c${n}`, short: `c${n}`, label: `CPU core ${n} usage`, warn: 80, critical: 95 }))
  const summary = coreSummary(cores, { c0: [10, 30, 50, 70], c1: [90, 90], c2: [null] })
  assert.deepEqual(summary.rows.map((row) => [row.name, row.recent, row.tone]), [['c0', 40, 'ok'], ['c1', 90, 'warn'], ['c2', null, 'unavailable']])
  assert.equal(summary.average, 65, 'a core that did not report is left out of the average')
  assert.equal(summary.busiest.name, 'c1')
  const cells = coreSummary([cores[0]], { c0: Array.from({ length: 240 }, (_, index) => [30, 70, 40, 60, 50][index % 5]) }).rows[0].cells
  assert.equal(cells.length, HEAT_COLUMNS)
  assert.ok(cells.every((value) => value === 50), 'each column is the mean of its samples, so alternating noise reads flat')
  assert.deepEqual(columnMeans([1, null, 3], 48), [1, null, 3], 'fewer samples than columns: one column each')
  assert.deepEqual([loadColor(0), loadColor(100), loadColor(null)], ['rgb(236 243 250)', 'rgb(12 64 140)', 'var(--surface-soft)'])
  assert.deepEqual(coreSummary([], {}), { rows: [], average: null, busiest: null })
})

test('compare runs overlays one series per run over elapsed time, baseline first, with Sentinel\'s own summary', () => {
  const overlay = compareOverlay(RAW, 'power')
  assert.deepEqual([overlay.spec.label, overlay.unit], ['Total power', 'W'])
  assert.deepEqual(overlay.lines.map((line) => [line.name, line.baseline]), [['tes3', true], ['insight-hw-1790177227', false]])
  assert.deepEqual(overlay.lines[0].points.map((point) => Math.round(point.t)), [0, 2, 4, 6], 'about two seconds apart, as recorded')
  assert.deepEqual(overlay.lines[1].points.map((point) => point.v), [8.53125, 8.53125, 8.53125, 8.875])
  assert.equal(Math.round(overlay.overlap), 6)
  const [base, other] = overlay.rows
  assert.deepEqual([base.samples, base.mean, base.energy], [4, 9.03125, 54.1891436875])
  assert.deepEqual([other.minimum, other.p95, other.maximum], [8.53125, 8.875, 8.875])
  assert.equal(Number(other.delta.toFixed(3)), -4.585)
  const table = compareTable(RAW)
  assert.deepEqual(table.columns.map((column) => [column.label, column.baseline]), [['tes3', true], ['insight-hw-1790177227', false]])
  assert.deepEqual(table.rows.find((row) => row.key === 'power_current_watts').cells.map((cell) => cell.value), [9.03125, 8.6171875])
  const points = [{ t: 0, v: 1 }, { t: 1, v: null }, { t: 2, v: 3 }, { t: 9, v: 5 }]
  assert.equal(elapsedPath(points, 4, { min: 0, max: 4 }, 100, 4), 'M0 3 M50 1 L225 0', 'the first point past the window carries the line to the edge')
  assert.equal(elapsedPath([{ t: 0, v: 1 }, { t: 9, v: 2 }, { t: 12, v: 3 }], 4, { min: 0, max: 4 }, 100, 4), 'M0 3 L225 2', 'and only the first')
  assert.equal(elapsedPath([{ t: 0, v: 1 }, { t: 2, v: 3 }], 0, { min: 0, max: 4 }, 100, 4), 'M49 3 L51 3', 'a zero common window shows its initial sample as a point')
  assert.deepEqual(windowPoints([{ t: 0, v: null }, { t: 2, v: 3 }], 0), [{ t: 0, v: null }], 'scale and tooltip see only that same window')
  assert.deepEqual([valueNear(points, 1.2), valueNear([], 1)], [{ t: 2, v: 3 }, null])
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

test('compare runs takes each run\'s own temperature sensors for the thermal maximum', () => {
  const run = (id, key, values) => ({
    metadata: { id, name: id },
    metrics: [{ key, label: `${key} temperature`, unit: 'C' }, { key: 'power_current_watts', unit: 'W' }],
    samples: values.map((value, index) => ({ timestamp: `2026-09-25T00:00:0${index}Z`, values: { [key]: value, power_current_watts: 9 } }))
  })
  const own = compareOverlay({ sentinel: { baseline_id: 'old', runs: [run('old', 'rtsn_0', [50, 52]), run('new', 'soc_temp', [61, 63])] } }, 'thermal')
  assert.deepEqual(own.lines.map((line) => line.points.map((point) => point.v)), [[50, 52], [61, 63]])
  assert.deepEqual(own.rows.map((row) => row.maximum), [52, 63])
  const instant = compareOverlay({ sentinel: { baseline_id: 'old', runs: [run('old', 'rtsn_0', [50]), run('new', 'soc_temp', [61, 63])] } }, 'thermal')
  assert.equal(instant.overlap, 0)
})

test('compare runs keeps an immediately stopped run with no samples', () => {
  const run = (id, samples) => ({
    metadata: { id, name: id }, metrics: [{ key: 'power_current_watts', unit: 'W' }], samples
  })
  const samples = [{ timestamp: '2026-09-25T00:00:00Z', values: { power_current_watts: 9 } }]
  const overlay = compareOverlay({ sentinel: { baseline_id: 'empty', runs: [run('empty', []), run('full', samples)] } }, 'power')
  assert.deepEqual([overlay.overlap, overlay.lines.map((line) => line.points.length), overlay.rows.map((row) => row.samples)], [0, [0, 1], [0, 1]])
})

test('compare runs offers a series recorded only by a later run', () => {
  const run = (id, metrics, values) => ({
    metadata: { id, name: id }, metrics,
    samples: [{ timestamp: '2026-09-25T00:00:00Z', values }, { timestamp: '2026-09-25T00:00:01Z', values }]
  })
  const payload = { sentinel: { baseline_id: 'old', runs: [
    run('old', [{ key: 'power_current_watts', unit: 'W' }], { power_current_watts: 9 }),
    run('new', [{ key: 'cpu_usage_pct', unit: '%' }], { cpu_usage_pct: 50 })
  ] } }
  assert.ok(compareSeriesAvailable(payload).some((series) => series.id === 'cpu'))
  const overlay = compareOverlay(payload, 'cpu')
  assert.deepEqual([overlay.unit, overlay.lines.map((line) => line.points.map((point) => point.v))], ['%', [[null, null], [50, 50]]])

  payload.sentinel.runs.push(run('new-units', [{ key: 'cpu_usage_pct', unit: 'ratio' }], { cpu_usage_pct: 0.5 }))
  assert.equal(compareSeriesAvailable(payload).some((series) => series.id === 'cpu'), false, 'values with different units are not combined')
})
