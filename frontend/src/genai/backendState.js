// What the GenAI tab shows about the board's GenAI Studio backend, derived from
// the relayed /health and /models/status answers. Kept free of React so
// `node --test` covers every state.

// The Studio API versions this Insight understands (`api_version` in /health).
// A backend from before the field existed reports none and is accepted.
export const SUPPORTED_API_VERSIONS = { min: 1, max: 1 }

export const START_COMMAND = './run.sh --backend-only'

export function checkApiVersion(health) {
  const version = health ? health.api_version : undefined
  if (version === undefined || version === null) return { supported: true, version: null }
  if (!Number.isInteger(version)) return { supported: false, version, reason: 'unreadable' }
  if (version < SUPPORTED_API_VERSIONS.min) return { supported: false, version, reason: 'too-old' }
  if (version > SUPPORTED_API_VERSIONS.max) return { supported: false, version, reason: 'too-new' }
  return { supported: true, version }
}

// health: {httpStatus, body, networkError} from GET /api/genai/health
// status: body of GET /api/genai/models/status, or null
// busyOp: label of an operation this tab started and is still running, or null
// lastError: message of the last failed operation, or null
// Returns {state, title, detail, action} where state is one of
// unconfigured | unavailable | incompatible | starting | busy | failed | ready.
export function deriveBackendState({ health, status = null, busyOp = null, lastError = null }) {
  if (!health) {
    return { state: 'starting', title: 'Connecting to the board…', detail: '', action: null }
  }
  const body = health.body || {}
  if (health.httpStatus === 503 && body.reason === 'not-configured') {
    return {
      state: 'unconfigured',
      title: 'No board selected',
      detail: 'Enter the address of the board that runs GenAI Studio.',
      action: 'settings'
    }
  }
  if (health.networkError || health.httpStatus === 502 || health.httpStatus === 504) {
    return {
      state: 'unavailable',
      title: 'GenAI Studio is not running on the board',
      detail: `Start it on the board from the Studio's directory with ${START_COMMAND}, or check the board address.`,
      action: 'start-command'
    }
  }
  if (health.httpStatus !== 200) {
    return {
      state: 'unavailable',
      title: `The board answered ${health.httpStatus}`,
      detail: body.error || 'The address may not point at GenAI Studio. Check the board address.',
      action: 'settings'
    }
  }

  const version = checkApiVersion(body)
  if (!version.supported) {
    const newer = version.reason === 'too-new'
    return {
      state: 'incompatible',
      title: 'This board runs an unsupported GenAI Studio version',
      detail: newer
        ? `The board's API version ${version.version} is newer than this Insight supports (${SUPPORTED_API_VERSIONS.max}). Update Insight.`
        : `The board's API version ${version.version} is older than this Insight needs (${SUPPORTED_API_VERSIONS.min}). Update Apps on the board.`,
      action: null
    }
  }

  // An operation this tab started (a model load, a reset) keeps the model server
  // too busy to answer /health; report it as such rather than as a restart.
  const loading = status && status.loading
  if (busyOp) {
    const remaining = loading && typeof loading.remainingS === 'number' ? ` · about ${formatDuration(loading.remainingS)} left` : ''
    return { state: 'busy', title: busyOp, detail: `Chat and speech wait until it finishes${remaining}.`, action: null }
  }

  const modelServerUp = Boolean(body.model_server && body.model_server.reachable)
  if (!body.ok || !modelServerUp) {
    return {
      state: 'starting',
      title: 'GenAI Studio is starting',
      detail: 'The model server is not answering yet; it may be loading a model or restarting.',
      action: null
    }
  }

  if (loading) {
    const label = `Loading ${loading.name}`
    const remaining = loading && typeof loading.remainingS === 'number' ? ` · about ${formatDuration(loading.remainingS)} left` : ''
    return { state: 'busy', title: label, detail: `Chat and speech wait until it finishes${remaining}.`, action: null }
  }

  if (lastError) {
    return {
      state: 'failed',
      title: 'The last operation failed',
      detail: lastError,
      action: 'reset-mla'
    }
  }

  return { state: 'ready', title: 'Connected to GenAI Studio on the board', detail: '', action: null }
}

// Chat and speech run only when the backend is ready (a failed operation still
// leaves the backend usable; the banner offers recovery).
export function canUseModels(state) {
  return state === 'ready' || state === 'failed'
}

export function chatModels(status) {
  return ((status && status.catalog) || []).filter((m) => m.type === 'llm' || m.type === 'vlm')
}

export function speechModels(status) {
  return ((status && status.catalog) || []).filter((m) => m.type === 'asr')
}

export function loadedChatModel(status) {
  const loaded = new Set((status && status.loaded) || [])
  return chatModels(status).find((m) => loaded.has(m.name)) || null
}

export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest ? `${m} min ${rest} s` : `${m} min`
}

// A readable model name: "Qwen3-VL-4B-Instruct-GPTQ-a16w4" -> "Qwen3 VL 4B",
// "florianvoss@whisper-small-a16w8-layered-encoder" -> "Whisper small".
// The exact name stays available as a tooltip.
const BUILD_WORDS = new Set(['instruct', 'chat', 'gptq', 'awq', 'autoround', 'layered', 'encoder', 'safetensors', 'hf', 'int8', 'int4', 'bf16', 'fp16'])

export function friendlyModelName(name) {
  if (!name) return ''
  const base = String(name).split('@').pop()
  const words = base
    .split(/[-_]+/)
    .filter((w) => w && !BUILD_WORDS.has(w.toLowerCase()) && !/^a\d+w\d+$/i.test(w))
  if (!words.length) return base
  const first = words[0]
  words[0] = first.charAt(0).toUpperCase() + first.slice(1)
  return words.join(' ')
}

// Whether a chat model has a step-by-step reasoning mode the tab can turn on
// or off. Qwen3 text models are hybrid thinkers; their Instruct (2507) and
// VL Instruct variants answer directly and ignore the switch.
export function supportsThinking(name) {
  const n = String(name || '').toLowerCase()
  if (/thinking|deepseek-r1|qwq/.test(n)) return true
  return /qwen3/.test(n) && !/instruct/.test(n)
}
