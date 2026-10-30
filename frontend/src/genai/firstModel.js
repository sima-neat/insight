// A board with no model to chat with: the chat offers to download a
// recommended one in place (then loads it), or to browse Hugging Face in
// Settings, Models. Kept free of React and DOM so `node --test` covers it.
import { chatModels, friendlyModelName } from './backendState.js'

// Qwen3-VL 4B sees images, so the chat, pictures and the vision view all work
// with it; GenAI Studio's README names it as its default vision-language model.
export const RECOMMENDED_MODEL = { repoId: 'simaai/Qwen3-VL-4B-Instruct-Autoround-a16w4', sees: true }

// The models/hub/card path that describes it (its download size).
export function cardPath(repoId) {
  return `models/hub/card?repoId=${encodeURIComponent(repoId)}`
}

// The name a download gets in the board's catalog (GenAI Studio's
// hub.safe_name): SiMa's own models keep their name, other accounts' become
// "<org>@<name>". '' for something that isn't an "org/name" id.
export function catalogNameFor(repoId) {
  const parts = String(repoId || '').split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return ''
  return parts[0].toLowerCase() === 'simaai' ? parts[1] : `${parts[0]}@${parts[1]}`
}

// Whether the chat has to offer a first model: the board lists no chat or
// vision model, or only builds it can't run. null while the catalog is
// unknown (the board is down or still answering), so nothing flashes.
export function firstModelNeeded(status) {
  if (!status || !Array.isArray(status.catalog)) return null
  const models = chatModels(status)
  if (models.some((m) => m.supported !== false)) return null
  return { reason: models.length ? 'unsupported' : 'none' }
}

// What the chat offers: the recommended model's readable name, its download
// size once the board has looked it up, and whether that fits the free space.
export function recommendedOffer({ status = null, card = null } = {}) {
  const { repoId, sees } = RECOMMENDED_MODEL
  const name = catalogNameFor(repoId)
  const sizeBytes = card && card.repoId === repoId && typeof card.sizeBytes === 'number' && card.sizeBytes > 0 ? card.sizeBytes : null
  const free = status && status.disk && typeof status.disk.freeBytes === 'number' ? status.disk.freeBytes : null
  return {
    repoId,
    name,
    label: friendlyModelName(name),
    sees,
    sizeBytes,
    freeBytes: free,
    tooBig: sizeBytes !== null && free !== null && sizeBytes > free
  }
}

// Whether models can be downloaded onto the board, from what the tab has seen:
// /models/status's hubEnabled (the board's server.hub.allow_download) and the
// latest Hugging Face answer (a search, a model card or a failed download),
// which says enabled: false when the board can't reach Hugging Face.
// state: unknown | disabled | offline | available. Backticks mark the words
// the view shows as code.
export function downloadAvailability({ status = null, hubReach = null } = {}) {
  if (!status) return { state: 'unknown', message: '' }
  if (!status.hubEnabled) {
    return {
      state: 'disabled',
      message: "Downloads are turned off on this board. To allow them, set `server.hub.allow_download: true` in GenAI Studio's " +
        '`config.local.yaml` on the board, then restart GenAI Studio.'
    }
  }
  if (hubReach && hubReach.enabled === false) {
    const error = String(hubReach.error || '').replace(/[.\s]+$/, '')
    return {
      state: 'offline',
      // The Studio's own words, unless they are the generic "offline or disabled":
      // downloads are allowed here, so it is offline.
      message: !error || /offline or disabled|disabled or offline/i.test(error)
        ? "The board can't reach Hugging Face. Check the board's internet connection, then try again."
        : `The board can't download from Hugging Face: ${error}.`
    }
  }
  return { state: 'available', message: '' }
}

// Hugging Face's answer as the tab remembers it: whether the board reached it.
export function hubReachOf(answer) {
  if (!answer || typeof answer.enabled !== 'boolean') return null
  return { enabled: answer.enabled, error: answer.enabled ? '' : String(answer.error || '') }
}

// A failed download as the tab shows it; a repo Hugging Face renamed names
// the id to download instead, and `offline` says the board couldn't reach
// Hugging Face at all (in the Studio's words for it, old and new).
export function downloadFailure(repoId, error) {
  const body = (error && error.body) || {}
  const message = (error && error.message) || 'Download failed'
  // Only an "org/name" id is offered as a button.
  const renamedTo = typeof body.renamedTo === 'string' && /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(body.renamedTo) ? body.renamedTo : null
  return { repoId, message, renamedTo, offline: /offline or disabled|disabled or offline|could not reach hugging face/i.test(message) }
}

// "a `b` c" -> ['a ', {code: 'b'}, ' c'], for the view to render.
export function codeParts(text) {
  return String(text || '').split('`').map((part, i) => (i % 2 ? { code: part } : part)).filter((part) => part !== '')
}
