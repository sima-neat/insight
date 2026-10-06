import assert from 'node:assert/strict'
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
  loadedChatModel,
  speechModels
} from './backendState.js'
import { TUTORIAL_STORAGE_KEY, markTutorialSeen, tutorialSeen, tutorialSteps } from './tutorial.js'
import { languageNames, readAloudSupport, scriptLanguage, speakableText } from './speech.js'
import { chatDeltaText, createJsonLinesParser, createSseParser, splitThinking } from './streams.js'
import { REPLY_CUT_OFF, probeHealth, streamChat } from './client.js'
import { chatStreamStats, heardMetrics, replyMetrics, speechMetrics } from './metrics.js'
import { createSentenceSplitter, speakablePieces } from './sentences.js'
import { documentsSummary, documentsSupport, parseSources, progressOutcome, sourcesNote } from './documents.js'
import { SOLUTIONS, chatLog, chatLogFilename, solutionUrl } from './chatExport.js'
import { benchProgress, benchmarkCsv, benchmarkFilename, benchmarkJson, benchmarkRequest, clampSetting, comparisonRows, BENCH_LIMITS } from './benchmark.js'

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
  assert.match(down.detail, /run\.sh --backend-only/)
  assert.equal(deriveBackendState({ health: { networkError: 'Failed to fetch' } }).state, 'unavailable')
  assert.equal(deriveBackendState({ health: { httpStatus: 404, body: {} } }).action, 'settings')
})

test('backend state: a board that answers with an error is running, not down', () => {
  const studioError = deriveBackendState({ health: { httpStatus: 500, body: { error: 'Internal error in GenAI Studio' } } })
  assert.equal(studioError.state, 'error')
  assert.match(studioError.title, /answered with an error \(HTTP 500\)/)
  assert.equal(studioError.detail, 'Internal error in GenAI Studio')
  const notStudio = deriveBackendState({ health: { httpStatus: 404, body: {}, unreadable: true } })
  assert.equal(notStudio.state, 'error')
  assert.match(notStudio.title, /doesn't answer like GenAI Studio/)
  assert.doesNotMatch(notStudio.detail, /<html>/)
  assert.equal(canUseModels('error'), false)
})

test('backend state: no board selected needs no extra button, the settings open on their own', () => {
  assert.equal(deriveBackendState({ health: { httpStatus: 503, body: { reason: 'not-configured' } } }).action, null)
})

function respondWith(status, body, contentType = 'text/plain') {
  globalThis.fetch = async () => new Response(body, { status, headers: { 'Content-Type': contentType } })
}

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

test('the tutorial covers every feature, and says why Think first is greyed out for a model that cannot', () => {
  const ids = tutorialSteps().map((s) => s.id)
  assert.deepEqual(ids, ['intro', 'model', 'ask', 'picture', 'talk', 'listen', 'languages', 'solutions', 'documents', 'benchmark', 'export', 'think', 'help'])
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
    { model: 'Broken, "quoted"', failed: 'failed to load' }
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
