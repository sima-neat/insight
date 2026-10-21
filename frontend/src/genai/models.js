// Which chat models are loaded on the board and which one answers, for a
// GenAI Studio that may keep several loaded (apps#587). Kept free of React so
// `node --test` covers every case.
//
// /models/status reports `loaded` (every model the model server serves),
// `resident` (the loaded chat models, most recently used first) and
// `maxResident` (how many chat models stay loaded). A Studio from before
// apps#587 reports neither of the last two and keeps one chat model.

import { chatModels } from './backendState.js'

// How many chat models the board keeps loaded at once.
export function residentLimit(status) {
  const limit = Number(status && status.maxResident)
  return Number.isInteger(limit) && limit > 0 ? limit : 1
}

// The loaded chat models, most recently used first when the board says so,
// otherwise in catalog order.
export function loadedChatModels(status) {
  const loaded = new Set((status && status.loaded) || [])
  const models = chatModels(status).filter((m) => loaded.has(m.name))
  const order = (status && Array.isArray(status.resident)) ? status.resident : []
  const rank = (m) => {
    const i = order.indexOf(m.name)
    return i === -1 ? order.length : i
  }
  return models.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map(({ m }) => m)
}

// The model that answers: the one the user chose while it stays loaded,
// otherwise the most recently loaded one.
export function activeChatModel(status, chosenName = null) {
  const loaded = loadedChatModels(status)
  return loaded.find((m) => m.name === chosenName) || loaded[0] || null
}

// The user's choice of answering model, kept only while a status from the
// board still has it loaded: once it is unloaded, the choice is forgotten, so
// loading it again later (by another client, or the benchmark) doesn't make
// it answer again over the most recently loaded model. An unknown status
// (null) keeps the choice.
export function keptChoice(status, chosenName) {
  if (!chosenName || !status) return chosenName || null
  return loadedChatModels(status).some((m) => m.name === chosenName) ? chosenName : null
}

// What loading `name` takes:
//   {kind: 'use'}                      it is loaded already: just answer with it
//   {kind: 'replace', unloads}         a limit of one: the loaded model goes
//   {kind: 'add', keeps}               there is room: the loaded ones stay
//   {kind: 'choose', loaded, needed}   the limit is reached: the user picks
//                                      `needed` of `loaded` to unload
export function loadPlan(status, name) {
  const loaded = loadedChatModels(status)
  if (loaded.some((m) => m.name === name)) return { kind: 'use' }
  const limit = residentLimit(status)
  if (limit === 1) return { kind: 'replace', unloads: loaded }
  const needed = loaded.length - (limit - 1)
  if (needed > 0) return { kind: 'choose', loaded, needed }
  return { kind: 'add', keeps: loaded }
}

// The board's refusal of a load that needs a model unloaded first, read from
// the error of POST /models/load, or null for any other error:
//   resident_limit  more chat models than the limit; `needed` must go
//   no_room         not enough accelerator memory beside the loaded models;
//                   `candidates` lists them largest first, one or more must go
export function unloadChoice(error) {
  const body = (error && error.body) || {}
  if (error && error.status !== 409) return null
  const candidates = Array.isArray(body.resident) ? body.resident.filter((n) => typeof n === 'string') : []
  if (body.code === 'resident_limit') {
    const needed = Number.isInteger(body.needed) && body.needed > 0 ? body.needed : 1
    return { code: 'resident_limit', candidates, needed: Math.min(needed, candidates.length || needed), message: body.error || '' }
  }
  if (body.code === 'no_room') {
    return { code: 'no_room', candidates, needed: 1, needBytes: body.needBytes, freeBytes: body.freeBytes, message: body.error || '' }
  }
  return null
}

// The chat models still loaded after a load answered {evicted: [...]}:
// for callers that track what a sequence of their own loads leaves loaded.
// An answer without the list may have unloaded any of them.
export function afterLoad(loadedNames, name, response) {
  if (!response || !Array.isArray(response.evicted)) return new Set([name])
  const evicted = new Set(response.evicted)
  const next = new Set([...loadedNames].filter((n) => !evicted.has(n)))
  next.add(name)
  return next
}
