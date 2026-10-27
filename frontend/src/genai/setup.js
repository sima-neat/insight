// The GenAI tab's setup panel: Insight installs, prepares and starts GenAI
// Studio on the selected board through /api/genai-setup, and the board reports
// each step's state, the cause and fixes of a failed one, and a note when one
// has gone quiet. Kept free of React so `node --test` covers it.

export const SETUP_STORAGE_KEY = 'neat-insight:genai-setup-open'

// While a request to the board has not answered for this long, the panel says so.
export const SLOW_REQUEST_MS = 15000

export const STEP_LABELS = {
  done: 'Done',
  running: 'Running',
  queued: 'Next',
  failed: 'Failed',
  blocked: 'Needs attention',
  pending: 'To do'
}

// What the panel's main button does now, or null while a job runs or nothing is left.
export function setupAction(status) {
  if (!status || status.active || !Array.isArray(status.steps)) return null
  const left = status.steps.filter((s) => s.state !== 'done')
  if (!left.length) return null
  if (left.some((s) => s.state === 'failed' || s.state === 'blocked')) return { label: 'Retry' }
  const ids = new Set(left.map((s) => s.id))
  if (ids.has('install')) return { label: 'Install and start GenAI Studio' }
  if (ids.has('prepare')) return { label: 'Prepare and start GenAI Studio' }
  return { label: 'Start GenAI Studio' }
}

// Stop ends a step in progress. Once every step is done the job only keeps
// GenAI Studio running, and stopping it is not part of setup.
export function setupStoppable(status) {
  return Boolean(status && status.active && (status.steps || []).some((s) => s.state === 'running' || s.state === 'queued'))
}

// The last line a running step printed, to show what it is doing now.
export function lastLine(log) {
  const lines = String(log || '').split('\n').filter((line) => line.trim())
  return lines.length ? lines[lines.length - 1] : ''
}

// A failed request to Insight or the board, as the panel shows it: what
// happened and what to do. `error` is a GenaiError from client.js.
export function requestProblem(error) {
  const body = (error && error.body) || {}
  if (!error || !error.status) {
    return {
      message: (error && error.message) || 'Insight did not answer.',
      fixes: ['Check that Insight is still running (reload this page), then try again.']
    }
  }
  return {
    message: body.error || error.message,
    fixes: [body.hint].filter(Boolean),
    detail: typeof body.detail === 'string' ? body.detail : ''
  }
}

export function setupOpenSaved(storage) {
  try {
    return storage.getItem(SETUP_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function saveSetupOpen(storage, open) {
  try {
    if (open) storage.setItem(SETUP_STORAGE_KEY, '1')
    else storage.removeItem(SETUP_STORAGE_KEY)
  } catch {
    // Without storage the panel just doesn't reopen after a reload; the board keeps the job's state.
  }
}
