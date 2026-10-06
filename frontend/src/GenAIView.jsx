import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  START_COMMAND,
  canUseModels,
  chatModels,
  deriveBackendState,
  engineName,
  formatBytes,
  formatDuration,
  friendlyModelName,
  loadedChatModel,
  speechModels,
  supportsThinking,
  thinkingModelOnBoard,
  voiceEngineWarnings
} from './genai/backendState.js'
import {
  REPLY_CUT_OFF,
  clearDocuments,
  resetDocuments,
  uploadDocument,
  downloadModel,
  followLoadProgress,
  getJson,
  getSettings,
  postJson,
  probeHealth,
  saveSettings,
  speak,
  streamChat,
  transcribe
} from './genai/client.js'
import { languageNames, readAloudSupport } from './genai/speech.js'
import { heardMetrics, replyMetrics, speechMetrics } from './genai/metrics.js'
import { SOLUTIONS, SOLUTIONS_ROOT, chatLog, chatLogFilename, solutionUrl } from './genai/chatExport.js'
import { documentsSummary, documentsSupport, progressOutcome, sourcesNote } from './genai/documents.js'
import { createSentenceSplitter, speakablePieces } from './genai/sentences.js'
import { splitThinking } from './genai/streams.js'
import { markTutorialSeen, tutorialSeen, tutorialSteps } from './genai/tutorial.js'

const GenAIBenchmark = lazy(() => import('./GenAIBenchmark.jsx'))

const POLL_MS = 5000
const MAX_TOKENS = 512
// The Studio's default system prompt (apps: src/common/config.yaml). The tab
// knows whether the message carries a picture, so it says so: a small vision
// model left to judge that itself answered "no image was provided" to some
// questions that had one, and invented a scene for others that had none.
const BASE_PROMPT =
  'Answer clearly and concisely. Use Markdown formatting when it helps. ' +
  'Answer the question in the language it was asked in.'
const WITH_IMAGE_PROMPT = `${BASE_PROMPT} The user's current message includes an image. Answer using what you see in it.`
const WITHOUT_IMAGE_PROMPT =
  `${BASE_PROMPT} No image is attached to the current message. If the user asks about an image, photo, camera or ` +
  'what you see, say that no image was provided and ask them to attach one or use the camera. Never describe an image you were not given.'
// A short silent WAV: played on the click itself so the browser lets the same
// element play the synthesized speech that arrives seconds later.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='
const LANGUAGES = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'German' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'zh', label: 'Chinese' }
]

// Scale an image down so large photos are not uploaded whole.
async function imageToDataUrl(blob, maxSide = 896) {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.9)
}

function Icon({ d }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="genai-icon">
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  photo: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M15.5 9.5a1 1 0 1 0 0-.01',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  send: 'M12 19V5M5 12l7-7 7 7',
  stop: 'M7 7h10v10H7z',
  newChat: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  export: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  shield: 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z',
  gauge: 'M3.5 17a8.5 8.5 0 1 1 17 0M12 17l4.5-5M12 17h.01M6.5 12.5l1.2.7M12 8.5V10M17.5 12.5l-1.2.7',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17v.01',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  settings: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4'
}

function StatusChip({ state }) {
  const labels = {
    ready: 'Ready',
    busy: 'Busy',
    starting: 'Starting',
    failed: 'Error',
    error: 'Error',
    unavailable: 'Not running',
    unconfigured: 'Not set up',
    incompatible: 'Incompatible'
  }
  return <span className={`genai-pill genai-pill-${state}`}>{labels[state] || state}</span>
}

function Metrics({ items, label }) {
  if (!items || !items.length) return null
  return (
    <p className="genai-metrics" aria-label={label}>
      {items.map((m) => (
        <span key={m.label} title={m.title}>
          <span className="genai-metric-label">{m.label}</span> {m.value}
        </span>
      ))}
    </p>
  )
}

function ProgressBar({ pct, label }) {
  const known = typeof pct === 'number'
  return (
    <div className="genai-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? pct : undefined}>
      <div className={known ? 'genai-progress-fill' : 'genai-progress-fill indeterminate'} style={known ? { width: `${pct}%` } : undefined} />
    </div>
  )
}

function modelLabel(model) {
  if (!model) return ''
  return `${friendlyModelName(model.name)}${model.supportsVision ? ' · sees images' : ''}`
}

export default function GenAIView({ onError, onStatus }) {
  const [settings, setSettings] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [solutionsOpen, setSolutionsOpen] = useState(false)
  const [benchOpen, setBenchOpen] = useState(false)
  const root = useRef(null)
  const [addressDraft, setAddressDraft] = useState('')
  const [health, setHealth] = useState(null)
  const [status, setStatus] = useState(null)
  const [busyOp, setBusyOp] = useState(null)
  const [lastError, setLastError] = useState(null)
  const [loadProgress, setLoadProgress] = useState(null)
  const [voices, setVoices] = useState(null)

  const [messages, setMessages] = useState([])
  // Read by callbacks that outlive a render (a recording that finishes later).
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const [draft, setDraft] = useState('')
  const [image, setImage] = useState(null)
  const [thinking, setThinking] = useState(false)
  const [useDocs, setUseDocs] = useState(false)
  // Turned on in a chat that already has replies: the model tends to repeat
  // its earlier answers over the documents, so a new chat is suggested.
  const [docsMidChat, setDocsMidChat] = useState(false)
  const [docStatus, setDocStatus] = useState(null)     // GET /rag/status
  const [docProgress, setDocProgress] = useState(null) // {label, text} while an upload/reset/clear runs
  const docInput = useRef(null)
  const [tutorialStep, setTutorialStep] = useState(null)
  const [streaming, setStreaming] = useState(false)
  const chatAbort = useRef(null)
  const transcriptBox = useRef(null)
  const stickToBottom = useRef(true)
  const composer = useRef(null)
  const fileInput = useRef(null)

  const [cameraOpen, setCameraOpen] = useState(false)
  const videoRef = useRef(null)
  const cameraStream = useRef(null)

  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [language, setLanguage] = useState('auto')
  const [readAloud, setReadAloud] = useState(false)
  const [engine, setEngine] = useState('default')
  const [voice, setVoice] = useState('')
  const recorder = useRef(null)
  const player = useRef(null)
  const speechAbort = useRef(null)
  const [speakingId, setSpeakingId] = useState(null)
  // {id, text}: why the last Read aloud of reply `id` failed, shown under it.
  const [speechError, setSpeechError] = useState(null)
  // reply id -> speed figures of its last reading aloud.
  const [speechStats, setSpeechStats] = useState({})
  const spokenLanguage = useRef(null)

  const [hubQuery, setHubQuery] = useState('')
  const [hubResults, setHubResults] = useState(null)
  const [download, setDownload] = useState(null)

  const backend = deriveBackendState({ health, status, busyOp, lastError })
  const usable = canUseModels(backend.state)
  const docs = documentsSupport(health)
  const chatModel = loadedChatModel(status)
  const sees = Boolean(chatModel && chatModel.supportsVision)
  const canThink = Boolean(chatModel && supportsThinking(chatModel.name))

  const fail = useCallback((message) => {
    setLastError(message)
    onError?.(message)
  }, [onError])

  // --- polling ---------------------------------------------------------------

  const refresh = useCallback(async () => {
    const nextHealth = await probeHealth()
    setHealth(nextHealth)
    if (nextHealth.httpStatus === 200 && nextHealth.body?.model_server?.reachable) {
      try {
        setStatus(await getJson('models/status'))
      } catch {
        // A failed status poll keeps the last known catalog.
      }
    }
    return nextHealth
  }, [])

  // The Documents section shows what the board's database holds.
  useEffect(() => {
    if (settingsOpen && docs.available) loadDocumentStatus()
  }, [settingsOpen, docs.available])

  useEffect(() => {
    let cancelled = false
    getSettings().then((s) => {
      if (cancelled) return
      setSettings(s)
      setAddressDraft(s.configuredUrl || '')
    }).catch(() => {})
    refresh()
    const timer = setInterval(() => { if (!cancelled) refresh() }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    if (!usable || voices) return
    getJson('v1/audio/voices').then(setVoices).catch(() => {})
  }, [usable, voices])

  // Follow a streaming reply only while the reader is at the bottom; scrolling
  // up to reread stops following until they scroll back down.
  useEffect(() => {
    const box = transcriptBox.current
    if (box && stickToBottom.current) box.scrollTop = box.scrollHeight
  }, [messages])

  // First visit: start the tutorial.
  useEffect(() => {
    if (!tutorialSeen(window.localStorage)) setTutorialStep(0)
  }, [])

  function onTranscriptScroll() {
    const box = transcriptBox.current
    if (box) stickToBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  }

  useEffect(() => () => {
    chatAbort.current?.abort()
    speechAbort.current?.abort()
    player.current?.pause()
    cameraStream.current?.getTracks().forEach((t) => t.stop())
    recorder.current?.stream?.getTracks().forEach((t) => t.stop())
  }, [])

  // --- settings ----------------------------------------------------------------

  async function applySettings(event) {
    event.preventDefault()
    try {
      const saved = await saveSettings({ url: addressDraft.trim() })
      setSettings(saved)
      setVoices(null)
      onStatus?.('Board settings saved.')
      refresh()
    } catch (error) {
      onError?.(error.message)
    }
  }

  // --- models -----------------------------------------------------------------

  async function runModelOp(label, path, body) {
    setBusyOp(label)
    setLastError(null)
    const progress = new AbortController()
    if (path === 'models/load') {
      followLoadProgress({ signal: progress.signal, onProgress: setLoadProgress }).catch(() => {})
    }
    try {
      await postJson(path, body)
      onStatus?.(`${label}: done.`)
    } catch (error) {
      fail(`${label} failed: ${error.message}`)
    } finally {
      progress.abort()
      setLoadProgress(null)
      setBusyOp(null)
      refresh()
    }
  }

  function chooseChatModel(name) {
    const model = chatModels(status).find((m) => m.name === name)
    if (!model || model === chatModel) return
    const wait = model.estimatedLoadS ? ` It takes about ${formatDuration(model.estimatedLoadS)}.` : ''
    if (!window.confirm(`Load ${friendlyModelName(model.name)}?${wait} The current model is unloaded first.`)) return
    runModelOp(`Loading ${friendlyModelName(model.name)}`, 'models/load', { name: model.name })
  }

  async function searchHub(event) {
    event.preventDefault()
    try {
      const query = hubQuery.trim() ? `?q=${encodeURIComponent(hubQuery.trim())}` : ''
      setHubResults(await getJson(`models/hub/search${query}`))
    } catch (error) {
      onError?.(`Search failed: ${error.message}`)
    }
  }

  async function startDownload(repoId) {
    setDownload({ repoId, state: 'resolving', pct: null })
    try {
      await downloadModel({ repoId, onProgress: (item) => setDownload({ repoId, ...item }) })
      onStatus?.(`Downloaded ${repoId}.`)
      setHubResults(null)
    } catch (error) {
      onError?.(`Download of ${repoId} failed: ${error.message}`)
    } finally {
      setDownload(null)
      refresh()
    }
  }

  // --- speech output ----------------------------------------------------------

  // Must run inside a click: the browser only lets an element play audio it
  // started during a user gesture.
  function unlockPlayer() {
    if (!player.current) player.current = new Audio()
    const audio = player.current
    // Detach the last reading's handlers: pausing or replacing its audio must not
    // end the reading that starts now (the same reply, read again, has the same id).
    audio.onended = null
    audio.onpause = null
    audio.pause()
    audio.src = SILENT_WAV
    audio.play().catch(() => {})
    return audio
  }

  function stopSpeaking() {
    speechAbort.current?.abort()
    speechAbort.current = null
    player.current?.pause()
    setSpeakingId(null)
  }

  function voiceLanguageFor(text) {
    const fallback = spokenLanguage.current || (language !== 'auto' ? language : 'en')
    return readAloudSupport(text, voices ? voices.languages : null, fallback)
  }

  // One reading of reply `id`, spoken piece by piece: add() takes each sentence
  // as soon as it is known (while the reply streams), the board turns them into
  // speech one after another, and they play in order on the unlocked player.
  // t0: when the wait began (the send, or the Read aloud click).
  function startReading(id, audio, t0) {
    stopSpeaking()
    setSpeechError(null)
    const controller = new AbortController()
    speechAbort.current = controller
    const { signal } = controller
    const pending = []          // pieces waiting to be turned into speech
    const ready = []            // {audio blob, rtf, engine} waiting to play
    let finished = false        // no more pieces will be added
    let synthesizing = false
    let playing = false
    let language = null         // decided by the first piece
    let firstAudio = null
    const rtfs = []
    let engineUsed = null
    let wake = null             // resolves the player loop's wait for audio

    const isOver = () => finished && !pending.length && !ready.length && !synthesizing
    const end = () => {
      setSpeakingId((current) => (current === id ? null : current))
      if (speechAbort.current === controller) speechAbort.current = null
    }
    const fail = (error) => {
      if (error.name === 'AbortError' || signal.aborted) return
      controller.abort()
      audio.pause()
      end()
      setSpeechError({ id, text: `Couldn't read this reply aloud: ${error.message}` })
    }
    const recordMetrics = () => {
      const rtf = rtfs.length ? rtfs.reduce((a, b) => a + b, 0) / rtfs.length : null
      setSpeechStats((prev) => ({ ...prev, [id]: speechMetrics({ t0, tAudio: firstAudio, rtf, engine: engineName(engineUsed) }) }))
    }

    function playOne({ blob }) {
      return new Promise((resolve) => {
        const url = URL.createObjectURL(blob)
        const settle = () => {
          audio.onended = null
          audio.onpause = null
          URL.revokeObjectURL(url)
          resolve()
        }
        audio.src = url
        audio.onended = settle
        audio.onpause = settle
        audio.play().then(() => {
          if (firstAudio === null) {
            firstAudio = performance.now()
            recordMetrics()
          }
        }, settle)
      })
    }

    async function playLoop() {
      if (playing) return
      playing = true
      try {
        for (;;) {
          if (signal.aborted) return
          if (!ready.length) {
            if (isOver()) break
            await new Promise((resolve) => { wake = resolve })
            continue
          }
          await playOne(ready.shift())
        }
        if (firstAudio !== null) recordMetrics()
        end()
      } finally {
        playing = false
      }
    }

    async function synthLoop() {
      if (synthesizing) return
      synthesizing = true
      try {
        while (pending.length && !signal.aborted) {
          const text = pending.shift()
          const result = await speak({ text, model: engine, voice: voice || undefined, language, signal })
          const rtf = Number(result.rtf)
          if (Number.isFinite(rtf) && rtf > 0) rtfs.push(rtf)
          engineUsed = engineUsed || result.engine
          ready.push({ blob: result.audio })
          wake?.()
        }
      } catch (error) {
        fail(error)
      } finally {
        synthesizing = false
        wake?.()
      }
    }

    return {
      // Returns false once the reply's language turns out to have no voice.
      add(piece) {
        if (signal.aborted) return false
        if (language === null) {
          const support = voiceLanguageFor(piece)
          if (!support.supported) {
            controller.abort()
            end()
            return false
          }
          language = support.language
          setSpeakingId(id)
          playLoop()
        }
        pending.push(piece)
        synthLoop()
        return true
      },
      finish() {
        finished = true
        if (language === null) end()
        wake?.()
      },
      abort() {
        controller.abort()
        audio.pause()
        end()
      }
    }
  }

  // Read aloud on a finished reply.
  function speakText(text, id, audio = unlockPlayer(), t0 = performance.now()) {
    const pieces = speakablePieces(text)
    if (!pieces.length) return
    const support = voiceLanguageFor(text)
    if (!support.supported) {
      onStatus?.(`The board's voices can't read ${support.name} aloud yet.`)
      return
    }
    const reading = startReading(id, audio, t0)
    for (const piece of pieces) reading.add(piece)
    reading.finish()
  }

  // --- chat -------------------------------------------------------------------

  function withNoThink(content) {
    if (typeof content === 'string') return `/no_think ${content}`
    return content.map((part) => (part.type === 'text' ? { ...part, text: `/no_think ${part.text}` } : part))
  }

  async function sendMessage(text = draft, { replyPlayer = readAloud ? unlockPlayer() : null, heard = null } = {}) {
    const prompt = text.trim()
    if ((!prompt && !image) || !chatModel || streaming) return
    const userText = prompt || 'Describe this image.'
    const userContent = image
      ? [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: image } }]
      : userText
    const history = messagesRef.current.map((m) => ({ role: m.role, content: m.role === 'assistant' ? splitThinking(m.content).answer : m.text }))
    const outgoing = [
      { role: 'system', content: image ? WITH_IMAGE_PROMPT : WITHOUT_IMAGE_PROMPT },
      ...history,
      { role: 'user', content: canThink && !thinking ? withNoThink(userContent) : userContent }
    ]
    const replyId = Date.now()
    setMessages((prev) => [...prev, { role: 'user', text: userText, image, heard }, { role: 'assistant', id: replyId, content: '', pending: true }])
    setDraft('')
    setImage(null)
    stickToBottom.current = true
    setStreaming(true)
    const controller = new AbortController()
    chatAbort.current = controller
    let reply = ''
    const t0 = performance.now()
    let tFirst = null
    // Read replies aloud: speak each sentence as soon as it is written.
    let reading = replyPlayer ? startReading(replyId, replyPlayer, t0) : null
    const splitter = createSentenceSplitter()
    const speakNew = (final) => {
      if (!reading) return
      for (const piece of splitter.push(splitThinking(reply).answer, final)) {
        if (!reading.add(piece)) {
          reading = null
          return
        }
      }
      if (final) reading.finish()
    }
    const update = (extra) => setMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', id: replyId, content: reply, ...extra }])
    try {
      const { stats, rag } = await streamChat({
        model: chatModel.name,
        messages: outgoing,
        maxTokens: MAX_TOKENS,
        useDocuments: useDocs && docs.available,
        signal: controller.signal,
        onDelta: (piece) => {
          if (tFirst === null) tFirst = performance.now()
          reply += piece
          update({ pending: true })
          speakNew(false)
        }
      })
      update({ metrics: replyMetrics({ t0, tFirst, tEnd: performance.now(), stats }), rag })
      speakNew(true)
    } catch (error) {
      const stopped = error.name === 'AbortError'
      // Stopping the reply stops its reading; a reply cut off by an error is
      // still read up to where it stopped.
      if (stopped) reading?.abort()
      else speakNew(true)
      update({ stopped, error: stopped ? null : error.message })
      if (!stopped) fail(error.message === REPLY_CUT_OFF ? REPLY_CUT_OFF : `The chat model didn't answer: ${error.message}`)
    } finally {
      setStreaming(false)
      chatAbort.current = null
    }
  }

  async function attachImage(file) {
    if (!file) return
    try {
      setImage(await imageToDataUrl(file))
    } catch {
      onError?.('That file could not be read as an image.')
    }
  }

  async function openCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      cameraStream.current = stream
      setCameraOpen(true)
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.srcObject = stream
      })
    } catch (error) {
      onError?.(`The camera isn't available (${error.message}). Allow camera access for this page, then try again.`)
    }
  }

  function closeCamera() {
    cameraStream.current?.getTracks().forEach((t) => t.stop())
    cameraStream.current = null
    setCameraOpen(false)
  }

  function captureFrame() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 896 / Math.max(video.videoWidth, video.videoHeight))
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    setImage(canvas.toDataURL('image/jpeg', 0.9))
    closeCamera()
    composer.current?.focus()
  }

  // --- speech input -----------------------------------------------------------

  async function toggleRecording() {
    if (recording) {
      recorder.current?.stop()
      return
    }
    // Unlocked during this click, so a spoken question can be answered aloud.
    const replyPlayer = readAloud ? unlockPlayer() : null
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const chunks = []
      const rec = new MediaRecorder(stream)
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setRecording(false)
        setTranscribing(true)
        try {
          const tStop = performance.now()
          const result = await transcribe(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }), { language })
          const heardMs = performance.now() - tStop
          const heard = (result.text || '').trim()
          if (!heard || result.ignored) {
            onStatus?.("Didn't catch that. Try again a little closer to the microphone.")
          } else {
            spokenLanguage.current = result.tts_language || null
            const languageName = result.language ? (languageNames([result.language])[0] || result.language.charAt(0).toUpperCase() + result.language.slice(1)) : null
            if (chatModel) sendMessage(heard, { replyPlayer, heard: heardMetrics({ ms: heardMs, language: languageName }) })
            else setDraft(heard)
          }
        } catch (error) {
          fail(`Couldn't transcribe the recording: ${error.message}`)
        } finally {
          setTranscribing(false)
        }
      }
      recorder.current = rec
      rec.start()
      setRecording(true)
    } catch (error) {
      onError?.(`The microphone isn't available (${error.message}). Allow microphone access for this page, then try again.`)
    }
  }

  // --- welcome cards ----------------------------------------------------------

  async function loadDocumentStatus() {
    try {
      setDocStatus(await getJson('rag/status'))
    } catch {
      setDocStatus(null)
    }
  }

  async function runDocumentTask(label, task) {
    setDocProgress({ label, text: '' })
    try {
      const text = await task({ onText: (t) => setDocProgress({ label, text: t }) })
      const outcome = progressOutcome(text)
      if (outcome.ok) onStatus?.(outcome.message)
      else onError?.(outcome.message || `${label} the documents failed.`)
    } catch (error) {
      onError?.(`${label} the documents failed: ${error.message}`)
    } finally {
      setDocProgress(null)
      loadDocumentStatus()
    }
  }

  function exportChat() {
    const now = new Date()
    const text = chatLog({ messages, model: chatModel ? chatModel.name : null, now })
    if (!text) return
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    link.download = chatLogFilename(now)
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(link.href), 1500)
    onStatus?.(`Chat saved as ${link.download}.`)
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.()
    else root.current?.requestFullscreen?.().catch(() => {})
  }

  function newChat() {
    chatAbort.current?.abort()
    stopSpeaking()
    setSpeechError(null)
    setSpeechStats({})
    setMessages([])
    composer.current?.focus()
  }

  function tryPrompt(text) {
    setDraft(text)
    composer.current?.focus()
  }

  const thinkingModel = thinkingModelOnBoard(status)
  const steps = tutorialSteps({ canThink, thinkingModel })
  const step = tutorialStep === null ? null : steps[Math.min(tutorialStep, steps.length - 1)]
  const spot = (target) => (step && step.target === target ? ' genai-spotlight' : '')

  function closeTutorial() {
    markTutorialSeen(window.localStorage)
    setTutorialStep(null)
  }

  function tryTutorialAction(action) {
    if (action === 'example-question') tryPrompt('Explain what an AI accelerator does, in simple terms.')
    else if (action === 'example-translate') tryPrompt("Translate 'good morning, how are you?' into Spanish.")
    else if (action === 'camera') openCamera()
    else if (action === 'settings') setSettingsOpen(true)
  }

  const engines = (voices && voices.engines) || []
  const engineVoices = useMemo(() => {
    const found = engines.find((e) => e.key === engine)
    return (found && found.voices) || []
  }, [engines, engine])
  const voiceWarnings = usable ? voiceEngineWarnings(health) : []
  const needsAttention = backend.state !== 'ready' || voiceWarnings.length > 0
  const canChat = usable && Boolean(chatModel)

  // --- render -----------------------------------------------------------------

  return (
    <div className="genai" ref={root}>
      {step && (
        <section className="panel genai-tutorial" aria-label="GenAI Studio tutorial" aria-live="polite">
          <p className="genai-tutorial-eyebrow">Tutorial · step {tutorialStep + 1} of {steps.length}</p>
          <p className="genai-tutorial-title">{step.title}</p>
          <p className="genai-tutorial-body">{step.body}</p>
          <div className="genai-actions">
            {step.action && (step.action !== 'camera' || (canChat && sees)) && (
              <button type="button" className="btn-tonal" onClick={() => tryTutorialAction(step.action)}>Try it</button>
            )}
            <span className="genai-tutorial-spacer" />
            <button type="button" className="btn-ghost" onClick={closeTutorial}>Skip tutorial</button>
            <button type="button" className="btn-ghost" disabled={tutorialStep === 0} onClick={() => setTutorialStep((i) => Math.max(0, i - 1))}>Back</button>
            {tutorialStep < steps.length - 1 ? (
              <button type="button" className="btn-tonal" onClick={() => setTutorialStep((i) => i + 1)}>Next</button>
            ) : (
              <button type="button" className="btn-tonal" onClick={closeTutorial}>Start chatting</button>
            )}
          </div>
        </section>
      )}

      <section className="panel genai-header" aria-label="GenAI Studio">
        <span className={`genai-spot-wrap${spot('status')}`}><StatusChip state={backend.state} /></span>
        <label className={`genai-model-picker${spot('model')}`}>
          <span>Model</span>
          <select
            value={chatModel ? chatModel.name : ''}
            onChange={(e) => chooseChatModel(e.target.value)}
            disabled={!usable || chatModels(status).length === 0}
            title={chatModel ? chatModel.name : ''}
          >
            {!chatModel && <option value="">{chatModels(status).length ? 'Choose a model to load' : 'No models on the board'}</option>}
            {chatModels(status).map((m) => (
              <option key={m.name} value={m.name}>{modelLabel(m)}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-ghost genai-tool genai-new-chat" onClick={newChat} disabled={messages.length === 0} aria-label="New chat" title="New chat: start over, the model forgets this conversation">
          <Icon d={ICONS.newChat} />
        </button>
        <label className={`genai-check${spot('read-aloud')}`} title="Read every reply aloud with the board's speech engine">
          <input type="checkbox" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} />
          Read replies aloud
        </label>
        <label
          className={`genai-check${canThink ? '' : ' genai-check-off'}${spot('think')}`}
          title={canThink
            ? 'This model can reason step by step before answering: slower, sometimes better for maths and logic. The reasoning appears folded above the answer.'
            : `${chatModel ? friendlyModelName(chatModel.name) : 'This model'} always answers directly. ${thinkingModel ? `Choose ${thinkingModel}` : 'Download a model that can reason, such as Qwen3,'} to think first.`}
        >
          <input type="checkbox" checked={canThink && thinking} disabled={!canThink} onChange={(e) => setThinking(e.target.checked)} />
          Think first
        </label>
        <label
          className={`genai-check${docs.available ? '' : ' genai-check-off'}${spot('documents')}`}
          title={docs.available ? 'Answer from the documents on the board (Settings, Documents): the board adds the matching passages to each question.' : docs.reason}
        >
          <input type="checkbox" checked={docs.available && useDocs} disabled={!docs.available} onChange={(e) => { setUseDocs(e.target.checked); setDocsMidChat(e.target.checked && messages.length > 0) }} />
          Use my documents
        </label>
        <span className="genai-header-spacer" />
        <div className="genai-toolbar" role="toolbar" aria-label="GenAI Studio tools">
          <button type="button" className={`btn-ghost genai-tool${spot('export')}`} onClick={exportChat} disabled={messages.length === 0} aria-label="Export chat" title="Export chat (.log)">
            <Icon d={ICONS.export} />
          </button>
          <button type="button" className={`btn-ghost genai-tool${spot('solutions')}`} onClick={() => setSolutionsOpen(true)} aria-label="SiMaSentry Solutions" title="SiMaSentry Solutions: Med, Safe and Sec demo apps on the loaded model">
            <Icon d={ICONS.shield} />
          </button>
          <button type="button" className={`btn-ghost genai-tool${spot('benchmark')}`} onClick={() => setBenchOpen(true)} disabled={!usable} aria-label="Benchmark" title={usable ? 'Benchmark: first token time and tokens per second for the board\'s models' : backend.title}>
            <Icon d={ICONS.gauge} />
          </button>
          <button type="button" className="btn-ghost genai-tool" onClick={() => setTutorialStep(0)} aria-pressed={step !== null} aria-label="Tutorial" title="Tutorial">
            <Icon d={ICONS.help} />
          </button>
          <button type="button" className={settingsOpen ? 'btn-tonal genai-tool' : 'btn-ghost genai-tool'} aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)} aria-label="Settings" title="Settings">
            <Icon d={ICONS.settings} />
          </button>
          <button type="button" className="btn-ghost genai-tool" onClick={toggleFullscreen} aria-label="Full screen" title="Full screen">
            <Icon d={ICONS.fullscreen} />
          </button>
        </div>
      </section>

      {needsAttention && (
        <section className={`panel genai-banner genai-banner-${backend.state}`} aria-live="polite">
          {backend.state !== 'ready' && <p className="genai-banner-title">{backend.title}</p>}
          {backend.state !== 'ready' && backend.detail && <p className="section-note">{backend.detail}</p>}
          {voiceWarnings.map((w) => <p key={w.key} className="section-note genai-voice-warning">{w.message}</p>)}
          {backend.state === 'busy' && <ProgressBar pct={loadProgress ? loadProgress.pct : null} label={backend.title} />}
          <div className="genai-actions">
            {backend.action === 'start-command' && (
              <button type="button" className="btn-ghost" onClick={() => navigator.clipboard?.writeText(START_COMMAND).then(() => onStatus?.('Start command copied.'))}>
                Copy start command
              </button>
            )}
            {(backend.action === 'settings' || backend.action === 'start-command') && !settingsOpen && (
              <button type="button" className="btn-ghost" onClick={() => setSettingsOpen(true)}>Change board address</button>
            )}
            {lastError && <button type="button" className="btn-ghost" onClick={() => setLastError(null)}>Dismiss</button>}
          </div>
        </section>
      )}

      {(settingsOpen || backend.state === 'unconfigured') && (
        <section className="panel genai-settings-panel" aria-label="GenAI settings">
          <div className="genai-settings-section">
            <h3>Board</h3>
            <form className="genai-form" onSubmit={applySettings}>
              <label>
                <span>Board address</span>
                <input value={addressDraft} onChange={(e) => setAddressDraft(e.target.value)} placeholder={settings?.defaultUrl || 'https://192.168.1.20:5000'} />
              </label>
              <button type="submit" className="btn-tonal">Save</button>
            </form>
            <p className="hint">
              Start GenAI Studio on the board with <code>{START_COMMAND}</code>. Leave the address empty to use {settings?.defaultUrl || 'the paired DevKit'}.
            </p>
          </div>

          <div className="genai-settings-section">
            <h3>Voice</h3>
            <div className="genai-form">
              <label>
                <span>Voice engine</span>
                <select value={engine} onChange={(e) => { setEngine(e.target.value); setVoice('') }}>
                  <option value="default">Automatic</option>
                  {engines.map((e) => <option key={e.key} value={e.key}>{e.label || e.key}</option>)}
                </select>
              </label>
              {engine !== 'default' && engineVoices.length > 0 && (
                <label>
                  <span>Voice</span>
                  <select value={voice} onChange={(e) => setVoice(e.target.value)}>
                    <option value="">Default</option>
                    {engineVoices.map((v) => <option key={v.id} value={v.id}>{v.label || v.id}</option>)}
                  </select>
                </label>
              )}
              <label>
                <span>Language you speak</span>
                <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
              </label>
            </div>
          </div>

          <div className="genai-settings-section">
            <h3>Models on the board</h3>
            <p className="hint">{status?.disk ? `${formatBytes(status.disk.freeBytes)} free.` : ''} The chat model runs one at a time; the speech model turns your voice into text.</p>
            <ModelList
              title="Chat"
              models={chatModels(status)}
              loadedNames={new Set(status?.loaded || [])}
              disabled={!usable}
              onLoad={(m) => runModelOp(`Loading ${friendlyModelName(m.name)}`, 'models/load', { name: m.name })}
              onUnload={(m) => runModelOp(`Unloading ${friendlyModelName(m.name)}`, 'models/unload', { name: m.name })}
            />
            <ModelList
              title="Speech recognition"
              models={speechModels(status)}
              activeName={status?.asrModel}
              disabled={!usable}
              onUse={(m) => runModelOp(`Switching speech recognition to ${friendlyModelName(m.name)}`, 'models/asr', { name: m.name })}
            />
          </div>

          {status?.hubEnabled && (
            <div className="genai-settings-section">
              <h3>Get more models</h3>
              <form className="genai-row" onSubmit={searchHub}>
                <input className="search-input" value={hubQuery} onChange={(e) => setHubQuery(e.target.value)} placeholder="Qwen, Whisper, Llama" aria-label="Search Hugging Face models" />
                <button type="submit" className="btn-ghost" disabled={Boolean(download)}>Search Hugging Face</button>
              </form>
              {download && (
                <div>
                  <p className="hint">{download.repoId}: {download.state}{typeof download.pct === 'number' ? ` · ${download.pct}%` : ''}{download.etaS ? ` · about ${formatDuration(download.etaS)} left` : ''}</p>
                  <ProgressBar pct={download.pct} label={`Downloading ${download.repoId}`} />
                </div>
              )}
              {hubResults && (
                <ul className="genai-models">
                  {(hubResults.results || []).length === 0 && <li className="hint">No matching models.</li>}
                  {(hubResults.results || []).map((r) => (
                    <li key={r.repoId}>
                      <span className="genai-model-name" title={r.repoId}>{friendlyModelName(r.repoId.split('/').pop())}</span>
                      <span className="genai-badge">{r.type}</span>
                      {r.alreadyInCatalog ? (
                        <span className="hint">on the board</span>
                      ) : (
                        <button type="button" className="btn-ghost genai-small" disabled={Boolean(download) || Boolean(r.unsupportedReason)} title={r.unsupportedReason || r.repoId} onClick={() => startDownload(r.repoId)}>
                          Download
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="genai-settings-section">
            <h3>Documents</h3>
            {docs.available ? (
              <>
                <p className="hint">
                  With <b>Use my documents</b> on, the board answers from these documents. Uploading a Markdown file
                  replaces them; Reset brings back the default SiMa document.
                </p>
                <p className="genai-doc-summary">{documentsSummary(docStatus)}</p>
                <input ref={docInput} type="file" accept=".md,text/markdown" hidden onChange={(e) => { runDocumentTask('Uploading', (o) => uploadDocument(e.target.files[0], o)); e.target.value = '' }} />
                <div className="genai-actions">
                  <button type="button" className="btn-tonal" disabled={!!docProgress} onClick={() => docInput.current?.click()}>Upload a Markdown file</button>
                  <button type="button" className="btn-ghost" disabled={!!docProgress} onClick={() => runDocumentTask('Resetting', resetDocuments)}>Reset to the default</button>
                  <button type="button" className="btn-ghost danger" disabled={!!docProgress || !(docStatus && docStatus.database)} onClick={() => window.confirm('Remove all documents from the board? Use my documents then finds nothing until you upload or reset.') && runDocumentTask('Clearing', clearDocuments)}>Clear</button>
                </div>
                {docProgress && (
                  <p className="hint" aria-live="polite">{docProgress.label}… {progressOutcome(docProgress.text).message}</p>
                )}
              </>
            ) : (
              <p className="hint">{docs.reason}</p>
            )}
          </div>

          <div className="genai-settings-section">
            <h3>Troubleshooting</h3>
            <p className="hint">
              If a model load fails or replies stop, restart GenAI Studio on the board: <code>./run.sh stop</code>, then <code>{START_COMMAND}</code>.
              That frees the accelerator; then load the model again.
            </p>
          </div>
        </section>
      )}

      <section className="panel genai-chat" aria-label="Chat">
        {docsMidChat && useDocs && messages.length > 0 && (
          <div className="genai-docs-hint" role="status">
            <span>Earlier replies in this chat can win over your documents. Start a new chat to answer from them.</span>
            <button type="button" className="btn-tonal genai-small" onClick={newChat}>New chat</button>
            <button type="button" className="btn-ghost genai-small" onClick={() => setDocsMidChat(false)}>Keep this chat</button>
          </div>
        )}
        <div className="genai-transcript" ref={transcriptBox} onScroll={onTranscriptScroll}>
          {messages.length === 0 && (
            <div className="genai-welcome">
              <p className="genai-welcome-title">Chat with {chatModel ? friendlyModelName(chatModel.name) : 'a model'} on your board</p>
              <p className="section-note">
                Type or talk, {sees ? 'add a picture, ' : ''}and hear the answer read aloud, in most languages. New here? Open the Tutorial.
              </p>
              <div className="genai-examples" aria-label="Examples to try">
                <span className="hint">Try:</span>
                <button type="button" className="btn-ghost genai-small" disabled={!canChat} onClick={() => tryPrompt('Explain what an AI accelerator does, in simple terms.')}>
                  Explain what an AI accelerator does
                </button>
                {sees && (
                  <button type="button" className="btn-ghost genai-small" disabled={!canChat} onClick={openCamera}>
                    What's in front of my camera?
                  </button>
                )}
                <button type="button" className="btn-ghost genai-small" disabled={!canChat} onClick={() => tryPrompt("Translate 'good morning, how are you?' into Spanish.")}>
                  Translate into Spanish
                </button>
                <button type="button" className="btn-ghost genai-small" disabled={!usable || !status?.asrModel} onClick={toggleRecording}>
                  Ask by voice
                </button>
              </div>
              {usable && !chatModel && chatModels(status).length > 0 && (
                <p className="hint">Choose a model at the top to start; loading takes a few minutes.</p>
              )}
            </div>
          )}
          {messages.map((m, index) => {
            if (m.role === 'user') {
              return (
                <div key={index} className="genai-msg genai-msg-user">
                  {m.image && <img src={m.image} alt="Sent with this message" className="genai-msg-image" />}
                  <p>{m.text}</p>
                  <Metrics items={m.heard} label="How fast your speech was heard" />
                </div>
              )
            }
            const parts = splitThinking(m.content)
            const speaking = speakingId === m.id
            const support = parts.answer && !m.pending ? voiceLanguageFor(parts.answer) : null
            return (
              <div key={index} className="genai-msg genai-msg-assistant">
                {parts.thinking && (
                  <details className="genai-thinking" open={!parts.thinkingDone}>
                    <summary>{parts.thinkingDone ? 'How it reasoned' : 'Thinking…'}</summary>
                    <p>{parts.thinking}</p>
                  </details>
                )}
                {parts.answer ? (
                  <div className="genai-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{parts.answer}</ReactMarkdown></div>
                ) : (
                  m.pending && !parts.thinking && <p className="hint">Writing…</p>
                )}
                {m.stopped && <p className="hint">Stopped.</p>}
                {m.error && <p className="genai-error">{m.error}</p>}
                {m.rag && <p className="hint genai-sources">{sourcesNote(m.rag)}</p>}
                <Metrics items={m.metrics} label="How fast the model answered" />
                <Metrics items={speechStats[m.id]} label="How fast the reply was spoken" />
                {speechError && speechError.id === m.id && <p className="genai-error">{speechError.text}</p>}
                {support && !support.supported && (
                  <p className="hint genai-no-voice" title={voices ? `The board's voices speak ${languageNames(voices.languages).join(', ')}.` : ''}>
                    Can't read {support.name} aloud yet: the board has no {support.name} voice.
                  </p>
                )}
                {speaking ? (
                  // Also while the reply is still being written and read.
                  <button type="button" className="btn-ghost genai-small" onClick={stopSpeaking}>Stop speaking</button>
                ) : (
                  support && support.supported && (
                    <button type="button" className="btn-ghost genai-small" onClick={() => speakText(parts.answer, m.id)} disabled={!usable} title={usable ? 'Read this reply aloud' : backend.title}>
                      Read aloud
                    </button>
                  )
                )}
              </div>
            )
          })}
        </div>

        {cameraOpen && (
          <div className="genai-camera">
            <video ref={videoRef} autoPlay playsInline muted aria-label="Camera preview" />
            <div className="genai-actions">
              <button type="button" className="btn-tonal" onClick={captureFrame}>Use this picture</button>
              <button type="button" className="btn-ghost" onClick={closeCamera}>Cancel</button>
            </div>
          </div>
        )}

        {image && (
          <div className="genai-attachment">
            <img src={image} alt="Picture to send with your next message" />
            <span className="hint">Sent with your next message.</span>
            <button type="button" className="btn-ghost genai-small" onClick={() => setImage(null)}>Remove</button>
          </div>
        )}

        {(recording || transcribing) && (
          <p className="genai-listening" aria-live="polite">
            {recording ? 'Listening… press the microphone again when you finish.' : 'Turning your speech into text…'}
          </p>
        )}

        <form className={`genai-composer${spot('composer')}`} onSubmit={(e) => { e.preventDefault(); sendMessage() }}>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => { attachImage(e.target.files[0]); e.target.value = '' }} />
          <textarea
            ref={composer}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendMessage()
              }
            }}
            placeholder={canChat ? 'Ask anything, or press the microphone and speak' : (usable ? 'Choose a model at the top first' : backend.title)}
            aria-label="Message"
            rows={1}
            disabled={!canChat}
          />
          <div className="genai-composer-tools">
            <span className={`genai-composer-media${spot('media')}`}>
              <button type="button" className="btn-ghost genai-icon-btn" aria-label="Attach a picture" title={sees ? 'Attach a picture' : 'Needs a model that sees images'} disabled={!canChat || !sees} onClick={() => fileInput.current?.click()}>
                <Icon d={ICONS.photo} />
              </button>
              <button type="button" className="btn-ghost genai-icon-btn" aria-label="Take a picture with the camera" title={sees ? 'Take a picture with the camera' : 'Needs a model that sees images'} disabled={!canChat || !sees || cameraOpen} onClick={openCamera}>
                <Icon d={ICONS.camera} />
              </button>
            </span>
            <span className="genai-header-spacer" />
            <button
              type="button"
              className={`${recording ? 'btn-ghost danger genai-icon-btn' : 'btn-ghost genai-icon-btn'}${spot('mic')}`}
              aria-label={recording ? 'Stop recording' : 'Speak your question'}
              aria-pressed={recording}
              title={recording ? 'Stop recording' : 'Speak your question'}
              disabled={!usable || !status?.asrModel || transcribing}
              onClick={toggleRecording}
            >
              <Icon d={ICONS.mic} />
            </button>
            {streaming ? (
              <button type="button" className="genai-send genai-send-stop" aria-label="Stop the reply" title="Stop the reply" onClick={() => chatAbort.current?.abort()}>
                <Icon d={ICONS.stop} />
              </button>
            ) : (
              <button type="submit" className="genai-send" aria-label="Send" title="Send" disabled={!canChat || (!draft.trim() && !image)}>
                <Icon d={ICONS.send} />
              </button>
            )}
          </div>
        </form>
      </section>

      {benchOpen && (
        <Suspense fallback={null}>
          <GenAIBenchmark status={status} onClose={() => setBenchOpen(false)} onModelsChanged={refresh} />
        </Suspense>
      )}

      {solutionsOpen && (
        <SolutionsOverlay
          model={chatModel ? chatModel.name : null}
          sees={Boolean(chatModel && sees)}
          onClose={() => setSolutionsOpen(false)}
        />
      )}
    </div>
  )
}

// SiMaSentry Solutions, like the standalone Studio's shield button: a launcher
// with the three demo apps, each opened full screen in a frame and wired to the
// loaded model through the relay. An app's own Home button returns here.
function SolutionsOverlay({ model, sees, onClose }) {
  const [open, setOpen] = useState(null)
  const frame = useRef(null)

  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Escape') return
      if (open) setOpen(null)
      else onClose()
    }
    function onMessage(e) {
      if (!frame.current || e.source !== frame.current.contentWindow || e.origin !== window.location.origin) return
      if (e.data && typeof e.data === 'object' && e.data.type === 'sima-sentry:home') setOpen(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('message', onMessage)
    }
  }, [open, onClose])

  function launch(app) {
    if (!sees) {
      const why = model
        ? `${friendlyModelName(model)} doesn't see images, so the ${app.name} picture features won't work. Open it anyway?`
        : `No chat model is loaded, so ${app.name} can't answer until you load one. Open it anyway?`
      if (!window.confirm(why)) return
    }
    setOpen(app)
  }

  return (
    <div className="genai-solutions" role="dialog" aria-modal="true" aria-label="SiMaSentry Solutions">
      {open ? (
        <iframe ref={frame} className="genai-solutions-frame" title={open.name} src={solutionUrl(open.mode, model)} allow="camera; microphone; fullscreen" />
      ) : (
        <div className="genai-solutions-grid">
          <h2>SiMaSentry <span>Solutions</span></h2>
          <p>Demo apps that run on the board's loaded model, entirely on the device.</p>
          <p className="genai-solutions-model">
            {model ? <>Using <b>{friendlyModelName(model)}</b>{sees ? '' : ': load a model that sees images for the picture features'}</> : 'No model loaded: choose one in the Model menu first'}
          </p>
          <div className="genai-solutions-cards">
            {SOLUTIONS.map((app) => (
              <button key={app.mode} type="button" className="genai-solutions-card" onClick={() => launch(app)}>
                {!sees && <span className="genai-solutions-badge">{model ? 'no vision support' : 'no model loaded'}</span>}
                <img src={`${SOLUTIONS_ROOT}/${app.mode}/${app.image}`} alt="" loading="lazy" />
                <span className="genai-solutions-name">{app.name}</span>
                <span className="genai-solutions-summary">{app.summary}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="genai-solutions-actions">
        {open && <button type="button" className="btn-ghost" onClick={() => setOpen(null)} title="Back to the solutions">Back</button>}
        {open && <a className="btn-ghost" href={solutionUrl(open.mode, model)} target="_blank" rel="noopener" title="Open in a new tab">New tab</a>}
        <button type="button" className="btn-ghost" onClick={onClose} title="Close (Esc)">Close</button>
      </div>
    </div>
  )
}

function ModelList({ title, models, loadedNames, activeName, disabled, onLoad, onUnload, onUse }) {
  return (
    <div className="genai-model-group">
      <p className="genai-model-group-title">{title}</p>
      {models.length === 0 && <p className="hint">None on the board yet.</p>}
      <ul className="genai-models">
        {models.map((m) => {
          const loaded = loadedNames ? loadedNames.has(m.name) : false
          const active = activeName === m.name
          return (
            <li key={m.name}>
              <span className="genai-model-name" title={m.name}>{friendlyModelName(m.name)}</span>
              {m.supportsVision && <span className="genai-badge">sees images</span>}
              {(loaded || active) && <span className="genai-badge genai-badge-on">{active ? 'in use' : 'loaded'}</span>}
              {m.sizeBytes ? <span className="hint">{formatBytes(m.sizeBytes)}</span> : null}
              {onLoad && !loaded && (
                <button type="button" className="btn-ghost genai-small" disabled={disabled || m.supported === false} title={m.unsupportedReason || (m.estimatedLoadS ? `About ${formatDuration(m.estimatedLoadS)} to load` : '')} onClick={() => onLoad(m)}>
                  Load
                </button>
              )}
              {onUnload && loaded && (
                <button type="button" className="btn-ghost genai-small" disabled={disabled} onClick={() => onUnload(m)}>Unload</button>
              )}
              {onUse && !active && (
                <button type="button" className="btn-ghost genai-small" disabled={disabled} onClick={() => onUse(m)}>Use</button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
