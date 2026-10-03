// Calls from the GenAI tab to Insight's /api/genai relay (insight#150), which
// forwards them to the board's GenAI Studio backend.
import { chatDeltaText, createJsonLinesParser, createSseParser } from './streams.js'

export const RELAY = '/api/genai'

async function readJson(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    // Not GenAI Studio's JSON (an HTML error page, another service).
    return { error: text.slice(0, 300), unreadable: true }
  }
}

export class GenaiError extends Error {
  constructor(message, { status = 0, body = {} } = {}) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function request(path, { method = 'GET', json, form, headers = {}, signal } = {}) {
  const init = { method, headers: { ...headers }, signal }
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(json)
  } else if (form) {
    init.body = form
  }
  let response
  try {
    response = await fetch(`${RELAY}/${path}`, init)
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new GenaiError(`Insight could not be reached: ${error.message}`)
  }
  return response
}

export async function getJson(path, options) {
  const response = await request(path, options)
  const body = await readJson(response)
  if (!response.ok) throw new GenaiError(body.error || `HTTP ${response.status}`, { status: response.status, body })
  return body
}

export async function postJson(path, json, options = {}) {
  const response = await request(path, { ...options, method: 'POST', json })
  const body = await readJson(response)
  if (!response.ok) throw new GenaiError(body.error || `HTTP ${response.status}`, { status: response.status, body })
  return body
}

// /health keeps its HTTP status: the tab derives its state from it.
export async function probeHealth(signal) {
  try {
    const response = await fetch(`${RELAY}/health`, { signal })
    const body = await readJson(response)
    if (body.unreadable) return { httpStatus: response.status, body: {}, unreadable: true }
    return { httpStatus: response.status, body }
  } catch (error) {
    if (error.name === 'AbortError') throw error
    return { networkError: error.message }
  }
}

export async function getSettings() {
  const response = await fetch(`${RELAY}/settings`)
  return readJson(response)
}

export async function saveSettings(update) {
  const response = await fetch(`${RELAY}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update)
  })
  const body = await readJson(response)
  if (!response.ok) throw new GenaiError(body.error || `HTTP ${response.status}`, { status: response.status, body })
  return body
}

async function readStream(response, onText) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    onText(decoder.decode(value, { stream: true }))
  }
  onText(decoder.decode())
}

export const REPLY_CUT_OFF = 'The reply stopped early: the connection to the board closed before it finished.'

// Streams a chat reply; calls onDelta(text) for each piece. Resolves when done.
export async function streamChat({ model, messages, maxTokens, signal, onDelta }) {
  const response = await request('v1/chat/completions', {
    method: 'POST',
    json: { model, messages, stream: true, ...(maxTokens ? { max_tokens: maxTokens } : {}) },
    signal
  })
  if (!response.ok) {
    const body = await readJson(response)
    throw new GenaiError(body.error?.message || body.error || `HTTP ${response.status}`, { status: response.status, body })
  }
  const parser = createSseParser()
  let finished = false
  try {
    await readStream(response, (text) => {
      for (const event of parser.push(text)) {
        if (finished) continue
        const delta = chatDeltaText(event.data)
        if (delta === null) finished = true
        else if (delta) onDelta(delta)
      }
    })
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof GenaiError || !(error instanceof TypeError)) throw error
    throw new GenaiError(REPLY_CUT_OFF)
  }
  // GenAI Studio ends every reply with [DONE]; a stream that ends without it was cut off.
  if (!finished) throw new GenaiError(REPLY_CUT_OFF)
}

// Follows /models/logs/stream while a load runs; calls onProgress(loading) with
// the backend's `loading` object (or null) until the stream ends.
export async function followLoadProgress({ signal, onProgress }) {
  const response = await request('models/logs/stream', { signal })
  if (!response.ok) return
  const parser = createSseParser()
  await readStream(response, (text) => {
    for (const event of parser.push(text)) {
      if (event.event === 'done') continue
      try {
        onProgress(JSON.parse(event.data).loading || null)
      } catch {
        // A malformed progress event only costs one update.
      }
    }
  })
}

// Downloads a Hugging Face repo onto the board; calls onProgress(item) for each
// JSON progress line ({state: resolving|downloading|done|error, pct, …}).
export async function downloadModel({ repoId, signal, onProgress }) {
  const response = await request('models/hub/download', { method: 'POST', json: { repoId }, signal })
  if (!response.ok) {
    const body = await readJson(response)
    throw new GenaiError(body.error || `HTTP ${response.status}`, { status: response.status, body })
  }
  const parser = createJsonLinesParser()
  let last = null
  await readStream(response, (text) => {
    for (const item of parser.push(text)) {
      last = item
      onProgress(item)
    }
  })
  if (last && last.state === 'error') throw new GenaiError(last.message || 'Download failed')
  return last
}

export async function transcribe(blob, { language = 'auto', signal } = {}) {
  const form = new FormData()
  const type = blob.type || 'audio/webm'
  const ext = type.includes('wav') ? 'wav' : type.includes('mp4') ? 'mp4' : 'webm'
  form.append('file', blob, `recording.${ext}`)
  form.append('response_format', 'verbose_json')
  if (language && language !== 'auto') form.append('language', language)
  const response = await request('v1/audio/transcriptions', { method: 'POST', form, signal })
  const body = await readJson(response)
  if (!response.ok) throw new GenaiError(body.error || `HTTP ${response.status}`, { status: response.status, body })
  return { ...body, model: response.headers.get('X-ASR-Model') || body.model }
}

export async function speak({ text, model = 'default', voice, language, signal }) {
  const response = await request('v1/audio/speech', {
    method: 'POST',
    json: { input: text, model, ...(voice ? { voice } : {}), ...(language ? { language } : {}) },
    signal
  })
  if (!response.ok) {
    const body = await readJson(response)
    throw new GenaiError(body.error || `HTTP ${response.status}`, { status: response.status, body })
  }
  return {
    audio: await response.blob(),
    engine: response.headers.get('X-Engine'),
    voice: response.headers.get('X-Voice'),
    rtf: response.headers.get('X-RTF')
  }
}
