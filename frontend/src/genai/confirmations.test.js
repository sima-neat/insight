import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

import { acceptedAnswer, benchmarkLoadQuestion, clearDocumentsQuestion, deleteModelQuestion, loadModelQuestion, loadPlanKey, solutionQuestion } from './confirmations.js'

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

test('a load plan is told apart by exact model names, not by the question text', () => {
  const gptq = { name: 'Llama-3.2-3B-Instruct-GPTQ-a16w4' }
  const awq = { name: 'Llama-3.2-3B-Instruct-AWQ' }
  // Two builds read the same in the question but unload different models.
  const unloadsGptq = loadModelQuestion(qwen, { kind: 'replace', unloads: [gptq] })
  const unloadsAwq = loadModelQuestion(qwen, { kind: 'replace', unloads: [awq] })
  assert.equal(unloadsGptq.message, unloadsAwq.message)
  assert.notEqual(unloadsGptq.plan, unloadsAwq.plan)
  // Unloading a model and keeping it are different plans.
  assert.notEqual(loadPlanKey({ kind: 'replace', unloads: [llama] }), loadPlanKey({ kind: 'add', keeps: [llama] }))
  // The order the board lists them in doesn't matter.
  assert.equal(loadPlanKey({ kind: 'add', keeps: [llama, qwen] }), loadPlanKey({ kind: 'add', keeps: [qwen, llama] }))
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

test('a benchmark of loaded models asks nothing', () => {
  const status = { catalog: [qwen, llama], loaded: [llama.name], maxResident: 1 }
  assert.equal(benchmarkLoadQuestion(status, [llama.name]), null)
})

test('a benchmark that swaps the loaded model says so first', () => {
  const status = { catalog: [qwen, llama], loaded: [llama.name], maxResident: 1 }
  const question = benchmarkLoadQuestion(status, [qwen.name])
  assert.equal(question.title, 'Swap the loaded model?')
  assert.equal(question.message, 'This test loads Qwen2.5 VL 3B, which takes about 1 min 30 s and unloads Llama 3.2 3B. Qwen2.5 VL 3B stays loaded afterwards. To chat with Llama 3.2 3B again, load it from the Model menu.')
  assert.equal(question.confirmLabel, 'Load and run')
  assert.ok(!question.danger)
})

test('a benchmark that returns to the loaded model last leaves it loaded', () => {
  const status = { catalog: [qwen, llama], loaded: [llama.name], maxResident: 1 }
  const question = benchmarkLoadQuestion(status, [qwen.name, llama.name])
  assert.equal(question.title, 'Load the model first?')
  assert.equal(question.message, 'This test loads Qwen2.5 VL 3B and Llama 3.2 3B, one at a time, which takes a few minutes. Llama 3.2 3B stays loaded afterwards.')
  const other = benchmarkLoadQuestion(status, [llama.name, qwen.name])
  assert.equal(other.title, 'Swap the loaded model?')
  assert.notEqual(other.plan, question.plan)
})

test('a benchmark with nothing loaded says it loads first', () => {
  const question = benchmarkLoadQuestion({ catalog: [qwen, llama], loaded: [], maxResident: 1 }, [llama.name])
  assert.equal(question.title, 'Load the model first?')
  assert.equal(question.message, 'This test loads Llama 3.2 3B, which takes a few minutes. Llama 3.2 3B stays loaded afterwards.')
})

test('a benchmark on a board that keeps several models says what can go', () => {
  const room = { catalog: [qwen, llama], loaded: [llama.name], maxResident: 2 }
  assert.equal(benchmarkLoadQuestion(room, [qwen.name]).title, 'Load the model first?')
  assert.match(benchmarkLoadQuestion(room, [qwen.name]).message, /If the board runs out of room, that unloads Llama 3\.2 3B\./)
  const gemma = { name: 'Gemma-2B' }
  const full = { catalog: [qwen, llama, gemma], loaded: [llama.name, gemma.name], maxResident: 2 }
  assert.equal(benchmarkLoadQuestion(full, [qwen.name]).title, 'Swap the loaded model?')
  assert.match(benchmarkLoadQuestion(full, [qwen.name]).message, /That unloads one or more of /)
})

test('a change to what is loaded changes a benchmark question\'s plan', () => {
  const before = benchmarkLoadQuestion({ catalog: [qwen, llama], loaded: [llama.name], maxResident: 1 }, [qwen.name])
  const after = benchmarkLoadQuestion({ catalog: [qwen, llama], loaded: [], maxResident: 1 }, [qwen.name])
  assert.notEqual(before.plan, after.plan)
})
