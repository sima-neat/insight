import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  canUseModels,
  chatModels,
  checkApiVersion,
  deriveBackendState,
  engineName,
  formatBytes,
  formatDuration,
  friendlyModelName,
  supportsThinking,
  thinkingModelOnBoard,
  voiceEngineWarnings,
  deletableModel,
  loadedChatModel,
  speechModels
} from './backendState.js'
import { TUTORIAL_STORAGE_KEY, markTutorialSeen, tutorialSeen, tutorialSteps } from './tutorial.js'
import { languageNames, latinLanguage, readAloudSupport, scriptLanguage, speakableText } from './speech.js'
import { chatDeltaText, createJsonLinesParser, createSseParser, splitThinking } from './streams.js'
import { REPLY_CUT_OFF, boardCameraSnapshot, chatRequestBody, downloadModel, errorMessage, probeHealth, streamChat } from './client.js'
import { chatStreamStats, heardMetrics, replyMetrics, speechMetrics } from './metrics.js'
import { createSentenceSplitter, speakablePieces } from './sentences.js'
import {
  INSPECT_LIMIT,
  documentsSummary,
  documentsSupport,
  filterSections,
  inspectPath,
  inspectSummary,
  parseSources,
  progressOutcome,
  sectionHeading,
  sourcesNote
} from './documents.js'
import { boardCameraSupport, parseCameraDevices, pickCamera, snapshotErrorMessage, snapshotPath } from './boardCamera.js'
import {
  DEFAULT_SYSTEM_PROMPT,
  MAX_TOKENS_KEY,
  MAX_TOKENS_LIMITS,
  SYSTEM_PROMPT_KEY,
  clampMaxTokens,
  loadReplySettings,
  saveReplySettings,
  systemPromptFor
} from './replySettings.js'
import { LOOP_PAUSE_MS, VISION_PRESETS, createVisionLoop, pause } from './visionLoop.js'
import { SOLUTIONS, chatLog, chatLogFilename, solutionUrl } from './chatExport.js'
import { allowedActions } from './activity.js'
import { anySignal, closedTicket, createBoardSession } from './boardSession.js'
import { benchProgress, benchmarkCsv, benchmarkSupport, benchmarkFilename, benchmarkJson, benchmarkRequest, clampSetting, comparisonRows, BENCH_LIMITS } from './benchmark.js'

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
    { name: 'Qwen3-0.6B-Autoround-a16w4', type: 'chat', supportsVision: false, loaded: false, sizeBytes: 1379000000 },
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
  assert.match(down.detail, /\.\/run\.sh/)
  assert.doesNotMatch(down.detail, /--backend-only/, 'GenAI Studio is backend-only; run.sh has no such option')
  assert.equal(deriveBackendState({ health: { networkError: 'Failed to fetch' } }).state, 'unavailable')
  assert.equal(deriveBackendState({ health: { httpStatus: 404, body: {} } }).action, 'settings')
})

test('backend state: a board that answers with an error is running, not down', () => {
  const studioError = deriveBackendState({ health: { httpStatus: 500, body: { error: 'Internal error in GenAI Studio' } } })
  assert.equal(studioError.state, 'error')
  assert.match(studioError.title, /answered with an error \(HTTP 500\)/)
  assert.equal(studioError.detail, 'Internal error in GenAI Studio')
  const htmlPage = deriveBackendState({ health: { httpStatus: 200, body: {}, unreadable: true } })
  assert.equal(htmlPage.state, 'error')
  assert.equal(htmlPage.action, 'settings')
  const notStudio = deriveBackendState({ health: { httpStatus: 404, body: {}, unreadable: true } })
  assert.equal(notStudio.state, 'error')
  assert.match(notStudio.title, /doesn't answer like GenAI Studio/)
  assert.doesNotMatch(notStudio.detail, /<html>/)
  assert.equal(canUseModels('error'), false)
})

test('backend state: no board selected needs no extra button, the settings open on their own', () => {
  assert.equal(deriveBackendState({ health: { httpStatus: 503, body: { reason: 'not-configured' } } }).action, null)
  const badAddress = deriveBackendState({ health: { httpStatus: 503, body: { reason: 'invalid-address' } } })
  assert.equal(badAddress.state, 'unconfigured')
  assert.equal(badAddress.action, 'settings')
  const cfg = deriveBackendState({ health: { httpStatus: 500, body: { reason: 'cfg-unreadable', error: "Insight's settings file could not be read" } } })
  assert.equal(cfg.title, "Insight's settings file can't be used")
  assert.match(cfg.detail, /could not be read/)
})

function respondWith(status, body, contentType = 'text/plain') {
  globalThis.fetch = async () => new Response(body, { status, headers: { 'Content-Type': contentType } })
}

test('a download is finished only when the board says done', async () => {
  const realFetch = globalThis.fetch
  try {
    respondWith(200, '{"state":"downloading","pct":40}\n{"state":"done"}\n', 'application/x-ndjson')
    assert.equal((await downloadModel({ repoId: 'a/b', onProgress: () => {} })).state, 'done')
    respondWith(200, '{"state":"downloading","pct":40}\n', 'application/x-ndjson')
    await assert.rejects(downloadModel({ repoId: 'a/b', onProgress: () => {} }), /stopped before it finished/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a health answer that is not GenAI Studio JSON is flagged instead of shown raw', async () => {
  const realFetch = globalThis.fetch
  try {
    respondWith(404, '<html>Not Found</html>', 'text/html')
    assert.deepEqual(await probeHealth(), { httpStatus: 404, body: {}, unreadable: true })
    respondWith(500, JSON.stringify({ error: 'boom' }), 'application/json')
    assert.deepEqual(await probeHealth(), { httpStatus: 500, body: { error: 'boom' } })
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a chat reply that ends without the done marker is reported as cut off', async () => {
  const realFetch = globalThis.fetch
  const sse = (...events) => events.map((e) => `data: ${e}\n\n`).join('')
  const delta = (text) => JSON.stringify({ choices: [{ delta: { content: text } }] })
  try {
    let text = ''
    respondWith(200, sse(delta('Hel'), delta('lo'), JSON.stringify({ choices: [{ delta: {} }], generated_tokens: 2, tps: 9.5 }), '[DONE]'), 'text/event-stream')
    const { stats, rag } = await streamChat({ model: 'm', messages: [], onDelta: (d) => { text += d } })
    assert.equal(text, 'Hello')
    assert.deepEqual(stats, { tokens: 2, tps: 9.5 }, "the board's figures come back with the reply")
    assert.equal(rag, null, 'no documents asked for')

    text = ''
    respondWith(200, sse(delta('Partial ans')), 'text/event-stream')
    await assert.rejects(streamChat({ model: 'm', messages: [], onDelta: (d) => { text += d } }), { message: REPLY_CUT_OFF })
    assert.equal(text, 'Partial ans')
  } finally {
    globalThis.fetch = realFetch
  }
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
  assert.equal(loading.title, 'Loading Qwen3 1.7B')
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
  assert.equal(failed.action, null, 'Platform 3.0 has no accelerator reset to offer')
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
  const unreadable = deriveBackendState({ health: { httpStatus: 200, body: { ...HEALTH_OK, api_version: 'one' } } })
  assert.match(unreadable.detail, /can't read \("one"\)/)
  assert.doesNotMatch(unreadable.detail, /older/)
  const incompatible = deriveBackendState({ health: { httpStatus: 200, body: { ...HEALTH_OK, api_version: 2 } } })
  assert.equal(incompatible.state, 'incompatible')
  assert.match(incompatible.detail, /Update Insight/)
})

test('catalog helpers split chat and speech models', () => {
  assert.deepEqual(chatModels(STATUS).map((m) => m.name), ['Qwen3-VL-4B-Instruct-GPTQ-a16w4', 'Qwen3-0.6B-Autoround-a16w4'])
  assert.deepEqual(chatModels({ catalog: [{ name: 'untyped' }] }).map((m) => m.name), ['untyped'], "the board's default type is chat")
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
  assert.deepEqual(readAloudSupport('Hello there', VOICE_LANGUAGES, 'de'), { supported: true, language: 'en' })
  assert.deepEqual(readAloudSupport('Tokyo, Osaka', VOICE_LANGUAGES, 'de'), { supported: true, language: 'de' })
  assert.deepEqual(readAloudSupport('ఒక యువతి', null), { supported: true, language: 'te' })
  assert.deepEqual(languageNames(['zh', 'en', 'na']), ['Chinese', 'English'])
})

test('Latin-script replies are read in their own language when it is clear', () => {
  assert.equal(latinLanguage('Buenos días, ¿cómo estás?'), 'es')
  assert.equal(latinLanguage('Bonjour, comment allez-vous aujourd\'hui ?'), 'fr')
  assert.equal(latinLanguage('Guten Morgen, wie geht es dir heute?'), 'de')
  assert.equal(latinLanguage('Buongiorno, come stai?'), 'it')
  assert.equal(latinLanguage('Bom dia, tudo bem com você?'), 'pt')
  assert.equal(latinLanguage('The weather is lovely today, and the park is open.'), 'en')
  assert.equal(latinLanguage('Hello there'), 'en')
  assert.equal(latinLanguage('Tokyo'), null)                      // nothing to go on
  assert.equal(latinLanguage('Die Hard is great'), null)          // a tie is not a guess
  const withSpanish = ['de', 'en', 'es']
  assert.deepEqual(readAloudSupport('Buenos días, ¿cómo estás?', withSpanish, 'en'), { supported: true, language: 'es' })
  // No voice for the guessed language: the fallback, as before.
  assert.deepEqual(readAloudSupport('Buenos días, ¿cómo estás?', ['de', 'en'], 'en'), { supported: true, language: 'en' })
  assert.deepEqual(readAloudSupport('Tokyo', withSpanish, 'de'), { supported: true, language: 'de' })
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

test('the tutorial covers every feature, and says why Think first is greyed out for a model that cannot', () => {
  const ids = tutorialSteps().map((s) => s.id)
  assert.deepEqual(ids, ['intro', 'model', 'ask', 'picture', 'vision', 'talk', 'listen', 'languages', 'solutions', 'documents', 'benchmark', 'export', 'think', 'help'])
  const think = (options) => tutorialSteps(options).find((s) => s.id === 'think').body
  assert.match(think({ canThink: true }), /Turn on Think first/)
  assert.match(think({ canThink: false, thinkingModel: 'Qwen3 0.6B' }), /greyed out.*choose Qwen3 0\.6B/)
  assert.match(think({ canThink: false }), /download one that can reason/)
  assert.equal(thinkingModelOnBoard(STATUS), 'Qwen3 0.6B')
  assert.equal(thinkingModelOnBoard({ catalog: [STATUS.catalog[0]] }), null)
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
  const [missingFile] = voiceEngineWarnings(health([{ key: 'piper-plus', loaded: false, error: 'RuntimeError: model file missing' }]))
  assert.match(missingFile.message, /model file missing/)
  const [busy] = voiceEngineWarnings(health([{ key: 'supertonic', loaded: false, error: 'accelerator-unavailable' }]))
  assert.match(busy.message, /the accelerator was busy or unavailable/)
  const [failed] = voiceEngineWarnings(health([{ key: 'supertonic', loaded: false, error: 'load-failed' }]))
  assert.match(failed.message, /failed to load \(the details are in GenAI Studio's log/)
  assert.deepEqual(voiceEngineWarnings(health([{ key: 'piper-plus', loaded: false }])), [])
  assert.deepEqual(voiceEngineWarnings(null), [])
})

test('reply speed uses the board figures and leaves out what was not measured', () => {
  // The last chunk GenAI Studio sends on a DevKit.
  const last = '{"choices":[{"delta":{},"finish_reason":"stop","index":0}],"generated_tokens":8,"tps":23.405731473813503}'
  assert.deepEqual(chatStreamStats(last), { tokens: 8, tps: 23.405731473813503 })
  assert.deepEqual(chatStreamStats('{"usage":{"completion_tokens":40}}'), { tokens: 40, tps: null })
  assert.equal(chatStreamStats('{"choices":[{"delta":{"content":"hi"}}]}'), null)
  assert.equal(chatStreamStats('[DONE]'), null)

  const shown = (items) => Object.fromEntries(items.map((m) => [m.label, m.value]))
  assert.deepEqual(shown(replyMetrics({ t0: 0, tFirst: 412, tEnd: 2500, stats: { tokens: 8, tps: 23.4057 } })), {
    'First token': '412 ms', Speed: '23.4 tokens/s', Tokens: '8', Total: '2.50 s'
  })
  // Tokens without a rate: the rate is worked out from the writing time.
  assert.equal(shown(replyMetrics({ t0: 0, tFirst: 1000, tEnd: 3000, stats: { tokens: 40, tps: null } })).Speed, '20.0 tokens/s')
  // Nothing reported: no made-up speed or count.
  assert.deepEqual(Object.keys(shown(replyMetrics({ t0: 0, tFirst: 300, tEnd: 900, stats: null }))), ['First token', 'Total'])
  assert.deepEqual(replyMetrics({ t0: 0, tFirst: null, tEnd: 900 }), [], 'a reply with no text has no timings')
})

test('spoken and heard figures', () => {
  const shown = (items) => Object.fromEntries(items.map((m) => [m.label, m.value]))
  assert.deepEqual(shown(speechMetrics({ t0: 0, tAudio: 1930, rtf: '0.314', engine: 'Supertonic' })), {
    'First audio': '1.93 s', RTF: '0.31', Voice: 'Supertonic'
  })
  assert.deepEqual(Object.keys(shown(speechMetrics({ t0: 0, tAudio: 800, rtf: null }))), ['First audio'])
  assert.deepEqual(shown(heardMetrics({ ms: 640, language: 'English' })), { Transcribed: '640 ms', Language: 'English' })
  assert.equal(engineName('piper-tts'), 'Piper')
  assert.equal(engineName('new-engine'), 'new-engine')
})

test('a reply is cut into sentences to speak while it streams', () => {
  const reply = 'An AI accelerator is a chip built for neural networks. It runs them much faster than a CPU!\n\n' +
    '1. Fast\n2. Efficient at matrix maths\n\n```python\nprint("not spoken")\n```\nThat is all.'
  // Fed a few characters at a time, as the stream arrives.
  const splitter = createSentenceSplitter()
  const streamed = []
  for (let i = 1; i <= reply.length; i += 3) streamed.push(...splitter.push(reply.slice(0, i)))
  streamed.push(...splitter.push(reply, true))
  assert.deepEqual(streamed, [
    'An AI accelerator is a chip built for neural networks.',
    'It runs them much faster than a CPU!',
    '1. Fast 2. Efficient at matrix maths',
    'That is all.'
  ])
  assert.deepEqual(speakablePieces(reply), streamed, 'Read aloud on a finished reply cuts it the same way')
})

test('sentence pieces: the first one is ready before the reply ends, and short or unfinished text waits', () => {
  const splitter = createSentenceSplitter()
  assert.deepEqual(splitter.push('Hello there, this is the first sentence. And the sec'), ['Hello there, this is the first sentence.'])
  assert.deepEqual(splitter.push('Hello there, this is the first sentence. And the sec'), [], 'nothing is spoken twice')
  assert.deepEqual(splitter.push('Hello there, this is the first sentence. And the second one', true), ['And the second one'])
  assert.deepEqual(speakablePieces('Yes. Of course I can help with that.'), ['Yes. Of course I can help with that.'])
  assert.deepEqual(speakablePieces('Ok.'), ['Ok.'], 'a short reply is still spoken')
  assert.deepEqual(speakablePieces('こんにちは。元気ですか？はい。'), ['こんにちは。元気ですか？はい。'])
  assert.deepEqual(speakablePieces('Run this:\n```\nls -la\n'), ['Run this:'], 'an unfinished code block is not read')
  assert.deepEqual(speakablePieces('Great job 👍 on the demo today!'), ['Great job on the demo today!'])
})

test("export chat writes the standalone Studio's .log format", () => {
  const now = new Date(2026, 9, 5, 14, 3, 9)
  const log = chatLog({
    now,
    model: 'Qwen3-VL-4B-Instruct-GPTQ-a16w4',
    messages: [
      { role: 'user', text: 'What is in this picture?', image: 'data:image/jpeg;base64,xx' },
      { role: 'assistant', content: '<think>looking</think>A red bicycle.' },
      { role: 'user', text: 'hello' },
      { role: 'assistant', content: '', error: 'Model server crashed while answering' },
      { role: 'assistant', content: '', pending: true }
    ]
  })
  const lines = log.split('\n')
  assert.equal(lines[0], 'Neat GenAI Studio — chat export')
  assert.match(lines[1], /^Exported: /)
  assert.equal(lines[2], 'Model: Qwen3-VL-4B-Instruct-GPTQ-a16w4')
  assert.equal(lines[3], '='.repeat(60))
  assert.deepEqual(lines.slice(5), [
    'You:', '[image]', 'What is in this picture?', '',
    'Assistant:', 'A red bicycle.', '',
    'You:', 'hello', '',
    'Assistant:', '[Model server crashed while answering]', ''
  ], 'the reasoning is left out and an empty reply in progress is skipped')
  assert.equal(chatLog({ messages: [] }), null)
  assert.equal(chatLogFilename(now), 'neat-chat-20261005-140309.log')
})

test('SiMaSentry apps open on the loaded model through the relay', () => {
  assert.deepEqual(SOLUTIONS.map((s) => s.name), ['SiMaSentry-Med', 'SiMaSentry-Safe', 'SiMaSentry-Sec'])
  const url = new URL(solutionUrl('health', 'Qwen3-VL-4B-Instruct-GPTQ-a16w4'), 'http://insight')
  assert.equal(url.pathname, '/genai-solutions/health/index.html')
  assert.equal(url.searchParams.get('base_url'), '/api/genai/v1/chat/completions')
  assert.equal(url.searchParams.get('provider'), 'ollama')
  assert.equal(url.searchParams.get('model'), 'Qwen3-VL-4B-Instruct-GPTQ-a16w4')
  assert.equal(new URL(solutionUrl('safety', null), 'http://insight').searchParams.has('model'), false)
})

// The SiMaSentry apps are plain scripts, each with its own copy of the check;
// this runs each shipped copy against the same cases.
function solutionsBaseUrlCheck(mode, origin) {
  const source = readFileSync(new URL(`../../public/genai-solutions/${mode}/app.js`, import.meta.url), 'utf8')
  const relay = source.match(/const RELAY_BASE_URL = ["'][^"']+["'];/)
  const check = source.match(/function safeBaseUrl\(value\) \{[\s\S]*?\n {0,2}\}\n/)
  assert.ok(relay && check, `${mode}/app.js has no safeBaseUrl`)
  return new Function('window', `${relay[0]}\n${check[0]}\nreturn safeBaseUrl`)({ location: { origin } })
}

for (const mode of ['health', 'safety', 'security']) {
  test(`the ${mode} app talks only to Insight's relay, whatever base_url a link or storage holds`, () => {
    const safe = solutionsBaseUrlCheck(mode, 'https://insight.local:8443')
    const relay = '/api/genai/v1/chat/completions'
    assert.equal(safe(relay), relay)
    assert.equal(safe('https://insight.local:8443/api/genai/v1/chat/completions'), relay)
    assert.equal(safe('  /api/genai/v1/chat/completions  '), relay)
    for (const bad of [
      'https://evil.example/api/genai/v1/chat/completions',
      'http://insight.local:8443/api/genai/v1/chat/completions',
      '//evil.example/api/genai/v1/chat/completions',
      'http://localhost:11434/v1/chat/completions',
      '/api/other/v1/chat/completions',
      '/api/genai',
      'javascript:alert(1)',
      '',
      null,
      undefined
    ]) {
      assert.equal(safe(bad), relay, String(bad))
    }
  })
}

// --- one rule table and one board session --------------------------------------

const READY = { usable: true, hasChatModel: true, sees: true, hasAsr: true, hasMessages: true, hasDraft: true }

test('nothing changes models, clears the chat or switches boards while speech input runs', () => {
  for (const busy of [{ recording: true }, { micOpening: true }, { transcribing: true }]) {
    const a = allowedActions({ ...READY, ...busy })
    assert.equal(a.listening, true)
    for (const action of ['send', 'newChat', 'changeChatModel', 'changeSpeechModel', 'changeBoard', 'startRecording']) {
      assert.equal(a[action], false, `${action} while ${Object.keys(busy)[0]}`)
    }
  }
  assert.equal(allowedActions({ ...READY, recording: true }).stopRecording, true)
})

test('a reply in progress blocks model and board changes but not a spoken question', () => {
  const a = allowedActions({ ...READY, replying: true })
  assert.deepEqual([a.send, a.changeChatModel, a.changeSpeechModel, a.changeBoard], [false, false, false, false])
  assert.deepEqual([a.stopReply, a.startRecording, a.newChat, a.typeMessage], [true, true, true, true])
})

test('a model operation or a download holds what depends on it', () => {
  const op = allowedActions({ ...READY, modelOp: true })
  for (const action of ['send', 'typeMessage', 'startRecording', 'readAloud', 'changeChatModel', 'changeSpeechModel', 'changeBoard']) {
    assert.equal(op[action], false, `${action} during a model operation`)
  }
  const dl = allowedActions({ ...READY, downloading: true })
  assert.deepEqual([dl.changeBoard, dl.searchModels, dl.downloadModel], [false, false, false])
  assert.equal(dl.send, true)
})

test('capabilities gate their controls when idle', () => {
  assert.equal(allowedActions(READY).changeBoard, true)
  assert.equal(allowedActions({ ...READY, sees: false }).attachPicture, false)
  assert.equal(allowedActions({ ...READY, cameraOpen: true }).openCamera, false)
  assert.equal(allowedActions({ ...READY, hasAsr: false }).startRecording, false)
  assert.equal(allowedActions({ ...READY, hasDraft: false }).send, false)
  assert.equal(allowedActions({ ...READY, hasChatModel: false }).typeMessage, false)
  assert.equal(allowedActions({ ...READY, usable: false }).readAloud, false)
})

test('a new board ends the previous session: its requests abort and its results are stale', () => {
  const session = createBoardSession()
  const own = new AbortController()
  const before = session.ticket(own.signal)
  const plain = session.ticket()
  session.restart()
  assert.equal(before.signal.aborted, true)
  assert.equal(plain.live(), false)
  const after = session.ticket()
  assert.equal(after.live(), true)
  assert.equal(after.signal.aborted, false)
  session.close()
  assert.equal(after.live(), false)
})

test('an operation can still stop itself within a live session', () => {
  const session = createBoardSession()
  const own = new AbortController()
  const t = session.ticket(own.signal)
  own.abort()
  assert.equal(t.signal.aborted, true)
  assert.equal(t.live(), true)
  const merged = anySignal([new AbortController().signal, AbortSignal.abort()])
  assert.equal(merged.aborted, true)
})

test('a tab that is gone gets tickets that are already over', () => {
  const t = closedTicket()
  assert.equal(t.signal.aborted, true)
  assert.equal(t.live(), false)
})

test('an open camera preview holds model changes', () => {
  const a = allowedActions({ ...READY, cameraOpen: true })
  assert.deepEqual([a.changeChatModel, a.changeSpeechModel], [false, false])
})

// A summary as GenAI Studio's model manager returns it (_benchmark_summary).
const stats = (mean, extra = {}) => ({ mean, median: mean, min: mean - 1, max: mean + 1, stdev: 0.5, cv: 1, p90: mean + 0.5, p95: mean + 0.8, ...extra })
const summary = (tps, ttft, tokens = 128) => ({ count: 5, errors: 0, ttftMs: stats(ttft), tps: stats(tps), tokens: stats(tokens), totalTokens: tokens * 5 })

test('benchmark settings are clamped to what the board accepts', () => {
  assert.equal(clampSetting('0', BENCH_LIMITS.runs), 1)
  assert.equal(clampSetting('500', BENCH_LIMITS.runs), 50)
  assert.equal(clampSetting('', BENCH_LIMITS.runs), 5)
  assert.equal(clampSetting('4096', BENCH_LIMITS.maxTokens), 2048)
  assert.deepEqual(benchmarkRequest({ model: 'Qwen3-0.6B-Autoround-a16w4', runs: '3', maxTokens: 'x', prompt: '  hi  ' }), {
    model: 'Qwen3-0.6B-Autoround-a16w4', num_samples: 3, max_new_tokens: 128, prompt: 'hi'
  })
})

test('benchmark progress and the comparison mark the fastest model', () => {
  assert.equal(benchProgress({ running: true, done: 1, total: 5, current: { tokens: 40, tps: 22.84 } }).text, 'Run 2 of 5 · 40 tokens · 22.8 tokens/s')
  assert.equal(benchProgress({ running: true, done: 1, total: 5 }).pct, 20)
  assert.equal(benchProgress({ running: false, done: 5, total: 5 }).text, '5 of 5 runs done')
  const rows = comparisonRows([
    { model: 'Qwen3-VL-4B-Instruct-GPTQ-a16w4', summary: summary(22.8, 250) },
    { model: 'Qwen3-0.6B-Autoround-a16w4', summary: summary(95.4, 38) },
    { model: 'Broken', failed: 'failed to load: out of memory' }
  ])
  assert.deepEqual(rows.map((r) => [r.bestTps, r.bestTtft]), [[false, false], [true, true], [undefined, undefined]])
  assert.equal(rows[2].failed, 'failed to load: out of memory')
})

test('benchmark exports match the standalone Studio', () => {
  const entries = [
    { model: 'Qwen3-0.6B-Autoround-a16w4', summary: summary(95.4, 38), runs: [{ ttftMs: 38, tps: 95.4, tokens: 128 }] },
    { model: 'Broken, "quoted"', failed: 'failed to load', stage: 'load' }
  ]
  const csv = benchmarkCsv(entries).split('\n')
  assert.equal(csv[0], 'model,tpsMean,tpsMedian,tpsMin,tpsMax,tpsP90,tpsStdev,ttftMeanMs,ttftP90Ms,tokensMean,validRuns,errors')
  assert.equal(csv[1], 'Qwen3-0.6B-Autoround-a16w4,95.4,95.4,94.4,96.4,95.9,0.5,38,38.5,128,5,0')
  assert.equal(csv.length, 2, 'a model without a result has no CSV line')
  const json = JSON.parse(benchmarkJson(entries, { runs: '5', maxTokens: '128', prompt: '' }, new Date('2026-10-05T12:00:00Z')))
  assert.deepEqual(json.config, { runs: 5, maxNewTokens: 128, prompt: '(default)' })
  assert.equal(json.results[1].loadFailed, true)
  assert.equal(benchmarkCsv([{ model: 'x', failed: 'no' }]), null)
  assert.equal(benchmarkFilename('csv', new Date(2026, 9, 5, 9, 5, 7)), 'neat-benchmark-20261005-090507.csv')
})

test('documents: what the board offers, and the note under a reply', () => {
  const health = (features) => ({ httpStatus: 200, body: { ...HEALTH_OK, ...(features ? { features } : {}) } })
  assert.equal(documentsSupport(health({ rag: true, benchmark: true })).available, true)
  assert.match(documentsSupport(health({ rag: false })).reason, /app\.rag\.enabled/)
  assert.match(documentsSupport(health(null)).reason, /Update Apps/, 'GenAI Studio from before features existed')
  assert.match(documentsSupport(null).reason, /Connect to a board/, 'before the board answers')
  assert.match(documentsSupport({ httpStatus: 503, body: { reason: 'not-configured' } }).reason, /Connect to a board/, 'no board configured')
  // X-RAG-Sources as the board sends it (non-ASCII escaped).
  const sources = parseSources('[{"source":"","heading":"Lab handbook \\u203a DevKit lab hours","score":0.9677},{"source":"","heading":"Lab handbook \\u203a DevKit lab hours","score":0.8}]')
  assert.equal(sources[0].heading, 'Lab handbook › DevKit lab hours')
  assert.equal(sourcesNote({ hits: 2, sources }), 'From your documents: Lab handbook › DevKit lab hours')
  assert.match(sourcesNote({ hits: 0, sources: [] }), /nothing matched/)
  assert.deepEqual(parseSources('not json'), [])
})

test('documents: the database in words, and upload progress', () => {
  assert.equal(documentsSummary({ enabled: true, database: true, service: 'ok', meta: { chunks: 8, input: '/x/src/common/rag/neat.md' } }), '8 sections from neat.md')
  assert.match(documentsSummary({ enabled: true, database: true, service: 'starting', meta: { chunks: 1, input: 'a.md' } }), /1 section from a\.md \(the search service is starting\)/)
  assert.match(documentsSummary({ enabled: true, database: false, service: 'no-database' }), /No documents yet/)
  assert.deepEqual(progressOutcome('⏳ Starting...\n📚 Creating VectorDB from Markdown...\n✅ Markdown RAG database is ready.\n'), {
    done: true, ok: true, message: 'Markdown RAG database is ready.', lines: ['Starting...', 'Creating VectorDB from Markdown...', 'Markdown RAG database is ready.']
  })
  assert.equal(progressOutcome('📚 Creating...\n❌ RAG document upload failed.\n').ok, false)
  assert.equal(progressOutcome('⏳ Starting...\n').done, false)
})

test('a benchmark or a document task holds what would disturb it', () => {
  const bench = allowedActions({ ...READY, benchmarking: true })
  for (const action of ['send', 'changeChatModel', 'changeBoard', 'documentTasks', 'openBenchmark']) {
    assert.equal(bench[action], false, `${action} while benchmarking`)
  }
  const docs = allowedActions({ ...READY, documentTask: true })
  assert.deepEqual([docs.changeBoard, docs.documentTasks, docs.openBenchmark], [false, false, false])
  assert.equal(docs.send, true)
  assert.equal(allowedActions({ ...READY, benchmarkAvailable: true }).openBenchmark, true)
})

test('board errors read in both shapes GenAI Studio uses', () => {
  assert.equal(errorMessage({ error: 'RAG is disabled' }, 409), 'RAG is disabled')
  assert.equal(errorMessage({ error: { message: 'messages must be a non-empty list', param: 'messages' } }, 400), 'messages must be a non-empty list')
  assert.equal(errorMessage({}, 502), 'HTTP 502')
  assert.equal(errorMessage({ error: { code: 'x' } }, 500), 'HTTP 500')
})

test('a search service that stopped is named, not shown as starting', () => {
  const failed = documentsSummary({ enabled: true, database: true, service: 'failed', meta: { input: 'neat.md', chunks: 8 } })
  assert.match(failed, /stopped/)
  assert.doesNotMatch(failed, /starting/)
})

test('questions with documents wait while the documents are rebuilt', () => {
  const rebuilding = { ...READY, documentTask: true, documentsAvailable: true }
  assert.equal(allowedActions({ ...rebuilding, useDocuments: true }).send, false)
  assert.equal(allowedActions({ ...rebuilding, useDocuments: false }).send, true)
  assert.equal(allowedActions({ ...READY, cameraOpen: true, benchmarkAvailable: true }).openBenchmark, false)
  assert.equal(allowedActions({ ...READY, documentsAvailable: false }).toggleDocuments, false)
})

test('a sources note always says something', () => {
  assert.equal(sourcesNote({ hits: 2, sources: [] }), 'Answered from 2 passages of your documents.')
})

test('the documents are not rebuilt under a reply that uses them', () => {
  assert.equal(allowedActions({ ...READY, replying: true, useDocuments: true }).documentTasks, false)
  assert.equal(allowedActions({ ...READY, replying: true, useDocuments: false }).documentTasks, true)
})

test('the documents choice and their rebuilds wait for replies and speech input', () => {
  assert.equal(allowedActions({ ...READY, documentsAvailable: true, replying: true }).toggleDocuments, false)
  assert.equal(allowedActions({ ...READY, recording: true }).documentTasks, false)
  assert.equal(allowedActions({ ...READY, transcribing: true }).documentTasks, false)
})

test('the benchmark JSON says which step failed and why', () => {
  const ok = { model: 'a', summary: { count: 1 }, runs: [] }
  const json = JSON.parse(benchmarkJson([ok, { model: 'b', failed: 'board error', stage: 'run' }, { model: 'c', failed: 'failed to load: x', stage: 'load' }], { runs: 1, maxTokens: 8, prompt: '' }))
  assert.deepEqual(json.results.map((r) => [r.model, r.loadFailed, r.error]), [['a', false, null], ['b', false, 'board error'], ['c', true, 'failed to load: x']])
})

test('the benchmark is offered only by a board that says so', () => {
  const health = (features) => ({ httpStatus: 200, body: { ...HEALTH_OK, features } })
  assert.equal(benchmarkSupport(health({ benchmark: true, rag: true })).available, true)
  assert.equal(benchmarkSupport(health({ benchmark: false })).available, false)
  assert.equal(benchmarkSupport(health(undefined)).available, false)
  assert.equal(allowedActions({ ...READY, benchmarkAvailable: false }).openBenchmark, false)
  assert.equal(allowedActions({ ...READY, benchmarkAvailable: true }).openBenchmark, true)
})

test('switching boards ends the conversation and drops an attached picture', () => {
  // The next message rebuilds its history from the conversation, so anything
  // left would be sent to the newly selected board.
  const view = readFileSync(new URL('../GenAIView.jsx', import.meta.url), 'utf8')
  const body = (name) => {
    const start = view.indexOf(`function ${name}() {`)
    assert.ok(start >= 0, name)
    return view.slice(start, view.indexOf('\n  }\n', start))
  }
  const forget = body('forgetBoard')
  assert.match(forget, /resetConversation\(\)/)
  assert.match(forget, /setImage\(null\)/)
  const reset = body('resetConversation')
  for (const step of ['chatAbort.current?.abort()', 'stopSpeaking()', 'setMessages([])']) assert.ok(reset.includes(step), step)
  assert.match(body('newChat'), /resetConversation\(\)/)
  // Saving the same address is not a switch: the conversation stays.
  const apply = view.slice(view.indexOf('async function applySettings('), view.indexOf('\n  }\n', view.indexOf('async function applySettings(')))
  assert.match(apply, /if \(saved\?\.url !== before\) forgetBoard\(\)/)
  // A picture still being resized when the board changes is dropped, not attached afterwards.
  assert.match(forget, /boardGeneration\.current \+= 1/)
  const attach = view.slice(view.indexOf('async function attachImage('), view.indexOf('\n  }\n', view.indexOf('async function attachImage(')))
  assert.match(attach, /if \(board === boardGeneration\.current\) setImage\(picture\)/)
})

// --- board camera, vision view, reply settings, model delete, documents viewer --

test('the board camera is offered only by a board that says so, with the reason otherwise', () => {
  const health = (features) => ({ httpStatus: 200, body: { ...HEALTH_OK, features } })
  assert.deepEqual(boardCameraSupport(health({ rag: true, benchmark: true, board_camera: true })), { available: true, reason: '' })
  // The DevKit's current build: features without board_camera.
  assert.match(boardCameraSupport(health({ rag: true, benchmark: true })).reason, /Update Apps on the board/)
  assert.equal(boardCameraSupport(health({ board_camera: false })).available, false)
  assert.equal(boardCameraSupport(health(undefined)).available, false)
  assert.match(boardCameraSupport(null).reason, /Connect to a board/)
  assert.equal(boardCameraSupport({ httpStatus: 502, body: {} }).available, false)
})

test("the board's camera list keeps only devices a snapshot accepts, and the default when it exists", () => {
  // Shapes from a Modalix DevKit: ISP nodes such as /dev/video15m2m are listed
  // too, but /board-camera/snapshot only accepts /dev/videoN.
  const body = {
    default: '/dev/video16',
    devices: [
      { device: '/dev/video15m2m', name: '' },
      { device: '/dev/video4', name: 'modalix-isp-stats-ctx0' },
      { device: '/dev/video16', name: '' },
      { device: '/dev/video16', name: 'duplicate' },
      { device: '../etc/passwd', name: 'x' },
      null,
      { device: '/dev/video2', label: 'USB Camera' }
    ]
  }
  const cameras = parseCameraDevices(body)
  assert.deepEqual(cameras, {
    default: '/dev/video16',
    devices: [
      { device: '/dev/video4', label: 'modalix-isp-stats-ctx0 (/dev/video4)' },
      { device: '/dev/video16', label: '/dev/video16' },
      { device: '/dev/video2', label: 'USB Camera (/dev/video2)' }
    ]
  })
  assert.equal(pickCamera(cameras, '/dev/video2'), '/dev/video2', 'the choice made before stays')
  assert.equal(pickCamera(cameras, '/dev/video9'), '/dev/video16', "else the board's default")
  assert.equal(pickCamera({ ...cameras, default: '/dev/video30' }, ''), '/dev/video4', 'else the first')
  assert.equal(pickCamera(parseCameraDevices({ devices: [] }), ''), null)
  assert.deepEqual(parseCameraDevices(null), { devices: [], default: null })
  assert.equal(parseCameraDevices({ devices: [], default: 'video0' }).default, null)
})

test('a board camera snapshot is the JPEG, and a refusal reads as what to do', async () => {
  assert.equal(snapshotPath('/dev/video16'), 'board-camera/snapshot?device=%2Fdev%2Fvideo16')
  assert.equal(snapshotPath(''), 'board-camera/snapshot')
  const realFetch = globalThis.fetch
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9])
  try {
    let asked = null
    globalThis.fetch = async (url, init) => {
      asked = { url, init }
      return new Response(jpeg, { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
    }
    const picture = await boardCameraSnapshot('/dev/video16')
    assert.equal(asked.url, '/api/genai/board-camera/snapshot?device=%2Fdev%2Fvideo16')
    assert.equal(asked.init.cache, 'no-store', 'never an earlier picture from the cache')
    assert.equal(picture.type, 'image/jpeg')
    assert.deepEqual(new Uint8Array(await picture.arrayBuffer()), jpeg, 'the bytes arrive unchanged')

    respondWith(503, JSON.stringify({ error: 'Board camera capture failed' }), 'application/json')
    const failed = await boardCameraSnapshot('/dev/video16').catch((e) => e)
    assert.equal(failed.status, 503)
    assert.equal(failed.message, 'Board camera capture failed')
    assert.match(snapshotErrorMessage(failed, '/dev/video16'), /couldn't take a picture with \/dev\/video16\. Check that the camera is plugged in/)

    respondWith(400, JSON.stringify({ error: 'Invalid board camera device' }), 'application/json')
    assert.match(snapshotErrorMessage(await boardCameraSnapshot('/dev/video1').catch((e) => e), '/dev/video1'), /doesn't accept \/dev\/video1/)

    respondWith(200, '<html>login</html>', 'text/html')
    await assert.rejects(boardCameraSnapshot('/dev/video16'), /instead of a picture/)
    respondWith(200, '', 'image/jpeg')
    await assert.rejects(boardCameraSnapshot('/dev/video16'), /empty picture/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('board camera and vision rules: one picture and one question at a time', () => {
  const cam = { ...READY, boardCameraAvailable: true }
  assert.equal(allowedActions(READY).openBoardCamera, false, 'not without the feature')
  assert.equal(allowedActions(cam).openBoardCamera, true)
  assert.equal(allowedActions({ ...cam, sees: false }).openBoardCamera, false)
  assert.equal(allowedActions({ ...cam, cameraOpen: true }).openBoardCamera, false, "one camera panel at a time")
  assert.equal(allowedActions({ ...cam, boardSnapshot: true }).takeBoardSnapshot, false, 'the device takes one capture at a time')
  assert.equal(allowedActions({ ...cam, visionLoop: true }).takeBoardSnapshot, false)
  assert.equal(allowedActions({ ...READY, visionOpen: true }).openCamera, false)

  const idle = allowedActions({ ...READY, visionOpen: true })
  assert.deepEqual([idle.askVision, idle.startVisionLoop, idle.stopVision, idle.chooseVisionSource], [true, true, false, true])
  for (const busy of [{ replying: true }, { recording: true }, { transcribing: true }, { visionAsking: true }, { visionLoop: true }, { boardSnapshot: true }]) {
    const a = allowedActions({ ...READY, visionOpen: true, ...busy })
    assert.equal(a.askVision, false, `ask while ${Object.keys(busy)[0]}`)
    assert.equal(a.startVisionLoop, false, `loop while ${Object.keys(busy)[0]}`)
  }
  const looping = allowedActions({ ...READY, visionOpen: true, visionLoop: true })
  assert.equal(looping.stopVision, true)
  assert.equal(looping.chooseVisionSource, false, 'the source stays while the loop runs')
  assert.equal(looping.continueVisionLoop, true)
  assert.equal(looping.changeReplySettings, false)
  assert.equal(allowedActions({ ...READY, visionAsking: true }).stopVision, true, 'Stop also ends a single question')
  // What ends a running loop at its next picture.
  for (const gone of [{ modelOp: true }, { benchmarking: true }, { usable: false }, { sees: false }, { hasChatModel: false }]) {
    assert.equal(allowedActions({ ...READY, visionLoop: true, ...gone }).continueVisionLoop, false, Object.keys(gone)[0])
  }
  assert.equal(allowedActions({ ...READY, sees: false }).openVision, false)
})

test('a vision question holds what would disturb it: the chat, models and the board', () => {
  for (const busy of [{ visionAsking: true }, { visionLoop: true }]) {
    const a = allowedActions({ ...READY, visionOpen: true, ...busy })
    for (const action of ['send', 'changeChatModel', 'changeSpeechModel', 'deleteModel', 'openBenchmark', 'changeBoard']) {
      assert.equal(a[action], false, `${action} while ${Object.keys(busy)[0]}`)
    }
  }
  // An open view is about to give the model a picture, as an open camera is.
  const open = allowedActions({ ...READY, visionOpen: true, benchmarkAvailable: true })
  assert.deepEqual([open.changeChatModel, open.deleteModel, open.openBenchmark], [false, false, false])
  assert.equal(open.changeBoard, true)
})

test('model delete, document viewing and reply settings have their own rules', () => {
  assert.equal(allowedActions(READY).deleteModel, true)
  for (const busy of [{ modelOp: true }, { downloading: true }, { replying: true }, { recording: true }, { benchmarking: true }, { cameraOpen: true }]) {
    assert.equal(allowedActions({ ...READY, ...busy }).deleteModel, false, Object.keys(busy)[0])
  }
  assert.equal(allowedActions({ ...READY, documentsAvailable: true }).inspectDocuments, true)
  assert.equal(allowedActions({ ...READY, documentsAvailable: true, documentTask: true }).inspectDocuments, false, 'not half-rebuilt')
  assert.equal(allowedActions({ ...READY, documentsAvailable: false }).inspectDocuments, false)
  assert.equal(allowedActions({ ...READY, replying: true }).changeReplySettings, true, 'a reply keeps the settings it was sent with')
})

test('only a model that is not in use can be deleted', () => {
  const [vlm, small, whisper, gte] = STATUS.catalog
  assert.equal(deletableModel(vlm, STATUS), false, 'loaded')
  assert.equal(deletableModel(small, STATUS), true)
  assert.equal(deletableModel(whisper, STATUS), false, 'the speech model in use')
  assert.equal(deletableModel(gte, STATUS), true)
  assert.equal(deletableModel(small, { ...STATUS, loading: { name: small.name } }), false, 'being loaded')
  assert.equal(deletableModel({ name: 'other-asr', type: 'asr' }, { ...STATUS, asrModel: 'other-asr' }), false)
  assert.equal(deletableModel(null, STATUS), false)
})

test('the vision loop asks one question at a time, pauses between answers, and reads the prompt each turn', async () => {
  const events = []
  let inFlight = 0
  let most = 0
  let question = 'What do you see?'
  let stopReason
  let stopped
  const done = new Promise((resolve) => { stopped = resolve })
  const loop = createVisionLoop({
    capture: async () => {
      events.push(`capture ${loop.turns + 1}`)
      return `frame ${loop.turns + 1}`
    },
    ask: async ({ picture, prompt, turn }) => {
      inFlight += 1
      most = Math.max(most, inFlight)
      events.push(`ask ${turn}: ${picture} / ${prompt}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      if (turn === 1) question = 'Read any text in view'
      if (turn === 3) loop.stop()
    },
    prompt: () => question,
    wait: async (ms) => { events.push(`pause ${ms}`) },
    onStop: (reason) => { stopReason = reason; stopped() }
  })
  loop.start()
  // Wait for the loop to end (a slow CI machine must not cut it short).
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5000))])
  assert.equal(most, 1, 'never two questions at once')
  assert.deepEqual(events, [
    'capture 1', 'ask 1: frame 1 / What do you see?', `pause ${LOOP_PAUSE_MS}`,
    'capture 2', 'ask 2: frame 2 / Read any text in view', `pause ${LOOP_PAUSE_MS}`,
    'capture 3', 'ask 3: frame 3 / Read any text in view'
  ])
  assert.equal(loop.running, false)
  assert.equal(stopReason, null, 'stopped by the user: nothing to report')
  assert.equal(loop.signal.aborted, true)
  assert.deepEqual(VISION_PRESETS, ['What do you see?', 'Describe the scene in detail', 'Read any text in view'])
})

test('the vision loop stops on a failed picture or answer, a block, or a request ended from outside', async () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
  const run = (options) => {
    const result = { reason: undefined, asked: 0, captured: 0 }
    const loop = createVisionLoop({
      capture: async () => { result.captured += 1; return 'frame' },
      ask: async () => { result.asked += 1 },
      prompt: () => 'q',
      wait: async () => {},
      onStop: (reason) => { result.reason = reason },
      ...options(result)
    })
    result.loop = loop.start()
    return result
  }
  const camera = run(() => ({ capture: async () => { throw new Error('The board couldn\'t take a picture.') } }))
  await settle()
  assert.equal(camera.reason, "The board couldn't take a picture.")
  assert.equal(camera.asked, 0)

  const answer = run((r) => ({ ask: async () => { r.asked += 1; throw new Error("The model didn't answer: boom") } }))
  await settle()
  assert.equal(answer.reason, "The model didn't answer: boom")
  assert.equal(answer.asked, 1, 'no second question after a failure')

  let allowed = true
  const blocked = run((r) => ({
    blocked: () => (allowed ? null : 'A model is loading.'),
    ask: async () => { r.asked += 1; allowed = false }
  }))
  await settle()
  assert.equal(blocked.reason, 'A model is loading.')
  assert.deepEqual([blocked.captured, blocked.asked], [1, 1], 'checked before the next picture is taken')

  // The board session ended the request (a board switch): stop without an error.
  const board = run((r) => ({ ask: async () => { r.asked += 1; throw new DOMException('aborted', 'AbortError') } }))
  await settle()
  assert.equal(board.reason, null)
  assert.equal(board.loop.running, false)
})

test('stopping the vision loop ends the question in flight and its pause', async () => {
  let askSignal = null
  let stops = 0
  const loop = createVisionLoop({
    capture: async () => 'frame',
    ask: ({ signal }) => new Promise((resolve, reject) => {
      askSignal = signal
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }),
    prompt: () => 'q',
    onStop: () => { stops += 1 }
  }).start()
  await new Promise((resolve) => setTimeout(resolve, 5))
  loop.stop('closed')
  loop.stop('twice')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(askSignal.aborted, true)
  assert.equal(stops, 1, 'reported once')

  const controller = new AbortController()
  const started = Date.now()
  const waiting = pause(10_000, controller.signal)
  controller.abort()
  await waiting
  assert.ok(Date.now() - started < 1000, 'a pause ends with the loop')
  await pause(10_000, AbortSignal.abort())
})

test('reply settings: the default prompt, a custom one with the picture note, and the reply length', () => {
  // The tab's prompts before they could be changed, word for word.
  const base = 'Answer clearly and concisely. Use Markdown formatting when it helps. Answer the question in the language it was asked in.'
  assert.equal(DEFAULT_SYSTEM_PROMPT, base)
  assert.equal(systemPromptFor({ picture: 'current' }), `${base} The user's current message includes an image. Answer using what you see in it.`)
  assert.equal(systemPromptFor({ picture: 'earlier' }), `${base} An earlier message in this conversation includes an image. Answer questions about it using what you see in it.`)
  assert.match(systemPromptFor({ custom: '   ' }), /^Answer clearly.*No image is attached.*Never describe an image you were not given\.$/)
  const pirate = systemPromptFor({ custom: '  Answer like a pirate.  ', picture: 'current' })
  assert.equal(pirate, "Answer like a pirate. The user's current message includes an image. Answer using what you see in it.")
  assert.doesNotMatch(systemPromptFor({ custom: 'Be brief.' }), /Answer clearly/, 'the custom prompt replaces the default text')

  assert.deepEqual([MAX_TOKENS_LIMITS.min, MAX_TOKENS_LIMITS.max, MAX_TOKENS_LIMITS.default], [32, 2048, 512])
  assert.equal(clampMaxTokens('8'), 32)
  assert.equal(clampMaxTokens(99999), 2048)
  assert.equal(clampMaxTokens('300'), 288, 'on the slider steps')
  assert.equal(clampMaxTokens('lots'), 512)
})

test('reply settings are remembered per browser, and storage that refuses gives the defaults', () => {
  const store = new Map()
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  }
  assert.deepEqual(loadReplySettings(storage), { systemPrompt: '', maxTokens: 512 })
  saveReplySettings(storage, { systemPrompt: 'Answer like a pirate.' })
  saveReplySettings(storage, { maxTokens: 1024 })
  assert.deepEqual(loadReplySettings(storage), { systemPrompt: 'Answer like a pirate.', maxTokens: 1024 })
  // Back to the defaults: nothing stays stored, so a new default reaches this browser.
  saveReplySettings(storage, { systemPrompt: '  ', maxTokens: 512 })
  assert.equal(store.has(SYSTEM_PROMPT_KEY), false)
  assert.equal(store.has(MAX_TOKENS_KEY), false)
  store.set(MAX_TOKENS_KEY, '100000')
  assert.equal(loadReplySettings(storage).maxTokens, 2048, 'a hand-edited value is clamped')

  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
  assert.deepEqual(loadReplySettings(broken), { systemPrompt: '', maxTokens: 512 })
  assert.doesNotThrow(() => saveReplySettings(broken, { systemPrompt: 'x', maxTokens: 64 }))
  assert.deepEqual(loadReplySettings(null), { systemPrompt: '', maxTokens: 512 }, 'window.localStorage itself refused')
  assert.doesNotThrow(() => saveReplySettings(null, { maxTokens: 64 }))
})

test('chat requests carry max_tokens and the system prompt; the documents only when asked', async () => {
  const messages = [{ role: 'system', content: systemPromptFor({ custom: 'Be brief.' }) }, { role: 'user', content: 'hi' }]
  assert.deepEqual(chatRequestBody({ model: 'm', messages, maxTokens: 256 }), { model: 'm', messages, stream: true, max_tokens: 256 })
  assert.deepEqual(chatRequestBody({ model: 'm', messages, maxTokens: 256, useDocuments: true }).neat_rag, true)
  assert.equal('max_tokens' in chatRequestBody({ model: 'm', messages }), false)

  const realFetch = globalThis.fetch
  try {
    let sent = null
    globalThis.fetch = async (url, init) => {
      sent = { url, body: JSON.parse(init.body) }
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    await streamChat({ model: 'm', messages, maxTokens: 1024, onDelta: () => {} })
    assert.equal(sent.url, '/api/genai/v1/chat/completions')
    assert.equal(sent.body.max_tokens, 1024)
    assert.equal(sent.body.messages[0].content, "Be brief. No image is attached to the current message. If the user asks about an image, photo, camera or what you see, say that no image was provided and ask them to attach one or use the camera. Never describe an image you were not given.")
  } finally {
    globalThis.fetch = realFetch
  }
})

test('View documents: the source, its sections by heading, and the filter', () => {
  // GET /rag/inspect as a DevKit returns it (limit 3 of the 8 sections).
  const inspect = {
    collection: 'demo_collection',
    count: 3,
    documents: [
      { id: 469763706461880320, metadata: { Header_2: 'What Neat Is', Header_1: 'Neat Library Overview' }, text: 'The Neat Library is the C++ and Python library.' },
      { id: 469763706461880321, metadata: { Header_1: 'Neat Library Overview', Header_2: 'How It Works' }, text: 'A compiled\nmodel archive becomes a Model component.' },
      { id: 469763706461880322, metadata: {}, text: 'Piper provides text-to-speech.' }
    ],
    enabled: true,
    error: null,
    exists: true,
    meta: { chunks: 8, collection: 'demo_collection', embedding_model: '/media/nvme/llima/models/gte-small/', input: '/media/nvme/st30/app587/src/common/rag/neat.md' },
    path: '/media/nvme/st30/app587/src/python/ui/milvus.db'
  }
  const view = inspectSummary(inspect)
  assert.deepEqual(view.rows.map((r) => [r.label, r.value]), [
    ['Source', 'neat.md'], ['Sections', '8 (showing the first 3)'], ['Search model', 'gte-small'], ['Database', 'milvus.db']
  ])
  assert.equal(view.rows[0].title, '/media/nvme/st30/app587/src/common/rag/neat.md')
  assert.equal(view.note, '')
  // The ids arrive rounded (64-bit) and equal: sections are told apart by number.
  assert.equal(new Set(inspect.documents.map((d) => d.id)).size, 1)
  assert.deepEqual(view.sections.map((s) => [s.number, s.heading]), [
    [1, 'Neat Library Overview › What Neat Is'],
    [2, 'Neat Library Overview › How It Works'],
    [3, '']
  ])
  assert.equal(sectionHeading({ Header_10: 'c', Header_2: 'b', Header_1: 'a', source: 'x' }), 'a › b › c')
  assert.deepEqual(filterSections(view.sections, '').length, 3)
  assert.deepEqual(filterSections(view.sections, 'MODEL archive').map((s) => s.number), [2], 'every word, any case')
  assert.deepEqual(filterSections(view.sections, 'how it works').map((s) => s.number), [2], 'headings count')
  assert.deepEqual(filterSections(view.sections, 'nothing like this'), [])

  assert.equal(inspectSummary({ ...inspect, documents: [], meta: {}, exists: false }).note, 'No documents yet: upload a Markdown file or reset to the default document.')
  assert.match(inspectSummary({ ...inspect, documents: [], error: 'Could not read the RAG database' }).note, /^Could not read the RAG database\. Restart GenAI Studio/)
  assert.equal(inspectSummary({ enabled: false, error: 'RAG is disabled' }).note, 'Document search is turned off on the board.')
  assert.equal(inspectSummary({ ...inspect, meta: {} }).rows.find((r) => r.label === 'Sections').value, '3')
  assert.equal(inspectPath(), `rag/inspect?limit=${INSPECT_LIMIT}`)
})

test('the view sends the reply settings, and drops board camera and vision results from a previous board', () => {
  const view = readFileSync(new URL('../GenAIView.jsx', import.meta.url), 'utf8')
  const fn = (signature) => {
    const start = view.indexOf(signature)
    assert.ok(start >= 0, signature)
    return view.slice(start, view.indexOf('\n  }\n', start))
  }
  const send = fn('function sendMessage(')
  assert.match(send, /systemPromptFor\(\{ custom: replySettings\.systemPrompt/)
  assert.match(send, /maxTokens: replySettings\.maxTokens/)
  assert.match(send, /visionBusy\.current\) return false/, 'a spoken question waits while the vision view asks')
  const ask = fn('async function askAboutPicture(')
  assert.match(ask, /systemPromptFor\(\{ custom: replySettings\.systemPrompt, picture: 'current' \}\)/)
  assert.match(ask, /maxTokens: replySettings\.maxTokens/)
  assert.match(ask, /const board = ticket\(signal\)/)
  assert.match(ask, /if \(reading\) await reading\.done/, 'a loop waits for the reading before the next picture')
  // A picture from the board's camera is attached only if the board is still the same.
  const snap = fn('async function takeBoardPicture(')
  assert.match(snap, /const board = ticket\(controller\.signal\)/)
  assert.ok(snap.indexOf('if (!board.live() || controller.signal.aborted) return') < snap.indexOf('setImage(picture)'))
  const forget = fn('function forgetBoard() {')
  for (const step of ['setVisionOpen(false)', 'setBoardCameraOpen(false)', 'setBoardCameras(null)']) assert.ok(forget.includes(step), step)
  // The vision view: each picture and answer is checked against the board it was asked of.
  const vision = view.slice(view.indexOf('function VisionView('))
  assert.match(vision, /if \(!board\.live\(\) \|\| signal\.aborted\) throw new DOMException/)
  assert.match(vision, /if \(!board\.live\(\) \|\| signal\.aborted\) return\n {4}setAnswer/)
  assert.match(vision, /loop\.current\.stop\('The model changed\.'\)/)
})

test("each vision answer starts without the previous answer's speech figures", () => {
  const view = readFileSync(new URL('../GenAIView.jsx', import.meta.url), 'utf8')
  const start = view.indexOf("setSpeechError((e) => (e && e.id === VISION_READING ? null : e))")
  assert.ok(start >= 0)
  assert.match(view.slice(start, start + 400), /const \{ \[VISION_READING\]: _previous, \.\.\.rest \} = prev/)
})
