import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

import { acceptedAnswer, clearDocumentsQuestion, deleteModelQuestion, loadModelQuestion, solutionQuestion } from './confirmations.js'

const qwen = { name: 'Qwen2.5-VL-3B-Instruct', estimatedLoadS: 90, sizeBytes: 3_200_000_000 }
const llama = { name: 'Llama-3.2-3B-Instruct' }

test('the questions keep the text the browser confirm() showed', () => {
  assert.equal(deleteModelQuestion(qwen).message, 'Delete Qwen2.5 VL 3B (3.2 GB) from the board? Its files are removed; download it again to use it.')
  assert.equal(deleteModelQuestion(llama).message, 'Delete Llama 3.2 3B from the board? Its files are removed; download it again to use it.')
  assert.equal(clearDocumentsQuestion().message, 'Remove all documents from the board? Use my documents then finds nothing until you upload or reset.')
})

test('deleting and clearing are destructive; loading and opening are not', () => {
  assert.equal(deleteModelQuestion(qwen).danger, true)
  assert.equal(clearDocumentsQuestion().danger, true)
  assert.ok(!loadModelQuestion(qwen, { kind: 'replace', unloads: [] }).danger)
  assert.ok(!solutionQuestion({ name: 'SiMa Security' }, null).danger)
})

test('loading says how long it takes and what is unloaded or stays loaded', () => {
  assert.equal(loadModelQuestion(qwen, { kind: 'replace', unloads: [llama] }).message, 'Load Qwen2.5 VL 3B? It takes about 1 min 30 s. Llama 3.2 3B is unloaded first.')
  assert.equal(loadModelQuestion(llama, { kind: 'replace', unloads: [] }).message, 'Load Llama 3.2 3B?')
  assert.equal(loadModelQuestion(llama, { kind: 'add', keeps: [qwen] }).message, 'Load Llama 3.2 3B? Qwen2.5 VL 3B stays loaded.')
  assert.equal(loadModelQuestion(llama, { kind: 'add', keeps: [qwen, { name: 'Llama-3.2-1B-Instruct' }] }).message, 'Load Llama 3.2 3B? Qwen2.5 VL 3B, Llama 3.2 1B stay loaded.')
})

test('opening a solution the model cannot serve says why', () => {
  const app = { name: 'SiMa Security' }
  assert.equal(solutionQuestion(app, qwen.name).message, "Qwen2.5 VL 3B doesn't see images, so the SiMa Security picture features won't work. Open it anyway?")
  assert.equal(solutionQuestion(app, null).message, "No chat model is loaded, so SiMa Security can't answer until you load one. Open it anyway?")
  assert.equal(solutionQuestion(app, null).confirmLabel, 'Open anyway')
})

test('only a yes about the board still selected runs the action', () => {
  const ask = { kind: 'load-model', board: 3 }
  assert.equal(acceptedAnswer(ask, true, 3), true)
  // Cancel, Esc and a click outside answer no.
  assert.equal(acceptedAnswer(ask, false, 3), false)
  // The board changed while the question was open.
  assert.equal(acceptedAnswer(ask, true, 4), false)
  // Nothing was asked (a second click on a closing dialog).
  assert.equal(acceptedAnswer(null, true, 3), false)
})

// The browser's own dialogs answer no at once in a frame sandboxed without
// allow-modals, such as a Palette SDK editor tab (#221): ask with ConfirmDialog.
test('the app asks in the page, never with window.confirm, alert or prompt', () => {
  const root = new URL('../', import.meta.url)
  const sources = readdirSync(root, { recursive: true })
    .filter((path) => /\.(jsx?|tsx?)$/.test(path) && !/\.test\.js$/.test(path))
  assert.ok(sources.includes('GenAIView.jsx'))
  for (const path of sources) {
    const text = readFileSync(new URL(path, root), 'utf8')
    assert.doesNotMatch(text, /\b(?:window|globalThis|self)\.(?:confirm|alert|prompt)\s*\(/, `${path} opens a native browser dialog`)
  }
})
