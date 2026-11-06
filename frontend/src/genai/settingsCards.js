// What the GenAI tab's Settings says about the connection, and how each model
// on the board reads in Settings, Models. Kept free of React and DOM so
// `node --test` covers it.
import { formatBytes, friendlyModelName } from './backendState.js'

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
export function addressSummary({ settings = null } = {}) {
  const url = settings && settings.url
  if (!url) return settings && settings.configuredUrl ? 'The saved address is not valid' : 'No address set'
  let host = url
  try {
    host = new URL(url).host
  } catch {
    // Shown as saved.
  }
  return settings.configuredUrl ? host : `${host} (default)`
}

// What kind of model it is, from the catalog's type (chat, llm, vlm, asr) or a
// Hugging Face search result's (llm, vlm, asr).
export function modelKind(model) {
  const type = model && model.type
  if (type === 'asr') return { key: 'speech', label: 'Speech' }
  if (type === 'vlm' || (model && model.supportsVision)) return { key: 'vision', label: 'Vision' }
  return { key: 'chat', label: 'Chat' }
}

// A model on the board: what kind it is, its size, and whether it is in
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
      : model.complete === false ? { key: 'incomplete', label: 'Download incomplete' }
        : model.supported === false ? { key: 'unsupported', label: "Can't run here" }
          : { key: 'off', label: 'On DevKit' }
  return {
    name: friendlyModelName(model.name),
    kind,
    size: typeof model.sizeBytes === 'number' && model.sizeBytes > 0 ? formatBytes(model.sizeBytes) : '',
    state,
    on
  }
}
