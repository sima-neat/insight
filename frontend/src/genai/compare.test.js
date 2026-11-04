import test from 'node:test'
import assert from 'node:assert/strict'

import {
  chooseCard,
  combinedRate,
  compareAnswerers,
  compareSelection,
  compareTurn,
  imageNote,
  loadedInDisplayOrder,
  toggleTicked,
  updateCard
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

test('cards keep catalog order whichever model was used last', () => {
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

test('a turn mirrors the chosen card and finishes with its last card', () => {
  let turn = compareTurn(1, [LM, VL], VL.name)
  turn = updateCard(turn, LM.name, { content: 'a', pending: false })
  assert.equal(turn.content, '')
  assert.equal(turn.pending, true)
  turn = updateCard(turn, VL.name, { content: 'b', pending: false })
  assert.equal(turn.content, 'b')
  assert.equal(turn.pending, false)
  assert.equal(chooseCard(turn, LM.name).content, 'a')
  assert.equal(chooseCard(turn, 'other'), turn)
})

test('a skipped model has a finished card from the start', () => {
  const turn = compareTurn(1, [LM, VL], VL.name, [LM])
  assert.deepEqual(turn.compare[0], { model: LM.name, content: '', pending: false, skipped: true })
  assert.equal(turn.compare[1].pending, true)
})

test('the combined speed counts every card over the whole turn', () => {
  const turn = { compare: [{ stats: { tokens: 30 } }, { stats: { tokens: 10 } }, {}] }
  assert.deepEqual(combinedRate(turn, 2000), { tokens: 40, tps: 20, seconds: 2 })
  assert.equal(combinedRate({ compare: [{}] }, 2000), null)
  assert.equal(combinedRate(turn, 0), null)
})
