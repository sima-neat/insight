// The derivations behind the compact Stats layout, which fold detail behind chips and
// disclosures without taking any value off the page.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ALL_GROUPS,
  chipKeyTarget,
  compareCsv,
  compareCsvFilename,
  compareGroups,
  compareRowGroup,
  compareSummary,
  compareTable,
  compareView,
  compareViewText,
  csvField,
  definitionsByKey,
  metricGroupChips,
  metricsModel,
  openGroup,
  rowChanged
} from './model.js'

const COMPARE = JSON.parse(readFileSync(new URL('./fixtures/compare-shape.json', import.meta.url), 'utf8'))

const DEFINITIONS = definitionsByKey({
  groups: [
    { name: 'Power', metrics: [{ key: 'power_current_watts', label: 'Current board power', unit: 'W', group: 'Power' }] },
    {
      name: 'CPU',
      metrics: [
        { key: 'cpu_core_0_usage_pct', label: 'CPU core 0', unit: '%', group: 'CPU' },
        { key: 'cpu_core_11_usage_pct', label: 'CPU core 11', unit: '%', group: 'CPU' },
        { key: 'cpu_core_13_usage_pct', label: 'CPU core 13', unit: '%', group: 'CPU' }
      ]
    },
    { name: 'APU', metrics: [{ key: 'rtsn_6', label: 'APU RTSN-6', unit: 'C', group: 'APU' }] }
  ]
})

const table = () => compareTable({ sentinel: COMPARE }, DEFINITIONS)

// RFC 4180, enough to read back what compareCsv writes.
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
    } else field += char
  }
  if (field || row.length) rows.push([...row, field])
  return rows
}

const group = (name, statuses) => ({
  name,
  metrics: statuses.map((status, index) => ({ key: `${name}-${index}`, label: `${name} ${index}`, status, value: 1 }))
})

test('metric groups become chips that carry their size and anything past a threshold', () => {
  const chips = metricGroupChips([group('CPU', ['ok', 'warn', 'critical', 'critical']), group('Disk', ['ok', 'warn']), group('APU', ['ok'])])
  assert.deepEqual(chips.map((chip) => [chip.label, chip.count]), [['CPU', 4], ['Disk', 2], ['APU', 1]])
  // A group used to open by itself when it held a critical metric. Groups now start closed,
  // so the chip is what says so, and a critical outranks a warning.
  assert.deepEqual(chips[0].alert, { tone: 'critical', count: 2 })
  assert.deepEqual(chips[1].alert, { tone: 'warn', count: 1 })
  assert.equal(chips[2].alert, null)
  assert.deepEqual(metricGroupChips(null), [])
})

test('the open group is remembered by name, so a live refresh keeps it open', () => {
  const first = metricsModel({ groups: [group('CPU', ['ok']), group('Disk', ['ok'])] })
  // Nothing is open until someone opens it.
  assert.equal(openGroup(first.groups, ''), null)
  assert.equal(openGroup(first.groups, 'Disk').name, 'Disk')
  // The next poll builds new objects; the same name still finds the group.
  const next = metricsModel({ groups: [group('CPU', ['warn']), group('Disk', ['critical'])] })
  assert.equal(openGroup(next.groups, 'Disk').metrics[0].status, 'critical')
  // A sample without that group shows nothing rather than another group.
  assert.equal(openGroup(metricsModel({ groups: [group('CPU', ['ok'])] }).groups, 'Disk'), null)
})

test('arrow keys walk the chips in reading order and wrap at both ends', () => {
  assert.equal(chipKeyTarget('ArrowRight', 0, 3), 1)
  assert.equal(chipKeyTarget('ArrowRight', 2, 3), 0)
  assert.equal(chipKeyTarget('ArrowLeft', 0, 3), 2)
  assert.equal(chipKeyTarget('Home', 2, 3), 0)
  assert.equal(chipKeyTarget('End', 0, 3), 2)
  // A focus index that no longer exists starts from the first chip.
  assert.equal(chipKeyTarget('ArrowRight', 7, 3), 1)
  assert.equal(chipKeyTarget('Enter', 0, 3), null)
  assert.equal(chipKeyTarget('ArrowDown', 0, 3), null)
  assert.equal(chipKeyTarget('ArrowRight', 0, 0), null)
})

test('comparison rows are grouped by the board definitions, with run totals apart', () => {
  const rows = table().rows
  assert.equal(compareRowGroup(rows.find((row) => row.key === 'energy_joules')), 'Run totals')
  assert.equal(compareRowGroup(rows.find((row) => row.key === 'power_current_watts')), 'Power')
  // A key no definition names is not dropped from the filter; it is "Other".
  assert.equal(compareRowGroup(rows.find((row) => row.key === 'disk_emmc_used_mb')), 'Other')
  assert.deepEqual(compareGroups(table()).map((item) => [item.label, item.count]), [
    [ALL_GROUPS, 10],
    ['Run totals', 3],
    ['APU', 1],
    ['CPU', 3],
    ['Power', 1],
    ['Other', 2]
  ])
  assert.deepEqual(compareGroups(null), [{ id: ALL_GROUPS, label: ALL_GROUPS, count: 0 }])
})

test('a row changed when any run differs from the baseline, even without a percentage', () => {
  const rows = Object.fromEntries(table().rows.map((row) => [row.key, row]))
  assert.equal(rowChanged(rows.power_current_watts), true)
  // A change far too small to print is still a change.
  assert.equal(rowChanged(rows.disk_emmc_used_mb), true)
  // 0 against 0: nothing moved.
  assert.equal(rowChanged(rows.cpu_core_11_usage_pct), false)
  // 0 against 5.9%: Sentinel has no percentage for it, and hiding it as "no change" would
  // hide the one metric that went from nothing to something.
  assert.equal(rows.cpu_core_13_usage_pct.cells[1].deltaAbsence, 'baseline_zero')
  assert.equal(rowChanged(rows.cpu_core_13_usage_pct), true)
  // Run totals have no published change; their values differ, so they changed.
  assert.equal(rowChanged(rows.duration_ms), true)
  // A published change of exactly zero is no change.
  const flat = { cells: [{ baseline: true, value: 5, deltaPct: null }, { baseline: false, value: 5, deltaPct: 0 }] }
  assert.equal(rowChanged(flat), false)
  // A run with no value has not been shown to move.
  const gone = { cells: [{ baseline: true, value: 5, deltaPct: null }, { baseline: false, value: null, deltaPct: null }] }
  assert.equal(rowChanged(gone), false)
})

test('the comparison view filters by group and says how many unchanged rows it hides', () => {
  const all = compareView(table())
  assert.equal(all.group, ALL_GROUPS)
  assert.equal(all.rows.length, 10)
  assert.equal(all.unchanged, 0)

  const cpu = compareView(table(), { group: 'CPU' })
  assert.deepEqual(cpu.rows.map((row) => row.key), ['cpu_core_0_usage_pct', 'cpu_core_11_usage_pct', 'cpu_core_13_usage_pct'])
  assert.equal(cpu.inGroup, 3)
  assert.equal(cpu.total, 10)

  const changed = compareView(table(), { group: 'CPU', changesOnly: true })
  assert.deepEqual(changed.rows.map((row) => row.key), ['cpu_core_0_usage_pct', 'cpu_core_13_usage_pct'])
  assert.equal(changed.unchanged, 1)
  assert.equal(compareView(table(), { changesOnly: true }).unchanged, 1)

  // A filter left over from an earlier comparison that lacks the group falls back to All.
  const stale = compareView(table(), { group: 'PowerRail' })
  assert.equal(stale.group, ALL_GROUPS)
  assert.equal(stale.rows.length, 10)
  assert.deepEqual(compareView(null).rows, [])
})

test('what the filters hide is said, never left silent', () => {
  assert.equal(compareViewText(compareView(table())), '')
  assert.equal(compareViewText(compareView(table(), { group: 'CPU' })), 'Showing 3 of 10 rows.')
  assert.equal(
    compareViewText(compareView(table(), { group: 'CPU', changesOnly: true })),
    'Showing 2 of 10 rows. Changes only hides 1 row where no run differs from the baseline.'
  )
  assert.equal(
    compareViewText(compareView(table(), { group: 'Power', changesOnly: true })),
    'Showing 1 of 10 rows. Every row shown differs from the baseline in at least one run, so Changes only hides nothing.'
  )
  assert.equal(compareViewText(null), '')
})

test('a collapsed comparison is summarised in one line', () => {
  assert.equal(compareSummary(table()), '2 runs · baseline insight-hw-1790177227 · 10 rows')
  // A shape Insight cannot tabulate still says how many runs it holds.
  assert.equal(compareSummary(null, { sentinel: { runs: [{}, {}, {}] } }), '3 runs')
  assert.equal(compareSummary(null, null), '')
})

test('a CSV field is quoted and escaped only when it has to be', () => {
  assert.equal(csvField('plain'), 'plain')
  assert.equal(csvField('before, after'), '"before, after"')
  assert.equal(csvField('say "hi"'), '"say ""hi"""')
  assert.equal(csvField('two\nlines'), '"two\nlines"')
  assert.equal(csvField(' padded'), '" padded"')
  assert.equal(csvField(-0.35731427657192105), '-0.35731427657192105')
  assert.equal(csvField(0), '0')
  assert.equal(csvField(null), '')
  assert.equal(csvField(Number.NaN), '')
  // A run name a spreadsheet would execute is written as text.
  assert.equal(csvField('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"')
  assert.equal(csvField('@sum'), "'@sum")
})

test('the comparison exports every row as CSV, with empty fields where the table has em dashes', () => {
  const text = compareCsv(table())
  assert.ok(text.endsWith('\r\n'))
  const lines = text.split('\r\n')
  assert.equal(lines[0], [
    'metric_key',
    'label',
    'group',
    'unit',
    'insight-hw-1790177227 (baseline; Insight hardware validation) mean',
    'insight-hw-1790177227 (baseline; Insight hardware validation) change vs baseline (%)',
    'insight-hw-1790177178 (Insight hardware validation) mean',
    'insight-hw-1790177178 (Insight hardware validation) change vs baseline (%)'
  ].join(','))
  assert.equal(lines[1], 'duration_ms,Duration,Run totals,s,6.667,,34.379,')

  const rows = parseCsv(text)
  // Every row of the table, whatever a filter shows on screen, plus the header.
  assert.equal(rows.length, table().rows.length + 1)
  const byKey = Object.fromEntries(rows.slice(1).map((row) => [row[0], row]))
  // Numbers are unformatted, a unit stays in its column, and the baseline has no change.
  assert.deepEqual(byKey.power_current_watts, ['power_current_watts', 'Current board power', 'Power', 'W', '8.6171875', '', '8.586397058823529', '-0.35731427657192105'])
  assert.deepEqual(byKey.rtsn_6.slice(3, 4), ['°C'])
  // A withheld change is an empty field, never a dash or a zero.
  assert.deepEqual(byKey.cpu_core_13_usage_pct.slice(4), ['0', '', '5.91190441525744', ''])
  assert.ok(!text.includes('—'))
  assert.ok(!/\d%/.test(text))
  assert.equal(compareCsv(null), '')
})

test('run names and notes with commas, quotes and line breaks survive the CSV', () => {
  const tricky = JSON.parse(JSON.stringify(COMPARE))
  tricky.runs[0].name = 'before, after'
  tricky.runs[1].note = 'line one\nline "two"'
  const rows = parseCsv(compareCsv(compareTable({ sentinel: tricky })))
  assert.equal(rows[0].length, 8)
  assert.equal(rows[0][4], 'before, after (baseline; Insight hardware validation) mean')
  assert.equal(rows[0][6], 'insight-hw-1790177178 (line one\nline "two") mean')
  assert.ok(rows.every((row) => row.length === 8))
})

test('the CSV is named after the baseline and the day, safely', () => {
  const day = new Date(2026, 8, 24, 12, 0, 0)
  assert.equal(compareCsvFilename(table(), day), 'sentinel-compare-insight-hw-1790177227-2026-09-24.csv')
  assert.equal(
    compareCsvFilename({ baselineLabel: '../before, after: "v2"/x' }, day),
    'sentinel-compare-before-after-v2-x-2026-09-24.csv'
  )
  assert.equal(compareCsvFilename({ baselineLabel: '///' }, day), 'sentinel-compare-runs-2026-09-24.csv')
  assert.equal(compareCsvFilename({ baselineLabel: 'x'.repeat(300) }, day).length, 'sentinel-compare--2026-09-24.csv'.length + 80)
  assert.match(compareCsvFilename(null, new Date('nonsense')), /^sentinel-compare-runs-\d{4}-\d{2}-\d{2}\.csv$/)
})
