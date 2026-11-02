// The GenAI tab's setup page: Insight installs, prepares and starts GenAI
// Studio on the selected board through /api/genai-setup, and the board reports
// each step's state, the cause and fixes of a failed one, and a note when one
// has gone quiet. While GenAI Studio can't be used, the tab shows only this page
// (setupView says what it shows); the chat appears once GenAI Studio answers.
// Kept free of React so `node --test` covers it.

// Set while the user is in the setup flow, so a reload keeps them there until
// they open GenAI Studio from the ready page.
export const SETUP_STORAGE_KEY = 'neat-insight:genai-setup-open'

// While a request to the board has not answered for this long, the panel says so.
export const SLOW_REQUEST_MS = 15000
// Stopping GenAI Studio (alone or before setup runs again) normally takes up to about 30 s.
export const SLOW_STOP_MS = 45000

// What each checklist icon (setupView's steps) says to a screen reader.
export const STEP_LABELS = {
  done: 'Done',
  running: 'In progress',
  waiting: 'Not done yet',
  failed: 'Needs attention'
}

// Stop setup ends the install or prepare step in progress. Once GenAI Studio is
// starting, stopping it (canStopStudio) takes over.
export function setupStoppable(status) {
  return Boolean(status && status.active && (status.steps || []).some((s) =>
    s.id === 'start' ? s.state === 'queued' : s.state === 'running' || s.state === 'queued'))
}

// GenAI Studio runs or is still loading, and no setup step is in progress: it can be
// stopped, whether setup or a shell on the board started it.
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
    detail: typeof body.detail === 'string' ? body.detail : '',
    code: typeof body.code === 'string' ? body.code : null
  }
}

// Board errors that mean Insight can't reach the selected board at all, not that setup failed.
const OFFLINE_CODES = new Set(['unreachable', 'auth_failed', 'timeout', 'host_key_changed'])

// The checklist's step names, in the user's words; the board's own titles stay in the details.
const STEP_NAMES = { install: 'Install Neat Apps', prepare: 'Prepare speech and search', start: 'Start and connect' }
const DONE_NOTES = { install: 'Installed', prepare: 'Prepared', start: 'Connected' }
const RUNNING_NOTES = { install: 'Downloading and installing Apps…', prepare: 'Preparing voices and search…', start: 'Waiting for GenAI Studio to answer…' }
const READY_NOTES = { install: 'Ready to install', prepare: 'Ready to prepare', start: 'Not running' }

// Each page's title and the line under it.
const PAGES = {
  checking: ['Checking the board…', 'Insight is reading what is installed on the selected board.'],
  'no-board': ['No board selected', 'Choose a board in the Board menu at the top of the page.'],
  disconnected: ['Board disconnected', 'Insight cannot reach the selected board. Reconnect it in the Board menu at the top of the page.'],
  unreadable: ['Insight could not check the board', ''],
  missing: ['Install GenAI Studio', 'About 20 minutes. Keep the board connected to the internet; setup keeps running if you leave this page.'],
  outdated: ['Update GenAI Studio', 'About 20 minutes. Downloaded models are kept; setup keeps running if you leave this page.'],
  unprepared: ['Finish setting up GenAI Studio', 'Apps is installed. Preparing speech and search takes about 15 minutes and needs internet access on the board.'],
  installing: ['Installing GenAI Studio', 'Downloading Apps to the board. You can leave this page; setup keeps running.'],
  preparing: ['Preparing your Studio', 'Setting up voices, speech recognition and document search. This takes about 15 minutes.'],
  starting: ['Starting GenAI Studio', 'Loading its voices and connecting to it. This takes a few minutes.'],
  connecting: ['Starting GenAI Studio', 'GenAI Studio runs on the board. Connecting this tab to it…'],
  elsewhere: ['This tab connects to another address', 'GenAI Studio runs on the selected board, but this tab connects to another address.'],
  failed: ['Setup needs attention', ''],
  stopped: ['Setup stopped', 'Files already downloaded are kept. Resume setup when you are ready.'],
  'studio-stopped': ['Start GenAI Studio', 'GenAI Studio is installed but not running. Starting it takes a few minutes.'],
  ready: ['GenAI Studio is ready', 'Next, choose a model and start a conversation.']
}

// Each page's main button. run: start the setup job for what is left; open: leave setup
// for the chat; reconnect: read the board again; connection: show GenAI Studio's address.
const ACTIONS = {
  'no-board': { kind: 'reconnect', label: 'Check again' },
  disconnected: { kind: 'reconnect', label: 'Try connection again' },
  unreadable: { kind: 'reconnect', label: 'Try again' },
  missing: { kind: 'run', label: 'Install GenAI Studio' },
  outdated: { kind: 'run', label: 'Update GenAI Studio' },
  unprepared: { kind: 'run', label: 'Continue setup' },
  elsewhere: { kind: 'connection', label: 'Connection settings' },
  failed: { kind: 'run', label: 'Retry' },
  stopped: { kind: 'run', label: 'Resume setup' },
  'studio-stopped': { kind: 'run', label: 'Start GenAI Studio' },
  ready: { kind: 'open', label: 'Open Studio' }
}

const IN_PROGRESS = { install: 'installing', prepare: 'preparing', start: 'starting' }

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// Which page setup shows now. `reached`: the tab gets an answer from GenAI Studio.
// `elsewhere`: the tab's GenAI Studio address is not on the board setup acts on.
// Not installed, installed but stopped and a disconnected board are different pages,
// so a stopped GenAI Studio is started rather than installed again.
export function setupPhase({ status, readError = null, reached = false, elsewhere = false }) {
  if (readError && readError.code === 'no_target') return 'no-board'
  if (readError && OFFLINE_CODES.has(readError.code)) return 'disconnected'
  if (!status || !Array.isArray(status.steps)) return readError ? 'unreadable' : 'checking'
  const steps = status.steps
  const busy = steps.find((s) => s.state === 'running') || steps.find((s) => s.state === 'queued')
  if (busy) return IN_PROGRESS[busy.id] || 'installing'
  const broken = steps.find((s) => s.state === 'failed' || s.state === 'blocked')
  if (broken) return broken.stopped ? 'stopped' : 'failed'
  const left = steps.find((s) => s.state !== 'done')
  if (left && left.id === 'install') return status.outdated ? 'outdated' : 'missing'
  if (left && left.id === 'prepare') return 'unprepared'
  if (left) return 'studio-stopped'
  if (reached) return 'ready'
  return elsewhere ? 'elsewhere' : 'connecting'
}

// Everything the setup page shows: {phase, title, subtitle, steps, action, stop, problem,
// stall, notice, warnings}. `steps` is the checklist, [{id, name, icon, note}] with an icon
// from stepIcon; problem, stall and notice stay visible, the rest of a step's detail is in
// the page's technical details.
export function setupView({ status, readError = null, reached = false, elsewhere = false }) {
  const phase = setupPhase({ status, readError, reached, elsewhere })
  const [title, subtitle] = PAGES[phase]
  const view = { phase, title, subtitle, steps: [], action: ACTIONS[phase] || null, stop: null, problem: null, stall: null, notice: null, warnings: [] }
  if (['no-board', 'disconnected', 'unreadable', 'checking'].includes(phase)) {
    if (phase === 'unreadable') view.problem = readError
    return view
  }
  const steps = status.steps
  const next = steps.find((s) => s.state !== 'done')
  const broken = steps.find((s) => s.state === 'failed' || s.state === 'blocked')
  view.steps = steps.map((s) => {
    const count = (s.warnings || []).length
    const row = (icon, note) => ({ id: s.id, name: STEP_NAMES[s.id] || s.title, icon, note })
    if (s.state === 'done' && s.id === 'start' && !reached) {
      return elsewhere ? row('waiting', 'Running, but this tab connects elsewhere') : row('running', 'Connecting this tab…')
    }
    if (s.state === 'done') return row('done', DONE_NOTES[s.id] + (count ? ` with ${plural(count, 'warning')}` : ''))
    if (s.state === 'running') return row('running', RUNNING_NOTES[s.id])
    if (s.state === 'queued') return row('waiting', 'Next')
    if (s.stopped) return row('waiting', 'Stopped, ready to resume')
    if (s.state === 'failed' || s.state === 'blocked') return row('failed', 'Needs attention')
    if (s.id === 'install' && status.outdated) return row('waiting', 'Update available')
    return row('waiting', s === next && !broken ? READY_NOTES[s.id] : 'Waiting')
  })
  if (phase === 'failed') {
    view.problem = broken.problem
    view.subtitle = broken.state === 'blocked'
      ? `${STEP_NAMES[broken.id]} can't run yet: the board is missing something it needs.`
      : `${STEP_NAMES[broken.id]} did not finish.`
  }
  const running = steps.find((s) => s.state === 'running')
  view.stall = (running && running.stall) || null
  view.notice = (steps.find((s) => s.notice) || {}).notice || null
  view.warnings = steps
    .filter((s) => (s.warnings || []).length)
    .map((s) => ({ id: s.id, name: STEP_NAMES[s.id] || s.title, done: s.state === 'done', warnings: s.warnings }))
  const warned = view.warnings.reduce((n, s) => n + s.warnings.length, 0)
  if (phase === 'ready' && warned) view.subtitle = `Chat is ready. Setup finished with ${plural(warned, 'warning')}: review ${warned === 1 ? 'it' : 'them'} below.`
  // Stopping is never the main button: setup's own Stop while a step runs, otherwise a
  // secondary Stop GenAI Studio once it runs.
  if (setupStoppable(status)) view.stop = { kind: 'stop', label: 'Stop setup' }
  else if (canStopStudio(status) && ['starting', 'connecting', 'elsewhere', 'ready'].includes(phase)) {
    view.stop = { kind: 'stop-studio', label: phase === 'starting' && status.active ? 'Stop setup' : 'Stop GenAI Studio' }
  }
  return view
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
    // Without storage a reload just skips the ready page; the board keeps the job's state.
  }
}
