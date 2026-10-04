// The Sentinel endpoints, one function each. `requestJson` is the Peripherals client:
// it turns a non-JSON answer or a dead server into the same error shape the board and
// Sentinel blueprints return, so the view has a single failure vocabulary.
import { requestJson } from '../peripherals/api.js'
import { HISTORY_SAMPLES, compareQuery, deleteRunQuery, installQuery, startTraceQuery, stopTraceQuery } from './model.js'

// Not a Sentinel route: /api/metrics is the machine Insight itself runs on.
export function fetchHostMetrics() {
  return requestJson('/api/metrics')
}

export function fetchSentinel() {
  return requestJson('/api/sentinel')
}

// `generation` is the one the Sentinel state offering installation was read under: a board
// switched in between is refused with 409 stale_snapshot instead of being installed on.
export function installSentinel(generation = null) {
  return requestJson(installQuery(generation), { method: 'POST' })
}

export function fetchMetrics(history = HISTORY_SAMPLES) {
  return requestJson(`/api/sentinel/metrics?history=${encodeURIComponent(history)}`)
}

export function fetchActiveTrace() {
  return requestJson('/api/sentinel/traces')
}

// `generation` is the one the active trace shown with the form was read under: a board switched
// in between is refused with 409 stale_snapshot instead of starting a trace on it.
export function startTrace(body, generation = null) {
  return requestJson(startTraceQuery(generation), { method: 'POST', body })
}

// `generation` is the one the shown trace was read under, so a board switched in between is
// refused with 409 stale_snapshot instead of stopping a trace on the board selected now;
// `traceId` is the shown trace's, so a trace that replaced it is refused with 409 trace_conflict.
export function stopTrace(generation = null, traceId = '') {
  return requestJson(stopTraceQuery(generation, traceId), { method: 'POST' })
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
