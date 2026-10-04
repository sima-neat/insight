import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { compareOverlay, completeTotal, lastNumber, stackedPaths, stackTotals, tightScale } from './dashboard.js'
import { compareCsv, compareCsvFilename, compareTable, createRequestGuard, runDetail, runList, traceBar, traceModel } from './model.js'

test('keyboard-only Stats controls keep a visible focus indicator', () => {
  const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  for (const selector of ['.stats-detail summary:focus-visible', '.stats-check input:focus-visible', '.stats-toggle input:focus-visible', '.stats-table-scroll:focus-visible', '#stats-runs-title:focus-visible', '.stats-segment:focus-visible']) {
    const rule = rules.find((match) => match[1].split(',').map((item) => item.trim()).includes(selector))
    assert.match(rule?.[2] || '', /\boutline:/, selector)
  }
})

test('the request guard admits one call per key and drops answers from a board left behind', () => {
  const guard = createRequestGuard()
  const early = guard.begin('state')
  assert.ok(guard.current(early, { generation: 1 }), 'the first answer can establish the board')
  assert.equal(guard.switchTo(1), false, 'the first board adopts what is already out')
  assert.ok(guard.current(early))
  assert.equal(guard.begin('state'), null)
  guard.end(early)

  const old = guard.begin('state')
  assert.equal(guard.switchTo(2), true)
  assert.equal(guard.current(old), false)
  const fresh = guard.begin('state')
  assert.ok(fresh && guard.current(fresh), 'the new board is not blocked by the old request')
  assert.equal(guard.current(fresh, { generation: 3 }), false, 'an answer from another board is not current')

  const first = guard.begin('run', { supersede: true })
  const second = guard.begin('run', { supersede: true })
  assert.equal(guard.current(first), false)
  assert.ok(guard.current(second))
})

test('charts keep missing readings missing and compare each run with its own definitions', () => {
  assert.equal(lastNumber([2, 4, null]), null)
  assert.equal(completeTotal([2, null]), null)
  assert.equal(completeTotal([2, 3]), 5)
  assert.deepEqual(stackTotals([[1, null, 3], [2, 4, 5]]), [3, null, 8])
  assert.ok(stackedPaths([[1, null, 3], [2, 4, 5]], { min: 0, max: 10 }, 100, 100).every((path) => !path.includes('50 ')))
  const payload = {
    sentinel: {
      baseline_id: 'a',
      runs: [
        { metadata: { id: 'a' }, metrics: [{ key: 'temp_a', unit: 'C' }], samples: [{ timestamp: '2026-01-01T00:00:00Z', values: { temp_a: 70 } }] },
        { metadata: { id: 'b' }, metrics: [{ key: 'temp_b', unit: 'C' }], samples: [{ timestamp: '2026-01-01T00:00:00Z', values: { temp_b: 80 } }] }
      ]
    }
  }
  assert.deepEqual(compareOverlay(payload, 'thermal').lines.map((line) => line.points[0].v), [70, 80])
})

test('long runs do not spread every sample onto the JavaScript call stack', () => {
  const values = Array.from({ length: 200000 }, (_, index) => index)
  assert.deepEqual(tightScale([values]), { min: -100000, max: 300000 })
  const run = runDetail({ sentinel: { metrics: [{ key: 'm' }], samples: values.map((m) => ({ values: { m } })) } })
  assert.deepEqual([run.metrics[0].minimum, run.metrics[0].maximum], [0, 199999])
})

test('a trace cannot start before the active trace of its board has been read', () => {
  assert.equal(traceBar(traceModel(null)).disabled, true)
  assert.equal(traceBar(traceModel({ generation: 3, sentinel: { trace: null } })).disabled, false)
  assert.equal(traceBar(traceModel({ generation: 3, sentinel: { trace: { name: 'old' } } })).disabled, true)
  assert.equal(traceBar(traceModel({ generation: 3, sentinel: { trace: { id: 'trace-a', name: 'old' } } })).disabled, false)
})

test('run actions use the stable id when another run is named after it', () => {
  const runs = runList({ sentinel: { runs: [{ id: 'run-a', name: 'baseline' }, { id: 'run-b', name: 'run-a' }] } })
  assert.deepEqual(runs.map((run) => [run.label, run.ref]), [['baseline', 'run-a'], ['run-a', 'run-b']])
})

test('run names cannot inject spreadsheet formulas or escape the download filename', () => {
  const table = compareTable({
    sentinel: {
      baseline_id: 'a',
      runs: [{ id: 'a', name: '=HYPERLINK("http://x")' }, { id: 'b', name: '+cmd|/C calc' }],
      summaries: { a: { metrics: { m: { mean: 1 } } }, b: { metrics: { m: { mean: 2 } } } }
    }
  })
  const header = compareCsv(table).split('\r\n')[0]
  assert.match(header, /"'=HYPERLINK\(""http:\/\/x""\) \(baseline\) mean"/)
  assert.match(header, /'\+cmd\|\/C calc mean/)
  assert.doesNotMatch(header, /(^|,)[=+]/)
  const name = compareCsvFilename({ baselineLabel: '../../etc/passwd' }, new Date(2026, 8, 24))
  assert.equal(name, 'sentinel-compare-etc-passwd-2026-09-24.csv')
})

test('comparisons use recorded metric definitions and expose conflicts', () => {
  const table = compareTable({
    sentinel: {
      baseline_id: 'a',
      runs: [
        { metadata: { id: 'a' }, metrics: [{ key: 'm', label: 'Recorded power', unit: 'W', group: 'Power' }] },
        { metadata: { id: 'b' }, metrics: [{ key: 'm', label: 'Recorded power', unit: 'mW', group: 'Power' }] }
      ],
      summaries: { a: { metrics: { m: { mean: 1 } } }, b: { metrics: { m: { mean: 2 } } } }
    }
  }, new Map([['m', { label: 'Live voltage', unit: 'V', group: 'Other' }]]))
  const row = table.rows.find((item) => item.key === 'm')
  assert.equal(row.label, 'Recorded power (recorded definitions differ)')
  assert.equal(row.unit, null)
  assert.equal(row.group, 'Power')
  assert.equal(row.definitionConflict, true)
})
