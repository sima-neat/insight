import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canUseModels,
  chatModels,
  checkApiVersion,
  deriveBackendState,
  formatBytes,
  formatDuration,
  friendlyModelName,
  loadedChatModel,
  speechModels
} from './backendState.js'
import { speakableText } from './speech.js'
import { chatDeltaText, createJsonLinesParser, createSseParser, splitThinking } from './streams.js'

// Shapes captured from a Modalix DevKit running GenAI Studio in backend-only mode.
const HEALTH_OK = {
  ok: true,
  mode: 'backend-only',
  asr_model: 'florianvoss@whisper-small-a16w8-layered-encoder',
  chat_models_loaded: ['Qwen3-VL-4B-Instruct-GPTQ-a16w4'],
  model_server: { error: null, reachable: true },
  tts: { engines: [{ key: 'supertonic', loaded: true }] }
}
const STATUS = {
  catalog: [
    { name: 'Qwen3-VL-4B-Instruct-GPTQ-a16w4', type: 'vlm', supportsVision: true, loaded: true, sizeBytes: 8369097563 },
    { name: 'florianvoss@whisper-small-a16w8-layered-encoder', type: 'asr', loaded: true, activeAsr: true },
    { name: 'gte-small', type: 'embedding', loaded: false }
  ],
  loaded: ['Qwen3-VL-4B-Instruct-GPTQ-a16w4'],
  loading: null,
  disk: { freeBytes: 5768511488 }
}

test('backend state: unconfigured, unavailable, and other HTTP failures', () => {
  assert.equal(
    deriveBackendState({ health: { httpStatus: 503, body: { reason: 'not-configured' } } }).state,
    'unconfigured'
  )
  const down = deriveBackendState({ health: { httpStatus: 502, body: { reason: 'unreachable' } } })
  assert.equal(down.state, 'unavailable')
  assert.equal(down.action, 'start-command')
  assert.match(down.detail, /run\.sh --backend-only/)
  assert.equal(deriveBackendState({ health: { networkError: 'Failed to fetch' } }).state, 'unavailable')
  assert.equal(deriveBackendState({ health: { httpStatus: 404, body: {} } }).action, 'settings')
})

test('backend state: starting until the model server answers', () => {
  assert.equal(deriveBackendState({ health: null }).state, 'starting')
  const starting = deriveBackendState({
    health: { httpStatus: 200, body: { ...HEALTH_OK, ok: false, model_server: { reachable: false, error: 'refused' } } }
  })
  assert.equal(starting.state, 'starting')
  assert.match(starting.detail, /loading a model or restarting/)
})

test('backend state: busy while a load runs or the tab has an operation in flight', () => {
  const loading = deriveBackendState({
    health: { httpStatus: 200, body: HEALTH_OK },
    status: { ...STATUS, loading: { name: 'Qwen3-1.7B', remainingS: 95 } }
  })
  assert.equal(loading.state, 'busy')
  assert.equal(loading.title, 'Loading Qwen3-1.7B')
  assert.match(loading.detail, /1 min 35 s left/)
  assert.equal(
    deriveBackendState({ health: { httpStatus: 200, body: HEALTH_OK }, status: STATUS, busyOp: 'Resetting the MLA' }).title,
    'Resetting the MLA'
  )
})

test('backend state: ready, failed with a recovery action, and gating', () => {
  const ready = deriveBackendState({ health: { httpStatus: 200, body: HEALTH_OK }, status: STATUS })
  assert.equal(ready.state, 'ready')
  const failed = deriveBackendState({ health: { httpStatus: 200, body: HEALTH_OK }, status: STATUS, lastError: 'boom' })
  assert.equal(failed.state, 'failed')
  assert.equal(failed.action, 'reset-mla')
  assert.ok(canUseModels('ready') && canUseModels('failed'))
  for (const state of ['busy', 'starting', 'unavailable', 'unconfigured', 'incompatible']) {
    assert.equal(canUseModels(state), false, state)
  }
})

test('api version check accepts unversioned and supported backends only', () => {
  assert.deepEqual(checkApiVersion(HEALTH_OK), { supported: true, version: null })
  assert.equal(checkApiVersion({ api_version: 1 }).supported, true)
  assert.equal(checkApiVersion({ api_version: 2 }).reason, 'too-new')
  assert.equal(checkApiVersion({ api_version: 0 }).reason, 'too-old')
  assert.equal(checkApiVersion({ api_version: '1' }).reason, 'unreadable')
  const incompatible = deriveBackendState({ health: { httpStatus: 200, body: { ...HEALTH_OK, api_version: 2 } } })
  assert.equal(incompatible.state, 'incompatible')
  assert.match(incompatible.detail, /Update Insight/)
})

test('catalog helpers split chat and speech models', () => {
  assert.deepEqual(chatModels(STATUS).map((m) => m.name), ['Qwen3-VL-4B-Instruct-GPTQ-a16w4'])
  assert.deepEqual(speechModels(STATUS).map((m) => m.name), ['florianvoss@whisper-small-a16w8-layered-encoder'])
  assert.equal(loadedChatModel(STATUS).name, 'Qwen3-VL-4B-Instruct-GPTQ-a16w4')
  assert.equal(loadedChatModel({ catalog: STATUS.catalog, loaded: [] }), null)
  assert.deepEqual(chatModels(null), [])
})

test('formatting helpers', () => {
  assert.equal(formatBytes(8369097563), '8.4 GB')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(undefined), '—')
  assert.equal(formatDuration(42), '42 s')
  assert.equal(formatDuration(120), '2 min')
  assert.equal(formatDuration(-1), '—')
})

test('SSE parser reassembles events split across chunks', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.push('id: 7\ndata: {"a"'), [])
  const events = parser.push(':1}\n\nevent: done\ndata: {}\r\n\r\ndata: x\ndata: y\n\n: ping\n\n')
  assert.deepEqual(events, [
    { event: 'message', data: '{"a":1}', id: '7' },
    { event: 'done', data: '{}', id: null },
    { event: 'message', data: 'x\ny', id: null }
  ])
})

test('JSON-lines parser keeps partial lines and flags unreadable ones', () => {
  const parser = createJsonLinesParser()
  assert.deepEqual(parser.push('{"state":"resolving"}\n{"state":"downl'), [{ state: 'resolving' }])
  assert.deepEqual(parser.push('oading","pct":40}\nnot json\n'), [
    { state: 'downloading', pct: 40 },
    { state: 'error', message: 'Unreadable progress line: not json' }
  ])
})

test('chat stream deltas, the done marker, and server errors', () => {
  assert.equal(chatDeltaText('{"choices":[{"delta":{"content":"Hel"}}]}'), 'Hel')
  assert.equal(chatDeltaText('{"choices":[{"delta":{}}]}'), '')
  assert.equal(chatDeltaText('[DONE]'), null)
  assert.equal(chatDeltaText('garbled'), '')
  assert.throws(() => chatDeltaText('{"error":{"message":"Unknown model"}}'), /Unknown model/)
})

test('thinking is split from the answer, including while it streams', () => {
  assert.deepEqual(splitThinking('Hi'), { thinking: '', answer: 'Hi', thinkingDone: true })
  assert.deepEqual(splitThinking('<think>plan'), { thinking: 'plan', answer: '', thinkingDone: false })
  assert.deepEqual(splitThinking('<think>plan</think>\n\nAnswer'), { thinking: 'plan', answer: 'Answer', thinkingDone: true })
})

test('speakable text drops Markdown symbols, code and emoji the speech engines reject', () => {
  assert.equal(
    speakableText('## Result\n**Great** work! ✌️ 👍🏽 🇯🇵 👩‍💻\n\n```js\nx()\n```\nSee [docs](https://x) and `run.sh`.'),
    'Result Great work! See docs and run.sh.'
  )
  assert.equal(speakableText(''), '')
  assert.equal(speakableText(null), '')
})

test('an operation the tab started stays busy while the model server is too busy to answer', () => {
  const state = deriveBackendState({
    health: { httpStatus: 200, body: { ...HEALTH_OK, ok: false, model_server: { reachable: false, error: 'ConnectTimeout' } } },
    status: { ...STATUS, loading: { name: 'Qwen3', remainingS: 200 } },
    busyOp: 'Loading Qwen3'
  })
  assert.equal(state.state, 'busy')
  assert.equal(state.title, 'Loading Qwen3')
  assert.match(state.detail, /3 min 20 s left/)
})

test('friendly model names drop build and quantization words', () => {
  assert.equal(friendlyModelName('Qwen3-VL-4B-Instruct-GPTQ-a16w4'), 'Qwen3 VL 4B')
  assert.equal(friendlyModelName('florianvoss@whisper-small-a16w8-layered-encoder'), 'Whisper small')
  assert.equal(friendlyModelName('Qwen3-0.6B-Autoround-a16w4'), 'Qwen3 0.6B')
  assert.equal(friendlyModelName('gte-small'), 'Gte small')
  assert.equal(friendlyModelName(''), '')
})
