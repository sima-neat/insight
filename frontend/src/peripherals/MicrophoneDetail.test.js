import assert from 'node:assert/strict'
import test from 'node:test'

import { find, loadComponent } from './jsxHarness.js'

const MicrophoneDetail = await loadComponent(new URL('./MicrophoneDetail.jsx', import.meta.url))

const mic = { id: 'microphone:usb:1-1.2:1.0', name: 'Yeti', errors: [] }
const testKey = (generation) => find(MicrophoneDetail({ mic, generation }), (node) => node.props?.mic === mic)?.key

test('a microphone test belongs to one board: another board with the same microphone id starts afresh', () => {
  // Codex 4255505622: keyed by the id alone, board A's recording stayed on screen under board B.
  assert.ok(testKey(1))
  assert.equal(testKey(1), testKey(1))
  assert.notEqual(testKey(1), testKey(2))
})
