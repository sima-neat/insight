import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  compareAnswerers,
  compareSelection,
  imageNote,
  loadedInDisplayOrder,
  panelHistory,
  toggleTicked
} from './compare.js'

const LM = { name: 'LFM2.5-230M-a16w4', type: 'chat', supportsVision: false, loaded: true }
const VL = { name: 'LFM2.5-VL-450M-Autoround-a16w4', type: 'vlm', supportsVision: true, loaded: true }
const QWEN = { name: 'Qwen3-VL-4B-Instruct-Autoround-a16w4', type: 'vlm', supportsVision: true, loaded: false }
const status = {
  catalog: [LM, VL, QWEN],
  loaded: [LM.name, VL.name],
  resident: [VL.name, LM.name],
  maxResident: 2
}

test('panels keep catalog order whichever model was used last', () => {
  assert.deepEqual(loadedInDisplayOrder(status).map((m) => m.name), [LM.name, VL.name])
})

test('ticking keeps display order and never empties the list', () => {
  const models = [LM, VL]
  assert.deepEqual(toggleTicked(models, [VL.name], LM.name), [LM.name, VL.name])
  assert.deepEqual(toggleTicked(models, [LM.name, VL.name], LM.name), [VL.name])
  assert.deepEqual(toggleTicked(models, [VL.name], VL.name), [VL.name])
})

test('a comparison needs two models, all still loaded', () => {
  const models = [LM, VL]
  assert.equal(compareSelection(models, []), null)
  assert.equal(compareSelection(models, [LM.name]), null)
  assert.equal(compareSelection(models, [LM.name, QWEN.name]), null)
  assert.deepEqual(compareSelection(models, [VL.name, LM.name]), models)
})

test('a picture goes only to the models that see images', () => {
  assert.deepEqual(compareAnswerers([LM, VL], true), { answer: [VL], skip: [LM] })
  assert.deepEqual(compareAnswerers([LM, VL], false), { answer: [LM, VL], skip: [] })
  assert.match(imageNote([LM, VL]), /can't take images/)
  assert.equal(imageNote([VL]), null)
  assert.equal(imageNote([LM]), null)
})

test('a panel keeps its own history and leaves out messages it sat out', () => {
  const chat = [
    { role: 'user', text: 'first' },
    { role: 'assistant', content: '<think>hm</think>one' },
    { role: 'user', text: 'with a picture', image: 'data:x' },
    { role: 'assistant', skipped: true, content: '' }
  ]
  const { history, picture } = panelHistory(chat, LM, false)
  assert.deepEqual(history.map((m) => m.role), ['user', 'assistant', 'user'])
  assert.equal(history[2].content, 'with a picture')
  assert.equal(picture, 'none')
})

test('a follow-up sends the last picture again only to a model that sees images', () => {
  const chat = [{ role: 'user', text: 'look', image: 'data:x' }, { role: 'assistant', content: 'red' }]
  const seen = panelHistory(chat, VL, false)
  assert.equal(seen.picture, 'earlier')
  assert.equal(seen.history[0].content[1].image_url.url, 'data:x')
  assert.equal(panelHistory(chat, VL, true).picture, 'current')
  assert.equal(panelHistory(chat, VL, true).history[0].content, 'look')
})

test('the view shows the Compare button when the board keeps several models', () => {
  const view = readFileSync(new URL('../GenAIView.jsx', import.meta.url), 'utf8')
  assert.match(view, /keepsSeveral && \(\s*<ComparePicker/)
  assert.match(view, /<ParallelPanels\b/)
})
