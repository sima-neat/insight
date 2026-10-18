import assert from 'node:assert/strict'
import test from 'node:test'

import { find, loadComponent } from './jsxHarness.js'

const MicrophoneDetail = await loadComponent(new URL('./MicrophoneDetail.jsx', import.meta.url))

const mic = { id: 'microphone:usb:1-1.2:1.0', name: 'Yeti', errors: [], device: { card_index: 2, pcm_node: '/dev/snd/pcmC2D0c' } }
const testKey = (generation, shown = mic) =>
  find(MicrophoneDetail({ mic: shown, generation }), (node) => node.props?.mic === shown)?.key

test('a microphone test belongs to one board: another board with the same microphone id starts afresh', () => {
  // Codex 4255505622: keyed by the id alone, board A's recording stayed on screen under board B.
  assert.ok(testKey(1))
  assert.equal(testKey(1), testKey(1))
  assert.notEqual(testKey(1), testKey(2))
})

test('a rescan that lists another device under the same microphone id starts the test afresh', () => {
  // Codex 4261034878: a replug in the same port kept the id, and the old device's recording stayed on screen.
  assert.equal(testKey(1), testKey(1, { ...mic, device: { ...mic.device } }))
  assert.notEqual(testKey(1), testKey(1, { ...mic, device: { ...mic.device, card_index: 3 } }))
})

test('a rescan that changes only fields the page does not show still starts the test afresh', () => {
  // Codex 4264051724: the key read the shown device fields; the backend binds a test to the whole scanned record.
  const recorded = { ...mic, record: 'a1' }
  assert.equal(testKey(1, recorded), testKey(1, { ...recorded, device: { ...mic.device } }))
  assert.notEqual(testKey(1, recorded), testKey(1, { ...recorded, record: 'b2' }))
})
