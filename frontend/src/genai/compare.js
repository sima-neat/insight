// Compare side by side: one message answered by several loaded models, each in
// its own card. The board keeps the models loaded (apps#587); the tab only
// chooses who answers. Kept free of React so `node --test` covers it.

import { chatModels, friendlyModelName } from './backendState.js'
import { loadedChatModels } from './models.js'

// The loaded chat models in catalog order, for anything shown side by side:
// the most-recently-used order changes whenever another model is picked, which
// would swap the cards between turns.
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

// A comparison turn keeps one card per model; `chosen` is the card the
// conversation continues from, and `content` mirrors it so history, export
// and Read aloud treat the turn like any other reply. Models in `skipped` get
// a card that says why they didn't answer.
export function compareTurn(id, models, chosen, skipped = []) {
  const skip = new Set(skipped.map((m) => m.name))
  return {
    role: 'assistant',
    id,
    compare: models.map((m) => (skip.has(m.name)
      ? { model: m.name, content: '', pending: false, skipped: true }
      : { model: m.name, content: '', pending: true })),
    chosen,
    content: '',
    pending: true
  }
}

export function updateCard(turn, model, patch) {
  const compare = turn.compare.map((c) => (c.model === model ? { ...c, ...patch } : c))
  const chosenCard = compare.find((c) => c.model === turn.chosen) || compare[0]
  return {
    ...turn,
    compare,
    content: chosenCard ? chosenCard.content : '',
    pending: compare.some((c) => c.pending)
  }
}

export function chooseCard(turn, model) {
  if (!turn.compare.some((c) => c.model === model)) return turn
  return updateCard({ ...turn, chosen: model }, model, {})
}

// The turn's combined speed: all tokens the models wrote over the time until
// the last one finished.
export function combinedRate(turn, wallMs) {
  if (!turn.compare || typeof wallMs !== 'number' || wallMs <= 0) return null
  const tokens = turn.compare.reduce((sum, c) => sum + ((c.stats && c.stats.tokens) || 0), 0)
  if (!tokens) return null
  return { tokens, tps: tokens / (wallMs / 1000), seconds: wallMs / 1000 }
}
