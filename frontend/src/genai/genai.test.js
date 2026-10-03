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
  supportsThinking,
  voiceEngineWarnings,
  loadedChatModel,
  speechModels
} from './backendState.js'
import { TUTORIAL_STORAGE_KEY, markTutorialSeen, tutorialSeen, tutorialSteps } from './tutorial.js'
import { languageNames, readAloudSupport, scriptLanguage, speakableText } from './speech.js'
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

const VOICE_LANGUAGES = ['ar', 'bg', 'de', 'en', 'hi', 'ja', 'ko', 'uk', 'zh']

test('script detection names the language of non-Latin replies only', () => {
  assert.deepEqual(scriptLanguage('ఒక యువతి, వేళ్ళతో తీసుకున్న'), { code: 'te', name: 'Telugu' })
  assert.equal(scriptLanguage('नमस्ते, आप कैसे हैं?').code, 'hi')
  assert.equal(scriptLanguage('今日はいい天気ですね').code, 'ja')
  assert.equal(scriptLanguage('今天天气很好').code, 'zh')
  assert.equal(scriptLanguage('안녕하세요').code, 'ko')
  assert.equal(scriptLanguage('Guten Morgen, wie geht es dir heute?'), null)
  assert.equal(scriptLanguage('The word 東京 means Tokyo in this sentence.'), null)
  assert.equal(scriptLanguage(''), null)
})

test('read aloud support says plainly when a language has no voice', () => {
  assert.deepEqual(readAloudSupport('ఒక యువతి', VOICE_LANGUAGES), { supported: false, language: 'te', name: 'Telugu' })
  assert.deepEqual(readAloudSupport('नमस्ते', VOICE_LANGUAGES), { supported: true, language: 'hi' })
  assert.deepEqual(readAloudSupport('Привет, как дела?', VOICE_LANGUAGES), { supported: true, language: 'uk' })
  assert.deepEqual(readAloudSupport('Hello there', VOICE_LANGUAGES, 'de'), { supported: true, language: 'de' })
  assert.deepEqual(readAloudSupport('ఒక యువతి', null), { supported: true, language: 'te' })
  assert.deepEqual(languageNames(['zh', 'en', 'na']), ['Chinese', 'English'])
})

test('thinking is offered only for models that have a reasoning mode', () => {
  assert.equal(supportsThinking('Qwen3-1.7B-GPTQ-a16w4'), true)
  assert.equal(supportsThinking('simaai/Qwen3-0.6B-Autoround-a16w4'), true)
  assert.equal(supportsThinking('Qwen3-VL-4B-Thinking-a16w4'), true)
  assert.equal(supportsThinking('DeepSeek-R1-Distill-Qwen-1.5B'), true)
  assert.equal(supportsThinking('Qwen3-VL-4B-Instruct-GPTQ-a16w4'), false)
  assert.equal(supportsThinking('Qwen3-4B-Instruct-2507'), false)
  assert.equal(supportsThinking('Llama-3.2-3B-Instruct'), false)
  assert.equal(supportsThinking(''), false)
})

test('the tutorial covers every feature and mentions thinking only when the model can', () => {
  const ids = tutorialSteps().map((s) => s.id)
  assert.deepEqual(ids, ['intro', 'model', 'ask', 'picture', 'talk', 'listen', 'languages', 'help'])
  assert.deepEqual(tutorialSteps({ canThink: true }).map((s) => s.id).slice(-2), ['think', 'help'])
  for (const step of tutorialSteps({ canThink: true })) {
    assert.ok(step.title && step.body.length > 40, step.id)
  }
})

test('the tutorial is remembered once seen, and not forced on every visit when storage fails', () => {
  const store = new Map()
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  assert.equal(tutorialSeen(storage), false)
  markTutorialSeen(storage)
  assert.equal(store.get(TUTORIAL_STORAGE_KEY), '1')
  assert.equal(tutorialSeen(storage), true)
  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  assert.equal(tutorialSeen(broken), true)
  assert.doesNotThrow(() => markTutorialSeen(broken))
})

test('voice engines that failed to load become plain warnings', () => {
  const health = (engines) => ({ httpStatus: 200, body: { ...HEALTH_OK, tts: { engines } } })
  const [warning] = voiceEngineWarnings(health([
    { key: 'piper-tts', loaded: true },
    { key: 'supertonic', loaded: false, error: 'NeatError: [infra.dispatcher_unavailable] The accelerator runtime is not available.\n\nStage: MLA_0_1' }
  ]))
  assert.equal(warning.key, 'supertonic')
  assert.match(warning.message, /Supertonic voice didn't load: the accelerator was busy or unavailable/)
  assert.match(voiceEngineWarnings(health([{ key: 'piper-plus', loaded: false, error: 'RuntimeError: model file missing' }]))[0].message, /model file missing/)
  assert.deepEqual(voiceEngineWarnings(health([{ key: 'piper-plus', loaded: false }])), [])
  assert.deepEqual(voiceEngineWarnings(null), [])
})
