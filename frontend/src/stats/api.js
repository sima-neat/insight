import { requestJson } from '../peripherals/api.js'
import { HISTORY_SAMPLES } from './model.js'

// Mutations carry the generation of the payload they were chosen from; the backend refuses a stale one.
function mutationPath(path, generation, fields = {}) {
  const query = new URLSearchParams()
  if (Number.isInteger(generation)) query.set('generation', generation)
  for (const [key, value] of Object.entries(fields)) if (value) query.set(key, value)
  const encoded = query.toString()
  return encoded ? `${path}?${encoded}` : path
}

export const fetchHostMetrics = () => requestJson('/api/metrics')
export const fetchSentinel = () => requestJson('/api/sentinel')
export const installSentinel = (generation) => requestJson(mutationPath('/api/sentinel/install', generation), { method: 'POST' })
export const fetchMetrics = () => requestJson(`/api/sentinel/metrics?history=${HISTORY_SAMPLES}`)
export const fetchActiveTrace = () => requestJson('/api/sentinel/traces')
export const startTrace = (body, generation) => requestJson(mutationPath('/api/sentinel/traces', generation), { method: 'POST', body })
export const stopTrace = (generation, traceId) => requestJson(mutationPath('/api/sentinel/traces/stop', generation, { trace_id: traceId }), { method: 'POST' })
export const fetchRuns = () => requestJson('/api/sentinel/runs')
export const fetchRun = (ref) => requestJson(`/api/sentinel/runs/${encodeURIComponent(ref)}`)
export const deleteRun = (ref, generation) => requestJson(mutationPath(`/api/sentinel/runs/${encodeURIComponent(ref)}`, generation), { method: 'DELETE' })
export const compareRuns = (refs) => requestJson(`/api/sentinel/compare?runs=${encodeURIComponent(refs.join(','))}&raw=1`)
