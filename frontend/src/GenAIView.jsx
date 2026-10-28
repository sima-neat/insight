import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  START_COMMAND,
  canUseModels,
  chatModels,
  deletableModel,
  deriveBackendState,
  engineName,
  formatBytes,
  formatDuration,
  friendlyModelName,
  offersSetup,
  speechModels,
  supportsThinking,
  thinkingModelOnBoard,
  voiceEngineWarnings
} from './genai/backendState.js'
import {
  REPLY_CUT_OFF,
  boardCameraSnapshot,
  clearDocuments,
  resetDocuments,
  uploadDocument,
  downloadModel,
  followLoadProgress,
  getJson,
  getSettings,
  getSetup,
  postJson,
  probeHealth,
  runSetup,
  saveSettings,
  speak,
  stopSetup,
  stopStudio,
  streamChat,
  transcribe
} from './genai/client.js'
import { languageNames, readAloudSupport } from './genai/speech.js'
import { allowedActions } from './genai/activity.js'
import { activeChatModel, keptChoice, loadPlan, residentLimit, unloadChoice } from './genai/models.js'
import { closedTicket, createBoardSession, isAbort } from './genai/boardSession.js'
import { heardMetrics, replyMetrics, speechMetrics } from './genai/metrics.js'
import { SOLUTIONS, SOLUTIONS_ROOT, chatLog, chatLogFilename, solutionUrl } from './genai/chatExport.js'
import { benchmarkSupport } from './genai/benchmark.js'
import {
  documentsSummary,
  documentsSupport,
  filterSections,
  inspectPath,
  inspectSummary,
  progressOutcome,
  sourcesNote
} from './genai/documents.js'
import { boardCameraSupport, parseCameraDevices, pickCamera, snapshotErrorMessage } from './genai/boardCamera.js'
import {
  DEFAULT_SYSTEM_PROMPT,
  MAX_TOKENS_LIMITS,
  clampMaxTokens,
  loadReplySettings,
  replySummary,
  saveReplySettings,
  systemPromptFor,
  systemPromptNote
} from './genai/replySettings.js'
import {
  catalogNameFor,
  cardPath,
  codeParts,
  downloadAvailability,
  downloadFailure,
  firstModelNeeded,
  hubReachOf,
  recommendedOffer
} from './genai/firstModel.js'
import { STATE_LABELS, boardSummary, documentsCardSummary, modelKind, modelRow, modelsSummary, voiceSummary } from './genai/settingsCards.js'
import { VISION_PRESETS, createVisionLoop } from './genai/visionLoop.js'
import { createSentenceSplitter, speakablePieces } from './genai/sentences.js'
import { splitThinking } from './genai/streams.js'
import { markTutorialSeen, tutorialSeen, tutorialSteps } from './genai/tutorial.js'
import {
  SLOW_REQUEST_MS,
  SLOW_STOP_MS,
  STEP_LABELS,
  bannerAction,
  canRunSetupAgain,
  canStopStudio,
  relayOnSetupBoard,
  connectIcon,
  lastLine,
  requestProblem,
  saveSetupOpen,
  setupAction,
  setupOpenSaved,
  setupStoppable,
  stepIcon
} from './genai/setup.js'
import { copyText } from './peripherals/api.js'

const GenAIBenchmark = lazy(() => import('./GenAIBenchmark.jsx'))

const POLL_MS = 5000
const SETUP_POLL_MS = 3000   // the setup panel, while open
// The id the vision view's answers are read aloud under (chat replies use their own).
const VISION_READING = 'vision'
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

// The frame a camera preview shows now, scaled the same way; null before it has one.
function videoFrameToDataUrl(video, maxSide = 896) {
  if (!video || !video.videoWidth) return null
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight))
  canvas.width = Math.round(video.videoWidth * scale)
  canvas.height = Math.round(video.videoHeight * scale)
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.9)
}

// Settings live in this browser; a browser that refuses storage (cookies
// blocked) throws on the property itself.
function browserStorage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

// Model output is untrusted: an image in it would be fetched from wherever the
// model points (so it is shown as its alt text), and links open outside Insight.
const MARKDOWN_COMPONENTS = {
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />
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
  boardCamera: 'M3 7h12v10H3zM15 10.5l6-3.5v10l-6-3.5',
  vision: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  send: 'M12 19V5M5 12l7-7 7 7',
  stop: 'M7 7h10v10H7z',
  newChat: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  export: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  shield: 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z',
  gauge: 'M3.5 17a8.5 8.5 0 1 1 17 0M12 17l4.5-5M12 17h.01M6.5 12.5l1.2.7M12 8.5V10M17.5 12.5l-1.2.7',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17v.01',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  settings: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  // Settings cards, and the chat's offer of a first model.
  board: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  models: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  replies: 'M4 5h16v11H10l-6 4zM8 9h8M8 12h5',
  voice: 'M4 9h4l5-4v14l-5-4H4zM16.5 9.5a3.5 3.5 0 0 1 0 5M19 7a7 7 0 0 1 0 10',
  documents: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  troubleshoot: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5.6 5.6l3.6 3.6M14.8 14.8l3.6 3.6M18.4 5.6l-3.6 3.6M9.2 14.8l-3.6 3.6',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14'
}

function StatusChip({ state }) {
  return <span className={`genai-pill genai-pill-${state}`}>{STATE_LABELS[state] || state}</span>
}

// Text with `code` parts (genai/firstModel.js codeParts).
function WithCode({ text }) {
  return codeParts(text).map((part, i) => (typeof part === 'string' ? part : <code key={i}>{part.code}</code>))
}

// A setup step's state as an icon: done, running, waiting or failed (genai/setup.js stepIcon).
function StepIcon({ kind, label }) {
  return (
    <span className={`genai-step-icon genai-step-icon-${kind}`} role="img" aria-label={label} title={label}>
      {kind === 'done' && <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10.5l3 3 6-6.5" /></svg>}
      {kind === 'failed' && <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 5.5v5.5M10 14.2v.3" /></svg>}
    </span>
  )
}

// What a step warned about on its way: each warning with its fix, and for
// setup, a button that runs it again once the fix is in.
function SetupWarnings({ warnings, finished, onRunAgain, busy }) {
  const count = `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
  return (
    <div className="genai-setup-help genai-setup-help-warn" role="status">
      <p className="genai-setup-help-title">{finished ? `Finished with ${count}` : count}</p>
      <ul>
        {warnings.map((w) => (
          <li key={w.message}>
            <WithCode text={/[.!?]$/.test(w.message) ? w.message : `${w.message}.`} />
            {w.fix && <span className="genai-setup-fix"> <WithCode text={w.fix} /></span>}
          </li>
        ))}
      </ul>
      {onRunAgain && (
        <div className="genai-actions">
          <button type="button" className="btn-ghost genai-small" disabled={busy} onClick={onRunAgain}>Run setup again</button>
          <span className="hint">Stops GenAI Studio, runs setup.sh again and starts it.</span>
        </div>
      )}
    </div>
  )
}

// Why a setup step or request failed, or why a step has gone quiet: the
// message, what to do, its last output and the command to run by hand.
function SetupHelp({ problem, log = '', warn = false, onCopy }) {
  return (
    <div className={`genai-setup-help${warn ? ' genai-setup-help-warn' : ''}`} role={warn ? 'status' : 'alert'}>
      <p className="genai-setup-help-title">{problem.message}</p>
      {problem.fixes?.length > 0 && (
        <ul>{problem.fixes.map((fix) => <li key={fix}><WithCode text={fix} /></li>)}</ul>
      )}
      {log && (
        <details>
          <summary>Last output</summary>
          <pre>{log}</pre>
        </details>
      )}
      {problem.command && (
        <div className="genai-setup-manual">
          <span>Or run it yourself in a shell on the board:</span>
          <div className="genai-tutorial-commands">
            <pre><code>{problem.command}</code></pre>
            <button type="button" className="btn-ghost genai-small" onClick={() => onCopy(problem.command)}>Copy</button>
          </div>
        </div>
      )}
    </div>
  )
}

// A Settings card: an icon, the title, and one line about how it is set now.
function SettingsCard({ id, icon, title, summary, wide, children }) {
  return (
    <section className={`genai-card${wide ? ' genai-card-wide' : ''}`} aria-labelledby={`genai-card-${id}`} aria-describedby={`genai-card-${id}-summary`}>
      <div className="genai-card-head">
        <span className="genai-card-icon"><Icon d={ICONS[icon]} /></span>
        <div className="genai-card-titles">
          <h3 id={`genai-card-${id}`}>{title}</h3>
          <p id={`genai-card-${id}-summary`} className="genai-card-summary" title={summary}>{summary}</p>
        </div>
      </div>
      {children}
    </section>
  )
}

// A download onto the board: its state, percent and time left, with a bar.
function DownloadProgress({ download }) {
  if (!download) return null
  const pct = typeof download.pct === 'number' ? ` · ${download.pct}%` : ''
  const eta = download.etaS ? ` · about ${formatDuration(download.etaS)} left` : ''
  return (
    <div className="genai-download" aria-live="polite">
      <p className="hint">{download.repoId}: {download.state}{pct}{eta}</p>
      <ProgressBar pct={download.pct} label={`Downloading ${download.repoId}`} />
    </div>
  )
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
  const [benchmarking, setBenchmarking] = useState(false)
  const root = useRef(null)
  const [addressDraft, setAddressDraft] = useState('')
  const [addressError, setAddressError] = useState('')   // shown under the address until it is edited
  const [health, setHealth] = useState(null)
  const [status, setStatus] = useState(null)
  const [busyOp, setBusyOp] = useState(null)
  const [lastError, setLastError] = useState(null)
  const [loadProgress, setLoadProgress] = useState(null)
  // The loaded chat model the user chose to answer, when the board keeps
  // several; the most recently loaded one otherwise.
  const [chosenModel, setChosenModel] = useState(null)
  // A load that needs loaded models unloaded first: {model, choice, already},
  // where `already` lists the models this load was already asked to unload.
  const [unloadAsk, setUnloadAsk] = useState(null)
  const [voices, setVoices] = useState(null)
  const voicesLoading = useRef(false)

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
  const [docsViewOpen, setDocsViewOpen] = useState(false)   // View documents: what the database holds
  const docInput = useRef(null)
  const [tutorialStep, setTutorialStep] = useState(null)
  const [setupOpen, setSetupOpen] = useState(false)   // the setup panel, shown instead of the tour
  const [setupStatus, setSetupStatus] = useState(null)   // GET /api/genai-setup
  const [setupError, setSetupError] = useState(null)   // a Run or Stop that failed, as {message, fixes, detail}
  const [setupReadError, setSetupReadError] = useState(null)   // the last status read, when it failed
  const [setupBusy, setSetupBusy] = useState(null)   // 'run' | 'stop' | 'stop-studio' while that request is out
  const setupWrites = useRef(0)   // + 1 when a Run or Stop starts and ends: older status reads are dropped
  const [setupSlow, setSetupSlow] = useState(false)   // that request has not answered for a while
  const [streaming, setStreaming] = useState(false)
  const chatAbort = useRef(null)
  const boardGeneration = useRef(0)   // + 1 on every board switch
  // Set synchronously, so two sends before the next render can't both stream.
  const streamingRef = useRef(false)
  // Bumped by New chat: a reply still finishing from the old chat is dropped.
  const chatGeneration = useRef(0)
  // The latest sendMessage, for a recording that finishes renders later.
  const sendRef = useRef(null)
  const mounted = useRef(false)
  const transcriptBox = useRef(null)
  const stickToBottom = useRef(true)
  const composer = useRef(null)
  const fileInput = useRef(null)

  const [cameraOpen, setCameraOpen] = useState(false)
  const videoRef = useRef(null)
  const cameraStream = useRef(null)
  const cameraStarting = useRef(false)
  const [cameraOpening, setCameraOpening] = useState(false)   // the browser may be asking permission
  // The board's own cameras: the panel under the chat, its list
  // (null until fetched) and the chosen /dev/videoN.
  const [boardCameraOpen, setBoardCameraOpen] = useState(false)
  const [boardCameras, setBoardCameras] = useState(null)
  const [boardCamera, setBoardCamera] = useState('')
  const [boardSnapshotting, setBoardSnapshotting] = useState(false)
  const boardSnapshotAbort = useRef(null)
  // The vision view and what it is doing ({asking, loop, snapshot}).
  const [visionOpen, setVisionOpen] = useState(false)
  const [visionActivity, setVisionActivity] = useState({ asking: false, loop: false, snapshot: false })
  // Read by sendMessage, which can run renders after a click (a recording).
  const visionBusy = useRef(false)
  // Settings, Replies: the system prompt ('' = the default) and the longest reply.
  const [replySettings, setReplySettings] = useState(() => loadReplySettings(browserStorage()))

  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [language, setLanguage] = useState('auto')
  const [readAloud, setReadAloud] = useState(false)
  const readAloudRef = useRef(readAloud)
  readAloudRef.current = readAloud
  const [engine, setEngine] = useState('default')
  const [voice, setVoice] = useState('')
  const recorder = useRef(null)
  const micStarting = useRef(false)   // set at once, so a double click can't open it twice
  const [micOpening, setMicOpening] = useState(false)   // drives the rule table while the browser asks
  const player = useRef(null)
  const speechAbort = useRef(null)
  const transcribeAbort = useRef(null)
  const [speakingId, setSpeakingId] = useState(null)
  // {id, text}: why the last Read aloud of reply `id` failed, shown under it.
  const [speechError, setSpeechError] = useState(null)
  // reply id -> speed figures of its last reading aloud.
  const [speechStats, setSpeechStats] = useState({})
  const spokenLanguage = useRef(null)

  const [hubQuery, setHubQuery] = useState('')
  const [hubResults, setHubResults] = useState(null)
  const [download, setDownload] = useState(null)
  // Hugging Face as the board last answered about it ({enabled, error}), the
  // recommended model's card (its download size), why the last download
  // failed, and a model to load once its download from the chat's offer is in
  // the catalog.
  const [hubReach, setHubReach] = useState(null)
  const [recommendedCard, setRecommendedCard] = useState(null)
  const recommendedCardLoading = useRef(false)
  const [failedDownload, setFailedDownload] = useState(null)
  const [loadAfterDownload, setLoadAfterDownload] = useState(null)
  // Browse models: + 1 each time it asks Settings to show the Hugging Face search.
  const [browseRequest, setBrowseRequest] = useState(0)
  const hubSearchBox = useRef(null)

  const backend = deriveBackendState({ health, status, busyOp, lastError })
  const usable = canUseModels(backend.state)
  const docs = documentsSupport(health)
  const bench = benchmarkSupport(health)
  const boardCam = boardCameraSupport(health)
  const chatModel = activeChatModel(status, chosenModel)
  // A chosen model that the board unloaded is forgotten (genai/models.js).
  useEffect(() => {
    const kept = keptChoice(status, chosenModel)
    if (kept !== chosenModel) setChosenModel(kept)
  }, [status, chosenModel])
  const keepsSeveral = residentLimit(status) > 1
  const sees = Boolean(chatModel && chatModel.supportsVision)
  // What the user may do now: every control and action reads this one table.
  const allowed = allowedActions({
    usable,
    hasChatModel: Boolean(chatModel),
    sees,
    hasAsr: Boolean(status?.asrModel),
    hasMessages: messages.length > 0,
    hasDraft: Boolean(draft.trim() || image),
    // Opening counts as open: a permission prompt may be pending.
    cameraOpen: cameraOpen || cameraOpening || boardCameraOpen,
    visionOpen,
    replying: streaming,
    recording,
    micOpening,
    transcribing,
    modelOp: Boolean(busyOp),
    downloading: Boolean(download),
    hubEnabled: Boolean(status?.hubEnabled),
    benchmarking,
    documentTask: Boolean(docProgress),
    documentsAvailable: docs.available,
    benchmarkAvailable: bench.available,
    boardCameraAvailable: boardCam.available,
    boardSnapshot: boardSnapshotting || visionActivity.snapshot,
    visionAsking: visionActivity.asking,
    visionLoop: visionActivity.loop,
    useDocuments: useDocs && docs.available
  })
  const canThink = Boolean(chatModel && supportsThinking(chatModel.name))
  // No model to chat with: the chat offers the recommended one instead.
  const firstModel = usable ? firstModelNeeded(status) : null
  const offer = recommendedOffer({ status, card: recommendedCard })
  const downloads = downloadAvailability({ status, hubReach })

  const fail = useCallback((message) => {
    setLastError(message)
    onError?.(message)
  }, [onError])

  // Every request to the board takes a ticket from the board session
  // (genai/boardSession.js): a new address or leaving the tab ends the
  // session, aborting its requests and marking their results stale.
  const boardSession = useRef(null)
  const ticket = useCallback((own) => {
    // After the tab is gone (a finally block refreshing, say), nothing more
    // goes to the board.
    return boardSession.current ? boardSession.current.ticket(own) : closedTicket()
  }, [])
  // Declared before the polling effect: effects run in order, also when
  // React mounts the tab a second time in development.
  useEffect(() => {
    boardSession.current = createBoardSession()
    return () => {
      boardSession.current.close()
      boardSession.current = null
    }
  }, [])

  // --- polling ---------------------------------------------------------------

  // Polls also overlap on one board (the timer, actions): a result older than
  // one already shown is dropped, so a slow reply can't undo a newer one.
  const refreshStarted = useRef(0)
  const refreshShown = useRef(0)
  const refresh = useCallback(async () => {
    const id = ++refreshStarted.current
    const board = ticket()
    let nextHealth
    try {
      nextHealth = await probeHealth(board.signal)
    } catch (error) {
      if (isAbort(error)) return null
      throw error
    }
    if (!board.live() || id < refreshShown.current) return nextHealth
    refreshShown.current = id
    const healthy = nextHealth.httpStatus === 200 && nextHealth.body?.model_server?.reachable
    // A board that is down or starting may come back with other models: its
    // catalog goes now, so recovery offers no model until a fresh one arrives.
    if (!healthy) setStatus(null)
    setHealth(nextHealth)
    if (healthy) {
      try {
        const nextStatus = await getJson('models/status', { signal: board.signal })
        if (board.live() && id === refreshShown.current) setStatus(nextStatus)
      } catch (error) {
        // An unknown catalog offers no model: a stale one could send to a
        // model that is no longer loaded. The next poll brings it back.
        if (!isAbort(error) && board.live() && id === refreshShown.current) setStatus(null)
      }
    }
    return nextHealth
  }, [ticket])

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

  // health changes on every poll, so a failed fetch is tried again on the next one.
  useEffect(() => {
    if (!usable || voices || voicesLoading.current) return
    const board = ticket()
    voicesLoading.current = true
    getJson('v1/audio/voices', { signal: board.signal })
      .then((v) => { if (board.live()) setVoices(v) })
      .catch(() => {})
      .finally(() => { if (board.live()) voicesLoading.current = false })
  }, [usable, voices, health, ticket])

  // Follow a streaming reply only while the reader is at the bottom; scrolling
  // up to reread stops following until they scroll back down.
  useEffect(() => {
    const box = transcriptBox.current
    if (box && stickToBottom.current) box.scrollTop = box.scrollHeight
  }, [messages])

  // The tab fills the window below Insight's header, as chat apps do: the
  // conversation takes the space and the composer sits at the bottom. CSS
  // reads where the tab starts (it moves when the header wraps or in full screen).
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return undefined
    const place = () => el.style.setProperty('--genai-top', `${Math.max(0, el.getBoundingClientRect().top + window.scrollY)}px`)
    place()
    // Also when something above it opens or closes (Insight's tour, a banner):
    // the page's size changes then. Placing again gives the same value once
    // settled, so this doesn't loop.
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null
    resized?.observe(document.body)
    window.addEventListener('resize', place)
    document.addEventListener('fullscreenchange', place)
    return () => {
      resized?.disconnect()
      window.removeEventListener('resize', place)
      document.removeEventListener('fullscreenchange', place)
    }
  }, [])

  // First visit: start the tutorial. A reload during setup reopens its panel.
  useEffect(() => {
    if (setupOpenSaved(window.localStorage)) setSetupOpen(true)
    else if (!tutorialSeen(window.localStorage)) setTutorialStep(0)
  }, [])

  // While GenAI Studio doesn't answer, the banner's button says whether one click starts it.
  useEffect(() => {
    if (setupOpen || !offersSetup(backend.state)) return undefined
    let cancelled = false
    getSetup().then((body) => { if (!cancelled) setSetupStatus(body) }, () => {})
    return () => {
      cancelled = true
    }
  }, [backend.state, setupOpen])

  // The setup panel follows the job on the board while it is open: one read at a time, the
  // next SETUP_POLL_MS after the last answered, and none that started before a Run or Stop ended.
  useEffect(() => {
    if (!setupOpen) return undefined
    let cancelled = false
    let timer = null
    const read = () => {
      const writes = setupWrites.current
      getSetup().then(
        (body) => { if (!cancelled && writes === setupWrites.current) { setSetupStatus(body); setSetupReadError(null) } },
        (err) => { if (!cancelled && writes === setupWrites.current) setSetupReadError(requestProblem(err)) }
      ).finally(() => { if (!cancelled) timer = setTimeout(read, SETUP_POLL_MS) })
    }
    read()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [setupOpen])

  function onTranscriptScroll() {
    const box = transcriptBox.current
    if (box) stickToBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  }

  // A picture waiting to be sent can't go to a model that doesn't see images.
  useEffect(() => {
    if (sees || !image || !chatModel) return   // no model known yet (e.g. just after a settings change)
    setImage(null)
    onStatus?.('Removed the picture: the loaded model does not see images.')
  }, [sees, image, chatModel])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      chatAbort.current?.abort()
      speechAbort.current?.abort()
      transcribeAbort.current?.abort()
      boardSnapshotAbort.current?.abort()
      player.current?.pause()
      cameraStream.current?.getTracks().forEach((t) => t.stop())
      recorder.current?.stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  // --- settings ----------------------------------------------------------------

  // Everything that describes or came from the previous board, in one place:
  // requests still on their way end, and its state goes, so nothing of it
  // (an error, a catalog, voices, search results) shows against the new one.
  function forgetBoard() {
    boardGeneration.current += 1
    boardSession.current?.restart()
    voicesLoading.current = false
    // The conversation and an attached picture belong to the previous board:
    // the next message must not send them to the new one.
    resetConversation()
    setImage(null)
    setHealth(null)
    setStatus(null)
    setLastError(null)
    setLoadProgress(null)
    setChosenModel(null)
    setUnloadAsk(null)
    setVoices(null)
    setEngine('default')      // the new board may not have the chosen engine or voice
    setVoice('')
    setHubResults(null)
    setHubReach(null)
    setRecommendedCard(null)
    recommendedCardLoading.current = false
    setFailedDownload(null)
    setLoadAfterDownload(null)
    setDocStatus(null)
    setUseDocs(false)         // chosen for the previous board's documents
    setDocsMidChat(false)
    setDocsViewOpen(false)
    // Its cameras, and the vision view (closing it stops its loop).
    setBoardCameraOpen(false)
    setBoardSnapshotting(false)
    setBoardCameras(null)
    setBoardCamera('')
    setVisionOpen(false)
  }

  async function applySettings(event) {
    event.preventDefault()
    if (!allowed.changeBoard) return
    try {
      const before = settings?.url
      const saved = await saveSettings({ url: addressDraft.trim() })
      setSettings(saved)
      // Saving the same address keeps the conversation; another board starts fresh.
      if (saved?.url !== before) forgetBoard()
      setAddressError('')
      onStatus?.('Board settings saved.')
      refresh()
    } catch (error) {
      // A rejected address is shown next to the field, where the user is
      // typing; anything else also goes to Insight's error popup.
      if (error.status === 400) {
        setAddressError("That isn't a board address. Use https://<board address>:5000, for example https://192.168.1.20:5000.")
      } else {
        setAddressError(error.message)
        onError?.(error.message)
      }
    }
  }

  // --- models -----------------------------------------------------------------

  async function runModelOp(label, path, body) {
    setBusyOp(label)
    setLastError(null)
    const progress = new AbortController()
    if (path === 'models/load') {
      followLoadProgress({ signal: ticket(progress.signal).signal, onProgress: setLoadProgress }).catch(() => {})
    }
    const op = ticket()
    try {
      await postJson(path, body, { signal: op.signal })
      onStatus?.(`${label}: done.`)
      // The model just loaded answers next.
      if (path === 'models/load' && op.live()) setChosenModel(body.name)
    } catch (error) {
      if (isAbort(error)) return
      // The board keeps several models and this one needs room: ask which of
      // the loaded ones to unload instead of failing.
      const choice = path === 'models/load' ? unloadChoice(error) : null
      const model = choice && chatModels(status).find((m) => m.name === body.name)
      // The board refused before unloading anything: models already chosen
      // for this load are unloaded too when it is tried again.
      if (model && choice.candidates.length && op.live()) setUnloadAsk({ model, choice, already: body.unload || [] })
      else fail(`${label} failed: ${error.message}`)
    } finally {
      progress.abort()
      setLoadProgress(null)
      // Unlock with a catalog fetched after the operation: the old one is
      // dropped first, so if the fetch fails no model is offered until the
      // next poll brings the real one (a send can't go to an unloaded model).
      setStatus(null)
      await refresh().catch(() => {})
      setBusyOp(null)
    }
  }

  // `unload`: the loaded models the user chose to unload to make room.
  function loadChatModel(model, unload = []) {
    if (!allowed.changeChatModel || model.supported === false) return
    const body = unload.length ? { name: model.name, unload } : { name: model.name }
    runModelOp(`Loading ${friendlyModelName(model.name)}`, 'models/load', body)
  }

  // Load from the model list, or answer with a model that is loaded already.
  // Past the board's limit, the user chooses what to unload first.
  function requestLoad(model) {
    if (!allowed.changeChatModel || model.supported === false) return
    const plan = loadPlan(status, model.name)
    if (plan.kind === 'use') answerWith(model)
    else if (plan.kind === 'choose') {
      setUnloadAsk({ model, choice: { code: 'resident_limit', candidates: plan.loaded.map((m) => m.name), needed: plan.needed } })
    } else loadChatModel(model)
  }

  // Answer with another loaded model. The conversation stays: the next
  // message sends it to the chosen model.
  function answerWith(model) {
    if (!allowed.changeChatModel) return
    setChosenModel(model.name)
    onStatus?.(`${friendlyModelName(model.name)} answers now.`)
  }

  function unloadChatModel(model) {
    if (allowed.changeChatModel) runModelOp(`Unloading ${friendlyModelName(model.name)}`, 'models/unload', { name: model.name })
  }

  function switchSpeechModel(model) {
    if (allowed.changeSpeechModel && model.supported !== false) runModelOp(`Switching speech recognition to ${friendlyModelName(model.name)}`, 'models/asr', { name: model.name })
  }

  // A model on the board that isn't in use; the board's refusal is shown as
  // the operation's error.
  function deleteModel(model) {
    if (!allowed.deleteModel || !deletableModel(model, status)) return
    const size = model.sizeBytes ? ` (${formatBytes(model.sizeBytes)})` : ''
    if (!window.confirm(`Delete ${friendlyModelName(model.name)}${size} from the board? Its files are removed; download it again to use it.`)) return
    runModelOp(`Deleting ${friendlyModelName(model.name)}`, 'models/delete', { name: model.name })
  }

  function chooseChatModel(name) {
    const model = chatModels(status).find((m) => m.name === name)
    if (!model || model === chatModel || !allowed.changeChatModel) return
    if (model.supported === false) {
      onError?.(model.unsupportedReason || `${friendlyModelName(model.name)} can't run on this board.`)
      return
    }
    const plan = loadPlan(status, model.name)
    if (plan.kind === 'use' || plan.kind === 'choose') {
      requestLoad(model)
      return
    }
    const wait = model.estimatedLoadS ? ` It takes about ${formatDuration(model.estimatedLoadS)}.` : ''
    const names = (list) => list.map((m) => friendlyModelName(m.name)).join(', ')
    const others = plan.kind === 'add' && plan.keeps.length
      ? ` ${names(plan.keeps)} ${plan.keeps.length === 1 ? 'stays' : 'stay'} loaded.`
      : plan.kind === 'replace' && plan.unloads.length ? ` ${names(plan.unloads)} is unloaded first.` : ''
    if (!window.confirm(`Load ${friendlyModelName(model.name)}?${wait}${others}`)) return
    loadChatModel(model)
  }

  // Only the latest search is shown.
  const hubSearchId = useRef(0)
  function searchHub(event) {
    event.preventDefault()
    runHubSearch(hubQuery)
  }

  async function runHubSearch(text) {
    if (!allowed.searchModels) return
    const id = ++hubSearchId.current
    const board = ticket()
    try {
      const query = text.trim() ? `?q=${encodeURIComponent(text.trim())}` : ''
      const results = await getJson(`models/hub/search${query}`, { signal: board.signal })
      if (id === hubSearchId.current && board.live()) {
        setHubResults(results)
        setHubReach((prev) => hubReachOf(results) || prev)
      }
    } catch (error) {
      if (id === hubSearchId.current && board.live() && !isAbort(error)) onError?.(`Search failed: ${error.message}`)
    }
  }

  // thenLoad: the chat's offer loads the model once it is in the catalog.
  async function startDownload(repoId, { thenLoad = false } = {}) {
    if (!allowed.downloadModel) return
    const board = ticket()
    setFailedDownload(null)
    setDownload({ repoId, state: 'resolving', pct: null })
    try {
      const done = await downloadModel({ repoId, signal: board.signal, onProgress: (item) => setDownload({ repoId, ...item }) })
      if (!board.live()) return
      setHubReach({ enabled: true, error: '' })
      onStatus?.(`Downloaded ${repoId}.`)
      setHubResults(null)
      if (thenLoad) setLoadAfterDownload(done.name || catalogNameFor(repoId))
    } catch (error) {
      if (!isAbort(error) && board.live()) {
        const failure = downloadFailure(repoId, error)
        setFailedDownload(failure)
        if (failure.offline) setHubReach({ enabled: false, error: failure.message })
        onError?.(`Download of ${repoId} failed: ${error.message}`)
      }
    } finally {
      setDownload(null)
      refresh()
    }
  }

  // The chat's offer: the recommended model (or the id Hugging Face renamed it
  // to), downloaded and then loaded.
  function getFirstModel(repoId = offer.repoId) {
    if (allowed.downloadFirstModel) startDownload(repoId, { thenLoad: true })
  }

  // Browse models: Settings, Models at the Hugging Face search, listing the
  // models the board can download.
  function browseModels() {
    if (!allowed.browseModels) return
    setSettingsOpen(true)
    setBrowseRequest((n) => n + 1)
    if (!hubResults) runHubSearch(hubQuery)
  }

  useEffect(() => {
    if (!browseRequest || !settingsOpen) return
    const box = hubSearchBox.current
    box?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    box?.focus({ preventScroll: true })
  }, [browseRequest, settingsOpen])

  // The offer says how big the download is, and finds out early whether the
  // board can reach Hugging Face. Once per board; the size is only a nicety,
  // so a failed lookup is not retried until Check again.
  useEffect(() => {
    if (!firstModel || !status?.hubEnabled || recommendedCard || recommendedCardLoading.current) return
    recommendedCardLoading.current = true
    const board = ticket()
    getJson(cardPath(offer.repoId), { signal: board.signal })
      .then((card) => {
        if (!board.live()) return
        setRecommendedCard(card)
        setHubReach((prev) => hubReachOf(card) || prev)
      })
      .catch(() => {})
  }, [Boolean(firstModel), status?.hubEnabled, recommendedCard, offer.repoId, ticket])

  function checkHubAgain() {
    setHubReach(null)
    setRecommendedCard(null)
    recommendedCardLoading.current = false
  }

  // A model downloaded from the chat's offer loads once the catalog lists it,
  // when nothing holds model changes; a model loaded meanwhile wins.
  useEffect(() => {
    if (!loadAfterDownload) return
    const model = chatModels(status).find((m) => m.name === loadAfterDownload)
    if (chatModel) {
      setLoadAfterDownload(null)
      return
    }
    if (!model) return
    if (model.supported === false) {
      setLoadAfterDownload(null)
      onError?.(model.unsupportedReason || `${friendlyModelName(model.name)} can't run on this board.`)
      return
    }
    if (!allowed.changeChatModel) return
    setLoadAfterDownload(null)
    loadChatModel(model)
  }, [loadAfterDownload, status, chatModel, allowed.changeChatModel])

  // --- speech output ----------------------------------------------------------

  // Must run inside a click: the browser only lets an element play audio it
  // started during a user gesture.
  // Call it only once the new reading will really start: it ends the current one.
  function unlockPlayer() {
    // Ending it settles the piece it is playing and frees that audio, so no
    // reading waits forever on the handlers detached below.
    stopSpeaking()
    if (!player.current) player.current = new Audio()
    const audio = player.current
    audio.onended = null
    audio.onpause = null
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
    let language = null         // the reply's language, decided by the first piece
    let firstAudio = null
    const rtfs = []
    let engineUsed = null
    let wake = null             // resolves the player loop's wait for audio
    let settlePlaying = null    // ends the piece playing now
    let over = null
    const done = new Promise((resolve) => { over = resolve })   // the reading ended, however
    // Stopping the reading (Stop speaking, a new reading, leaving the tab) must
    // also end the piece in flight, or its player loop never finishes.
    signal.addEventListener('abort', () => {
      settlePlaying?.()
      wake?.()
      over()
    })

    const isOver = () => finished && !pending.length && !ready.length && !synthesizing
    const end = () => {
      setSpeakingId((current) => (current === id ? null : current))
      if (speechAbort.current === controller) speechAbort.current = null
      over()
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
        let settled = false
        const settle = () => {
          if (settled) return
          settled = true
          settlePlaying = null
          audio.onended = null
          audio.onpause = null
          URL.revokeObjectURL(url)
          resolve()
        }
        settlePlaying = settle
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
          const { text, language: pieceLanguage } = pending.shift()
          const result = await speak({ text, model: engine, voice: voice || undefined, language: pieceLanguage, signal: ticket(signal).signal })
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
      done,
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
        // A piece in another language ("Here is the translation: Buenos días")
        // gets its own voice language; otherwise the reply's.
        const own = readAloudSupport(piece, voices ? voices.languages : null, language)
        pending.push({ text: piece, language: own.supported ? own.language : language })
        synthLoop()
        return true
      },
      finish() {
        finished = true
        if (language === null) end()
        wake?.()
      },
      abort() {
        // Already stopped: the player may be reading something else by now.
        if (signal.aborted) return
        controller.abort()
        audio.pause()
        end()
      }
    }
  }

  // Read aloud on a finished reply.
  function speakText(text, id) {
    if (!allowed.readAloud) return
    const t0 = performance.now()
    const pieces = speakablePieces(text)
    if (!pieces.length) return
    const support = voiceLanguageFor(text)
    if (!support.supported) {
      onStatus?.(`The board's voices can't read ${support.name} aloud yet.`)
      return
    }
    const reading = startReading(id, unlockPlayer(), t0)
    for (const piece of pieces) reading.add(piece)
    reading.finish()
  }

  // --- chat -------------------------------------------------------------------

  function withNoThink(content) {
    if (typeof content === 'string') return `/no_think ${content}`
    return content.map((part) => (part.type === 'text' ? { ...part, text: `/no_think ${part.text}` } : part))
  }

  // Returns whether the message was sent. replyPlayer: an already unlocked
  // player (or null), when the click that asked was earlier than this call.
  function sendMessage(text = draft, { replyPlayer, heard = null } = {}) {
    const prompt = text.trim()
    if ((!prompt && !image) || !chatModel || streamingRef.current || visionBusy.current) return false
    if (replyPlayer === undefined) replyPlayer = readAloud ? unlockPlayer() : null
    const generation = chatGeneration.current
    // A detected spoken language applies to the spoken turn only, not to later typed ones.
    if (!heard) spokenLanguage.current = null
    const userText = prompt || 'Describe this image.'
    const userContent = image
      ? [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: image } }]
      : userText
    // Requests are stateless: send the most recent earlier image again so
    // follow-up questions can still see it. Only that one, as several images
    // make each reply slow on the board; a new image replaces it.
    const earlier = messagesRef.current
    const carried = !image && chatModel.supportsVision ? earlier.findLastIndex((m) => m.role === 'user' && m.image) : -1
    const history = earlier.map((m, i) => {
      if (m.role === 'assistant') return { role: 'assistant', content: splitThinking(m.content).answer }
      if (i === carried) return { role: 'user', content: [{ type: 'text', text: m.text }, { type: 'image_url', image_url: { url: m.image } }] }
      return { role: 'user', content: m.text }
    })
    const outgoing = [
      { role: 'system', content: systemPromptFor({ custom: replySettings.systemPrompt, picture: image ? 'current' : carried >= 0 ? 'earlier' : 'none' }) },
      ...history,
      { role: 'user', content: canThink && !thinking ? withNoThink(userContent) : userContent }
    ]
    const replyId = Date.now()
    setMessages((prev) => [...prev, { role: 'user', text: userText, image, heard }, { role: 'assistant', id: replyId, content: '', pending: true }])
    setDraft('')
    setImage(null)
    stickToBottom.current = true
    streamingRef.current = true
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
    const update = (extra) => {
      if (chatGeneration.current !== generation) return
      setMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', id: replyId, content: reply, ...extra }])
    }
    streamReply()
    return true

    async function streamReply() {
      try {
        const { stats, rag } = await streamChat({
          model: chatModel.name,
          messages: outgoing,
          maxTokens: replySettings.maxTokens,
          useDocuments: useDocs && docs.available,
          signal: ticket(controller.signal).signal,
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
        streamingRef.current = false
        setStreaming(false)
        if (chatAbort.current === controller) chatAbort.current = null
      }
    }
  }
  sendRef.current = sendMessage

  // Typed messages wait while a spoken one is being recorded or transcribed.
  function sendTyped() {
    if (allowed.send) sendMessage()
  }

  async function attachImage(file) {
    if (!file) return
    // A board switch while a large picture is being resized drops it: it was
    // chosen for the previous board.
    const board = boardGeneration.current
    try {
      const picture = await imageToDataUrl(file)
      if (board === boardGeneration.current) setImage(picture)
    } catch {
      if (board === boardGeneration.current) onError?.('That file could not be read as an image.')
    }
  }

  async function openCamera() {
    if (!allowed.openCamera || cameraStream.current || cameraStarting.current) return
    cameraStarting.current = true
    setCameraOpening(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      if (!mounted.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      cameraStream.current = stream
      setCameraOpen(true)
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.srcObject = stream
      })
    } catch (error) {
      onError?.(`The camera isn't available (${error.message}). Allow camera access for this page, then try again.`)
    } finally {
      cameraStarting.current = false
      setCameraOpening(false)
    }
  }

  function closeCamera() {
    cameraStream.current?.getTracks().forEach((t) => t.stop())
    cameraStream.current = null
    setCameraOpen(false)
  }

  function captureFrame() {
    const picture = videoFrameToDataUrl(videoRef.current)
    if (!picture) return
    setImage(picture)
    closeCamera()
    composer.current?.focus()
  }

  // --- board camera -----------------------------------------------------------

  // The board's cameras, fetched when its camera panel or the vision view opens.
  async function loadBoardCameras() {
    const board = ticket()
    try {
      const cameras = parseCameraDevices(await getJson('board-camera/devices', { signal: board.signal }))
      if (!board.live()) return
      setBoardCameras(cameras)
      setBoardCamera((current) => pickCamera(cameras, current) || '')
    } catch (error) {
      if (!isAbort(error) && board.live()) setBoardCameras({ devices: [], default: null, error: `Couldn't list the board's cameras: ${error.message}` })
    }
  }

  function openBoardCamera() {
    if (!allowed.openBoardCamera) return
    setBoardCameraOpen(true)
    loadBoardCameras()
  }

  function closeBoardCamera() {
    boardSnapshotAbort.current?.abort()
    setBoardCameraOpen(false)
  }

  // A picture from the board's camera, attached like a photo to the next message.
  async function takeBoardPicture() {
    if (!allowed.takeBoardSnapshot || !boardCamera) return
    const device = boardCamera
    const controller = new AbortController()
    boardSnapshotAbort.current = controller
    const board = ticket(controller.signal)
    setBoardSnapshotting(true)
    try {
      const picture = await imageToDataUrl(await boardCameraSnapshot(device, { signal: board.signal }))
      // Taken for the board in use when it was asked for, and still wanted:
      // a board switch or Cancel meanwhile drops it.
      if (!board.live() || controller.signal.aborted) return
      setImage(picture)
      setBoardCameraOpen(false)
      composer.current?.focus()
    } catch (error) {
      if (!isAbort(error) && board.live() && !controller.signal.aborted) onError?.(snapshotErrorMessage(error, device))
    } finally {
      if (boardSnapshotAbort.current === controller) boardSnapshotAbort.current = null
      if (board.live()) setBoardSnapshotting(false)
    }
  }

  // --- vision view ------------------------------------------------------------

  function openVision() {
    if (!allowed.openVision) return
    setVisionOpen(true)
    if (boardCam.available) loadBoardCameras()
  }

  // What the view is doing, for the rule table (and sendMessage, which can
  // run after a recording ends).
  const onVisionActivity = useCallback((activity) => {
    visionBusy.current = Boolean(activity.asking || activity.loop)
    setVisionActivity(activity)
  }, [])

  // Must run inside a click: unlocks the player for the answers read aloud.
  function prepareVisionSpeech() {
    if (readAloudRef.current) unlockPlayer()
  }

  function changeReadAloud(on) {
    setReadAloud(on)
    if (on) unlockPlayer()            // the vision loop reads its answers renders later
    else if (speakingId === VISION_READING) stopSpeaking()
  }

  // One question about one picture from the vision view: a request of its own
  // (no chat history), with the tab's system prompt and reply length.
  // onDelta(answer so far). With Read replies aloud on, the answer is read as
  // it is written, and this resolves once the reading is over too: a loop
  // takes its next picture only then. Ending `signal` ends both.
  async function askAboutPicture({ picture, prompt, signal, onDelta }) {
    const model = chatModel
    if (!model || !model.supportsVision) throw new Error('Load a model that sees images first.')
    const content = [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: picture } }]
    const messages = [
      { role: 'system', content: systemPromptFor({ custom: replySettings.systemPrompt, picture: 'current' }) },
      { role: 'user', content: canThink && !thinking ? withNoThink(content) : content }
    ]
    const board = ticket(signal)
    const t0 = performance.now()
    let tFirst = null
    let reply = ''
    // A reading that failed, and its speech figures, belong to the previous answer.
    setSpeechError((e) => (e && e.id === VISION_READING ? null : e))
    setSpeechStats((prev) => {
      if (!(VISION_READING in prev)) return prev
      const { [VISION_READING]: _previous, ...rest } = prev
      return rest
    })
    let reading = readAloudRef.current && player.current ? startReading(VISION_READING, player.current, t0) : null
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
    const stopReading = () => reading?.abort()
    signal.addEventListener('abort', stopReading, { once: true })
    try {
      const { stats } = await streamChat({
        model: model.name,
        messages,
        maxTokens: replySettings.maxTokens,
        signal: board.signal,
        onDelta: (piece) => {
          if (tFirst === null) tFirst = performance.now()
          reply += piece
          // An answer from the previous board is not shown.
          if (board.live()) onDelta(splitThinking(reply).answer)
          speakNew(false)
        }
      })
      const metrics = replyMetrics({ t0, tFirst, tEnd: performance.now(), stats })
      speakNew(true)
      if (reading) await reading.done
      return { answer: splitThinking(reply).answer, metrics }
    } catch (error) {
      reading?.abort()
      if (isAbort(error)) throw error
      throw new Error(error.message === REPLY_CUT_OFF ? REPLY_CUT_OFF : `The model didn't answer: ${error.message}`)
    } finally {
      signal.removeEventListener('abort', stopReading)
    }
  }

  // --- reply settings ---------------------------------------------------------

  function changeReplySettings(update) {
    if (!allowed.changeReplySettings) return
    setReplySettings((prev) => ({ ...prev, ...update }))
    saveReplySettings(browserStorage(), update)
  }

  // --- speech input -----------------------------------------------------------

  async function toggleRecording() {
    if (recording || recorder.current?.state === 'recording') {
      recorder.current?.stop()
      return
    }
    // A second click while the browser is still opening the microphone.
    if (micStarting.current || !allowed.startRecording) return
    micStarting.current = true
    setMicOpening(true)
    // Unlocked during this click (so a spoken question can be answered aloud) only if there is no player yet (so nothing is
    // playing to cut off); an existing one was unlocked by an earlier click.
    const replyPlayer = readAloud && !player.current ? unlockPlayer() : undefined
    let stream = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mounted.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const chunks = []
      const rec = new MediaRecorder(stream)
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        if (!mounted.current) return
        setRecording(false)
        setTranscribing(true)
        const controller = new AbortController()
        transcribeAbort.current = controller
        try {
          const tStop = performance.now()
          const result = await transcribe(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }), { language, signal: ticket(controller.signal).signal })
          if (!mounted.current) return
          const heardMs = performance.now() - tStop
          const heard = (result.text || '').trim()
          if (!heard || result.ignored) {
            onStatus?.("Didn't catch that. Try again a little closer to the microphone.")
          } else {
            spokenLanguage.current = result.tts_language || null
            const languageName = result.language ? (languageNames([result.language])[0] || result.language.charAt(0).toUpperCase() + result.language.slice(1)) : null
            // The latest sendMessage: this one's model and image may be stale.
            // Read aloud as the setting is now, not as it was at the click.
            const reply = readAloudRef.current ? replyPlayer : null
            if (!sendRef.current(heard, { replyPlayer: reply, heard: heardMetrics({ ms: heardMs, language: languageName }) })) setDraft(heard)
          }
        } catch (error) {
          if (mounted.current) fail(`Couldn't transcribe the recording: ${error.message}`)
        } finally {
          if (transcribeAbort.current === controller) transcribeAbort.current = null
          if (mounted.current) setTranscribing(false)
        }
      }
      recorder.current = rec
      rec.start()
      setRecording(true)
    } catch (error) {
      stream?.getTracks().forEach((t) => t.stop())
      onError?.(`The microphone isn't available (${error.message}). Allow microphone access for this page, then try again.`)
    } finally {
      micStarting.current = false
      setMicOpening(false)
    }
  }

  // --- welcome cards ----------------------------------------------------------

  async function loadDocumentStatus() {
    const board = ticket()
    try {
      const next = await getJson('rag/status', { signal: board.signal })
      if (board.live()) setDocStatus(next)
    } catch {
      if (board.live()) setDocStatus(null)
    }
  }

  // Upload, reset or clear. Leaving the tab ends the request; the board then
  // restores the previous documents (sima-neat/apps#574).
  async function runDocumentTask(label, task) {
    if (!allowed.documentTasks) return
    const board = ticket()
    setDocProgress({ label, text: '' })
    try {
      const text = await task({ signal: board.signal, onText: (t) => { if (board.live()) setDocProgress({ label, text: t }) } })
      const outcome = progressOutcome(text)
      if (outcome.ok) onStatus?.(outcome.message)
      else onError?.(outcome.message || `${label} the documents failed.`)
    } catch (error) {
      if (!isAbort(error) && board.live()) onError?.(`${label} the documents failed: ${error.message}`)
    } finally {
      setDocProgress(null)
      if (board.live()) loadDocumentStatus()
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

  // Ends the conversation: cancels a reply in progress, stops speaking and
  // clears the history. New chat and switching boards both start here.
  function resetConversation() {
    chatGeneration.current += 1
    chatAbort.current?.abort()
    stopSpeaking()
    setSpeechError(null)
    setSpeechStats({})
    setMessages([])
    setDocsMidChat(false)
  }

  function newChat() {
    if (!allowed.newChat) return
    resetConversation()
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

  function openSetup() {
    setSetupError(null)
    setTutorialStep(null)
    setSetupOpen(true)
    saveSetupOpen(window.localStorage, true)
  }

  // Leaving setup for the tour (at `tourStep`), or closing both.
  function leaveSetup(tourStep = null) {
    saveSetupOpen(window.localStorage, false)
    setSetupOpen(false)
    if (tourStep === null) markTutorialSeen(window.localStorage)
    setTutorialStep(tourStep)
  }

  // Run or stop the job; a request the board is slow to answer says so.
  async function setupRequest(kind, call, slowAfter = SLOW_REQUEST_MS) {
    setSetupBusy(kind)
    setSetupError(null)
    setSetupSlow(false)
    setupWrites.current += 1
    const slow = setTimeout(() => setSetupSlow(true), slowAfter)
    try {
      setSetupStatus(await call())
    } catch (err) {
      setSetupError(requestProblem(err))
    } finally {
      setupWrites.current += 1
      clearTimeout(slow)
      setSetupSlow(false)
      setSetupBusy(null)
    }
  }

  function copyCommand(command) {
    copyText(command).then(() => onStatus?.('Copied. Paste it into a shell on the board.'), (err) => onError?.(err.message))
  }

  const setupNext = setupAction(setupStatus)
  const banner = bannerAction(setupStatus, settings?.url)

  // One click starts an installed GenAI Studio, once a fresh read confirms only that is
  // left (the board may have changed since the banner's button was labelled).
  async function startFromBanner() {
    openSetup()
    if (!banner.runNow) return
    const fresh = await getSetup().catch(() => null)
    if (fresh && bannerAction(fresh, settings?.url).runNow) setupRequest('run', () => runSetup(undefined, fresh.generation))
  }

  function tryTutorialAction(action) {
    if (action === 'example-question') tryPrompt('Explain what an AI accelerator does, in simple terms.')
    else if (action === 'example-translate') tryPrompt("Translate 'good morning, how are you?' into Spanish.")
    else if (action === 'camera') openCamera()
    else if (action === 'vision') openVision()
    else if (action === 'settings') setSettingsOpen(true)
  }

  const engines = (voices && voices.engines) || []
  // An engine the board doesn't offer (any more) falls back to automatic.
  useEffect(() => {
    if (!voices || engine === 'default' || engines.some((e) => e.key === engine)) return
    setEngine('default')
    setVoice('')
  }, [voices, engines, engine])
  const engineVoices = useMemo(() => {
    const found = engines.find((e) => e.key === engine)
    return (found && found.voices) || []
  }, [engines, engine])
  const voiceWarnings = usable ? voiceEngineWarnings(health) : []
  const needsAttention = backend.state !== 'ready' || voiceWarnings.length > 0

  // --- render -----------------------------------------------------------------

  return (
    <div className="genai" ref={root}>
      {step && (
        <section className="panel genai-tutorial" aria-label="GenAI Studio tutorial" aria-live="polite">
          <p className="genai-tutorial-eyebrow">Tutorial · step {tutorialStep + 1} of {steps.length}</p>
          <p className="genai-tutorial-title">{step.title}</p>
          <p className="genai-tutorial-body">{step.body}</p>
          {step.id === 'intro' && offersSetup(backend.state) && (
            <p className="genai-tutorial-body genai-tutorial-question">
              GenAI Studio isn't answering at the board address yet. Is this your first time using it on this board?
            </p>
          )}
          <div className="genai-actions">
            {step.action && ((step.action !== 'camera' && step.action !== 'vision') || allowed.attachPicture) && (
              <button
                type="button"
                className="btn-tonal"
                disabled={step.action === 'camera' ? !allowed.openCamera : step.action === 'vision' ? !allowed.openVision : step.action.startsWith('example') && !allowed.typeMessage}
                onClick={() => tryTutorialAction(step.action)}
              >
                Try it
              </button>
            )}
            <span className="genai-tutorial-spacer" />
            <button type="button" className="btn-ghost" onClick={closeTutorial}>Skip tutorial</button>
            <button type="button" className="btn-ghost" disabled={tutorialStep === 0} onClick={() => setTutorialStep((i) => Math.max(0, i - 1))}>Back</button>
            {step.id === 'intro' && offersSetup(backend.state) ? (
              <>
                <button type="button" className="btn-tonal" onClick={openSetup}>Yes, set it up</button>
                <button type="button" className="btn-ghost" onClick={() => setTutorialStep((i) => i + 1)}>No, show me around</button>
              </>
            ) : tutorialStep < steps.length - 1 ? (
              <button type="button" className="btn-tonal" onClick={() => setTutorialStep((i) => i + 1)}>Next</button>
            ) : (
              <button type="button" className="btn-tonal" onClick={closeTutorial}>Start chatting</button>
            )}
          </div>
        </section>
      )}

      {setupOpen && (
        <section className="panel genai-tutorial genai-setup" aria-label="Set up GenAI Studio" aria-live="polite">
          <p className="genai-tutorial-eyebrow">Set up GenAI Studio{setupStatus?.board?.label ? ` · ${setupStatus.board.label}` : ''}</p>
          <p className="genai-tutorial-title">Get GenAI Studio running on the board</p>
          <p className="genai-tutorial-body">
            Insight runs each step on the board for you. The first time takes about 20 minutes and needs internet
            access on the board; the steps keep running if you close this page.
          </p>
          {!setupStatus && !setupReadError && <p className="hint">Checking the board…</p>}
          {setupStatus && settings?.url && !relayOnSetupBoard(settings.url, setupStatus) && (
            <p className="hint genai-setup-slow">
              These steps run on {setupStatus.board?.label || 'the board Insight is connected to'}, but this tab connects to {settings.url}.
              If that is not the same board, change the board address in Settings or select the board in the Board menu.
            </p>
          )}
          {setupStatus && (
            <ol className="genai-setup-steps">
              {setupStatus.steps.map((item) => (
                <li key={item.id} className={`genai-setup-step genai-setup-${item.state}`}>
                  <StepIcon kind={stepIcon(item.state)} label={STEP_LABELS[item.state] || item.state} />
                  <div className="genai-setup-step-body">
                    <p className="genai-setup-step-title">{item.title}</p>
                    <p className="hint">{item.description}</p>
                    {item.state === 'running' && lastLine(item.log) && <p className="genai-setup-last"><code>{lastLine(item.log)}</code></p>}
                    {item.stall && <SetupHelp problem={item.stall} warn onCopy={copyCommand} />}
                    {item.problem && <SetupHelp problem={item.problem} log={item.log} onCopy={copyCommand} />}
                    {item.warnings?.length > 0 && (
                      <SetupWarnings
                        warnings={item.warnings}
                        finished={item.state === 'done'}
                        onRunAgain={item.id === 'prepare' && canRunSetupAgain(setupStatus) ? () => setupRequest('run', () => runSetup('prepare', setupStatus?.generation), SLOW_STOP_MS) : null}
                        busy={setupBusy !== null}
                      />
                    )}
                  </div>
                </li>
              ))}
              <li className={`genai-setup-step genai-setup-${backend.state === 'ready' ? 'done' : 'pending'}`}>
                <StepIcon kind={connectIcon(backend.state)} label={STATE_LABELS[backend.state] || backend.state} />
                <div className="genai-setup-step-body">
                  <p className="genai-setup-step-title">Connect this tab</p>
                  <p className="hint">
                    {backend.state === 'ready'
                      ? 'GenAI Studio answers. Show me around starts with loading your first model.'
                      : `This tab connects to ${settings?.url || 'the board address in Settings'} once GenAI Studio is running. If GenAI Studio is running but this step doesn't get a check, check the board address in Settings.`}
                  </p>
                </div>
              </li>
            </ol>
          )}
          {setupReadError && <SetupHelp problem={setupReadError} log={setupReadError.detail} onCopy={copyCommand} />}
          {setupError && <SetupHelp problem={setupError} log={setupError.detail} onCopy={copyCommand} />}
          {setupSlow && (
            <p className="hint genai-setup-slow">
              The board has not answered yet. If this lasts, check that the board is on and reachable: the Board menu at the top shows its connection.
            </p>
          )}
          <div className="genai-actions">
            {setupNext && (
              <button type="button" className="btn-tonal" disabled={setupBusy !== null} onClick={() => setupRequest('run', () => runSetup(undefined, setupStatus?.generation))}>
                {setupBusy === 'run' ? 'Starting…' : setupNext.label}
              </button>
            )}
            {!setupNext && canStopStudio(setupStatus) && (
              <button type="button" className="btn-tonal" disabled={setupBusy !== null} onClick={() => setupRequest('stop-studio', () => stopStudio(setupStatus?.generation), SLOW_STOP_MS)}>
                {setupBusy === 'stop-studio' ? 'Stopping…' : 'Stop GenAI Studio'}
              </button>
            )}
            {setupStoppable(setupStatus) && (
              <button type="button" className="btn-ghost" disabled={setupBusy !== null} onClick={() => setupRequest('stop', () => stopSetup(setupStatus?.generation))}>
                {setupBusy === 'stop' ? 'Stopping…' : 'Stop'}
              </button>
            )}
            {!settingsOpen && (
              <button type="button" className="btn-ghost" onClick={() => setSettingsOpen(true)}>Open Settings</button>
            )}
            <span className="genai-tutorial-spacer" />
            <button type="button" className="btn-ghost" onClick={() => leaveSetup()}>Close</button>
            {backend.state === 'ready' && (
              <button type="button" className="btn-tonal" onClick={() => leaveSetup(1)}>Show me around</button>
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
            disabled={!allowed.changeChatModel || chatModels(status).length === 0}
            title={chatModel ? chatModel.name : ''}
          >
            {!chatModel && <option value="">{chatModels(status).length ? 'Choose a model to load' : 'No models on the board'}</option>}
            {chatModels(status).map((m) => (
              <option key={m.name} value={m.name} disabled={m.supported === false} title={m.unsupportedReason || undefined}>
                {modelLabel(m)}{keepsSeveral && (status?.loaded || []).includes(m.name) ? ' · loaded' : ''}{m.supported === false ? ' · not supported' : ''}
              </option>
            ))}
          </select>
        </label>
        {/* The tooltip sits on a wrapper: browsers show none on a disabled button. */}
        <span className="genai-tooltip-wrap" title="New chat">
          <button type="button" className="btn-ghost genai-tool genai-new-chat" onClick={newChat} disabled={!allowed.newChat} aria-label="New chat">
            <Icon d={ICONS.newChat} />
          </button>
        </span>
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
          <input type="checkbox" checked={docs.available && useDocs} disabled={!allowed.toggleDocuments} onChange={(e) => { setUseDocs(e.target.checked); setDocsMidChat(e.target.checked && messages.length > 0) }} />
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
          <button type="button" className={`btn-ghost genai-tool${spot('benchmark')}`} onClick={() => { if (allowed.openBenchmark) setBenchOpen(true) }} disabled={!allowed.openBenchmark} aria-label="Benchmark" title={!usable ? backend.title : bench.available ? 'Benchmark: first token time and tokens per second for the board\'s models' : bench.reason}>
            <Icon d={ICONS.gauge} />
          </button>
          <button type="button" className="btn-ghost genai-tool" onClick={() => { saveSetupOpen(window.localStorage, false); setSetupOpen(false); setTutorialStep(0) }} aria-pressed={step !== null || setupOpen} aria-label="Tutorial" title="Tutorial">
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
            {offersSetup(backend.state) && !setupOpen && (
              <button type="button" className="btn-tonal" onClick={startFromBanner}>{banner.label}</button>
            )}
            {(backend.action === 'settings' || backend.action === 'setup') && !settingsOpen && (
              <button type="button" className="btn-ghost" onClick={() => setSettingsOpen(true)}>Change board address</button>
            )}
            {lastError && <button type="button" className="btn-ghost" onClick={() => setLastError(null)}>Dismiss</button>}
          </div>
        </section>
      )}

      {(settingsOpen || backend.state === 'unconfigured') && (
        <section className="panel genai-settings-panel" aria-label="GenAI settings">
          <SettingsCard id="board" icon="board" title="Board" summary={boardSummary({ settings, state: backend.state })}>
            <form className="genai-form" onSubmit={applySettings}>
              <label>
                <span>Board address</span>
                <input
                  value={addressDraft}
                  onChange={(e) => { setAddressDraft(e.target.value); setAddressError('') }}
                  placeholder={settings?.defaultUrl || 'https://192.168.1.20:5000'}
                  aria-invalid={addressError ? 'true' : undefined}
                  aria-describedby={addressError ? 'genai-address-error' : undefined}
                />
              </label>
              <button type="submit" className="btn-tonal" disabled={!allowed.changeBoard}>Save</button>
            </form>
            {!allowed.changeBoard && <p className="hint">The address can be changed once the current reply, recording, model operation or download finishes.</p>}
            {addressError && <p id="genai-address-error" className="genai-field-error" role="alert">{addressError}</p>}
            <div className="genai-actions">
              <button type="button" className="btn-ghost genai-small" onClick={() => { setSettingsOpen(false); openSetup() }} disabled={setupOpen}>
                Open GenAI Studio setup
              </button>
            </div>
            <p className="hint">
              GenAI Studio setup installs, prepares and starts it on the board Insight is connected to, and lists each step's warnings. Leave the address empty to use {settings?.defaultUrl || 'the paired DevKit'}.
            </p>
          </SettingsCard>

          <SettingsCard id="replies" icon="replies" title="Replies" summary={replySummary(replySettings)}>
            <label className="genai-field">
              <span>System prompt</span>
              <textarea
                value={replySettings.systemPrompt}
                onChange={(e) => changeReplySettings({ systemPrompt: e.target.value })}
                // A field left empty shows the default again: that is what is sent.
                onBlur={() => { if (!replySettings.systemPrompt.trim()) changeReplySettings({ systemPrompt: DEFAULT_SYSTEM_PROMPT }) }}
                placeholder={DEFAULT_SYSTEM_PROMPT}
                rows={3}
                disabled={!allowed.changeReplySettings}
                aria-describedby="genai-system-prompt-note"
              />
            </label>
            <div className="genai-actions">
              <button type="button" className="btn-ghost genai-small" disabled={!allowed.changeReplySettings || replySettings.systemPrompt === DEFAULT_SYSTEM_PROMPT} onClick={() => changeReplySettings({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}>
                Reset to default
              </button>
              <span id="genai-system-prompt-note" className="hint">
                {systemPromptNote(replySettings.systemPrompt)} The tab still tells the model whether a message has a picture.
              </span>
            </div>
            <label className="genai-field">
              <span>Longest reply: {replySettings.maxTokens} tokens</span>
              <input
                type="range"
                min={MAX_TOKENS_LIMITS.min}
                max={MAX_TOKENS_LIMITS.max}
                step={MAX_TOKENS_LIMITS.step}
                value={replySettings.maxTokens}
                onChange={(e) => changeReplySettings({ maxTokens: clampMaxTokens(e.target.value) })}
                disabled={!allowed.changeReplySettings}
              />
            </label>
            <p className="hint">
              A token is about three quarters of a word; a reply that reaches the limit stops there. Both settings apply to the chat
              and the vision view, not to the benchmark, and this browser remembers them.
            </p>
          </SettingsCard>

          <SettingsCard id="models" icon="models" title="Models" summary={modelsSummary(status)} wide>
            <p className="hint">{status?.disk ? `${formatBytes(status.disk.freeBytes)} free on the board. ` : ''}{keepsSeveral ? `Up to ${residentLimit(status)} chat models stay loaded, and the one in use answers;` : 'One chat model runs at a time;'} the speech model turns your voice into text.</p>
            <ModelList
              title="Chat and vision"
              models={chatModels(status)}
              status={status}
              activeName={keepsSeveral && chatModel ? chatModel.name : undefined}
              disabled={!allowed.changeChatModel}
              onLoad={requestLoad}
              onUnload={unloadChatModel}
              onUse={keepsSeveral ? answerWith : undefined}
              useOnlyLoaded
              canDelete={(m) => deletableModel(m, status)}
              deleteDisabled={!allowed.deleteModel}
              onDelete={deleteModel}
            />
            <ModelList
              title="Speech recognition"
              models={speechModels(status)}
              status={status}
              disabled={!allowed.changeSpeechModel}
              onUse={switchSpeechModel}
              canDelete={(m) => deletableModel(m, status)}
              deleteDisabled={!allowed.deleteModel}
              onDelete={deleteModel}
            />
            {downloads.state !== 'unknown' && (
              <div className="genai-model-group">
                <h4 className="genai-model-group-title">Get more models</h4>
                {downloads.state === 'disabled' ? (
                  <p className="hint"><WithCode text={downloads.message} /></p>
                ) : (
                  <>
                    <form className="genai-row" onSubmit={searchHub}>
                      <input ref={hubSearchBox} type="search" className="search-input" value={hubQuery} onChange={(e) => setHubQuery(e.target.value)} placeholder="Qwen, Whisper, Llama" aria-label="Search Hugging Face models" />
                      <button type="submit" className="btn-ghost" disabled={!allowed.searchModels}>Search Hugging Face</button>
                    </form>
                    {downloads.state === 'offline' && <p className="hint">{downloads.message}</p>}
                    <DownloadProgress download={download} />
                    <DownloadFailure failure={failedDownload} disabled={!allowed.downloadModel} onDownload={(repoId) => startDownload(repoId)} />
                    {hubResults && hubResults.enabled !== false && (
                      <ul className="genai-models" aria-label="Models on Hugging Face">
                        {(hubResults.results || []).length === 0 && <li className="hint">No matching models.</li>}
                        {(hubResults.results || []).map((r) => {
                          const kind = modelKind(r)
                          const name = friendlyModelName(r.repoId.split('/').pop())
                          return (
                            <li key={r.repoId} className="genai-model-row">
                              <span className={`genai-kind genai-kind-${kind.key}`}>{kind.label}</span>
                              <span className="genai-model-name" title={r.repoId}>{name}</span>
                              <span className="genai-model-size">{r.sizeBytes ? formatBytes(r.sizeBytes) : ''}</span>
                              {r.alreadyInCatalog ? <span className="genai-model-state genai-model-state-on">On the board</span>
                                : r.unsupportedReason ? <span className="genai-model-state genai-model-state-unsupported" title={r.unsupportedReason}>Can't run here</span>
                                  : <span className="genai-model-state genai-model-state-off">On Hugging Face</span>}
                              <span className="genai-model-actions">
                                {!r.alreadyInCatalog && (
                                  <button type="button" className="btn-ghost genai-small" disabled={!allowed.downloadModel || Boolean(r.unsupportedReason)} title={r.unsupportedReason || r.repoId} aria-label={`Download ${name}`} onClick={() => startDownload(r.repoId)}>
                                    Download
                                  </button>
                                )}
                              </span>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
          </SettingsCard>

          <SettingsCard
            id="voice"
            icon="voice"
            title="Voice"
            summary={voiceSummary({ engine, voice, engines, languageLabel: language === 'auto' ? null : LANGUAGES.find((l) => l.value === language)?.label })}
          >
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
          </SettingsCard>

          <SettingsCard id="documents" icon="documents" title="Documents" summary={documentsCardSummary({ docs, docStatus })}>
            {docs.available ? (
              <>
                <p className="hint">
                  With <b>Use my documents</b> on, the board answers from these documents. Uploading a Markdown file
                  replaces them; Reset brings back the default SiMa document.
                </p>
                {/* The summary line may be cut short: a search service that isn't running is said in full. */}
                {docStatus?.database && docStatus.service && docStatus.service !== 'ok' && <p className="genai-error">{documentsSummary(docStatus)}</p>}
                <input ref={docInput} type="file" accept=".md,text/markdown" hidden onChange={(e) => { runDocumentTask('Uploading', (o) => uploadDocument(e.target.files[0], o)); e.target.value = '' }} />
                <div className="genai-actions">
                  <button type="button" className="btn-tonal" disabled={!allowed.documentTasks} onClick={() => docInput.current?.click()}>Upload a Markdown file</button>
                  <button type="button" className="btn-ghost" disabled={!allowed.documentTasks} onClick={() => runDocumentTask('Resetting', resetDocuments)}>Reset to the default</button>
                  <button type="button" className="btn-ghost danger" disabled={!allowed.documentTasks || !(docStatus && docStatus.database)} onClick={() => window.confirm('Remove all documents from the board? Use my documents then finds nothing until you upload or reset.') && runDocumentTask('Clearing', clearDocuments)}>Clear</button>
                  <button type="button" className="btn-ghost" disabled={!allowed.inspectDocuments || !(docStatus && docStatus.database)} title="The sections the board searches, with a filter" onClick={() => { if (allowed.inspectDocuments) setDocsViewOpen(true) }}>
                    View documents
                  </button>
                </div>
                {docProgress && (
                  <p className="hint" aria-live="polite">{docProgress.label}… {progressOutcome(docProgress.text).message}</p>
                )}
              </>
            ) : (
              <p className="hint">{docs.reason}</p>
            )}
          </SettingsCard>

          <SettingsCard id="troubleshooting" icon="troubleshoot" title="Troubleshooting" summary="Restart GenAI Studio if a model load fails or replies stop" wide>
            <p className="hint">
              Restart GenAI Studio on the board: <code>./run.sh stop</code>, then <code>{START_COMMAND}</code>.
              That frees the accelerator; then load the model again.
            </p>
          </SettingsCard>
        </section>
      )}

      <section className="panel genai-chat" aria-label="Chat">
        {docsMidChat && useDocs && messages.length > 0 && (
          <div className="genai-docs-hint" role="status">
            <span>Earlier replies in this chat can win over your documents. Start a new chat to answer from them.</span>
            <button type="button" className="btn-tonal genai-small" onClick={newChat} disabled={!allowed.newChat}>New chat</button>
            <button type="button" className="btn-ghost genai-small" onClick={() => setDocsMidChat(false)}>Keep this chat</button>
          </div>
        )}
        <div className="genai-transcript" ref={transcriptBox} onScroll={onTranscriptScroll}>
          {messages.length === 0 && firstModel && (
            <FirstModelOffer
              need={firstModel}
              offer={offer}
              downloads={downloads}
              download={download}
              failure={failedDownload}
              loadingNext={loadAfterDownload}
              allowed={allowed}
              onDownload={getFirstModel}
              onBrowse={browseModels}
              onCheckAgain={checkHubAgain}
            />
          )}
          {messages.length === 0 && !firstModel && (
            <div className="genai-welcome">
              <p className="genai-welcome-title">Chat with {chatModel ? friendlyModelName(chatModel.name) : 'a model'} on your board</p>
              <p className="section-note">
                Type or talk, {sees ? 'add a picture, ' : ''}and hear the answer read aloud, in most languages. New here? Open the Tutorial.
              </p>
              <div className="genai-examples" aria-label="Examples to try">
                <span className="hint">Try:</span>
                <button type="button" className="btn-ghost genai-small" disabled={!allowed.typeMessage} onClick={() => tryPrompt('Explain what an AI accelerator does, in simple terms.')}>
                  Explain what an AI accelerator does
                </button>
                {sees && (
                  <button type="button" className="btn-ghost genai-small" disabled={!allowed.openCamera} onClick={openCamera}>
                    What's in front of my camera?
                  </button>
                )}
                <button type="button" className="btn-ghost genai-small" disabled={!allowed.typeMessage} onClick={() => tryPrompt("Translate 'good morning, how are you?' into Spanish.")}>
                  Translate into Spanish
                </button>
                <button type="button" className="btn-ghost genai-small" disabled={!allowed.startRecording && !allowed.stopRecording} onClick={toggleRecording}>
                  Ask by voice
                </button>
              </div>
              {usable && !chatModel && chatModels(status).length > 0 && (
                <p className="hint" aria-live="polite">
                  {loadAfterDownload ? `Downloaded. Loading ${friendlyModelName(loadAfterDownload)} next…` : 'Choose a model at the top to start; loading takes a few minutes.'}
                </p>
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
                  <div className="genai-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{parts.answer}</ReactMarkdown></div>
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
                    <button type="button" className="btn-ghost genai-small" onClick={() => speakText(parts.answer, m.id)} disabled={!allowed.readAloud} title={allowed.readAloud ? 'Read this reply aloud' : backend.title}>
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

        {boardCameraOpen && (
          <div className="genai-camera" role="group" aria-label="Board camera">
            <BoardCameraPicker cameras={boardCameras} camera={boardCamera} onChange={setBoardCamera} disabled={!allowed.takeBoardSnapshot} />
            <div className="genai-actions">
              <button type="button" className="btn-tonal" onClick={takeBoardPicture} disabled={!allowed.takeBoardSnapshot || !boardCamera}>
                {boardSnapshotting ? 'Taking a picture…' : 'Take a picture'}
              </button>
              <button type="button" className="btn-ghost" onClick={closeBoardCamera}>Cancel</button>
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

        <form className={`genai-composer${spot('composer')}`} onSubmit={(e) => { e.preventDefault(); sendTyped() }}>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => { attachImage(e.target.files[0]); e.target.value = '' }} />
          <textarea
            ref={composer}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendTyped()
              }
            }}
            placeholder={allowed.typeMessage ? 'Ask anything, or press the microphone and speak' : firstModel ? 'Get a model first (above)' : (usable ? 'Choose a model at the top first' : backend.title)}
            aria-label="Message"
            rows={1}
            disabled={!allowed.typeMessage}
          />
          <div className="genai-composer-tools">
            <span className={`genai-composer-media${spot('media')}`}>
              <button type="button" className="btn-ghost genai-icon-btn" aria-label="Attach a picture" title={sees ? 'Attach a picture' : 'Needs a model that sees images'} disabled={!allowed.attachPicture} onClick={() => fileInput.current?.click()}>
                <Icon d={ICONS.photo} />
              </button>
              {/* A board without its camera says why here, where the board's camera would be. */}
              <button
                type="button"
                className="btn-ghost genai-icon-btn"
                aria-label="Take a picture with this browser's camera"
                title={!sees ? 'Needs a model that sees images' : `Take a picture with this browser's camera${boardCam.available ? '' : `. Board camera: ${boardCam.reason}`}`}
                disabled={!allowed.openCamera}
                onClick={openCamera}
              >
                <Icon d={ICONS.camera} />
              </button>
              {boardCam.available && (
                <button type="button" className="btn-ghost genai-icon-btn" aria-label="Take a picture with the board's camera" title={sees ? "Take a picture with a camera plugged into the board" : 'Needs a model that sees images'} disabled={!allowed.openBoardCamera} onClick={openBoardCamera}>
                  <Icon d={ICONS.boardCamera} />
                </button>
              )}
              <button type="button" className={`btn-ghost genai-icon-btn${spot('vision')}`} aria-label="Vision view" title={sees ? 'Vision: the camera full size, ask about it once or in a loop' : 'Needs a model that sees images'} disabled={!allowed.openVision} onClick={openVision}>
                <Icon d={ICONS.vision} />
              </button>
            </span>
            <span className="genai-header-spacer" />
            <button
              type="button"
              className={`${recording ? 'btn-ghost danger genai-icon-btn' : 'btn-ghost genai-icon-btn'}${spot('mic')}`}
              aria-label={recording ? 'Stop recording' : 'Speak your question'}
              aria-pressed={recording}
              title={recording ? 'Stop recording' : 'Speak your question'}
              disabled={!allowed.startRecording && !allowed.stopRecording}
              onClick={toggleRecording}
            >
              <Icon d={ICONS.mic} />
            </button>
            {streaming ? (
              <button type="button" className="genai-send genai-send-stop" aria-label="Stop the reply" title="Stop the reply" onClick={() => chatAbort.current?.abort()}>
                <Icon d={ICONS.stop} />
              </button>
            ) : (
              <button type="submit" className="genai-send" aria-label="Send" title="Send" disabled={!allowed.send}>
                <Icon d={ICONS.send} />
              </button>
            )}
          </div>
        </form>
      </section>

      {benchOpen && (
        <Suspense fallback={null}>
          <GenAIBenchmark
            status={status}
            ticket={ticket}
            onRunningChange={setBenchmarking}
            onClose={() => { setBenchOpen(false); setBenchmarking(false) }}
            onModelsChanged={refresh}
          />
        </Suspense>
      )}

      {visionOpen && (
        <VisionView
          model={chatModel}
          allowed={allowed}
          busyReason={backend.title}
          boardCam={boardCam}
          cameras={boardCameras}
          camera={boardCamera}
          onCameraChange={setBoardCamera}
          ticket={ticket}
          ask={askAboutPicture}
          prepareSpeech={prepareVisionSpeech}
          readAloud={readAloud}
          onReadAloudChange={changeReadAloud}
          speechStats={speechStats[VISION_READING]}
          speechError={speechError && speechError.id === VISION_READING ? speechError.text : ''}
          onActivity={onVisionActivity}
          onFullscreen={toggleFullscreen}
          onClose={() => setVisionOpen(false)}
        />
      )}

      {docsViewOpen && <DocumentsViewer ticket={ticket} onClose={() => setDocsViewOpen(false)} />}

      {unloadAsk && (
        <UnloadChoice
          ask={unloadAsk}
          status={status}
          disabled={!allowed.changeChatModel}
          onCancel={() => setUnloadAsk(null)}
          onConfirm={(names) => {
            const { model, already = [] } = unloadAsk
            setUnloadAsk(null)
            loadChatModel(model, [...new Set([...already, ...names])])
          }}
        />
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
  const frameWindow = useRef(null)    // the app's window, while Esc is watched there
  const backButton = useRef(null)
  const closeButton = useRef(null)

  // Keys pressed inside the app go to its frame, not to this page.
  const onFrameKey = useCallback((e) => {
    if (e.key === 'Escape') setOpen(null)
  }, [])

  function watchFrameKeys() {
    unwatchFrameKeys()
    try {
      const win = frame.current?.contentWindow
      win?.addEventListener('keydown', onFrameKey)
      frameWindow.current = win || null
    } catch {
      // Not same-origin after all: Esc works once focus is back on this page.
    }
  }

  function unwatchFrameKeys() {
    try {
      frameWindow.current?.removeEventListener('keydown', onFrameKey)
    } catch {
      // The frame's window is already gone.
    }
    frameWindow.current = null
  }

  // Focus moves into the dialog when it opens and when an app opens or closes.
  useEffect(() => {
    (backButton.current || closeButton.current)?.focus()
    return unwatchFrameKeys
  }, [open])

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
        <iframe ref={frame} className="genai-solutions-frame" title={open.name} src={solutionUrl(open.mode, model)} allow="camera; microphone; fullscreen" onLoad={watchFrameKeys} />
      ) : (
        <div className="genai-solutions-grid">
          <h2>SiMaSentry <span>Solutions</span></h2>
          <p>Demo apps that run on the board's loaded model. Voice input inside them uses the browser's own speech recognition, which may use an online service.</p>
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
        {open && <button type="button" ref={backButton} className="btn-ghost" onClick={() => setOpen(null)} title="Back to the solutions">Back</button>}
        {open && <a className="btn-ghost" href={solutionUrl(open.mode, model)} target="_blank" rel="noopener" title="Open in a new tab">New tab</a>}
        <button type="button" ref={closeButton} className="btn-ghost" onClick={onClose} title="Close (Esc)">Close</button>
      </div>
    </div>
  )
}

// Asks which loaded chat models to unload so another can load: past the
// board's limit (resident_limit), or when it doesn't fit in the accelerator's
// memory beside them (no_room). The board unloads only what is chosen here,
// because other clients may be using the others.
function UnloadChoice({ ask, status, disabled, onCancel, onConfirm }) {
  const { model, choice, already = [] } = ask
  const byName = new Map(chatModels(status).map((m) => [m.name, m]))
  const [picked, setPicked] = useState(() => new Set())
  const first = useRef(null)
  useEffect(() => { first.current?.focus() }, [])
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  const name = friendlyModelName(model.name)
  const why = choice.code === 'no_room'
    ? `${name} needs about ${formatBytes(choice.needBytes || model.acceleratorBytes || 0)} of accelerator memory, and about ${formatBytes(choice.freeBytes || 0)} is free beside the loaded models. Choose what to unload to make room.`
    : `The board keeps ${residentLimit(status)} chat models loaded at once. Choose ${choice.needed === 1 ? 'one' : choice.needed} to unload for ${name}.`
  const enough = picked.size >= choice.needed
  function toggle(n) {
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })
  }
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Make room for ${name}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="modal-card genai-unload-card">
        <h3>Make room for {name}</h3>
        <p className="hint">{why}</p>
        {already.length > 0 && <p className="hint">{already.map(friendlyModelName).join(', ')} {already.length === 1 ? 'is' : 'are'} unloaded too, as you chose.</p>}
        <ul className="genai-unload-list">
          {choice.candidates.map((n, i) => {
            const m = byName.get(n)
            const size = m && m.acceleratorBytes ? formatBytes(m.acceleratorBytes) : ''
            return (
              <li key={n}>
                <label>
                  <input ref={i === 0 ? first : undefined} type="checkbox" checked={picked.has(n)} onChange={() => toggle(n)} />
                  <span title={n}>{friendlyModelName(n)}</span>
                  {size && <span className="hint">{size}</span>}
                </label>
              </li>
            )
          })}
        </ul>
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn-tonal" disabled={disabled || !enough} onClick={() => onConfirm([...picked])}>
            Unload and load {name}
          </button>
        </div>
      </div>
    </div>
  )
}

// A group of models on the board, one row each: its kind, name, size and
// whether it is in use, then what can be done with it. activeName: the loaded
// chat model that answers, when the board keeps several. useOnlyLoaded: Use is
// offered for the other loaded models (chat); otherwise for models not in use
// (speech).
function ModelList({ title, models, status, activeName, disabled, onLoad, onUnload, onUse, useOnlyLoaded, canDelete, deleteDisabled, onDelete }) {
  return (
    <div className="genai-model-group">
      <h4 className="genai-model-group-title">{title}</h4>
      {models.length === 0 ? (
        <p className="hint">None on the board yet.</p>
      ) : (
        <ul className="genai-models" aria-label={title}>
          {models.map((m) => {
            const row = modelRow(m, status, activeName)
            return (
              <li key={m.name} className={`genai-model-row${row.on ? ' genai-model-row-on' : ''}`}>
                <span className={`genai-kind genai-kind-${row.kind.key}`}>{row.kind.label}</span>
                <span className="genai-model-name" title={m.name}>{row.name}</span>
                <span className="genai-model-size">{row.size}</span>
                <span className={`genai-model-state genai-model-state-${row.state.key}`} title={row.state.key === 'unsupported' ? m.unsupportedReason || undefined : undefined}>
                  {row.state.label}
                </span>
                <span className="genai-model-actions">
                  {onLoad && !row.on && (
                    <button type="button" className="btn-ghost genai-small" disabled={disabled || m.supported === false} title={m.unsupportedReason || (m.estimatedLoadS ? `About ${formatDuration(m.estimatedLoadS)} to load` : '')} aria-label={`Load ${row.name}`} onClick={() => onLoad(m)}>
                      Load
                    </button>
                  )}
                  {onUnload && row.on && (
                    <button type="button" className="btn-ghost genai-small" disabled={disabled} aria-label={`Unload ${row.name}`} onClick={() => onUnload(m)}>Unload</button>
                  )}
                  {onUse && (useOnlyLoaded ? row.on && m.name !== activeName : !row.on) && (
                    <button type="button" className="btn-ghost genai-small" disabled={disabled || m.supported === false} title={m.unsupportedReason || ''} aria-label={`Use ${row.name}`} onClick={() => onUse(m)}>Use</button>
                  )}
                  {onDelete && canDelete(m) && (
                    <button type="button" className="btn-ghost genai-small danger" disabled={deleteDisabled} title="Delete it from the board to free its space" aria-label={`Delete ${row.name}`} onClick={() => onDelete(m)}>Delete</button>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// Why the last download failed; for a repo Hugging Face renamed, a button
// downloads the new id (the board refuses to follow the rename on its own).
function DownloadFailure({ failure, disabled, onDownload }) {
  if (!failure) return null
  return (
    <div className="genai-actions" role="alert">
      <span className="genai-error">Download of {failure.repoId} failed: {failure.message}</span>
      {failure.renamedTo && (
        <button type="button" className="btn-tonal genai-small" disabled={disabled} onClick={() => onDownload(failure.renamedTo)}>
          Download {failure.renamedTo}
        </button>
      )}
    </div>
  )
}

// The chat's offer when the board has no model to chat with: the recommended
// model downloaded and loaded in place, or Settings, Models to browse; on a
// board that doesn't allow downloads, how to allow them.
function FirstModelOffer({ need, offer, downloads, download, failure, loadingNext, allowed, onDownload, onBrowse, onCheckAgain }) {
  return (
    <section className="genai-welcome genai-first-model" aria-labelledby="genai-first-model-title">
      <span className="genai-card-icon genai-first-model-icon"><Icon d={ICONS.models} /></span>
      <h2 id="genai-first-model-title" className="genai-welcome-title">
        {need.reason === 'unsupported' ? 'None of the models on the board can run on it' : 'Get a model to start chatting'}
      </h2>
      <p className="section-note">
        {need.reason === 'unsupported' ? 'The board lists only models it can\'t run. ' : 'The board has no chat model yet. '}
        <b>{offer.label}</b> is a good first one: it chats{offer.sees ? ', understands pictures and works in the vision view' : ''}.
        Downloading it onto the board, then loading it, takes several minutes.
      </p>
      {downloads.state === 'disabled' ? (
        <p className="genai-first-model-note"><WithCode text={downloads.message} /></p>
      ) : downloads.state === 'offline' ? (
        <>
          <p className="genai-first-model-note">{downloads.message}</p>
          <div className="genai-actions">
            <button type="button" className="btn-ghost" onClick={onCheckAgain}>Check again</button>
          </div>
        </>
      ) : (
        <>
          <div className="genai-actions genai-first-model-actions">
            <button type="button" className="btn-tonal" disabled={!allowed.downloadFirstModel} onClick={() => onDownload(offer.repoId)}>
              <Icon d={ICONS.download} />
              Download {offer.label}{offer.sizeBytes ? ` (${formatBytes(offer.sizeBytes)})` : ''}
            </button>
            <button type="button" className="btn-ghost" disabled={!allowed.browseModels} onClick={onBrowse}>Browse models</button>
          </div>
          <p className="hint">From Hugging Face: {offer.repoId}</p>
          {offer.tooBig && (
            <p className="genai-first-model-note">
              The board has {formatBytes(offer.freeBytes)} free, less than the {formatBytes(offer.sizeBytes)} download: delete a model in Settings, Models first.
            </p>
          )}
        </>
      )}
      <DownloadProgress download={download} />
      {loadingNext && <p className="hint" aria-live="polite">Downloaded. Loading {friendlyModelName(loadingNext)} next…</p>}
      <DownloadFailure failure={failure} disabled={!allowed.downloadFirstModel} onDownload={onDownload} />
    </section>
  )
}

// The board's cameras as a menu; while they are listed, why there are none, or
// what went wrong.
function BoardCameraPicker({ cameras, camera, onChange, disabled }) {
  if (!cameras) return <span className="hint">Looking for cameras on the board…</span>
  if (cameras.error) return <span className="genai-error">{cameras.error}</span>
  if (!cameras.devices.length) return <span className="hint">No camera is plugged into the board.</span>
  return (
    <label className="genai-model-picker">
      <span>Board camera</span>
      <select value={camera} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {cameras.devices.map((d) => <option key={d.device} value={d.device}>{d.label}</option>)}
      </select>
    </label>
  )
}

const asSentence = (text) => (/[.!?…]$/.test(text) ? text : `${text}.`)

// The vision view, like the standalone Studio's full-screen Vision: a camera
// (this browser's, or the board's, one picture per question) full size, with
// the latest answer under it. Ask asks once; Loop takes a new picture and asks
// again after each answer (genai/visionLoop.js) until Stop, an error, a model
// change, or the view closing (also when the board changes or the tab is left).
// `ask` is the tab's: its requests belong to the board session, and it reads
// the answers aloud when Read replies aloud is on.
function VisionView({ model, allowed, busyReason, boardCam, cameras, camera, onCameraChange, ticket, ask, prepareSpeech, readAloud, onReadAloudChange, speechStats, speechError, onActivity, onFullscreen, onClose }) {
  const sees = Boolean(model && model.supportsVision)
  const modelName = model ? model.name : null
  const [source, setSource] = useState('browser')          // 'browser' | 'board'
  const [prompt, setPrompt] = useState(VISION_PRESETS[0])
  const [answer, setAnswer] = useState(null)                // {prompt, text, pending, stopped, metrics, turn}
  const [notice, setNotice] = useState('')                  // why the loop stopped, or a camera problem
  const [asking, setAsking] = useState(false)
  const [looping, setLooping] = useState(false)
  const [snapshotting, setSnapshotting] = useState(false)
  const [boardPicture, setBoardPicture] = useState(null)    // the board camera's latest picture
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraTry, setCameraTry] = useState(0)            // choosing this browser's camera again retries it
  const videoRef = useRef(null)
  const promptBox = useRef(null)
  const loop = useRef(null)
  const loopModel = useRef(null)
  const once = useRef(null)          // a single question's AbortController
  const preview = useRef(null)       // Take a picture's AbortController
  // Read by the loop at every turn: it outlives the render that started it.
  const latest = useRef({})
  latest.current = { ask, source, camera, prompt, allowed, busyReason, model, sees }

  useEffect(() => {
    onActivity({ asking, loop: looping, snapshot: snapshotting })
  }, [asking, looping, snapshotting, onActivity])

  // Closing the view ends the loop and any question.
  useEffect(() => () => {
    loop.current?.stop()
    once.current?.abort()
    preview.current?.abort()
    onActivity({ asking: false, loop: false, snapshot: false })
  }, [onActivity])

  // Another model answers now: the loop was asking the previous one.
  useEffect(() => {
    if (loop.current && loopModel.current !== modelName) loop.current.stop('The model changed.')
  }, [modelName])

  useEffect(() => {
    promptBox.current?.focus()
  }, [])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // This browser's camera runs while it is the source.
  useEffect(() => {
    if (source !== 'browser') return undefined
    let stream = null
    let cancelled = false
    setCameraReady(false)
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice("This browser can't use a camera on this page. Use the board camera, or open Insight over HTTPS.")
      return undefined
    }
    navigator.mediaDevices.getUserMedia({ video: true, audio: false }).then((s) => {
      if (cancelled) {
        s.getTracks().forEach((t) => t.stop())
        return
      }
      stream = s
      if (videoRef.current) videoRef.current.srcObject = s
      setCameraReady(true)
    }, (error) => {
      if (!cancelled) setNotice(`This browser's camera isn't available (${error.message}). Allow camera access for this page, then choose it again.`)
    })
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
      if (videoRef.current) videoRef.current.srcObject = null
    }
  }, [source, cameraTry])

  // The picture to ask about: this browser's camera now, or a new one from the board's.
  async function capture(signal) {
    const { source: from, camera: device } = latest.current
    if (from === 'browser') {
      const picture = videoFrameToDataUrl(videoRef.current)
      if (!picture) throw new Error("This browser's camera has no picture yet.")
      return picture
    }
    if (!device) throw new Error('Choose a board camera first.')
    const board = ticket(signal)
    setSnapshotting(true)
    try {
      const picture = await imageToDataUrl(await boardCameraSnapshot(device, { signal: board.signal }))
      // From the previous board, or for a question that was stopped: dropped.
      if (!board.live() || signal.aborted) throw new DOMException('Stopped', 'AbortError')
      setBoardPicture(picture)
      return picture
    } catch (error) {
      if (isAbort(error)) throw error
      throw new Error(snapshotErrorMessage(error, device))
    } finally {
      if (board.live()) setSnapshotting(false)
    }
  }

  // One question about one picture; the answer shows as it is written.
  async function answerTurn({ picture, prompt: question, signal, turn }) {
    const board = ticket(signal)
    setAnswer({ prompt: question, text: '', pending: true, turn })
    const result = await latest.current.ask({
      picture,
      prompt: question,
      signal: board.signal,
      onDelta: (text) => {
        if (!board.signal.aborted) setAnswer((a) => (a && a.pending ? { ...a, text } : a))
      }
    })
    if (!board.live() || signal.aborted) return
    setAnswer({ prompt: question, text: result.answer, metrics: result.metrics, turn })
  }

  function blockedReason() {
    const now = latest.current
    if (now.allowed.continueVisionLoop) return null
    if (!now.model) return 'No chat model is loaded.'
    if (!now.sees) return `${friendlyModelName(now.model.name)} doesn't see images.`
    return asSentence(now.busyReason || 'The board is busy')
  }

  function markStopped() {
    setAnswer((a) => (a && a.pending ? { ...a, pending: false, stopped: true } : a))
  }

  async function askOnce(question = prompt) {
    if (!allowed.askVision) return
    const text = question.trim() || VISION_PRESETS[0]
    prepareSpeech()
    setNotice('')
    const controller = new AbortController()
    once.current = controller
    setAsking(true)
    try {
      await answerTurn({ picture: await capture(controller.signal), prompt: text, signal: controller.signal })
    } catch (error) {
      if (!isAbort(error) && !controller.signal.aborted) {
        setNotice(asSentence(error.message))
        setAnswer((a) => (a && a.pending ? { ...a, pending: false } : a))
      }
    } finally {
      if (once.current === controller) once.current = null
      setAsking(false)
    }
  }

  function startLoop() {
    if (!allowed.startVisionLoop) return
    prepareSpeech()
    setNotice('')
    loopModel.current = modelName
    const run = createVisionLoop({
      capture,
      ask: answerTurn,
      prompt: () => latest.current.prompt.trim() || VISION_PRESETS[0],
      blocked: blockedReason,
      onStop: (reason) => {
        if (loop.current === run) loop.current = null
        setLooping(false)
        markStopped()
        if (reason) setNotice(`The loop stopped. ${asSentence(reason)}`)
      }
    })
    loop.current = run
    setLooping(true)
    run.start()
  }

  function stop() {
    if (!allowed.stopVision) return
    loop.current?.stop()
    once.current?.abort()
    markStopped()
  }

  // In a loop the next picture is asked about it; otherwise it is asked now.
  function choosePreset(text) {
    setPrompt(text)
    if (!looping) askOnce(text)
  }

  function chooseSource(next) {
    if (!allowed.chooseVisionSource) return
    setNotice('')
    if (next !== source) setSource(next)
    else if (next === 'browser' && !cameraReady) setCameraTry((n) => n + 1)   // e.g. after allowing access
  }

  // Board camera: a picture to aim with, before asking.
  async function takePicture() {
    if (!allowed.takeBoardSnapshot) return
    setNotice('')
    const controller = new AbortController()
    preview.current = controller
    try {
      await capture(controller.signal)
    } catch (error) {
      if (!isAbort(error) && !controller.signal.aborted) setNotice(asSentence(error.message))
    } finally {
      if (preview.current === controller) preview.current = null
    }
  }

  const busy = asking || looping
  return (
    <div className="genai-vision" role="dialog" aria-modal="true" aria-label="Vision">
      <div className="genai-bench-top genai-vision-top">
        <h2>Vision</h2>
        <p>
          {!model ? 'No model loaded: choose one in the Model menu first.'
            : sees ? <>Asking <b>{friendlyModelName(model.name)}</b> about what the camera sees.</>
              : `${friendlyModelName(model.name)} doesn't see images: load a model that does.`}
        </p>
        <div className="genai-vision-sources" role="group" aria-label="Picture source">
          <button type="button" className={source === 'browser' ? 'btn-tonal genai-small' : 'btn-ghost genai-small'} aria-pressed={source === 'browser'} disabled={!allowed.chooseVisionSource} onClick={() => chooseSource('browser')}>
            This browser's camera
          </button>
          {boardCam.available && (
            <button type="button" className={source === 'board' ? 'btn-tonal genai-small' : 'btn-ghost genai-small'} aria-pressed={source === 'board'} disabled={!allowed.chooseVisionSource} onClick={() => chooseSource('board')}>
              Board camera
            </button>
          )}
        </div>
        <button type="button" className="btn-ghost genai-tool" onClick={onFullscreen} aria-label="Full screen" title="Full screen">
          <Icon d={ICONS.fullscreen} />
        </button>
        <button type="button" className="btn-ghost" onClick={onClose} title="Close (Esc)">Close</button>
      </div>
      {!boardCam.available && <p className="hint genai-vision-note">Board camera: {boardCam.reason}</p>}

      <div className="genai-vision-stage">
        {source === 'browser' ? (
          <video ref={videoRef} autoPlay playsInline muted aria-label="This browser's camera" />
        ) : boardPicture ? (
          <img src={boardPicture} alt="The latest picture from the board's camera" />
        ) : (
          <p className="genai-vision-empty">Each question takes a new picture with the board's camera. Take a picture to aim it first.</p>
        )}
        {source === 'browser' && !cameraReady && !notice && <p className="genai-vision-empty genai-vision-over">Starting this browser's camera…</p>}
        {looping && <span className="genai-vision-live">Loop{answer && answer.turn ? ` · answer ${answer.turn}` : ''}</span>}
      </div>

      <div className="genai-vision-answer" aria-live="polite">
        {answer ? (
          <>
            <p className="genai-vision-question">{answer.prompt}</p>
            {answer.text ? (
              <div className="genai-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{answer.text}</ReactMarkdown></div>
            ) : (
              answer.pending && <p className="hint">{snapshotting ? 'Taking a picture on the board…' : 'Looking…'}</p>
            )}
            {answer.stopped && <p className="hint">Stopped.</p>}
            <Metrics items={answer.metrics} label="How fast the model answered" />
            <Metrics items={speechStats} label="How fast the answer was spoken" />
          </>
        ) : (
          <p className="hint">Ask about the picture and the answer appears here. Loop asks again about each new picture until you press Stop.</p>
        )}
        {speechError && <p className="genai-error">{speechError}</p>}
        {notice && <p className="genai-error" role="alert">{notice}</p>}
      </div>

      <form className="genai-vision-ask" onSubmit={(e) => { e.preventDefault(); askOnce() }}>
        <div className="genai-examples" aria-label="Questions to ask">
          {VISION_PRESETS.map((text) => (
            <button key={text} type="button" className="btn-ghost genai-small" aria-pressed={prompt === text} disabled={!allowed.typeMessage} onClick={() => choosePreset(text)}>
              {text}
            </button>
          ))}
        </div>
        <div className="genai-row">
          <input ref={promptBox} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={VISION_PRESETS[0]} aria-label="Question about the picture" disabled={!allowed.typeMessage} />
          {busy ? (
            <button type="button" className="btn-ghost danger" disabled={!allowed.stopVision} onClick={stop}>Stop</button>
          ) : (
            <>
              <button type="submit" className="btn-tonal" disabled={!allowed.askVision}>Ask</button>
              <button type="button" className="btn-ghost" disabled={!allowed.startVisionLoop} title="Ask again about each new picture until you press Stop" onClick={startLoop}>Loop</button>
            </>
          )}
        </div>
        <div className="genai-actions">
          {source === 'board' && <BoardCameraPicker cameras={cameras} camera={camera} onChange={onCameraChange} disabled={!allowed.chooseVisionSource} />}
          {source === 'board' && (
            <button type="button" className="btn-ghost genai-small" disabled={!allowed.takeBoardSnapshot || !camera} onClick={takePicture}>
              {snapshotting && !busy ? 'Taking a picture…' : 'Take a picture'}
            </button>
          )}
          <span className="genai-header-spacer" />
          <label className="genai-check" title="Read every answer aloud with the board's speech engine; a loop waits for the reading before the next picture">
            <input type="checkbox" checked={readAloud} onChange={(e) => onReadAloudChange(e.target.checked)} />
            Read answers aloud
          </label>
        </div>
      </form>
    </div>
  )
}

// View documents: what the board's document database holds (GET rag/inspect),
// the source and its sections, with a filter, like the standalone Studio's.
function DocumentsViewer({ ticket, onClose }) {
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState('')
  const [query, setQuery] = useState('')
  const filterBox = useRef(null)

  useEffect(() => {
    // Closing the viewer, a board switch or leaving the tab ends the request.
    const closed = new AbortController()
    const board = ticket(closed.signal)
    getJson(inspectPath(), { signal: board.signal })
      .then((next) => { if (board.live() && !closed.signal.aborted) setData(next) })
      .catch((error) => { if (!isAbort(error) && board.live()) setFailed(`Couldn't read the documents: ${error.message}`) })
    return () => closed.abort()
  }, [ticket])

  // The filter box appears with the sections.
  useEffect(() => {
    if (data) filterBox.current?.focus()
  }, [data])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const view = useMemo(() => inspectSummary(data), [data])
  const shown = useMemo(() => filterSections(view.sections, query), [view, query])
  return (
    <div className="genai-bench" role="dialog" aria-modal="true" aria-label="Documents on the board">
      <div className="genai-bench-top">
        <h2>Documents</h2>
        <p>What the board searches when Use my documents is on.</p>
        <button type="button" className="btn-ghost" onClick={onClose} title="Close (Esc)">Close</button>
      </div>
      <div className="genai-bench-body">
        <section className="genai-bench-live" aria-label="Summary">
          {view.rows.length > 0 && (
            <dl className="genai-docs-meta">
              {view.rows.map((r) => (
                <div key={r.label}>
                  <dt>{r.label}</dt>
                  <dd title={r.title}>{r.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {failed ? <p className="genai-error">{failed}</p> : view.note && <p className="hint">{view.note}</p>}
        </section>
        {view.sections.length > 0 && (
          <section className="genai-bench-results" aria-label="Sections">
            <div className="genai-bench-results-head">
              <input ref={filterBox} type="search" className="search-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter sections…" aria-label="Filter sections" />
              <span className="hint genai-docs-count">{query.trim() ? `${shown.length} of ${view.sections.length}` : view.sections.length} sections</span>
            </div>
            {shown.length === 0 && <p className="hint">No section matches “{query.trim()}”.</p>}
            <ol className="genai-docs-sections">
              {shown.map((s) => (
                <li key={s.number}>
                  <p className="genai-docs-heading"><span>{s.number}</span>{s.heading || '(no heading)'}</p>
                  <p className="genai-docs-text">{s.text}</p>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  )
}
