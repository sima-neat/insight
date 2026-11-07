// Compare side by side: a chat panel per ticked model, sent one prompt each or
// the same prompt to all. The board keeps the models loaded (apps#587); the tab
// only chooses who answers. Kept free of React so `node --test` covers it.

import { chatModels, friendlyModelName } from './backendState.js'
import { loadedChatModels } from './models.js'
import { splitThinking } from './streams.js'

// The loaded chat models in catalog order, for anything shown side by side:
// the most-recently-used order changes whenever another model is picked, which
// would swap the panels around.
export function loadedInDisplayOrder(status) {
  const loaded = new Set(loadedChatModels(status).map((m) => m.name))
  return chatModels(status).filter((m) => loaded.has(m.name))
}

// Ticking a model in the Compare panel. `ticked` is the names ticked now;
// returns the new list in display order. The last ticked model stays ticked:
// one model is a normal chat, two or more are compared.
export function toggleTicked(models, ticked, name) {
  const set = new Set(ticked)
  if (set.has(name)) {
    if (set.size === 1) return models.filter((m) => set.has(m.name)).map((m) => m.name)
    set.delete(name)
  } else {
    set.add(name)
  }
  return models.filter((m) => set.has(m.name)).map((m) => m.name)
}

// The models of the chosen comparison, in display order; null when Compare is
// off or a model in it is no longer loaded.
export function compareSelection(models, names) {
  if (!names || names.length < 2) return null
  const chosen = models.filter((m) => names.includes(m.name))
  return chosen.length === names.length ? chosen : null
}

// Who answers a message: with a picture, only the models that see images.
export function compareAnswerers(models, withImage) {
  const answer = withImage ? models.filter((m) => m.supportsVision) : models
  const skip = withImage ? models.filter((m) => !m.supportsVision) : []
  return { answer, skip }
}

// The note shown while a picture is attached in a comparison, or null when
// every compared model sees images (or none does).
export function imageNote(models) {
  const { answer, skip } = compareAnswerers(models, true)
  if (!skip.length || !answer.length) return null
  const names = (list) => list.map((m) => friendlyModelName(m.name)).join(' and ')
  return `${names(skip)} can't take images, so only ${names(answer)} will answer this message.`
}

// One model's panel conversation as request history, and what the system
// prompt should say about pictures. Requests are stateless: the most recent
// earlier picture goes again so follow-ups can still see it, only to a model
// that sees images and only while no new picture replaces it.
export function panelHistory(chat, model, hasNewImage) {
  const said = chat.filter((m) => !m.skipped)
  const carried = !hasNewImage && model.supportsVision ? said.findLastIndex((m) => m.role === 'user' && m.image) : -1
  const history = said.map((m, i) => {
    if (m.role === 'assistant') return { role: 'assistant', content: splitThinking(m.content).answer }
    if (i === carried) return { role: 'user', content: [{ type: 'text', text: m.text }, { type: 'image_url', image_url: { url: m.image } }] }
    return { role: 'user', content: m.text }
  })
  return { history, picture: hasNewImage ? 'current' : carried >= 0 ? 'earlier' : 'none' }
}
