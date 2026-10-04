// The Sentinel endpoints, one function each. `requestJson` is the Peripherals client:
// it turns a non-JSON answer or a dead server into the same error shape the board and
// Sentinel blueprints return, so the view has a single failure vocabulary.
import { requestJson } from '../peripherals/api.js'
import { HISTORY_SAMPLES, compareQuery, deleteRunQuery, stopTraceQuery } from './model.js'

export { requestJson }

export function fetchBoard() {
  return requestJson('/api/board')
}

// Not a Sentinel route: /api/metrics is the machine Insight itself runs on.
export function fetchHostMetrics() {
  return requestJson('/api/metrics')
}

export function fetchSentinel() {
  return requestJson('/api/sentinel')
}

export function installSentinel() {
  return requestJson('/api/sentinel/install', { method: 'POST' })
}

export function fetchMetrics(history = HISTORY_SAMPLES) {
  return requestJson(`/api/sentinel/metrics?history=${encodeURIComponent(history)}`)
}

export function fetchActiveTrace() {
  return requestJson('/api/sentinel/traces')
}

export function startTrace(body) {
  return requestJson('/api/sentinel/traces', { method: 'POST', body })
}

// `generation` is the one the shown trace was read under, so a board switched in between is
// refused with 409 stale_snapshot instead of stopping a trace on the board selected now.
export function stopTrace(generation = null) {
  return requestJson(stopTraceQuery(generation), { method: 'POST' })
}

export function fetchRuns() {
  return requestJson('/api/sentinel/runs')
}

export function fetchRun(ref) {
  return requestJson(`/api/sentinel/runs/${encodeURIComponent(ref)}`)
}

// `generation` is the one the run list was read under: a board switched in between is
// refused with 409 stale_snapshot instead of deleting a same-named run on the new board.
export function deleteRun(ref, generation = null) {
  return requestJson(deleteRunQuery(ref, generation), { method: 'DELETE' })
}

export function compareRuns(refs) {
  return requestJson(compareQuery(refs, { raw: true }))
}
