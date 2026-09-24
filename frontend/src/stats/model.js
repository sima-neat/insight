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
  durationMs: ['duration_ms', 'elapsed_ms']
}

const STAT_FIELDS = ['mean', 'avg', 'average', 'value', 'median', 'last', 'max']
const DELTA_FIELDS = ['delta', 'delta_mean', 'delta_vs_baseline', 'diff']
const DELTA_PCT_FIELDS = ['delta_pct', 'delta_percent', 'pct_change', 'percent_change']

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

export function formatDelta(value, unit) {
  if (!isNumber(value)) return ''
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±'
  return `${sign}${formatValue(Math.abs(value), unit)}`
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
 * One in-flight request per key. React state settles a tick later than a click, so a
 * second Re-check, Refresh or Compare can start before the first has set its busy flag;
 * each of those is a command on the board, so the guard is synchronous.
 */
export function createRequestGuard() {
  const active = new Set()
  return {
    running: (key) => active.has(key),
    begin(key) {
      if (active.has(key)) return false
      active.add(key)
      return true
    },
    end(key) {
      active.delete(key)
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
export function failureNotice(error, generation = null) {
  const normalized = normalizeError(error)
  if (!normalized) return null
  const code = normalized.code || ''
  return {
    code,
    generation,
    title: FAILURE_TITLES[code] || 'Something went wrong',
    message: normalized.message,
    hint: normalized.hint || FALLBACK_HINTS[code] || '',
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

export function countsSummary(counts) {
  const total = counts?.total || 0
  const parts = [`${total} metric${total === 1 ? '' : 's'}`]
  if (counts?.critical) parts.push(`${counts.critical} critical`)
  if (counts?.warn) parts.push(`${counts.warn} warning`)
  if (counts?.unavailable) parts.push(`${counts.unavailable} not measured`)
  return parts.join(' · ')
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
  const list = Array.isArray(tags) ? tags.filter(Boolean) : parseTags(tags)
  if (list.length > MAX_TAGS) return { error: `At most ${MAX_TAGS} tags can be attached to a trace.` }
  const body = { name: trimmed }
  if (text) body.note = text
  if (list.length) body.tags = list
  return { body }
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

export function compareQuery(refs) {
  return `/api/sentinel/compare?runs=${encodeURIComponent((refs || []).join(','))}`
}

export function compareReady(refs) {
  const list = refs || []
  return list.length >= MIN_COMPARE_RUNS && list.length <= MAX_COMPARE_RUNS
}

export function compareHint(refs) {
  const list = refs || []
  const count = list.length
  if (count < MIN_COMPARE_RUNS) return `Select ${MIN_COMPARE_RUNS - count} more run to compare; the first is the baseline.`
  const comparing = `Comparing ${count} runs against ${list[0]}.`
  // At the limit the checkboxes go disabled; say why, since that hint is what they point at.
  return count >= MAX_COMPARE_RUNS
    ? `${comparing} Sentinel compares at most ${MAX_COMPARE_RUNS} runs at once, so clear one to select another.`
    : comparing
}

function statValue(stat) {
  if (isNumber(stat)) return { value: stat, delta: null, deltaPct: null }
  if (!stat || typeof stat !== 'object') return { value: null, delta: null, deltaPct: null }
  const value = pick(stat, STAT_FIELDS)
  const delta = pick(stat, DELTA_FIELDS)
  const deltaPct = pick(stat, DELTA_PCT_FIELDS)
  return {
    value: isNumber(value) ? value : null,
    delta: isNumber(delta) ? delta : null,
    deltaPct: isNumber(deltaPct) ? deltaPct : null
  }
}

function compareColumns(runs) {
  return (runs || []).map((run, index) => {
    if (run && typeof run === 'object') {
      const name = pick(run, RUN_FIELDS.name) || pick(run, RUN_FIELDS.id)
      return { key: String(name || index), label: String(name || `Run ${index + 1}`), baseline: index === 0 }
    }
    return { key: String(run ?? index), label: String(run ?? `Run ${index + 1}`), baseline: index === 0 }
  })
}

/**
 * A metric-per-row table for /api/sentinel/compare, when the daemon's body carries one.
 * The comparison body is Sentinel's own and is not pinned by Insight's contract, so an
 * unrecognized shape returns null and the view falls back to plain fact rows.
 */
export function compareTable(payload) {
  const body = payload?.sentinel
  if (!body || typeof body !== 'object') return null
  const columns = compareColumns(body.runs)
  const metrics = Array.isArray(body.metrics) ? body.metrics : null
  if (columns.length < MIN_COMPARE_RUNS || !metrics) return null
  const rows = metrics
    .map((metric) => {
      if (!metric || typeof metric !== 'object') return null
      const perRun = metric.runs || metric.values || metric.stats
      if (!perRun) return null
      const cells = columns.map((column, index) => {
        const stat = Array.isArray(perRun) ? perRun[index] : perRun[column.key]
        return { ...statValue(stat), column: column.key }
      })
      if (cells.every((cell) => cell.value === null)) return null
      return {
        key: String(metric.key || metric.label || ''),
        label: String(metric.label || titleCase(metric.key) || 'Metric'),
        unit: metric.unit || null,
        cells
      }
    })
    .filter(Boolean)
  return rows.length ? { columns, rows } : null
}
