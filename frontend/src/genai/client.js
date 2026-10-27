// Calls from the GenAI tab to Insight's /api/genai relay (insight#150), which
// forwards them to the board's GenAI Studio backend.
import { snapshotPath } from './boardCamera.js'
import { parseSources } from './documents.js'
import { chatStreamStats } from './metrics.js'
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

// A board error's message, in either shape GenAI Studio uses: the OpenAI one
// on chat ({"error": {"message": ...}}) or a plain string elsewhere.
export function errorMessage(body, status) {
  const error = body && body.error
  if (typeof error === 'string' && error) return error
  if (error && typeof error.message === 'string' && error.message) return error.message
  return `HTTP ${status}`
}

export class GenaiError extends Error {
  constructor(message, { status = 0, body = {} } = {}) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function request(path, { method = 'GET', json, form, headers = {}, signal, cache } = {}) {
  const init = { method, headers: { ...headers }, signal, ...(cache ? { cache } : {}) }
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
  if (!response.ok) throw new GenaiError(errorMessage(body, response.status), { status: response.status, body })
  return body
}

export async function postJson(path, json, options = {}) {
  const response = await request(path, { ...options, method: 'POST', json })
  const body = await readJson(response)
  if (!response.ok) throw new GenaiError(errorMessage(body, response.status), { status: response.status, body })
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

// Setup goes to Insight's own /api/genai-setup, not through the relay: Insight
// runs the steps on the selected board itself.
export const SETUP = '/api/genai-setup'

async function setupRequest(path, method = 'GET') {
  let response
  try {
    response = await fetch(`${SETUP}${path}`, { method, cache: 'no-store' })
  } catch (error) {
    throw new GenaiError(`Insight could not be reached: ${error.message}`)
  }
  const body = await readJson(response)
  if (!response.ok) throw new GenaiError(errorMessage(body, response.status), { status: response.status, body })
  return body
}

export const getSetup = () => setupRequest('')
export const runSetup = () => setupRequest('/run', 'POST')
export const stopSetup = () => setupRequest('/stop', 'POST')

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
  if (!response.ok) throw new GenaiError(errorMessage(body, response.status), { status: response.status, body })
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

// The body of POST v1/chat/completions: an OpenAI request, plus "neat_rag"
// to answer from the board's documents.
export function chatRequestBody({ model, messages, maxTokens, useDocuments = false }) {
  return {
    model,
    messages,
    stream: true,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(useDocuments ? { neat_rag: true } : {})
  }
}

// Streams a chat reply; calls onDelta(text) for each piece. Resolves with
// {stats, rag}: the board's {tokens, tps} for the reply (or null), and with
// useDocuments the passages the board added ({hits, sources}, else null).
export async function streamChat({ model, messages, maxTokens, useDocuments = false, signal, onDelta }) {
  const response = await request('v1/chat/completions', {
    method: 'POST',
    json: chatRequestBody({ model, messages, maxTokens, useDocuments }),
    signal
  })
  if (!response.ok) {
    const body = await readJson(response)
    throw new GenaiError(errorMessage(body, response.status), { status: response.status, body })
  }
  const parser = createSseParser()
  let finished = false
  let stats = null
  try {
    await readStream(response, (text) => {
      for (const event of parser.push(text)) {
        if (finished) continue
        stats = chatStreamStats(event.data) || stats
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
  const hits = response.headers.get('X-RAG-Hits')
  const rag = useDocuments && hits !== null
    ? { hits: Number(hits) || 0, sources: parseSources(response.headers.get('X-RAG-Sources')) }
    : null
  return { stats, rag }
}

// Document upload, reset and clear stream progress as text; onText gets the
// text so far. Resolves with the whole text.
async function postTextStream(path, { form, signal, onText } = {}) {
  const response = await request(path, { method: 'POST', form, signal })
  if (!response.ok) {
    const body = await readJson(response)
    throw new GenaiError(errorMessage(body, response.status), { status: response.status, body })
  }
  let text = ''
  await readStream(response, (piece) => {
    text += piece
    onText?.(text)
  })
  return text
}

export function uploadDocument(file, options) {
  const form = new FormData()
  form.append('file', file, file.name)
  return postTextStream('rag/upload', { ...options, form })
}

export function resetDocuments(options) {
  return postTextStream('rag/reset', options)
}

export function clearDocuments(options) {
  return postTextStream('rag/clear', options)
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
// Resolves with the "done" line ({name}: the model's name in the catalog). A
// failure keeps the board's error line as `body`: for a repo Hugging Face
// renamed, its `renamedTo` names the id to download instead.
export async function downloadModel({ repoId, signal, onProgress }) {
  const response = await request('models/hub/download', { method: 'POST', json: { repoId }, signal })
  if (!response.ok) {
    const body = await readJson(response)
    throw new GenaiError(errorMessage(body, response.status), { status: response.status, body })
  }
  const parser = createJsonLinesParser()
  let last = null
  await readStream(response, (text) => {
    for (const item of parser.push(text)) {
      last = item
      onProgress(item)
    }
  })
  if (last && last.state === 'error') throw new GenaiError(last.message || 'Download failed', { body: last })
  // A stream that ends without "done" (the Studio restarted, the connection
  // dropped) is not a finished download.
  if (!last || last.state !== 'done') throw new GenaiError('The download stopped before it finished.')
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
  if (!response.ok) throw new GenaiError(errorMessage(body, response.status), { status: response.status, body })
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
    throw new GenaiError(errorMessage(body, response.status), { status: response.status, body })
  }
  return {
    audio: await response.blob(),
    engine: response.headers.get('X-Engine'),
    voice: response.headers.get('X-Voice'),
    rtf: response.headers.get('X-RTF')
  }
}

// One picture from a camera on the board (GET board-camera/snapshot): a JPEG
// Blob. The board answers errors as JSON (400 for a device it doesn't accept,
// 503 when it couldn't capture); anything that isn't a picture is an error too.
export async function boardCameraSnapshot(device, { signal } = {}) {
  const response = await request(snapshotPath(device), { signal, cache: 'no-store' })
  if (!response.ok) {
    const body = await readJson(response)
    throw new GenaiError(errorMessage(body, response.status), { status: response.status, body })
  }
  const type = response.headers.get('Content-Type') || ''
  if (!type.startsWith('image/')) throw new GenaiError(`The board sent ${type || 'something'} instead of a picture.`, { status: response.status })
  const picture = await response.blob()
  if (!picture.size) throw new GenaiError('The board sent an empty picture.', { status: response.status })
  return picture
}
