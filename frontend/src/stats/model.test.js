import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { compareCsv, compareCsvFilename, compareTable, createRequestGuard, responseMatchesGeneration, runDetail, runList, traceBar, traceModel } from './model.js'

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
  assert.equal(guard.switchTo(1), false, 'the first board adopts what is already out')
  assert.ok(guard.current(early))
  assert.equal(guard.begin('state'), null)
  guard.end(early)

  const old = guard.begin('state')
  assert.equal(guard.switchTo(2), true)
  assert.equal(guard.current(old), false)
  const fresh = guard.begin('state')
  assert.ok(fresh && guard.current(fresh), 'the new board is not blocked by the old request')

  const first = guard.begin('run', { supersede: true })
  const second = guard.begin('run', { supersede: true })
  assert.equal(guard.current(first), false)
  assert.ok(guard.current(second))
})

test('Sentinel state recovery reloads instead of exposing a newer board under the old label', () => {
  const shown = { generation: 4, label: 'board-a' }
  const recovered = { generation: 5, board: { label: 'board-b' } }
  assert.equal(responseMatchesGeneration({ generation: 4 }, shown.generation), true)
  assert.equal(responseMatchesGeneration(recovered, shown.generation), false)
  assert.equal(responseMatchesGeneration({}, 4), false)
  assert.equal(responseMatchesGeneration({ generation: 4 }, null), false)
})

test('clearing a selection cancels its pending comparison response', () => {
  const guard = createRequestGuard()
  guard.switchTo(4)
  const pending = guard.begin('compare')
  guard.cancel('compare')
  assert.equal(guard.current(pending), false)
  assert.ok(guard.begin('compare'), 'a later selection can start a new comparison')
})

test('long runs compute extrema without spreading every sample as a function argument', () => {
  const samples = Array.from({ length: 200000 }, (_, value) => ({ values: { load: value % 11 } }))
  const detail = runDetail({ sentinel: { metrics: [{ key: 'load' }], samples } })
  assert.deepEqual(
    { minimum: detail.metrics[0].minimum, maximum: detail.metrics[0].maximum, mean: detail.metrics[0].mean },
    { minimum: 0, maximum: 10, mean: 4.999955 }
  )
})

test('a trace cannot start before the active trace of its board has been read', () => {
  assert.equal(traceBar(traceModel(null)).disabled, true)
  assert.equal(traceBar(traceModel({ generation: 3, sentinel: { trace: null } })).disabled, false)
  assert.equal(traceBar(traceModel({ generation: 3, sentinel: { trace: { name: 'old daemon' } } })).disabled, true)
  assert.equal(traceBar(traceModel({ generation: 3, sentinel: { trace: { id: 'trace-1', name: 'baseline' } } })).disabled, false)
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
