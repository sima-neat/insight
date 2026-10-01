import { requestJson } from '../peripherals/api.js'
import { HISTORY_SAMPLES } from './model.js'

// Mutations carry the generation of the payload they were chosen from; the backend refuses a stale one.
function withGeneration(path, generation) {
  return Number.isInteger(generation) ? `${path}?generation=${generation}` : path
}

export const fetchHostMetrics = () => requestJson('/api/metrics')
export const fetchSentinel = () => requestJson('/api/sentinel')
export const installSentinel = (generation) => requestJson(withGeneration('/api/sentinel/install', generation), { method: 'POST' })
export const fetchMetrics = () => requestJson(`/api/sentinel/metrics?history=${HISTORY_SAMPLES}`)
export const fetchActiveTrace = () => requestJson('/api/sentinel/traces')
export const startTrace = (body, generation) => requestJson(withGeneration('/api/sentinel/traces', generation), { method: 'POST', body })
export const stopTrace = (generation, id) => requestJson(withGeneration('/api/sentinel/traces/stop', generation), { method: 'POST', body: { id } })
export const fetchRuns = () => requestJson('/api/sentinel/runs')
export const fetchRun = (ref) => requestJson(`/api/sentinel/runs/${encodeURIComponent(ref)}`)
export const deleteRun = (ref, generation) => requestJson(withGeneration(`/api/sentinel/runs/${encodeURIComponent(ref)}`, generation), { method: 'DELETE' })
export const compareRuns = (refs) => requestJson(`/api/sentinel/compare?runs=${encodeURIComponent(refs.join(','))}&raw=1`)
