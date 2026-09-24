// The Sentinel endpoints, one function each. `requestJson` is the Peripherals client:
// it turns a non-JSON answer or a dead server into the same error shape the board and
// Sentinel blueprints return, so the view has a single failure vocabulary.
import { requestJson } from '../peripherals/api.js'
import { HISTORY_SAMPLES, compareQuery } from './model.js'

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

export function stopTrace() {
  return requestJson('/api/sentinel/traces/stop', { method: 'POST' })
}

export function fetchRuns() {
  return requestJson('/api/sentinel/runs')
}

export function fetchRun(ref) {
  return requestJson(`/api/sentinel/runs/${encodeURIComponent(ref)}`)
}

export function compareRuns(refs) {
  return requestJson(compareQuery(refs))
}
