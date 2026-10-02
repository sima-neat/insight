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
import { splitThinking } from './genai/streams.js'

const POLL_MS = 5000
const MAX_TOKENS = 512
const LANGUAGES = [
  { value: 'auto', label: 'Detect language' },
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

// Markdown in a reply would be read out symbol by symbol; speak plain text.
function speakableText(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>|~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Scale an image to the model's input size so large photos are not uploaded whole.
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

function StatePill({ state }) {
  const labels = {
    ready: 'Ready',
    busy: 'Busy',
    starting: 'Starting',
    failed: 'Error',
    unavailable: 'Unavailable',
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
  const [draft, setDraft] = useState('')
  const [image, setImage] = useState(null)
  const [thinking, setThinking] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const chatAbort = useRef(null)
  const transcriptEnd = useRef(null)

  const [cameraOpen, setCameraOpen] = useState(false)
  const videoRef = useRef(null)
  const cameraStream = useRef(null)

  const [recording, setRecording] = useState(false)
  const [transcript, setTranscript] = useState(null)
  const [language, setLanguage] = useState('auto')
  const [speakReplies, setSpeakReplies] = useState(false)
  const [engine, setEngine] = useState('default')
  const [voice, setVoice] = useState('')
  const recorder = useRef(null)
  const player = useRef(null)

  const [hubQuery, setHubQuery] = useState('')
  const [hubResults, setHubResults] = useState(null)
  const [download, setDownload] = useState(null)

  const backend = deriveBackendState({ health, status, busyOp, lastError })
  const usable = canUseModels(backend.state)
  const chatModel = loadedChatModel(status)

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

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  useEffect(() => () => {
    chatAbort.current?.abort()
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
      setSettingsOpen(false)
      setVoices(null)
      onStatus?.('GenAI board settings saved.')
      refresh()
    } catch (error) {
      onError?.(error.message)
    }
  }

  async function resetMla() {
    if (!window.confirm('Reset the board\'s accelerator? Every model is unloaded and the model server restarts; any reply in progress stops.')) return
    setBusyOp('Resetting the MLA')
    try {
      await postJson('models/reset-mla', {})
      setLastError(null)
      onStatus?.('Accelerator reset. The model server is restarting.')
    } catch (error) {
      if (error instanceof GenaiError && error.status === 401) {
        const token = window.prompt('Reset MLA needs the reset token that run.sh printed on the board. Enter it to save it for next time:')
        if (token && token.trim()) {
          try {
            setSettings(await saveSettings({ resetToken: token.trim() }))
            await postJson('models/reset-mla', {})
            setLastError(null)
            onStatus?.('Accelerator reset. The model server is restarting.')
          } catch (retryError) {
            fail(`Reset failed: ${retryError.message}`)
          }
        }
      } else {
        fail(`Reset failed: ${error.message}`)
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

  // --- chat -------------------------------------------------------------------

  async function sendMessage(text = draft) {
    const prompt = text.trim()
    if ((!prompt && !image) || !chatModel || streaming) return
    const userContent = image
      ? [{ type: 'text', text: prompt || 'Describe this image.' }, { type: 'image_url', image_url: { url: image } }]
      : prompt
    const history = messages.map((m) => ({ role: m.role, content: m.role === 'assistant' ? splitThinking(m.content).answer : m.text }))
    const outgoing = [...history, { role: 'user', content: thinking ? userContent : withNoThink(userContent) }]
    setMessages((prev) => [...prev, { role: 'user', text: prompt || 'Describe this image.', image }, { role: 'assistant', content: '', pending: true }])
    setDraft('')
    setImage(null)
    setStreaming(true)
    const controller = new AbortController()
    chatAbort.current = controller
    let reply = ''
    try {
      await streamChat({
        model: chatModel.name,
        messages: outgoing,
        maxTokens: MAX_TOKENS,
        signal: controller.signal,
        onDelta: (piece) => {
          reply += piece
          setMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', content: reply, pending: true }])
        }
      })
      setMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', content: reply }])
      if (speakReplies) speakText(splitThinking(reply).answer)
    } catch (error) {
      const stopped = error.name === 'AbortError'
      setMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', content: reply, stopped, error: stopped ? null : error.message }])
      if (!stopped) fail(`Chat failed: ${error.message}`)
    } finally {
      setStreaming(false)
      chatAbort.current = null
    }
  }

  function withNoThink(content) {
    if (typeof content === 'string') return `/no_think ${content}`
    return content.map((part) => (part.type === 'text' ? { ...part, text: `/no_think ${part.text}` } : part))
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
      onError?.(`Camera unavailable: ${error.message}. Allow camera access for this page, then try again.`)
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
  }

  // --- speech -----------------------------------------------------------------

  async function toggleRecording() {
    if (recording) {
      recorder.current?.stop()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const chunks = []
      const rec = new MediaRecorder(stream)
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setRecording(false)
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        const started = performance.now()
        try {
          const result = await transcribe(blob, { language })
          setTranscript({ ...result, seconds: (performance.now() - started) / 1000 })
        } catch (error) {
          fail(`Transcription failed: ${error.message}`)
        }
      }
      recorder.current = rec
      rec.start()
      setRecording(true)
      setTranscript(null)
    } catch (error) {
      onError?.(`Microphone unavailable: ${error.message}. Allow microphone access for this page, then try again.`)
    }
  }

  async function speakText(text) {
    const words = speakableText(text)
    if (!words) return
    try {
      const lang = transcript?.tts_language || (language !== 'auto' ? language : 'en')
      const result = await speak({ text: words, model: engine, voice: voice || undefined, language: lang })
      const url = URL.createObjectURL(result.audio)
      player.current?.pause()
      const audio = new Audio(url)
      audio.onended = () => URL.revokeObjectURL(url)
      player.current = audio
      await audio.play()
    } catch (error) {
      onError?.(`Speech failed: ${error.message}`)
    }
  }

  const engines = (voices && voices.engines) || []
  const engineVoices = useMemo(() => {
    const found = engines.find((e) => e.key === engine)
    return (found && found.voices) || []
  }, [engines, engine])

  // --- render -----------------------------------------------------------------

  return (
    <div className="genai">
      <section className={`panel genai-banner genai-banner-${backend.state}`} aria-live="polite">
        <div className="genai-banner-main">
          <StatePill state={backend.state} />
          <div>
            <p className="genai-banner-title">{backend.title}</p>
            {backend.detail && <p className="section-note">{backend.detail}</p>}
            {backend.state === 'busy' && loadProgress && (
              <ProgressBar pct={loadProgress.pct} label={`Loading ${loadProgress.name}`} />
            )}
          </div>
        </div>
        <div className="genai-banner-meta">
          {status && (
            <span className="section-note">
              Chat: {chatModel ? chatModel.name : 'none loaded'} · Speech: {status.asrModel || 'none'}
            </span>
          )}
          <span className="section-note">Board: {settings?.url || 'not set'}</span>
          <div className="genai-actions">
            {backend.action === 'start-command' && (
              <button type="button" className="btn-ghost" onClick={() => navigator.clipboard?.writeText(START_COMMAND).then(() => onStatus?.('Start command copied.'))}>
                Copy start command
              </button>
            )}
            {(backend.state === 'failed' || backend.state === 'ready') && (
              <button type="button" className="btn-ghost danger" onClick={resetMla} title="Unload every model and restart the model server">
                Reset MLA
              </button>
            )}
            {lastError && <button type="button" className="btn-ghost" onClick={() => setLastError(null)}>Dismiss error</button>}
            <button type="button" className="btn-ghost" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>
              Board settings
            </button>
          </div>
        </div>
        {(settingsOpen || backend.state === 'unconfigured') && (
          <form className="genai-settings" onSubmit={applySettings}>
            <label>
              <span>Board address</span>
              <input
                value={addressDraft}
                onChange={(e) => setAddressDraft(e.target.value)}
                placeholder={settings?.defaultUrl || 'https://<board-ip>:5000'}
                aria-describedby="genai-address-hint"
              />
            </label>
            <label>
              <span>Reset MLA token</span>
              <input
                type="password"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder={settings?.hasResetToken ? 'Saved (enter a new one to replace it)' : 'Printed by run.sh on the board'}
                autoComplete="off"
              />
            </label>
            <button type="submit" className="btn-tonal">Save</button>
            <p id="genai-address-hint" className="hint">
              Leave the address empty to use {settings?.defaultUrl || 'the paired DevKit'}. Start the backend on the board with <code>{START_COMMAND}</code>.
            </p>
          </form>
        )}
      </section>

      <div className="grid two genai-grid">
        <section className="panel genai-chat" aria-label="Chat">
          <div className="panel-topbar">
            <div>
              <h2>Chat</h2>
              <p className="section-note">
                {chatModel ? `${chatModel.name}${chatModel.supportsVision ? ' · accepts images' : ''}` : 'Load a chat model to start.'}
              </p>
            </div>
            <label className="genai-check">
              <input type="checkbox" checked={thinking} onChange={(e) => setThinking(e.target.checked)} />
              Thinking
            </label>
          </div>

          <div className="genai-transcript">
            {messages.length === 0 && <p className="empty">Replies stream here as the board generates them.</p>}
            {messages.map((m, index) => {
              if (m.role === 'user') {
                return (
                  <div key={index} className="genai-msg genai-msg-user">
                    {m.image && <img src={m.image} alt="Attached to this message" className="genai-msg-image" />}
                    <p>{m.text}</p>
                  </div>
                )
              }
              const parts = splitThinking(m.content)
              return (
                <div key={index} className="genai-msg genai-msg-assistant">
                  {parts.thinking && (
                    <details className="genai-thinking" open={!parts.thinkingDone}>
                      <summary>{parts.thinkingDone ? 'Reasoning' : 'Thinking…'}</summary>
                      <p>{parts.thinking}</p>
                    </details>
                  )}
                  {parts.answer ? (
                    <div className="genai-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{parts.answer}</ReactMarkdown></div>
                  ) : (
                    m.pending && !parts.thinking && <p className="hint">Waiting for the first words…</p>
                  )}
                  {m.stopped && <p className="hint">Stopped.</p>}
                  {m.error && <p className="genai-error">{m.error}</p>}
                  {!m.pending && parts.answer && (
                    <button type="button" className="btn-ghost genai-small" onClick={() => speakText(parts.answer)} disabled={!usable}>
                      Speak
                    </button>
                  )}
                </div>
              )
            })}
            <div ref={transcriptEnd} />
          </div>

          {cameraOpen && (
            <div className="genai-camera">
              <video ref={videoRef} autoPlay playsInline muted aria-label="Camera preview" />
              <div className="genai-actions">
                <button type="button" className="btn-tonal" onClick={captureFrame}>Use this frame</button>
                <button type="button" className="btn-ghost" onClick={closeCamera}>Cancel</button>
              </div>
            </div>
          )}

          {image && (
            <div className="genai-attachment">
              <img src={image} alt="Image to send with the next message" />
              <button type="button" className="btn-ghost genai-small" onClick={() => setImage(null)}>Remove image</button>
            </div>
          )}

          <form className="genai-composer" onSubmit={(e) => { e.preventDefault(); sendMessage() }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendMessage()
                }
              }}
              placeholder={chatModel ? 'Ask something (Shift+Enter for a new line)' : 'Load a chat model first'}
              aria-label="Message"
              rows={2}
              disabled={!usable || !chatModel}
            />
            <div className="genai-actions">
              {chatModel?.supportsVision && (
                <>
                  <label className="btn-ghost genai-file">
                    Image
                    <input type="file" accept="image/*" onChange={(e) => { attachImage(e.target.files[0]); e.target.value = '' }} disabled={!usable} />
                  </label>
                  <button type="button" className="btn-ghost" onClick={openCamera} disabled={!usable || cameraOpen}>Camera</button>
                </>
              )}
              {messages.length > 0 && !streaming && (
                <button type="button" className="btn-ghost" onClick={() => setMessages([])}>New chat</button>
              )}
              {streaming ? (
                <button type="button" className="btn-ghost danger" onClick={() => chatAbort.current?.abort()}>Stop</button>
              ) : (
                <button type="submit" className="btn-tonal" disabled={!usable || !chatModel || (!draft.trim() && !image)}>Send</button>
              )}
            </div>
          </form>
        </section>

        <div className="genai-side">
          <section className="panel" aria-label="Speech">
            <div className="panel-topbar">
              <div>
                <h2>Speech</h2>
                <p className="section-note">Speech to text with {status?.asrModel || 'the active speech model'}.</p>
              </div>
            </div>
            <div className="genai-speech-row">
              <button
                type="button"
                className={recording ? 'btn-ghost danger' : 'btn-tonal'}
                onClick={toggleRecording}
                disabled={!usable || !status?.asrModel}
                aria-pressed={recording}
              >
                {recording ? 'Stop recording' : 'Record'}
              </button>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Spoken language">
                {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            {transcript && (
              <div className="genai-transcript-result">
                <p className="genai-quote">{transcript.text || '(no speech detected)'}</p>
                <p className="hint">
                  {transcript.language ? `Language: ${transcript.language}` : ''}
                  {transcript.ignored ? ' · ignored as silence or noise' : ''}
                  {` · ${transcript.seconds.toFixed(2)} s`}
                </p>
                <div className="genai-actions">
                  <button type="button" className="btn-tonal genai-small" disabled={!transcript.text || !chatModel || streaming} onClick={() => sendMessage(transcript.text)}>
                    Ask the chat model
                  </button>
                  <button type="button" className="btn-ghost genai-small" disabled={!transcript.text} onClick={() => setDraft(transcript.text)}>
                    Edit in chat
                  </button>
                </div>
              </div>
            )}
            <div className="genai-voice">
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
              <label className="genai-check">
                <input type="checkbox" checked={speakReplies} onChange={(e) => setSpeakReplies(e.target.checked)} />
                Speak replies
              </label>
            </div>
          </section>

          <section className="panel" aria-label="Models">
            <div className="panel-topbar">
              <div>
                <h2>Models</h2>
                <p className="section-note">
                  {status?.disk ? `${formatBytes(status.disk.freeBytes)} free on the board` : 'Models on the board'}
                </p>
              </div>
            </div>
            <ModelList
              title="Chat and vision"
              models={chatModels(status)}
              loadedNames={new Set(status?.loaded || [])}
              disabled={!usable}
              onLoad={(m) => runModelOp(`Loading ${m.name}`, 'models/load', { name: m.name })}
              onUnload={(m) => runModelOp(`Unloading ${m.name}`, 'models/unload', { name: m.name })}
            />
            <ModelList
              title="Speech to text"
              models={speechModels(status)}
              activeName={status?.asrModel}
              disabled={!usable}
              onUse={(m) => runModelOp(`Switching speech to ${m.name}`, 'models/asr', { name: m.name })}
            />
            {status?.hubEnabled && (
              <div className="genai-hub">
                <form className="genai-speech-row" onSubmit={searchHub}>
                  <input className="search-input" value={hubQuery} onChange={(e) => setHubQuery(e.target.value)} placeholder="Search Hugging Face models" aria-label="Search Hugging Face models" />
                  <button type="submit" className="btn-ghost" disabled={Boolean(download)}>Search</button>
                </form>
                {download && (
                  <div className="genai-download">
                    <p className="hint">{download.repoId}: {download.state}{typeof download.pct === 'number' ? ` · ${download.pct}%` : ''}{download.etaS ? ` · about ${formatDuration(download.etaS)} left` : ''}</p>
                    <ProgressBar pct={download.pct} label={`Downloading ${download.repoId}`} />
                  </div>
                )}
                {hubResults && (
                  <ul className="genai-models">
                    {(hubResults.results || []).length === 0 && <li className="hint">No matching models.</li>}
                    {(hubResults.results || []).map((r) => (
                      <li key={r.repoId}>
                        <span className="genai-model-name">{r.repoId}</span>
                        <span className="genai-badge">{r.type}</span>
                        {r.alreadyInCatalog ? (
                          <span className="hint">on the board</span>
                        ) : (
                          <button type="button" className="btn-ghost genai-small" disabled={Boolean(download) || Boolean(r.unsupportedReason)} title={r.unsupportedReason || ''} onClick={() => startDownload(r.repoId)}>
                            Download
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        </div>
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
              <span className="genai-model-name" title={m.name}>{m.name}</span>
              {m.supportsVision && <span className="genai-badge">vision</span>}
              {(loaded || active) && <span className="genai-badge genai-badge-on">{active ? 'active' : 'loaded'}</span>}
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
