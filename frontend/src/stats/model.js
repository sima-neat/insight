// Pure derivation for the Stats view: it turns the Sentinel endpoints' bodies into the
// text, ranks and rows the view renders, and maps every failure the backend can return
// into a sentence a developer can act on. Nothing here touches the DOM or the network.
import { formatRelativeTime, normalizeError } from '../peripherals/model.js'

export { formatRelativeTime, normalizeError }

export const POLL_MS = 2000
export const MAX_POLL_MS = 30000
export const HISTORY_SAMPLES = 60
export const NAME_LIMIT = 128
export const NOTE_LIMIT = 512
export const MAX_TAGS = 16
export const MIN_COMPARE_RUNS = 2
export const MAX_COMPARE_RUNS = 8
const FACT_LIMIT = 120
const OTHER_GROUP = 'Other'

// Board-level failures: the fix is in the Board panel, not in Sentinel.
export const BOARD_PROBLEM_CODES = new Set([
  'no_target',
  'unreachable',
  'auth_failed',
  'host_key_changed',
  'timeout',
  'permission_denied',
  'tool_missing',
  'command_failed'
])
// Sentinel is reachable only once the daemon runs; these say it does not.
export const DAEMON_PROBLEM_CODES = new Set(['sentinel_missing', 'sentinel_stopped', 'sentinel_denied'])

const STATUS_TONES = {
  ok: { label: 'Normal', tone: 'ok' },
  warn: { label: 'Warning', tone: 'warn' },
  critical: { label: 'Critical', tone: 'periph-danger' },
  unavailable: { label: 'Not measured', tone: '' }
}

const DAEMON_STATES = {
  ready: { label: 'Running', tone: 'ok' },
  missing: { label: 'Not installed', tone: 'warn' },
  stopped: { label: 'Installed but stopped', tone: 'warn' },
  error: { label: 'Not answering', tone: 'periph-danger' }
}

// Titles say what failed; the backend's own message and hint carry the detail.
const FAILURE_TITLES = {
  no_target: 'No board is selected',
  unreachable: 'The board could not be reached',
  auth_failed: 'The board refused the SSH key',
  host_key_changed: 'The board presented a different host key',
  timeout: 'The board took too long to answer',
  permission_denied: 'The board refused the command',
  tool_missing: 'A tool is missing on the board',
  command_failed: 'A command failed on the board',
  sentinel_missing: 'Sentinel is not running on this board',
  sentinel_stopped: 'The Sentinel service is stopped',
  sentinel_denied: 'Sentinel refused this user',
  sentinel_schema: 'Sentinel and Insight speak different API versions',
  sentinel_failed: 'Sentinel could not answer',
  already_installed: 'Sentinel is already installed',
  trace_conflict: 'That trace cannot start',
  not_found: 'That run is not on this board',
  invalid_request: 'The request was rejected',
  request_too_large: 'The request was too large',
  response_too_large: 'Sentinel answered with more than Insight reads',
  network: 'Insight is not answering',
  bad_response: 'Insight answered something unexpected'
}

const FALLBACK_HINTS = {
  no_target: 'Choose a board in the Board panel above, then reload.',
  unreachable: 'Fix the connection in the Board panel above, then retry.',
  auth_failed: 'Fix the connection in the Board panel above, then retry.',
  host_key_changed: 'Confirm the fingerprint in the Board panel above before trusting the new key.',
  timeout: 'Check the board is awake and on the network, then retry.',
  sentinel_missing: 'Install Sentinel from this page, or start it on the board.',
  sentinel_stopped: 'Start it on the board with `sudo systemctl start simaai-sentinel`.',
  sentinel_failed: 'Check `systemctl status simaai-sentinel` on the board.'
}

/**
 * The same codes mean something else when they come back from POST /api/sentinel/install.
 * Nothing was being read there, so "Sentinel could not answer" is not what failed and not
 * where the fix is: `sentinel_failed` is how the backend reports a missing `sima-cli`, an
 * installer that exited non-zero, and an installer that finished with the service still
 * down; `sentinel_denied` is how it reports that the board's user has no passwordless
 * sudo; and a `timeout` is the 15-minute installer budget, not an unresponsive board.
 */
const INSTALL_TITLES = {
  sentinel_failed: 'Sentinel could not be installed',
  sentinel_denied: 'Installing Sentinel needs sudo on the board',
  timeout: 'The installer did not finish in time'
}

/**
 * What DELETE /api/sentinel/runs/<run> failures mean. The codes are shared with reading and
 * starting a trace, but here `trace_conflict` is the CLI refusing a run that is still
 * recording, and `stale_snapshot` is the board changing between reading the list and
 * deleting from it, so nothing was deleted on the other board.
 */
const DELETE_TITLES = {
  trace_conflict: 'That run is still recording',
  not_found: 'That run is not on this board',
  stale_snapshot: 'The selected board changed',
  sentinel_failed: 'Sentinel did not delete the run',
  sentinel_denied: 'The board user may not delete runs',
  tool_missing: 'The Sentinel CLI is missing on the board'
}

const INSTALL_HINTS = {
  timeout: 'Run the install in a shell on the board, where it can take as long as it needs.',
  sentinel_failed: 'Check the installer output below, or run the install in a shell on the board.'
}

const RUN_FIELDS = {
  id: ['id', 'run_id', 'uid'],
  name: ['name', 'label', 'title'],
  state: ['state', 'status'],
  startedAt: ['started_at', 'start_time', 'start', 'created_at'],
  endedAt: ['ended_at', 'stopped_at', 'end_time', 'finished_at', 'end'],
  note: ['note', 'description', 'comment'],
  tags: ['tags', 'labels'],
  samples: ['samples', 'sample_count', 'sample_counts', 'count'],
  durationSec: ['duration_sec', 'duration_s', 'duration_seconds', 'elapsed_sec', 'elapsed_s'],
  durationMs: ['duration_ms', 'elapsed_ms'],
  energyJoules: ['energy_joules', 'energy_j']
}

function pick(source, keys) {
  for (const key of keys) {
    const value = source?.[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function titleCase(key) {
  const text = String(key || '').replace(/[_.]+/g, ' ').trim()
  return text ? text[0].toUpperCase() + text.slice(1) : ''
}

/** Sentinel samples every two seconds; a failing board is polled ever more slowly. */
export function pollDelay(failures = 0) {
  const count = Number.isInteger(failures) && failures > 0 ? failures : 0
  return Math.min(MAX_POLL_MS, POLL_MS * 2 ** Math.min(count, 8))
}

export function statusInfo(status) {
  return STATUS_TONES[status] || STATUS_TONES.unavailable
}

export function formatNumber(value) {
  if (!isNumber(value)) return ''
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
  return String(Number(value.toFixed(digits)))
}

export function unitSuffix(unit) {
  const text = String(unit || '').trim()
  if (!text) return ''
  if (text === 'C' || text === 'celsius') return '°C'
  return text
}

/** A value Sentinel could not measure reads as an em dash, never as zero. */
export function formatValue(value, unit) {
  if (!isNumber(value)) return '—'
  const suffix = unitSuffix(unit)
  if (!suffix) return formatNumber(value)
  return suffix === '%' ? `${formatNumber(value)}%` : `${formatNumber(value)} ${suffix}`
}

/**
 * A percentage change against the baseline. A change too small to show at this precision
 * is reported as such rather than rounded to 0%, which would read as "no change", and an
 * absent comparison stays an em dash.
 */
export function formatPercentDelta(value) {
  if (!isNumber(value)) return '—'
  if (value === 0) return '±0%'
  const sign = value > 0 ? '+' : '−'
  const size = Math.abs(value)
  return size < 0.01 ? `${sign}<0.01%` : `${sign}${formatNumber(size)}%`
}

export function formatSeconds(seconds) {
  if (!isNumber(seconds) || seconds < 0) return ''
  if (seconds < 60) return `${Number(seconds.toFixed(seconds < 10 ? 1 : 0))} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${Math.round(seconds - minutes * 60)} s`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export function formatTimestamp(iso) {
  const time = Date.parse(iso || '')
  if (!Number.isFinite(time)) return ''
  return new Date(time).toLocaleString()
}

/** True when a payload was read before the selected board changed under it. */
export function isStale(board, payload) {
  if (!board || !payload || payload.generation === undefined || payload.generation === null) return false
  return Number(board.generation) !== Number(payload.generation)
}

/**
 * Which of the view's payloads were read from a board that is no longer the selected
 * one. Every Sentinel answer carries the generation it was read under, and an SSH round
 * trip can outlive a board switch, so each payload is judged on its own: values from the
 * previous board are kept and labelled rather than silently rendered as current ones.
 */
export function staleFlags(board, payloads = {}) {
  const flags = {}
  for (const [name, payload] of Object.entries(payloads)) flags[name] = isStale(board, payload)
  return flags
}

export function staleNote(what, label) {
  return `${what} below: read from ${label || 'a board that is no longer selected'}, not from the board selected now.`
}

/** The board a payload was actually read from, for a stale label. */
export function payloadBoardLabel(payload) {
  return payload?.board?.label || ''
}

/**
 * One in-flight request per key, each bound to the board it was asked of. React state
 * settles a tick later than a click, so a second Re-check, Refresh or Compare can start
 * before the first has set its busy flag; each of those is a command on the board, so the
 * guard is synchronous.
 *
 * `begin` returns a ticket, or null while the key is taken. The view applies an answer
 * only while `current(ticket)` holds: the request has not been superseded or cancelled,
 * and the board it was asked of is still the selected one. `switchTo` follows the board
 * selection; moving to another board cancels everything still out, so a request to the
 * new board is never refused because the old one has not answered, and the old board's
 * answer is dropped instead of being applied as the new board's.
 */
export function createRequestGuard() {
  const active = new Map()
  let generation = null
  return {
    running: (key) => active.has(key),
    /** True when the selected board changed to another one, not when it first arrived. */
    switchTo(next = null) {
      const value = next ?? null
      if (value === generation) return false
      const first = generation === null
      generation = value
      if (first) {
        // Requests sent before the page knew the board went to that board.
        for (const ticket of active.values()) ticket.generation = value
        return false
      }
      for (const ticket of active.values()) ticket.cancelled = true
      active.clear()
      return true
    },
    // `supersede` is for reads where only the latest matters (opening a run): the new
    // request replaces the one still out, whose answer is then dropped.
    begin(key, { supersede = false } = {}) {
      const running = active.get(key)
      if (running && !supersede) return null
      if (running) running.cancelled = true
      const ticket = { key, generation, cancelled: false }
      active.set(key, ticket)
      return ticket
    },
    current(ticket) {
      return Boolean(ticket) && !ticket.cancelled && ticket.generation === generation
    },
    cancel(key) {
      const running = active.get(key)
      if (!running) return
      running.cancelled = true
      active.delete(key)
    },
    end(ticket) {
      if (ticket && active.get(ticket.key) === ticket) active.delete(ticket.key)
    }
  }
}

/** The daemon panel is busy during the first check too, when no state has arrived yet. */
export function daemonBusy({ installBusy = false, stateBusy = false } = {}) {
  return Boolean(installBusy || stateBusy)
}

/** What /api/sentinel says about the daemon, and whether this page can install it. */
export function daemonInfo(state) {
  const daemon = state?.daemon || null
  const status = state?.status || {}
  const key = state ? status.state || 'error' : 'unknown'
  const known = DAEMON_STATES[key] || { label: 'Unknown', tone: '' }
  const healthy = Boolean(daemon?.healthy)
  const simaCli = daemon?.sima_cli || null
  return {
    state: key,
    label: known.label,
    tone: known.tone,
    available: Boolean(state?.available),
    version: state?.version || null,
    schema: state?.schema ?? null,
    installed: Boolean(daemon?.installed),
    healthy,
    service: daemon?.service || 'unknown',
    socket: Boolean(daemon?.socket),
    socketPath: daemon?.socket_path || null,
    simaCli,
    // The installer restarts the daemon, so a healthy one is never reinstalled from here.
    canInstall: Boolean(daemon) && !healthy && Boolean(simaCli),
    installBlocked: !daemon
      ? 'Sentinel state is unknown; reload before installing.'
      : healthy
        ? 'Sentinel is already running. Reinstalling would restart it and end a trace in flight.'
        : simaCli
          ? ''
          : 'sima-cli was not found on the board, so Insight cannot install Sentinel from here.',
    error: normalizeError(status.error || null)
  }
}

/**
 * Whether the telemetry panels stay on the page when Sentinel stops answering.
 *
 * A board that goes away mid-view fails the next poll, `/api/sentinel` fails behind it,
 * and the daemon state becomes unknown. Hiding the panels on that alone takes the samples,
 * the trace and the runs already read off the page — and with them the failure's own
 * sentence, which is rendered inside those panels. They stay, stop updating, and carry the
 * failure. Selecting another board is different: that clears what was read first, so
 * nothing here can show one board's numbers under another board's name.
 */
export function telemetryVisible(info, read = {}) {
  if (info?.available) return true
  return Boolean(read.metrics || read.traces || read.runs)
}

/**
 * Whether the daemon section has anything to say.
 *
 * A working daemon is the normal case and needs no panel: its version, service name and socket
 * path are plumbing, and the telemetry below is the proof it is running. The section appears only
 * when something is wrong or was just attempted — not ready, a failure to report, collector errors
 * the daemon itself raised, or installer output to read.
 */
export function daemonNoticeNeeded(info, { error = null, health = null, install = null } = {}) {
  if (!info || info.state !== 'ready') return true
  if (error) return true
  if (healthProblems(health).length > 0) return true
  return Boolean(install?.log)
}

export function daemonFacts(info) {
  const rows = [['Service', info.service]]
  if (info.version) rows.push(['Version', info.version])
  if (info.socketPath) rows.push(['API socket', `${info.socketPath}${info.socket ? '' : ' (absent)'}`])
  if (info.simaCli) rows.push(['sima-cli', info.simaCli])
  return rows
}

export function healthFacts(health) {
  if (!health) return []
  const rows = []
  if (isNumber(health.metric_count)) rows.push(['Metrics', String(health.metric_count)])
  if (isNumber(health.cached_samples)) rows.push(['Cached samples', String(health.cached_samples)])
  if (health.latest_sample_at) rows.push(['Latest sample', formatRelativeTime(health.latest_sample_at)])
  return rows
}

/** Health errors are the daemon's own collector failures; they are strings or objects. */
export function healthProblems(health) {
  return (health?.errors || [])
    .map((item) => (typeof item === 'string' ? item : item?.error || item?.message || ''))
    .filter(Boolean)
}

/**
 * One readable failure: a title, the backend's sentence, its hint, and where the fix is.
 * `generation` is the board generation the request was issued under, so a failure that
 * lands after a board switch can be labelled like a stale payload.
 */
export function failureNotice(error, generation = null, { action = 'read' } = {}) {
  const normalized = normalizeError(error)
  if (!normalized) return null
  const code = normalized.code || ''
  const installing = action === 'install'
  const deleting = action === 'delete'
  return {
    code,
    generation,
    // What the failure came out of, so the view can label its attached output.
    action,
    title:
      (installing && INSTALL_TITLES[code]) || (deleting && DELETE_TITLES[code]) || FAILURE_TITLES[code] || 'Something went wrong',
    message: normalized.message,
    hint: normalized.hint || (installing && INSTALL_HINTS[code]) || FALLBACK_HINTS[code] || '',
    detail: typeof normalized.details?.detail === 'string' ? normalized.details.detail : '',
    // Kept so the Board card can still offer its host-key recovery from a Sentinel failure.
    details: normalized.details || {},
    board: BOARD_PROBLEM_CODES.has(code),
    daemon: DAEMON_PROBLEM_CODES.has(code),
    // A board that is missing or unreachable will not answer the next poll either.
    retryable: code !== 'no_target'
  }
}

export function metricsModel(payload) {
  const groups = (payload?.groups || []).map((group) => ({
    name: group?.name || 'Other',
    metrics: (group?.metrics || []).filter((metric) => metric && metric.key)
  })).filter((group) => group.metrics.length)
  const byKey = new Map()
  for (const group of groups) for (const metric of group.metrics) byKey.set(metric.key, metric)
  const highlights = (payload?.highlights || []).map((key) => byKey.get(key)).filter(Boolean)
  const counts = payload?.counts || { total: byKey.size, unavailable: 0, warn: 0, critical: 0 }
  return {
    groups,
    highlights: highlights.length ? highlights : groups[0]?.metrics.slice(0, 4) || [],
    counts,
    sampledAt: payload?.sampled_at || null,
    version: payload?.version || null,
    series: payload?.history?.series || {},
    timestamps: payload?.history?.timestamps || []
  }
}

/**
 * The Stats page splits into what the board reports and what the machine Insight runs on
 * reports. The board is what people open the page for, so it is the default; a saved value
 * that is not one of the two (an old build's, or a hand edit) falls back to it.
 */
export const STATS_TABS = [
  { id: 'devkit', label: 'DevKit' },
  { id: 'host', label: 'Host' }
]
export const STATS_TAB_KEY = 'neat-insight:stats-tab'

export function statsTabFrom(saved) {
  return STATS_TABS.some((tab) => tab.id === saved) ? saved : STATS_TABS[0].id
}

/**
 * The board's live metrics as the reader asks about them: an overview, then power, thermal
 * and system. Overview is Sentinel's own highlights; every metric lands in exactly one of
 * the other three.
 */
export const METRIC_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'power', label: 'Power' },
  { id: 'thermal', label: 'Thermal' },
  { id: 'system', label: 'System' }
]

const TEMPERATURE_UNITS = new Set(['c', '°c', 'degc', 'deg c', 'celsius'])
const POWER_UNITS = new Set(['w', 'mw', 'kw'])
const TEMPERATURE_NAME = /temp|rtsn|thermal/i

function unitKey(unit) {
  return String(unit ?? '').trim().toLowerCase()
}

/**
 * A temperature, wherever Sentinel grouped it: the board sensors sit under Board, the SoC's
 * RTSN sensors under MLA, APU, CVU and TOP. The unit decides when there is one, so a
 * percentage or a size whose name happens to hold "temp" is never read as a temperature; a
 * metric with no unit is a temperature when its key or label names a sensor.
 */
export function isThermalMetric(metric) {
  const unit = unitKey(metric?.unit)
  if (unit) return TEMPERATURE_UNITS.has(unit)
  return TEMPERATURE_NAME.test(`${metric?.key || ''} ${metric?.label || ''}`)
}

/**
 * The one section a metric belongs to. Thermal is decided first, so a temperature Sentinel
 * filed under Power is still found under Thermal. Power is Sentinel's Power and PowerRail
 * groups, and anything else measured in watts. Everything left is System.
 */
export function metricSection(metric, groupName = metric?.group) {
  if (isThermalMetric(metric)) return 'thermal'
  const group = String(groupName || '').replace(/[\s_-]+/g, '').toLowerCase()
  if (group.startsWith('power') || POWER_UNITS.has(unitKey(metric?.unit))) return 'power'
  return 'system'
}

/**
 * The live groups sorted into the three sections. Each section keeps Sentinel's own group
 * names, in Sentinel's order, as its sub-headings; a group whose metrics went elsewhere is
 * left out of the section rather than shown empty.
 */
export function metricSections(groups) {
  const sections = { power: [], thermal: [], system: [] }
  for (const group of groups || []) {
    const split = { power: [], thermal: [], system: [] }
    for (const metric of group.metrics || []) split[metricSection(metric, group.name)].push(metric)
    for (const id of Object.keys(split)) {
      if (split[id].length) sections[id].push({ name: group.name, metrics: split[id] })
    }
  }
  return sections
}

/** How many of these metrics are past a threshold, as the worst tone and its count. */
export function metricAlert(metrics) {
  const critical = (metrics || []).filter((metric) => metric.status === 'critical').length
  const warn = (metrics || []).filter((metric) => metric.status === 'warn').length
  return critical ? { tone: 'critical', count: critical } : warn ? { tone: 'warn', count: warn } : null
}

/**
 * The section tabs, with each section's size and anything in it past a threshold, so a hot
 * sensor shows on the Thermal tab while Overview is open. Overview counts nothing: it is a
 * choice of metrics from the other three.
 */
export function metricSectionTabs(sections) {
  return METRIC_SECTIONS.map((section) => {
    if (section.id === 'overview') return { ...section }
    const metrics = (sections?.[section.id] || []).flatMap((group) => group.metrics)
    return { ...section, count: metrics.length, alert: metricAlert(metrics) }
  })
}

export function metricSectionFrom(id) {
  return METRIC_SECTIONS.some((section) => section.id === id) ? id : METRIC_SECTIONS[0].id
}

/**
 * One line above the thermal tables: how many sensors, the hottest one, and the limits they
 * share. Sensors that did not report are counted but never chosen as the hottest.
 */
export function thermalSummary(groups) {
  const metrics = (groups || []).flatMap((group) => group.metrics)
  let hottest = null
  for (const metric of metrics) {
    if (isNumber(metric.value) && (!hottest || metric.value > hottest.value)) hottest = metric
  }
  const shared = (field) => {
    const values = new Set(metrics.map((metric) => (isNumber(metric[field]) ? metric[field] : null)))
    const [only] = values
    return values.size === 1 && only !== null ? only : null
  }
  const warn = shared('warn')
  const critical = shared('critical')
  const unit = metrics[0]?.unit ?? 'C'
  return {
    count: metrics.length,
    reporting: metrics.filter((metric) => isNumber(metric.value)).length,
    hottest,
    limits: thresholdText({ warn, critical, unit })
  }
}

/**
 * Where an arrow key moves focus in a row of chips. Chips wrap onto several lines, but they
 * are one list in reading order, so Left and Right step through it and wrap at the ends.
 * Anything else returns null and is left to the browser.
 */
export function chipKeyTarget(key, index, length) {
  if (!length) return null
  const at = Number.isInteger(index) && index >= 0 && index < length ? index : 0
  if (key === 'ArrowRight') return (at + 1) % length
  if (key === 'ArrowLeft') return (at - 1 + length) % length
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  return null
}

/**
 * An SVG polyline for one metric's recent values, scaled to the card.
 * Gaps (nulls) are dropped rather than drawn as zero, and a flat series stays centred.
 */
export function sparkline(values, width = 120, height = 28) {
  const points = (values || []).map((value, index) => ({ index, value })).filter((point) => isNumber(point.value))
  if (points.length < 2) return null
  const numbers = points.map((point) => point.value)
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  const span = max - min || 1
  const steps = Math.max(1, (values.length || 1) - 1)
  const scaled = points.map((point) => {
    const x = (point.index / steps) * width
    const y = height - ((point.value - min) / span) * (height - 2) - 1
    return `${Number(x.toFixed(1))},${Number(y.toFixed(1))}`
  })
  return { points: scaled.join(' '), min, max, count: points.length }
}

export function sparklineLabel(metric, spark) {
  if (!spark) return ''
  const low = formatValue(spark.min, metric?.unit)
  const high = formatValue(spark.max, metric?.unit)
  return `${metric?.label || metric?.key}: ${spark.count} recent samples, ${low} to ${high}`
}

export function thresholdText(metric) {
  const parts = []
  if (isNumber(metric?.warn)) parts.push(`warn at ${formatValue(metric.warn, metric.unit)}`)
  if (isNumber(metric?.critical)) parts.push(`critical at ${formatValue(metric.critical, metric.unit)}`)
  return parts.join(', ')
}

export function traceModel(payload) {
  const body = payload?.sentinel || {}
  const trace = body.trace || null
  return {
    // Kept so a trace read before a board switch can be labelled with the board it came from.
    payload: payload || null,
    active: Boolean(trace),
    trace,
    name: trace ? String(pick(trace, RUN_FIELDS.name) || pick(trace, RUN_FIELDS.id) || 'trace') : '',
    startedAt: trace ? pick(trace, RUN_FIELDS.startedAt) : null,
    // What the trace was started with, shown while it records.
    note: trace ? String(pick(trace, RUN_FIELDS.note) || '') : '',
    tags: trace && Array.isArray(pick(trace, RUN_FIELDS.tags)) ? pick(trace, RUN_FIELDS.tags).map(String) : [],
    summary: body.summary || null,
    facts: factRows(body.summary, [])
  }
}

export function parseTags(text) {
  return String(text || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

/** The same rules the API applies, checked here so a bad name never reaches the board. */
export function validateTrace({ name, note, tags }) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return { error: 'Name the trace so you can find its run later.' }
  if (trimmed.length > NAME_LIMIT) return { error: `The name can be at most ${NAME_LIMIT} characters.` }
  const text = String(note || '').trim()
  if (text.length > NOTE_LIMIT) return { error: `The note can be at most ${NOTE_LIMIT} characters.` }
  // /api/sentinel/compare carries its runs as one comma-separated list, so a comma in a
  // name splits that run into runs the board does not have. Refusing it here is what keeps
  // a trace from being recorded under a name it could never be compared by.
  if (trimmed.includes(',')) {
    return { error: 'The name cannot contain a comma; runs are compared by a comma-separated list of names.' }
  }
  const list = Array.isArray(tags) ? tags.filter(Boolean) : parseTags(tags)
  if (list.length > MAX_TAGS) return { error: `At most ${MAX_TAGS} tags can be attached to a trace.` }
  const body = { name: trimmed }
  if (text) body.note = text
  if (list.length) body.tags = list
  return { body }
}

/**
 * What the collapsed "Add note and tags" fields hold, so text typed into them is never
 * saved with a trace without being on screen. Empty when there is nothing in them.
 */
export function traceExtrasSummary(form) {
  const note = String(form?.note || '').trim()
  const tags = parseTags(form?.tags)
  const parts = []
  if (note) parts.push('a note')
  if (tags.length) parts.push(`${tags.length} tag${tags.length === 1 ? '' : 's'}`)
  return parts.length ? `${parts.join(' and ')} will be saved with this trace` : ''
}

/**
 * The one note the Runs panel carries: what a trace is for. The rules Sentinel enforces -- one
 * trace at a time, no reused name -- are said where they bite, in the refusal next to the form,
 * rather than read by everyone up front.
 */
export const RUNS_NOTE = 'Record a trace around a workload; it is saved on the board as a run you can reopen and compare.'

/**
 * The Runs panel's header row. Idle, it is the trace form; while a trace records, the same
 * row says what is recording and carries the control that stops it, so starting a trace
 * swaps the row's contents instead of adding one. `busy` is a start or stop in flight.
 */
export function traceBar(trace, { busy = false, now = Date.now() } = {}) {
  if (!trace?.active) {
    return { recording: false, submitLabel: busy ? 'Starting…' : 'Start trace' }
  }
  const startedAt = trace.startedAt || null
  const started = startedAt ? formatRelativeTime(startedAt, now) : ''
  return {
    recording: true,
    name: trace.name,
    startedAt,
    started,
    tags: trace.tags || [],
    note: trace.note || '',
    stopLabel: busy ? 'Stopping…' : 'Stop trace'
  }
}

function durationOf(source) {
  const seconds = pick(source, RUN_FIELDS.durationSec)
  if (isNumber(seconds)) return seconds
  const ms = pick(source, RUN_FIELDS.durationMs)
  if (isNumber(ms)) return ms / 1000
  const start = Date.parse(pick(source, RUN_FIELDS.startedAt) || '')
  const end = Date.parse(pick(source, RUN_FIELDS.endedAt) || '')
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 1000 : null
}

/** Sentinel's run summaries, read defensively: the daemon names these fields, not Insight. */
export function runList(payload) {
  const runs = payload?.sentinel?.runs
  if (!Array.isArray(runs)) return []
  return runs
    .map((run, index) => {
      const source = run && typeof run === 'object' ? run : { name: String(run ?? '') }
      const id = pick(source, RUN_FIELDS.id)
      const name = pick(source, RUN_FIELDS.name)
      const key = String(id || name || `run-${index}`)
      const tags = pick(source, RUN_FIELDS.tags)
      return {
        key,
        // Sentinel accepts either a unique name or a stable id on /runs/<id>.
        ref: String(name || id || key),
        id: id ? String(id) : '',
        name: name ? String(name) : '',
        label: String(name || id || `Run ${index + 1}`),
        state: String(pick(source, RUN_FIELDS.state) || ''),
        startedAt: pick(source, RUN_FIELDS.startedAt),
        endedAt: pick(source, RUN_FIELDS.endedAt),
        durationSec: durationOf(source),
        // Sentinel is power telemetry, and this is the number a run is judged on. It is
        // in every /runs entry, so it belongs in the list, not only in a comparison.
        energyJoules: pick(source, RUN_FIELDS.energyJoules),
        samples: pick(source, RUN_FIELDS.samples),
        note: pick(source, RUN_FIELDS.note),
        tags: Array.isArray(tags) ? tags.map(String) : [],
        source
      }
    })
    // A run Sentinel does not name or identify cannot be opened or compared; drop it.
    .filter((run) => run.id || run.name)
}

export function runSubtitle(run, now) {
  const parts = []
  if (run.state) parts.push(titleCase(run.state))
  if (run.startedAt) parts.push(`started ${formatRelativeTime(run.startedAt, now)}`)
  const duration = formatSeconds(run.durationSec)
  if (duration) parts.push(duration)
  if (isNumber(run.energyJoules)) parts.push(formatValue(run.energyJoules, 'J'))
  if (isNumber(run.samples)) parts.push(`${run.samples} samples`)
  return parts.join(' · ')
}

/**
 * Label/value rows for a body whose shape belongs to the daemon, not to Insight:
 * scalars are shown as they are, nested objects are flattened with their path, and the
 * list is bounded so a large run can never freeze the page.
 */
export function factRows(value, skip = [], prefix = '', depth = 0, rows = []) {
  if (rows.length >= FACT_LIMIT || value === null || value === undefined) return rows
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== 'object')) {
      if (value.length) rows.push([titleCase(prefix), value.map((item) => String(item ?? '—')).join(', ')])
      return rows
    }
    value.slice(0, 20).forEach((item, index) => factRows(item, skip, `${prefix}[${index}]`, depth + 1, rows))
    return rows
  }
  if (typeof value === 'object') {
    if (depth > 2) return rows
    for (const [key, item] of Object.entries(value)) {
      if (skip.includes(key)) continue
      factRows(item, skip, prefix ? `${prefix}.${key}` : key, depth + 1, rows)
    }
    return rows
  }
  rows.push([titleCase(prefix) || 'Value', typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value)])
  return rows
}

export function toggleSelection(selected, key, limit = MAX_COMPARE_RUNS) {
  const list = selected || []
  if (list.includes(key)) return list.filter((item) => item !== key)
  return list.length >= limit ? list : [...list, key]
}

/**
 * The selected refs the board's run list no longer contains. A run deleted on the board
 * takes its checkbox off the page with it, so the selection keeps a ref that cannot be
 * unticked and every Compare fails with the daemon's `not_found` naming it - on this
 * board, `{"code":"not_found","error":"unknown run '<ref>'"}` with a 404. The view has to
 * say which ref to drop. `runs` is null until the list has been read: that is not the
 * same as a list read and found empty, in which every selected run has gone.
 */
export function missingSelection(selected, runs) {
  const list = selected || []
  if (!list.length || !Array.isArray(runs)) return []
  const refs = new Set()
  for (const run of runs) {
    for (const value of [run?.ref, run?.id, run?.name]) if (value) refs.add(String(value))
  }
  return list.filter((ref) => !refs.has(String(ref)))
}

export function compareQuery(refs) {
  return `/api/sentinel/compare?runs=${encodeURIComponent((refs || []).join(','))}`
}

/**
 * Selected runs the compare query cannot carry. `/api/sentinel/compare` takes its runs as
 * one comma-separated list, and percent-encoding does not help: the backend splits the
 * decoded value, so a run named `before, after` is read as two runs. On this board that
 * answers 404 `{"code":"not_found","error":"unknown run 'before'"}`, naming a run nobody
 * selected and that never existed. Insight no longer records such a name, but a run
 * already saved on the board can still carry one, so the selection says so instead.
 */
export function uncomparableRefs(refs) {
  return (refs || []).filter((ref) => String(ref).includes(','))
}

export function compareReady(refs) {
  const list = refs || []
  if (list.length < MIN_COMPARE_RUNS || list.length > MAX_COMPARE_RUNS) return false
  return uncomparableRefs(list).length === 0
}

/** The request that deletes one run, bound to the board generation its run list came from. */
export function deleteRunQuery(ref, generation = null) {
  const path = `/api/sentinel/runs/${encodeURIComponent(String(ref))}`
  return Number.isInteger(generation) ? `${path}?generation=${generation}` : path
}

/** The request that stops the active trace, bound to the board generation it was read under. */
export function stopTraceQuery(generation = null) {
  const path = '/api/sentinel/traces/stop'
  return Number.isInteger(generation) ? `${path}?generation=${generation}` : path
}

export function deletePrompt(count) {
  return `Delete ${count} run${count === 1 ? '' : 's'}?`
}

/**
 * Whether the runs still to delete would fail the same way: the fault is the board, the
 * daemon, Insight or a board switch, not the run. They are then reported as not attempted
 * rather than sent one by one into the same failure.
 */
export function deleteStops(notice) {
  if (!notice) return false
  return Boolean(notice.board || notice.daemon || ['stale_snapshot', 'network', 'bad_response'].includes(notice.code))
}

/**
 * The outcome of deleting the selected runs, one result per ref in the order they were sent:
 * `{ref, deleted}` when the board deleted it, `{ref, notice}` when it failed, `{ref, skipped}`
 * when an earlier failure made trying pointless. `gone` holds every name a deleted run went
 * by - the ref the selection held and the id and name the backend reports - because a
 * selection, an open run and a comparison may each hold either.
 */
export function deleteSummary(results) {
  const list = results || []
  const deleted = list.filter((result) => result.deleted)
  const failed = list.filter((result) => result.notice)
  const skipped = list.filter((result) => result.skipped).map((result) => result.ref)
  const gone = new Set()
  for (const result of deleted) {
    for (const value of [result.ref, result.deleted?.id, result.deleted?.name]) if (value) gone.add(String(value))
  }
  const count = deleted.length
  const status = count ? `Deleted ${count} run${count === 1 ? '' : 's'} from the board.` : ''
  let title = ''
  if (failed.length || skipped.length) {
    const notDeleted = failed.length + skipped.length
    title =
      notDeleted === 1 && failed.length === 1
        ? `Run ${failed[0].ref} was not deleted`
        : `${notDeleted} of ${list.length} runs were not deleted`
  }
  return { deleted: deleted.map((result) => result.ref), failed, skipped, gone, status, title }
}

/** Whether a comparison includes a run that has been deleted, by the id or name it reports. */
export function compareIncludes(compare, gone) {
  const runs = compare?.sentinel?.runs
  if (!Array.isArray(runs) || !gone || !gone.size) return false
  return runs.some((run) => run && typeof run === 'object' && [run.id, run.name].some((value) => value && gone.has(String(value))))
}

/**
 * The comparison /api/sentinel/compare returns, as a table: one row per metric, one
 * column per run, the baseline marked.
 *
 * The daemon's shape is pinned against sentinel main:80ab7de4da31 and captured in
 * fixtures/compare-shape.json:
 *
 *   baseline_id        the run id the deltas are measured against
 *   runs[]             {id, name, note, started_at, ended_at, sample_interval_ms, ...}
 *   summaries[runId]   {duration_ms, energy_joules, samples, metrics: {key: stats}}
 *                      where stats is {count, minimum, maximum, mean, median, p95}
 *   baseline_deltas_pct[runId][key]   percent change of that metric's MEAN against the
 *                      baseline's mean, or null when the baseline mean is zero and there
 *                      is nothing to compare against
 *
 * Cells therefore carry the mean, because that is the statistic the delta describes.
 * Nothing is invented: a label and unit are used only when the board's own metric
 * definitions name that key, and a run-level scalar has no delta because the daemon
 * publishes none. A body that does not match this shape returns null, and the view falls
 * back to listing the values as they came.
 *
 * A cell with no delta also carries `deltaAbsence`, the reason it has none. The daemon's
 * null is not one thing: on this board 10 of 59 metrics come back null because the
 * baseline's mean was 0 - `cpu_core_13_usage_pct` is null although the baseline measured
 * it four times and the other run averaged 5.9% - and that is a different statement from
 * "the baseline never measured it". The view reports the reason rather than leaving one
 * undifferentiated em dash to be read as the metric being absent.
 */
export const COMPARE_STATISTIC = 'mean'
// Sentinel reports these per run alongside the metric summaries. They carry no delta of
// its own, and it sends a duration in milliseconds, which is not the unit the rest of
// this view reads a duration in; `scale` converts it once, here.
const RUN_SCALARS = [
  { key: 'duration_ms', label: 'Duration', unit: 's', scale: 0.001 },
  { key: 'energy_joules', label: 'Energy', unit: 'J', scale: 1 },
  { key: 'samples', label: 'Samples', unit: null, scale: 1 }
]

/**
 * Why a cell shows no change. An em dash on its own reads as "nothing here", but the
 * daemon withholds a delta for four different reasons and only one of them means the
 * metric was never measured. Keeping them apart is what stops the table claiming, of a
 * metric that went from 0 to 5.9%, that there was nothing to compare.
 */
export const DELTA_ABSENCE = {
  not_published: 'Sentinel publishes no change for it.',
  no_baseline: 'the baseline run has no value for that metric.',
  baseline_zero: 'the baseline measured 0, and there is no percentage change from 0.',
  no_value: 'this run has no value for that metric.'
}

export function deltaAbsenceText(code) {
  return DELTA_ABSENCE[code] || ''
}

function compareColumns(runs, baselineId, summaries) {
  return runs.map((run, index) => {
    const id = String(run?.id ?? index)
    return {
      key: id,
      label: String(run?.name || run?.id || `Run ${index + 1}`),
      // What tells two runs of the same workload apart. The runs table shows it, and a
      // comparison is exactly where "which of these was the baseline again" is asked.
      note: String(run?.note || ''),
      baseline: id === String(baselineId),
      // A run the daemon listed but summarised nothing for: its column is all em dashes,
      // and saying so beats letting it read as a run that measured nothing.
      summarised: Boolean(summaries?.[id]),
      run: run || null
    }
  })
}

function metricKeysOf(summaries, columns) {
  const keys = []
  for (const column of columns) {
    const metrics = summaries[column.key]?.metrics
    if (!metrics || typeof metrics !== 'object') continue
    for (const key of Object.keys(metrics)) if (!keys.includes(key)) keys.push(key)
  }
  return keys.sort()
}

function compareCell(column, value, delta, baselineValue, published = true) {
  const has = isNumber(value)
  // The baseline is what the others are measured against, so it shows no change. Neither
  // does a cell with no value: a change beside an em dash describes a number that is not
  // on the page, so the value the daemon has is what decides whether a change is shown.
  const deltaPct = column.baseline || !has || !isNumber(delta) ? null : delta
  let deltaAbsence = null
  if (!column.baseline && deltaPct === null) {
    if (!has) deltaAbsence = 'no_value'
    else if (!published) deltaAbsence = 'not_published'
    else if (!isNumber(baselineValue)) deltaAbsence = 'no_baseline'
    else if (baselineValue === 0) deltaAbsence = 'baseline_zero'
    else deltaAbsence = 'not_published'
  }
  return { column: column.key, baseline: column.baseline, value: has ? value : null, deltaPct, deltaAbsence }
}

export function compareTable(payload, definitions = null) {
  const body = payload?.sentinel
  if (!body || typeof body !== 'object') return null
  const runs = Array.isArray(body.runs) ? body.runs : null
  const summaries = body.summaries
  if (!runs || !summaries || typeof summaries !== 'object') return null
  const columns = compareColumns(runs, body.baseline_id, summaries)
  if (columns.length < MIN_COMPARE_RUNS || !columns.some((column) => summaries[column.key])) return null
  const deltas = body.baseline_deltas_pct && typeof body.baseline_deltas_pct === 'object' ? body.baseline_deltas_pct : {}
  const define = (key) => (definitions instanceof Map ? definitions.get(key) : null) || null
  // Every delta is measured against this column, so it also decides why one is missing.
  const baselineColumn = columns.find((column) => column.baseline) || columns[0]

  const scalarRows = RUN_SCALARS.filter((spec) => columns.some((column) => isNumber(summaries[column.key]?.[spec.key])))
    .map((spec) => {
      const valueOf = (column) => {
        const raw = summaries[column.key]?.[spec.key]
        return isNumber(raw) ? raw * spec.scale : null
      }
      const baselineValue = valueOf(baselineColumn)
      return {
        key: spec.key,
        // A run total, not a metric: it has no metric group of its own.
        kind: 'run',
        label: spec.label,
        unit: spec.unit,
        group: null,
        // The daemon publishes no delta for a run scalar, so none is shown for it.
        cells: columns.map((column) => compareCell(column, valueOf(column), null, baselineValue, false))
      }
    })

  const metricRows = metricKeysOf(summaries, columns).map((key) => {
    const definition = define(key)
    const meanOf = (column) => summaries[column.key]?.metrics?.[key]?.[COMPARE_STATISTIC]
    const baselineValue = meanOf(baselineColumn)
    return {
      key,
      kind: 'metric',
      label: definition?.label || titleCase(key),
      unit: definition?.unit || null,
      group: definition?.group || null,
      cells: columns.map((column) => compareCell(column, meanOf(column), deltas[column.key]?.[key], baselineValue))
    }
  })

  const rows = [...scalarRows, ...metricRows].filter((row) => row.cells.some((cell) => cell.value !== null))
  if (!rows.length) return null
  return {
    columns,
    rows,
    baselineId: body.baseline_id ?? null,
    baselineLabel: columns.find((column) => column.baseline)?.label || '',
    generatedAt: body.generated_at || null,
    statistic: COMPARE_STATISTIC
  }
}

// --- viewing and exporting a comparison ---------------------------------------
export const ALL_GROUPS = 'All'
const RUN_TOTALS = 'Run totals'

/** The group a comparison row is filtered and exported under. */
export function compareRowGroup(row) {
  if (row?.kind === 'run') return RUN_TOTALS
  return row?.group || OTHER_GROUP
}

/** "All" first, then run totals, the metric groups by name, and unlabelled keys last. */
export function compareGroups(table) {
  const counts = new Map()
  for (const row of table?.rows || []) {
    const group = compareRowGroup(row)
    counts.set(group, (counts.get(group) || 0) + 1)
  }
  const rank = (name) => (name === RUN_TOTALS ? 0 : name === OTHER_GROUP ? 2 : 1)
  const names = [...counts.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  return [
    { id: ALL_GROUPS, label: ALL_GROUPS, count: table?.rows?.length || 0 },
    ...names.map((name) => ({ id: name, label: name, count: counts.get(name) }))
  ]
}

/**
 * Whether any run differs from the baseline on this row. A published change decides it.
 * Where Sentinel publishes none - a run total, or a baseline that measured 0 - the two
 * values are compared directly: a metric that went from 0 to 5.9% has changed even though
 * there is no percentage to say by how much. A run with no value at all is not a change;
 * there is nothing to say it moved.
 */
export function rowChanged(row) {
  const cells = row?.cells || []
  const base = cells.find((cell) => cell.baseline) || cells[0]
  return cells.some((cell) => {
    if (cell === base) return false
    if (isNumber(cell.deltaPct)) return cell.deltaPct !== 0
    return isNumber(cell.value) && isNumber(base?.value) && cell.value !== base.value
  })
}

/**
 * The rows a comparison shows under a group filter and the "changes only" toggle, with
 * counts, so the view can say what it is not showing. A group the comparison does not
 * have reads as All rather than as an empty table.
 */
export function compareView(table, { group = ALL_GROUPS, changesOnly = false } = {}) {
  const all = table?.rows || []
  const known = group !== ALL_GROUPS && all.some((row) => compareRowGroup(row) === group)
  const active = known ? group : ALL_GROUPS
  const inGroup = active === ALL_GROUPS ? all : all.filter((row) => compareRowGroup(row) === active)
  const rows = changesOnly ? inGroup.filter(rowChanged) : inGroup
  return {
    group: active,
    changesOnly: Boolean(changesOnly),
    rows,
    total: all.length,
    inGroup: inGroup.length,
    unchanged: inGroup.length - rows.length
  }
}

/** What the filters leave out, in words, so a shorter table is never read as the whole one. */
export function compareViewText(view) {
  if (!view) return ''
  const parts = []
  if (view.rows.length < view.total) parts.push(`Showing ${view.rows.length} of ${view.total} rows.`)
  if (view.changesOnly) {
    const count = view.unchanged
    parts.push(
      count
        ? `Changes only hides ${count} row${count === 1 ? '' : 's'} where no run differs from the baseline.`
        : 'Every row shown differs from the baseline in at least one run, so Changes only hides nothing.'
    )
  }
  return parts.join(' ')
}

/**
 * One CSV field (RFC 4180): quoted when it holds a quote, comma or line break, or would
 * lose leading or trailing space. Numbers are written as they are; a missing value is an
 * empty field. Text that a spreadsheet would run as a formula - a run named "=cmd|..." -
 * is prefixed with an apostrophe, since run names are whatever someone typed on the board.
 */
export function csvField(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text
}

function csvColumnName(column) {
  const marks = [column.baseline ? 'baseline' : '', column.note].filter(Boolean)
  return marks.length ? `${column.label} (${marks.join('; ')})` : column.label
}

/**
 * The comparison as CSV: every row the table holds, whatever filter is on screen. Per run,
 * its value and its percent change against the baseline, unformatted, with an empty field
 * wherever the table shows an em dash - never a dash or a zero, which a spreadsheet would
 * read as a value. The baseline's own change column is always empty, for the same reason
 * the table shows none. Units live in their own column, never inside a number.
 */
export function compareCsv(table) {
  if (!table?.rows?.length) return ''
  const header = ['metric_key', 'label', 'group', 'unit']
  for (const column of table.columns) {
    const name = csvColumnName(column)
    header.push(`${name} ${table.statistic}`, `${name} change vs baseline (%)`)
  }
  const lines = [header]
  for (const row of table.rows) {
    const line = [row.key, row.label, compareRowGroup(row), unitSuffix(row.unit)]
    for (const cell of row.cells) line.push(cell.value, cell.deltaPct)
    lines.push(line)
  }
  return lines.map((line) => line.map(csvField).join(',')).join('\r\n') + '\r\n'
}

function localDay(date) {
  const day = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/** `sentinel-compare-<baseline>-<YYYY-MM-DD>.csv`, safe on every filesystem. */
export function compareCsvFilename(table, date = new Date()) {
  const baseline = String(table?.baselineLabel || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
    .replace(/[-.]+$/, '')
  return `sentinel-compare-${baseline || 'runs'}-${localDay(date)}.csv`
}

/** Metric definitions from /api/sentinel/metrics, by key, for labelling saved runs. */
export function definitionsByKey(metrics) {
  const map = new Map()
  for (const group of metrics?.groups || []) {
    for (const metric of group?.metrics || []) {
      if (metric?.key) map.set(metric.key, metric)
    }
  }
  return map
}

/**
 * Rank one value the way the backend ranks a live one, using the thresholds that were in
 * force when the run was recorded.
 */
export function statusOf(value, warn, critical) {
  if (!isNumber(value)) return 'unavailable'
  if (isNumber(critical) && value >= critical) return 'critical'
  if (isNumber(warn) && value >= warn) return 'warn'
  return 'ok'
}

function seriesStats(values) {
  const numbers = values.filter(isNumber)
  if (!numbers.length) return { count: 0, minimum: null, maximum: null, mean: null, last: null }
  return {
    count: numbers.length,
    minimum: Math.min(...numbers),
    maximum: Math.max(...numbers),
    mean: numbers.reduce((total, value) => total + value, 0) / numbers.length,
    last: numbers[numbers.length - 1]
  }
}

/**
 * One saved run from /api/sentinel/runs/<id>, pinned against sentinel main:80ab7de4da31
 * and captured in fixtures/run-detail-shape.json. The daemon answers with exactly three
 * keys:
 *
 *   metadata  {id, name, note, tags, started_at, ended_at, sample_interval_ms,
 *              sentinel_version, system}
 *   metrics   the definitions that were in force for this run: a list of
 *             {key, label, short, description, group, unit, warn, critical}
 *   samples   a list of {timestamp, values{key: number|null}}
 *
 * A run therefore carries its own definitions, and those are the ones used to label,
 * unit-format and rank it - not the definitions of whatever the board reports today,
 * which may have changed since. The per-metric minimum, maximum and mean are computed
 * here from the run's own samples, because the daemon publishes none for a single run;
 * everything else is shown as the board sent it.
 */
export function runDetail(payload) {
  const body = payload?.sentinel
  if (!body || typeof body !== 'object') return null
  if (!('metadata' in body) && !('metrics' in body) && !('samples' in body)) return null
  const samples = Array.isArray(body.samples) ? body.samples : []
  const stamps = samples.map((sample) => sample?.timestamp).filter((stamp) => typeof stamp === 'string')
  const listed = Array.isArray(body.metrics) ? body.metrics : []
  const definitions = listed.filter((metric) => metric && metric.key)
  const valuesOf = (key) => samples.map((sample) => (sample?.values || {})[key])

  const metrics = definitions.map((definition) => {
    const stats = seriesStats(valuesOf(definition.key))
    return {
      key: definition.key,
      label: definition.label || titleCase(definition.key),
      short: definition.short || definition.label || titleCase(definition.key),
      description: definition.description || null,
      group: definition.group || OTHER_GROUP,
      unit: definition.unit || null,
      warn: isNumber(definition.warn) ? definition.warn : null,
      critical: isNumber(definition.critical) ? definition.critical : null,
      ...stats,
      // The worst moment of the run, against the run's own thresholds.
      status: statusOf(stats.maximum, definition.warn, definition.critical)
    }
  })
  metrics.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))

  // A value the run recorded that its definitions never named is still counted, so the
  // page never claims to show more of the run than it does.
  const named = new Set(definitions.map((metric) => metric.key))
  const undefinedKeys = [...new Set(samples.flatMap((sample) => Object.keys(sample?.values || {})))].filter(
    (key) => !named.has(key)
  )

  return {
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : null,
    facts: factRows(body.metadata, []),
    definitions,
    metrics,
    undefinedKeys,
    // `metrics` may be a map of key -> definition rather than the documented list.
    metricCount: definitions.length || (body.metrics && typeof body.metrics === 'object' ? Object.keys(body.metrics).length : 0),
    sampleCount: samples.length,
    // A run of one sample is a moment, not an interval. "from 15:27:12 to 15:27:12" reads
    // as a range that was measured and turned out to be nothing, and a mean, minimum and
    // maximum of one value are three columns of the same number: both are said plainly.
    single: samples.length === 1,
    sampledAt: stamps.length === 1 ? stamps[0] : null,
    firstSampleAt: stamps[0] || null,
    lastSampleAt: stamps.length ? stamps[stamps.length - 1] : null,
    crossed: metrics.filter((metric) => metric.status === 'warn' || metric.status === 'critical').length,
    // Anything the daemon adds beyond the three documented keys is still listed.
    extras: factRows(
      Object.fromEntries(Object.entries(body).filter(([key]) => !['metadata', 'metrics', 'samples'].includes(key))),
      []
    )
  }
}

// --- the Insight host --------------------------------------------------------
// /api/metrics measures the machine Insight itself runs on - the SDK container or the
// board Insight is installed on - or, when the legacy REMOTE_DEVKIT configuration is
// set, that separate connection. It is not the selected board and never mixes with
// Sentinel's numbers, so it is modelled and labelled apart.
export const HOST_POLL_MS = 15000

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(value) {
  if (!isNumber(value) || value < 0) return ''
  let size = value
  let unit = 0
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${formatNumber(size)} ${BYTE_UNITS[unit]}`
}

function numberOf(value) {
  if (value === '' || value === null || value === undefined) return null
  const number = typeof value === 'string' ? Number(value) : value
  return isNumber(number) ? number : null
}

function percentOf(value) {
  const number = numberOf(value)
  return number === null ? null : Math.max(0, Math.min(100, number))
}

function usageDetail(usage) {
  const used = formatBytes(usage?.used)
  const total = formatBytes(usage?.total)
  return used && total ? `${used} of ${total}` : ''
}

/**
 * The host snapshot as rows the panel renders: a percentage where the endpoint gives
 * one, the bytes behind it, and `null` - never zero - where it gives nothing. A remote
 * DevKit that is configured but not connected answers with empty fields; that is
 * reported as offline instead of as a machine at 0%.
 */
export function hostMetricsModel(payload) {
  const remote = Boolean(payload?.REMOTE)
  const cpu = percentOf(payload?.cpu_load)
  const memory = payload?.memory || {}
  const disk = payload?.disk || {}
  const temperature = numberOf(payload?.temperature_celsius_avg)
  const offline = remote && cpu === null && !isNumber(memory.percent)
  const rows = [
    { key: 'cpu_load', label: 'CPU load', percent: cpu, value: cpu, unit: '%', detail: '' },
    {
      key: 'memory',
      label: 'Memory',
      percent: percentOf(memory.percent),
      value: percentOf(memory.percent),
      unit: '%',
      detail: usageDetail(memory)
    },
    {
      key: 'disk',
      label: 'Disk',
      percent: percentOf(disk.percent),
      value: percentOf(disk.percent),
      unit: '%',
      detail: [usageDetail(disk), disk.mount].filter(Boolean).join(' · ')
    }
  ]
  // The backend only reads a temperature on a Davinci board, and sends 0 for a remote
  // DevKit it cannot reach; either way an absent reading is left out rather than shown.
  if (isNumber(temperature) && !(remote && temperature === 0)) {
    rows.push({ key: 'temperature', label: 'Temperature', percent: null, value: temperature, unit: 'C', detail: '' })
  }
  return {
    source: remote ? 'remote' : 'local',
    sourceLabel: remote
      ? 'Remote DevKit from the legacy REMOTE_DEVKIT configuration'
      : 'The machine Insight runs on',
    offline,
    rows: offline ? [] : rows,
    empty: !offline && rows.every((row) => row.value === null)
  }
}

/**
 * What the host panel says in place of its rows, or '' when it has rows to show. A
 * snapshot with no readings at all was being rendered as three labels against three em
 * dashes and nothing else, which reads as a machine whose load could not be measured
 * rather than as an endpoint that answered with nothing. `read` is whether /api/metrics
 * has answered at least once, so the first paint says it is still reading.
 */
export function hostNotice(model, read = false) {
  if (model?.offline) {
    return 'A remote DevKit is configured for this endpoint but is not connected, so it reports nothing.'
  }
  if (!model?.empty) return ''
  return read
    ? 'Insight answered with no CPU, memory or disk reading for this machine, so none is shown rather than zeros.'
    : 'Reading this machine…'
}
