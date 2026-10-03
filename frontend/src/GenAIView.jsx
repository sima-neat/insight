import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  START_COMMAND,
  canUseModels,
  chatModels,
  deriveBackendState,
  formatBytes,
  formatDuration,
  friendlyModelName,
  loadedChatModel,
  speechModels
} from './genai/backendState.js'
import {
  GenaiError,
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
import { speakableText } from './genai/speech.js'
import { splitThinking } from './genai/streams.js'

const POLL_MS = 5000
const MAX_TOKENS = 512
// The Studio's default system prompt (apps: src/common/config.yaml), plus a rule
// against describing images that were never attached: vision models otherwise
// answer "what do you see?" with an invented scene.
const SYSTEM_PROMPT =
  'Answer clearly and concisely. Use Markdown formatting when it helps. ' +
  'Answer the question in the language it was asked in. ' +
  'You can only see images that are attached to the current message. ' +
  'If the user asks about an image, photo, camera or what you see and no image is attached, ' +
  'say that no image was provided and ask them to attach one or use the camera. ' +
  'Never describe an image you were not given.'
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
  chat: 'M4 5h16v11H9l-5 4z',
  translate: 'M4 5h8M8 3v2M6 5c0 4 2 7 6 8M10 5c0 3-2 6-6 8M13 21l4-10 4 10M14.5 17h5',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .5-1.5-1.5.5-2-3-1-1 2h-2l-1-2-3 1 .5 2L5 8.5 3 8l-1 3 2 1v0l-2 1 1 3 2-.5L6.5 16 6 18l3 1 1-2h2l1 2 3-1-.5-2 1.5-1.5 2 .5 1-3z'
}

function StatusChip({ state }) {
  const labels = {
    ready: 'Ready',
    busy: 'Busy',
    starting: 'Starting',
    failed: 'Error',
    unavailable: 'Not running',
    unconfigured: 'Not set up',
    incompatible: 'Incompatible'
  }
  return <span className={`genai-pill genai-pill-${state}`}>{labels[state] || state}</span>
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
  const [addressDraft, setAddressDraft] = useState('')
  const [tokenDraft, setTokenDraft] = useState('')
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
  const spokenLanguage = useRef(null)

  const [hubQuery, setHubQuery] = useState('')
  const [hubResults, setHubResults] = useState(null)
  const [download, setDownload] = useState(null)

  const backend = deriveBackendState({ health, status, busyOp, lastError })
  const usable = canUseModels(backend.state)
  const chatModel = loadedChatModel(status)
  const sees = Boolean(chatModel && chatModel.supportsVision)

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

  // --- settings and recovery -------------------------------------------------

  async function applySettings(event) {
    event.preventDefault()
    try {
      const update = { url: addressDraft.trim() }
      if (tokenDraft.trim()) update.resetToken = tokenDraft.trim()
      const saved = await saveSettings(update)
      setSettings(saved)
      setTokenDraft('')
      setVoices(null)
      onStatus?.('Board settings saved.')
      refresh()
    } catch (error) {
      onError?.(error.message)
    }
  }

  async function restartAccelerator() {
    if (!window.confirm('Restart the board\'s accelerator? Every model is unloaded and the model server restarts; a reply in progress stops.')) return
    setBusyOp('Restarting the accelerator')
    try {
      await postJson('models/reset-mla', {})
      setLastError(null)
      onStatus?.('Accelerator restarted. Load a chat model to continue.')
    } catch (error) {
      if (error instanceof GenaiError && error.status === 401) {
        const token = window.prompt('Restarting the accelerator needs the reset token that run.sh printed on the board. Enter it to save it for next time:')
        if (token && token.trim()) {
          try {
            setSettings(await saveSettings({ resetToken: token.trim() }))
            await postJson('models/reset-mla', {})
            setLastError(null)
            onStatus?.('Accelerator restarted. Load a chat model to continue.')
          } catch (retryError) {
            fail(`Restart failed: ${retryError.message}`)
          }
        }
      } else {
        fail(`Restart failed: ${error.message}`)
      }
    } finally {
      setBusyOp(null)
      refresh()
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

  async function speakText(text, id, audio = unlockPlayer()) {
    stopSpeaking()
    const words = speakableText(text)
    if (!words) return
    const controller = new AbortController()
    speechAbort.current = controller
    setSpeakingId(id)
    try {
      const lang = spokenLanguage.current || (language !== 'auto' ? language : 'en')
      const result = await speak({ text: words, model: engine, voice: voice || undefined, language: lang, signal: controller.signal })
      if (controller.signal.aborted) return
      const url = URL.createObjectURL(result.audio)
      const done = () => {
        URL.revokeObjectURL(url)
        setSpeakingId((current) => (current === id ? null : current))
      }
      audio.onended = done
      audio.onpause = done
      audio.src = url
      await audio.play()
    } catch (error) {
      setSpeakingId((current) => (current === id ? null : current))
      if (error.name !== 'AbortError') onError?.(`Couldn't read the reply aloud: ${error.message}`)
    }
  }

  // --- chat -------------------------------------------------------------------

  function withNoThink(content) {
    if (typeof content === 'string') return `/no_think ${content}`
    return content.map((part) => (part.type === 'text' ? { ...part, text: `/no_think ${part.text}` } : part))
  }

  async function sendMessage(text = draft, { replyPlayer = readAloud ? unlockPlayer() : null } = {}) {
    const prompt = text.trim()
    if ((!prompt && !image) || !chatModel || streaming) return
    const userText = prompt || 'Describe this image.'
    const userContent = image
      ? [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: image } }]
      : userText
    const history = messagesRef.current.map((m) => ({ role: m.role, content: m.role === 'assistant' ? splitThinking(m.content).answer : m.text }))
    const outgoing = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: thinking ? userContent : withNoThink(userContent) }
    ]
    const replyId = Date.now()
    setMessages((prev) => [...prev, { role: 'user', text: userText, image }, { role: 'assistant', id: replyId, content: '', pending: true }])
    setDraft('')
    setImage(null)
    stickToBottom.current = true
    setStreaming(true)
    const controller = new AbortController()
    chatAbort.current = controller
    let reply = ''
    const update = (extra) => setMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', id: replyId, content: reply, ...extra }])
    try {
      await streamChat({
        model: chatModel.name,
        messages: outgoing,
        maxTokens: MAX_TOKENS,
        signal: controller.signal,
        onDelta: (piece) => {
          reply += piece
          update({ pending: true })
        }
      })
      update({})
      if (replyPlayer) speakText(splitThinking(reply).answer, replyId, replyPlayer)
    } catch (error) {
      const stopped = error.name === 'AbortError'
      update({ stopped, error: stopped ? null : error.message })
      if (!stopped) fail(`The chat model didn't answer: ${error.message}`)
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
          const result = await transcribe(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }), { language })
          const heard = (result.text || '').trim()
          if (!heard || result.ignored) {
            onStatus?.("Didn't catch that. Try again a little closer to the microphone.")
          } else {
            spokenLanguage.current = result.tts_language || null
            if (chatModel) sendMessage(heard, { replyPlayer })
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

  function tryPrompt(text) {
    setDraft(text)
    composer.current?.focus()
  }

  const engines = (voices && voices.engines) || []
  const engineVoices = useMemo(() => {
    const found = engines.find((e) => e.key === engine)
    return (found && found.voices) || []
  }, [engines, engine])
  const needsAttention = backend.state !== 'ready'
  const canChat = usable && Boolean(chatModel)

  // --- render -----------------------------------------------------------------

  return (
    <div className="genai">
      <section className="panel genai-header" aria-label="GenAI Studio">
        <StatusChip state={backend.state} />
        <label className="genai-model-picker">
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
        <label className="genai-check" title="Read every reply aloud with the board's speech engine">
          <input type="checkbox" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} />
          Read replies aloud
        </label>
        <label className="genai-check" title="Lets reasoning models think step by step before answering. Slower, sometimes better.">
          <input type="checkbox" checked={thinking} onChange={(e) => setThinking(e.target.checked)} />
          Think first
        </label>
        <button
          type="button"
          className={settingsOpen ? 'btn-tonal genai-settings-btn' : 'btn-ghost genai-settings-btn'}
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <Icon d={ICONS.settings} /> Settings
        </button>
      </section>

      {needsAttention && (
        <section className={`panel genai-banner genai-banner-${backend.state}`} aria-live="polite">
          <p className="genai-banner-title">{backend.title}</p>
          {backend.detail && <p className="section-note">{backend.detail}</p>}
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
            {backend.action === 'reset-mla' && (
              <button type="button" className="btn-ghost danger" onClick={restartAccelerator}>Restart the accelerator</button>
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
              <label>
                <span>Reset token</span>
                <input type="password" value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} placeholder={settings?.hasResetToken ? 'Saved' : 'Printed by run.sh'} autoComplete="off" />
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
            <h3>Troubleshooting</h3>
            <p className="hint">If a model load gets stuck or replies stop, restart the board's accelerator. Every model is unloaded and the model server restarts.</p>
            <button type="button" className="btn-ghost danger" onClick={restartAccelerator} disabled={!health || health.httpStatus !== 200}>
              Restart the accelerator
            </button>
          </div>
        </section>
      )}

      <section className="panel genai-chat" aria-label="Chat">
        <div className="genai-transcript" ref={transcriptBox} onScroll={onTranscriptScroll}>
          {messages.length === 0 && (
            <div className="genai-welcome">
              <p className="genai-welcome-title">What you can do with GenAI on the board</p>
              <p className="section-note">
                Everything runs on the DevKit's accelerator{chatModel ? ` with ${friendlyModelName(chatModel.name)}` : ''}. Pick one to try.
              </p>
              <div className="genai-cards">
                <button type="button" className="genai-card" disabled={!canChat} onClick={() => tryPrompt('Explain what an AI accelerator does, in simple terms.')}>
                  <Icon d={ICONS.chat} />
                  <span className="genai-card-title">Ask a question</span>
                  <span className="genai-card-hint">Explain what an AI accelerator does</span>
                </button>
                <button type="button" className="genai-card" disabled={!canChat || !sees} onClick={openCamera} title={sees ? '' : 'Needs a model that sees images'}>
                  <Icon d={ICONS.camera} />
                  <span className="genai-card-title">Show it something</span>
                  <span className="genai-card-hint">{sees ? 'Use the camera or a photo' : 'Needs a model that sees images'}</span>
                </button>
                <button type="button" className="genai-card" disabled={!usable || !status?.asrModel} onClick={toggleRecording}>
                  <Icon d={ICONS.mic} />
                  <span className="genai-card-title">Talk to it</span>
                  <span className="genai-card-hint">Speak, then turn on Read replies aloud</span>
                </button>
                <button type="button" className="genai-card" disabled={!canChat} onClick={() => tryPrompt('Translate into German: Good morning, how are you today?')}>
                  <Icon d={ICONS.translate} />
                  <span className="genai-card-title">Translate</span>
                  <span className="genai-card-hint">Say this in German</span>
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
                </div>
              )
            }
            const parts = splitThinking(m.content)
            const speaking = speakingId === m.id
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
                {!m.pending && parts.answer && (
                  speaking ? (
                    <button type="button" className="btn-ghost genai-small" onClick={stopSpeaking}>Stop speaking</button>
                  ) : (
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

        <form className="genai-composer" onSubmit={(e) => { e.preventDefault(); sendMessage() }}>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => { attachImage(e.target.files[0]); e.target.value = '' }} />
          <button type="button" className="btn-ghost genai-icon-btn" aria-label="Attach a picture" title={sees ? 'Attach a picture' : 'Needs a model that sees images'} disabled={!canChat || !sees} onClick={() => fileInput.current?.click()}>
            <Icon d={ICONS.photo} />
          </button>
          <button type="button" className="btn-ghost genai-icon-btn" aria-label="Take a picture with the camera" title={sees ? 'Take a picture with the camera' : 'Needs a model that sees images'} disabled={!canChat || !sees || cameraOpen} onClick={openCamera}>
            <Icon d={ICONS.camera} />
          </button>
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
          <button
            type="button"
            className={recording ? 'btn-ghost danger genai-icon-btn' : 'btn-ghost genai-icon-btn'}
            aria-label={recording ? 'Stop recording' : 'Speak your question'}
            aria-pressed={recording}
            title={recording ? 'Stop recording' : 'Speak your question'}
            disabled={!usable || !status?.asrModel || transcribing}
            onClick={toggleRecording}
          >
            <Icon d={ICONS.mic} />
          </button>
          {streaming ? (
            <button type="button" className="btn-ghost danger" onClick={() => chatAbort.current?.abort()}>Stop</button>
          ) : (
            <button type="submit" className="btn-tonal" disabled={!canChat || (!draft.trim() && !image)}>Send</button>
          )}
        </form>
        {messages.length > 0 && !streaming && (
          <button type="button" className="btn-ghost genai-small genai-new-chat" onClick={() => { stopSpeaking(); setMessages([]) }}>New chat</button>
        )}
      </section>
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
