// The GenAI tab's setup panel: Insight installs, prepares and starts GenAI
// Studio on the selected board through /api/genai-setup, and the board reports
// each step's state, the cause and fixes of a failed one, and a note when one
// has gone quiet. Kept free of React so `node --test` covers it.

export const SETUP_STORAGE_KEY = 'neat-insight:genai-setup-open'

// While a request to the board has not answered for this long, the panel says so.
export const SLOW_REQUEST_MS = 15000
// Stopping GenAI Studio (alone or before setup runs again) normally takes up to about 30 s.
export const SLOW_STOP_MS = 45000

export const STEP_LABELS = {
  done: 'Done',
  running: 'Running',
  queued: 'Next',
  failed: 'Failed',
  blocked: 'Needs attention',
  pending: 'To do'
}

// What the panel's main button does now, or null while a step runs or nothing is left.
export function setupAction(status) {
  if (!status || !Array.isArray(status.steps)) return null
  // Nothing while a step runs or waits to, including a GenAI Studio still loading. A job
  // that only keeps GenAI Studio running doesn't count: Retry stops it first.
  if (status.steps.some((s) => s.state === 'running' || s.state === 'queued')) return null
  const left = status.steps.filter((s) => s.state !== 'done')
  if (!left.length) return null
  if (left.some((s) => s.state === 'failed' || s.state === 'blocked')) return { label: 'Retry' }
  const ids = new Set(left.map((s) => s.id))
  // An outdated GenAI Studio is replaced: the board reports why under the install step.
  if (ids.has('install') && status.outdated) return { label: 'Update and start GenAI Studio' }
  if (ids.has('install')) return { label: 'Install and start GenAI Studio' }
  if (ids.has('prepare')) return { label: 'Prepare and start GenAI Studio' }
  return { label: 'Start GenAI Studio' }
}

// Stop ends the install or prepare step in progress. Once GenAI Studio is starting,
// the main button stops it instead (Stop GenAI Studio).
export function setupStoppable(status) {
  return Boolean(status && status.active && (status.steps || []).some((s) =>
    s.id === 'start' ? s.state === 'queued' : s.state === 'running' || s.state === 'queued'))
}

// The icon a step shows: a check when done, a spinner while running, a grey
// circle for steps still to come, a warning sign when it failed or can't start.
export function stepIcon(state) {
  if (state === 'done') return 'done'
  if (state === 'running') return 'running'
  if (state === 'failed' || state === 'blocked') return 'failed'
  return 'waiting'
}

// The last row, Connect this tab, from the tab's own backend state.
export function connectIcon(backendState) {
  if (backendState === 'ready' || backendState === 'failed') return 'done'
  if (backendState === 'busy') return 'running'
  return 'waiting'
}

// GenAI Studio runs or is still loading, and no setup step is in progress: the main
// button, Start GenAI Studio when it is stopped, becomes Stop GenAI Studio. Works
// whether setup or a shell on the board started it.
export function canStopStudio(status) {
  const start = status && Array.isArray(status.steps) && status.steps.find((s) => s.id === 'start')
  return Boolean(start && (start.state === 'done' || start.state === 'running') && !setupStoppable(status))
}

// Setup runs again (and restarts GenAI Studio) once a finished step's warnings are fixed.
export function canRunSetupAgain(status) {
  const prepare = status && Array.isArray(status.steps) && status.steps.find((s) => s.id === 'prepare')
  return Boolean(prepare && prepare.state === 'done' && (prepare.warnings || []).length && !setupStoppable(status))
}

// Whether the GenAI Studio address the tab uses (`relayUrl`, from Settings) points at the
// board setup acts on (`status.target`: Insight's selected board). Unknown counts as no.
export function relayOnSetupBoard(relayUrl, status) {
  const target = status && status.target
  if (!target || !relayUrl) return false
  let host
  try {
    host = new URL(relayUrl).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  if (target.mode === 'local') return ['127.0.0.1', 'localhost', '::1'].includes(host)
  return Boolean(target.host) && host === target.host
}

// The banner's button while GenAI Studio doesn't answer: one click starts an installed
// Studio on the board the tab's address points at; anything more opens the panel first.
export function bannerAction(status, relayUrl) {
  const next = setupAction(status)
  if (next && next.label === 'Start GenAI Studio') {
    return { label: 'Start GenAI Studio', runNow: relayOnSetupBoard(relayUrl, status) }
  }
  return { label: 'Set up GenAI Studio', runNow: false }
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
