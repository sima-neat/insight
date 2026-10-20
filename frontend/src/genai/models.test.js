import assert from 'node:assert/strict'
import test from 'node:test'

import { activeChatModel, afterLoad, loadPlan, loadedChatModels, residentLimit, unloadChoice } from './models.js'

const catalog = [
  { name: 'a-chat', type: 'chat' },
  { name: 'b-vlm', type: 'vlm', supportsVision: true },
  { name: 'c-chat', type: 'chat' },
  { name: 'whisper', type: 'asr' }
]
const status = (loaded, extra = {}) => ({ catalog, loaded, ...extra })

test('a board from before several models keeps one', () => {
  assert.equal(residentLimit(null), 1)
  assert.equal(residentLimit(status([])), 1)
  assert.equal(residentLimit(status([], { maxResident: 0 })), 1)
  assert.equal(residentLimit(status([], { maxResident: 3 })), 3)
})

test('loaded chat models follow the board\'s most recently used order', () => {
  const s = status(['a-chat', 'b-vlm', 'whisper'], { resident: ['b-vlm', 'a-chat'], maxResident: 2 })
  assert.deepEqual(loadedChatModels(s).map((m) => m.name), ['b-vlm', 'a-chat'])
  // No order from the board: catalog order, and the speech model never chats.
  assert.deepEqual(loadedChatModels(status(['c-chat', 'a-chat', 'whisper'])).map((m) => m.name), ['a-chat', 'c-chat'])
})

test('the chosen model answers while it stays loaded, else the latest one', () => {
  const s = status(['a-chat', 'b-vlm'], { resident: ['b-vlm', 'a-chat'], maxResident: 2 })
  assert.equal(activeChatModel(s).name, 'b-vlm', 'the model loaded last answers by default')
  assert.equal(activeChatModel(s, 'a-chat').name, 'a-chat')
  assert.equal(activeChatModel(s, 'c-chat').name, 'b-vlm', 'a chosen model that was unloaded no longer answers')
  assert.equal(activeChatModel(status([])), null)
})

test('a load replaces, adds, or asks what to unload', () => {
  assert.deepEqual(loadPlan(status(['a-chat']), 'a-chat'), { kind: 'use' })
  assert.deepEqual(loadPlan(status(['a-chat']), 'b-vlm').kind, 'replace', 'a limit of one replaces')
  const two = status(['a-chat'], { resident: ['a-chat'], maxResident: 2 })
  assert.deepEqual(loadPlan(two, 'b-vlm').kind, 'add')
  assert.deepEqual(loadPlan(two, 'b-vlm').keeps.map((m) => m.name), ['a-chat'])
  const full = status(['a-chat', 'b-vlm'], { resident: ['b-vlm', 'a-chat'], maxResident: 2 })
  const plan = loadPlan(full, 'c-chat')
  assert.equal(plan.kind, 'choose')
  assert.equal(plan.needed, 1)
  assert.deepEqual(plan.loaded.map((m) => m.name), ['b-vlm', 'a-chat'])
})

test('the board\'s 409 refusals become an unload choice', () => {
  const limit = { status: 409, body: { code: 'resident_limit', resident: ['b-vlm', 'a-chat'], maxResident: 2, needed: 1, error: 'over the limit' } }
  assert.deepEqual(unloadChoice(limit), { code: 'resident_limit', candidates: ['b-vlm', 'a-chat'], needed: 1, message: 'over the limit' })
  const room = { status: 409, body: { code: 'no_room', resident: ['b-vlm'], needBytes: 9e9, freeBytes: 8e9, error: 'no room' } }
  assert.deepEqual(unloadChoice(room), { code: 'no_room', candidates: ['b-vlm'], needed: 1, needBytes: 9e9, freeBytes: 8e9, message: 'no room' })
  assert.equal(unloadChoice({ status: 409, body: { error: 'RAG is disabled' } }), null, 'another 409 is an ordinary error')
  assert.equal(unloadChoice({ status: 503, body: { code: 'no_room' } }), null)
  assert.equal(unloadChoice(new Error('network')), null)
  assert.equal(unloadChoice(null), null)
})

test('a run tracks what its own loads leave loaded', () => {
  assert.deepEqual([...afterLoad(new Set(['a-chat']), 'b-vlm', { evicted: [] })].sort(), ['a-chat', 'b-vlm'])
  assert.deepEqual([...afterLoad(new Set(['a-chat', 'b-vlm']), 'c-chat', { evicted: ['a-chat'] })].sort(), ['b-vlm', 'c-chat'])
  assert.deepEqual([...afterLoad(new Set(['a-chat']), 'b-vlm', {})], ['b-vlm'], 'without the list, nothing else is known to be loaded')
})

test('the Models card names the model in use and counts the loaded ones', async () => {
  const { modelRow, modelsSummary } = await import('./settingsCards.js')
  const s = status(['a-chat', 'b-vlm', 'whisper'], { resident: ['b-vlm', 'a-chat'], maxResident: 2 })
  assert.equal(modelRow(catalog[1], s, 'b-vlm').state.label, 'In use')
  assert.equal(modelRow(catalog[0], s, 'b-vlm').state.label, 'Loaded')
  assert.equal(modelRow(catalog[0], s).state.label, 'Loaded', 'a board that keeps one says Loaded, as before')
  assert.match(modelsSummary(s), /^2 chat models loaded/)
  assert.equal(modelsSummary({ catalog: [catalog[0]], loaded: ['a-chat'] }), 'A loaded · 1 model on the board', 'one loaded model is named')
})
