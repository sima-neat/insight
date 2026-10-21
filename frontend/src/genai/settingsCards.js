// What the GenAI tab's Settings cards say: one line per card about how it is
// set now, and how each model on the board reads in the Models card. Kept free
// of React and DOM so `node --test` covers it.
import { chatModels, engineName, formatBytes, friendlyModelName, speechModels } from './backendState.js'
import { loadedChatModels } from './models.js'
import { documentsSummary } from './documents.js'

// The status label's words, shared by the header chip and the Board card.
export const STATE_LABELS = {
  ready: 'Ready',
  busy: 'Busy',
  starting: 'Starting',
  failed: 'Error',
  error: 'Error',
  unavailable: 'Not running',
  unconfigured: 'Not set up',
  incompatible: 'Incompatible'
}

// settings: GET /api/genai/settings ({url, configuredUrl, defaultUrl}).
export function boardSummary({ settings = null, state = '' } = {}) {
  const url = settings && settings.url
  if (!url) return settings && settings.configuredUrl ? 'The saved address is not valid' : 'No board selected'
  let host = url
  try {
    host = new URL(url).host
  } catch {
    // Shown as saved.
  }
  const where = settings.configuredUrl ? host : `${host} (default)`
  return STATE_LABELS[state] ? `${where} · ${STATE_LABELS[state]}` : where
}

// The models the Models card lists (chat, vision and speech recognition).
export function modelsSummary(status) {
  if (!status) return 'Waiting for the board'
  const count = chatModels(status).length + speechModels(status).length
  const onBoard = count ? `${count} model${count === 1 ? '' : 's'} on the board` : 'No models on the board yet'
  const loading = status.loading && status.loading.name
  const loaded = loadedChatModels(status)
  const now = loading ? `Loading ${friendlyModelName(loading)}`
    : loaded.length > 1 ? `${loaded.length} chat models loaded`
      : loaded.length ? `${friendlyModelName(loaded[0].name)} loaded`
        : count ? 'No chat model loaded' : ''
  return [now, onBoard].filter(Boolean).join(' · ')
}

// engines: /v1/audio/voices engines ({key, label, voices: [{id, label}]}).
// languageLabel: the spoken language chosen, or null for automatic.
export function voiceSummary({ engine = 'default', voice = '', engines = [], languageLabel = null } = {}) {
  const found = (engines || []).find((e) => e.key === engine)
  const engineText = engine === 'default' ? 'Automatic voice' : (found && found.label) || engineName(engine)
  const chosen = voice && found && (found.voices || []).find((v) => v.id === voice)
  const voiceText = voice ? ` (${(chosen && chosen.label) || voice})` : ''
  const language = languageLabel ? `you speak ${languageLabel}` : 'spoken language detected automatically'
  return `${engineText}${voiceText} · ${language}`
}

// docs: documentsSupport(health); docStatus: GET /rag/status.
export function documentsCardSummary({ docs, docStatus = null } = {}) {
  if (!docs || !docs.available) return 'Not available on this board'
  return documentsSummary(docStatus)
}

// What kind of model it is, from the catalog's type (chat, llm, vlm, asr) or a
// Hugging Face search result's (llm, vlm, asr).
export function modelKind(model) {
  const type = model && model.type
  if (type === 'asr') return { key: 'speech', label: 'Speech' }
  if (type === 'vlm' || (model && model.supportsVision)) return { key: 'vision', label: 'Vision' }
  return { key: 'chat', label: 'Chat' }
}

// A model in the Models card: what kind it is, its size, and whether it is in
// use now. Speech recognition models are "in use" (one at a time), chat and
// vision models "loaded".
// activeName: the loaded chat model that answers, when the board keeps several;
// it reads "In use" and the other loaded ones "Loaded".
export function modelRow(model, status, activeName) {
  const kind = modelKind(model)
  const loaded = new Set((status && status.loaded) || [])
  const loading = status && status.loading && status.loading.name
  const speech = kind.key === 'speech'
  const on = speech ? Boolean(model.activeAsr) || (status && status.asrModel) === model.name : loaded.has(model.name)
  const state = loading === model.name ? { key: 'loading', label: 'Loading…' }
    : on ? { key: 'on', label: speech || (activeName && activeName === model.name) ? 'In use' : 'Loaded' }
      : model.supported === false ? { key: 'unsupported', label: "Can't run here" }
        : { key: 'off', label: speech ? 'Not in use' : 'Not loaded' }
  return {
    name: friendlyModelName(model.name),
    kind,
    size: typeof model.sizeBytes === 'number' && model.sizeBytes > 0 ? formatBytes(model.sizeBytes) : '',
    state,
    on
  }
}
