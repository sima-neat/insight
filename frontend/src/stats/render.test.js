// The Runs panel as React renders it, for what markup alone decides: whether a keyboard
// or touch reader can reach the reason a comparison cell shows no change, and whether a
// trace from another board can be stopped. StatsView.jsx is bundled with the esbuild that
// Vite already ships, and rendered to static markup.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DELTA_ABSENCE, runList, traceModel } from './model.js'

const RECORDING = {
  generation: 3,
  board: { label: 'sima@192.168.2.2' },
  sentinel: { trace: { name: 'baseline', started_at: '2026-09-24T11:59:00Z' }, summary: { samples: 4 } }
}

const COMPARE = JSON.parse(readFileSync(new URL('./fixtures/compare-shape.json', import.meta.url), 'utf8'))

async function loadStatsView() {
  const entry = fileURLToPath(new URL('../StatsView.jsx', import.meta.url))
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.svg': 'text', '.png': 'empty', '.css': 'empty' },
    logLevel: 'silent'
  })
  // Inside node_modules so the bundle's bare `react` imports resolve like the app's.
  const dir = fileURLToPath(new URL('../../node_modules/.cache/stats-render-test/', import.meta.url))
  mkdirSync(dir, { recursive: true })
  const file = `${dir}StatsView.${process.pid}.mjs`
  writeFileSync(file, bundled.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}

const noop = () => {}

function runsPanel(RunsPanel, overrides = {}) {
  return renderToStaticMarkup(
    createElement(RunsPanel, {
      trace: traceModel(null),
      traceStale: false,
      traceBusy: false,
      traceError: null,
      form: { name: '', note: '', tags: '' },
      formError: '',
      onFormChange: noop,
      onStart: noop,
      onStop: noop,
      onRefreshTrace: noop,
      runs: runList(null),
      runsPayload: null,
      definitions: null,
      stale: false,
      busy: false,
      error: null,
      selected: [],
      openRef: '',
      detail: null,
      detailError: null,
      detailBusy: false,
      detailStale: false,
      compare: { sentinel: COMPARE },
      compareError: null,
      compareBusy: false,
      compareStale: false,
      compareOpen: true,
      deleteBusy: false,
      deleteResult: null,
      now: Date.parse('2026-09-24T12:00:00Z'),
      onRefresh: noop,
      onToggle: noop,
      onOpen: noop,
      onCompare: noop,
      onDelete: noop,
      onClearCompare: noop,
      onDropMissing: noop,
      onToggleCompare: noop,
      ...overrides
    })
  )
}

/** The body cells of the comparison table, as markup. */
function compareCells(html) {
  const table = html.slice(html.indexOf('stats-compare-table'))
  const body = table.slice(table.indexOf('<tbody>'), table.indexOf('</tbody>'))
  return [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1])
}

/** Markup with every visually hidden span removed: what a sighted reader can see. */
function visible(html) {
  return html.replace(/<span class="sr-only">[^<]*<\/span>/g, '')
}

const { RunsPanel } = await loadStatsView()

test('the reason a comparison cell shows no change can be reached without a pointer', () => {
  const cells = compareCells(runsPanel(RunsPanel))
  const withoutChange = cells.filter((cell) => cell.includes('—') && !visible(cell).includes('%'))
  assert.ok(withoutChange.length > 0)
  // Every reason the fixture exercises is checked; 0 against 5.9% must be among them.
  const seen = new Set()
  for (const cell of withoutChange) {
    const reason = Object.entries(DELTA_ABSENCE).find(([, text]) => cell.includes(text))
    if (!reason) continue
    seen.add(reason[0])
    // Something in the cell takes focus, so Tab and a tap reach it, not only a hover...
    assert.match(cell, /<button type="button"[^>]*>/, cell)
    // ...and what it reveals is text on the page, not a title attribute a keyboard or
    // touch reader never sees.
    assert.doesNotMatch(cell, /title="/, cell)
    const shown = visible(cell)
    const text = reason[1]
    assert.ok(shown.toLowerCase().includes(text.slice(0, -1).toLowerCase()), `${reason[0]} is not visible: ${cell}`)
  }
  assert.ok(seen.has('baseline_zero'))
})

test('the table stays as calm as it was: no legend, and changes still read as numbers', () => {
  const html = runsPanel(RunsPanel)
  assert.doesNotMatch(html, /stats-compare-legend/)
  const cells = compareCells(html)
  // A published change is plain text beside its value, not a control.
  const changed = cells.filter((cell) => /[+−-]\d/.test(visible(cell)) && cell.includes('stats-delta'))
  assert.ok(changed.length > 0)
  for (const cell of changed) assert.doesNotMatch(cell, /<button/)
})

test('a trace read from a board no longer selected cannot be stopped from here', () => {
  const stopOf = (html) => html.match(/<button[^>]*>(?:Stop trace|Stopping…)<\/button>/)?.[0] || ''
  const current = stopOf(runsPanel(RunsPanel, { trace: traceModel(RECORDING), compare: null }))
  assert.ok(current, 'no Stop button for a recording trace')
  assert.doesNotMatch(current, /disabled/)
  // Stop acts on the board selected now, which is not the one this trace was read from.
  const stale = stopOf(runsPanel(RunsPanel, { trace: traceModel(RECORDING), traceStale: true, compare: null }))
  assert.match(stale, /disabled/)
})

test('a trace cannot start before its board-bound state has loaded', () => {
  const startOf = (html) => html.match(/<button[^>]*>Start trace<\/button>/)?.[0] || ''
  const loading = startOf(runsPanel(RunsPanel))
  assert.match(loading, /disabled/)
  const ready = startOf(runsPanel(RunsPanel, {
    trace: traceModel({ generation: 3, sentinel: { trace: null } })
  }))
  assert.doesNotMatch(ready, /disabled/)
})
