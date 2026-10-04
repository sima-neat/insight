import { countLabel, formatRelativeTime, normalizeError } from '../peripherals/model.js'

export { formatRelativeTime }

const POLL_MS = 2000
const MAX_POLL_MS = 30000
export const HISTORY_SAMPLES = 240
export const HOST_POLL_MS = 15000
const NAME_LIMIT = 128
const NOTE_LIMIT = 512
const MAX_TAGS = 16
export const MAX_COMPARE_RUNS = 8
const OTHER_GROUP = 'Other'

const BOARD_PROBLEM_CODES = new Set([
  'no_target',
  'unreachable',
  'auth_failed',
  'host_key_changed',
  'timeout',
  'permission_denied',
  'tool_missing',
  'command_failed'
])
const DAEMON_PROBLEM_CODES = new Set(['sentinel_missing', 'sentinel_stopped', 'sentinel_denied'])

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

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function titleCase(key) {
  const text = String(key || '').replace(/[_.]+/g, ' ').trim()
  return text ? text[0].toUpperCase() + text.slice(1) : ''
}

export function pollDelay(failures = 0) {
  return Math.min(MAX_POLL_MS, POLL_MS * 2 ** Math.min(failures, 8))
}

export function statusInfo(status) {
  return STATUS_TONES[status] || STATUS_TONES.unavailable
}

export function statusOf(value, warn, critical) {
  if (!isNumber(value)) return 'unavailable'
  if (isNumber(critical) && value >= critical) return 'critical'
  if (isNumber(warn) && value >= warn) return 'warn'
  return 'ok'
}

function formatNumber(value) {
  if (!isNumber(value)) return ''
  const abs = Math.abs(value)
  return String(Number(value.toFixed(abs >= 100 ? 0 : abs >= 10 ? 1 : 2)))
}

export function unitSuffix(unit) {
  const text = String(unit || '').trim()
  if (text === 'C' || text === 'celsius') return '°C'
  return text === 'load' ? '' : text
}

/** A value Sentinel could not measure reads as an em dash, never as zero. */
export function formatValue(value, unit) {
  if (!isNumber(value)) return '—'
  const suffix = unitSuffix(unit)
  if (!suffix) return formatNumber(value)
  return suffix === '%' ? `${formatNumber(value)}%` : `${formatNumber(value)} ${suffix}`
}

export function formatPercentDelta(value) {
  if (!isNumber(value)) return '—'
  if (value === 0) return '±0%'
  const sign = value > 0 ? '+' : '−'
  const size = Math.abs(value)
  return size < 0.01 ? `${sign}<0.01%` : `${sign}${formatNumber(size)}%`
}

function formatSeconds(seconds) {
  if (!isNumber(seconds) || seconds < 0) return ''
  if (seconds < 60) {
    const value = Number(seconds.toFixed(seconds < 10 ? 1 : 0))
    return `${value} ${value === 1 ? 'second' : 'seconds'}`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${countLabel(minutes, 'minute')} ${countLabel(Math.round(seconds - minutes * 60), 'second')}`
  return `${countLabel(Math.floor(minutes / 60), 'hour')} ${countLabel(minutes % 60, 'minute')}`
}

export function formatTimestamp(iso) {
  const time = Date.parse(iso || '')
  return Number.isFinite(time) ? new Date(time).toLocaleString() : ''
}

function formatTimeRange(fromIso, toIso) {
  const from = Date.parse(fromIso || '')
  const to = Date.parse(toIso || '')
  if (!Number.isFinite(from) || !Number.isFinite(to)) return ''
  if (from === to) return formatTimestamp(fromIso)
  const a = new Date(from)
  const b = new Date(to)
  const day = (date) => date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  // hourCycle, not hour12: false, which some ICU builds render as 24:00:10 at midnight.
  const clock = (date) => date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  return a.toDateString() === b.toDateString()
    ? `${day(a)}, ${clock(a)}–${clock(b)}`
    : `${day(a)}, ${clock(a)} – ${day(b)}, ${clock(b)}`
}

// One request per key; an answer applies only while current(ticket), and a board switch cancels every ticket.
export function createRequestGuard() {
  const active = new Map()
  let generation = null
  return {
    switchTo(next = null) {
      const value = next ?? null
      if (value === generation) return false
      const first = generation === null
      generation = value
      if (first) {
        for (const ticket of active.values()) ticket.generation = value
        return false
      }
      for (const ticket of active.values()) ticket.cancelled = true
      active.clear()
      return true
    },
    begin(key, { supersede = false } = {}) {
      const running = active.get(key)
      if (running && !supersede) return null
      if (running) running.cancelled = true
      const ticket = { key, generation, cancelled: false }
      active.set(key, ticket)
      return ticket
    },
    current(ticket, answer) {
      if (!ticket || ticket.cancelled || ticket.generation !== generation) return false
      const read = answer?.generation
      return !Number.isInteger(read) || ticket.generation === null || Number(ticket.generation) === read
    },
    cancel(key) {
      const running = active.get(key)
      if (running) running.cancelled = true
      active.delete(key)
    },
    end(ticket) {
      if (ticket && active.get(ticket.key) === ticket) active.delete(ticket.key)
    }
  }
}

export function daemonInfo(state) {
  const daemon = state?.daemon || null
  const key = state ? state.status?.state || 'error' : 'unknown'
  const known = DAEMON_STATES[key] || { label: 'Unknown', tone: '' }
  let installBlocked = ''
  if (!daemon) installBlocked = 'Sentinel state is unknown; reload before installing.'
  else if (daemon.healthy) installBlocked = 'Sentinel is already running. Reinstalling would restart it and end a trace in flight.'
  else if (!daemon.sima_cli) installBlocked = 'sima-cli was not found on the board, so Insight cannot install Sentinel from here.'
  return {
    state: key,
    label: known.label,
    tone: known.tone,
    available: Boolean(state?.available),
    version: state?.version || null,
    canInstall: !installBlocked,
    installBlocked,
    error: normalizeError(state?.status?.error || null)
  }
}

export function healthProblems(health) {
  return (health?.errors || [])
    .map((item) => (typeof item === 'string' ? item : item?.error || item?.message || ''))
    .filter(Boolean)
}

export function failureNotice(error) {
  const normalized = normalizeError(error)
  if (!normalized) return null
  return {
    ...normalized,
    detail: typeof normalized.details?.detail === 'string' ? normalized.details.detail : '',
    board: BOARD_PROBLEM_CODES.has(normalized.code),
    daemon: DAEMON_PROBLEM_CODES.has(normalized.code)
  }
}

export function metricsModel(payload) {
  const all = (payload?.groups || []).flatMap((group) => (group?.metrics || []).filter((metric) => metric?.key))
  const byKey = new Map(all.map((metric) => [metric.key, metric]))
  const listed = (payload?.order || []).map((key) => byKey.get(key)).filter(Boolean)
  const seen = new Set(listed.map((metric) => metric.key))
  return {
    metrics: [...listed, ...all.filter((metric) => !seen.has(metric.key))],
    byKey,
    series: payload?.history?.series || {},
    timestamps: payload?.history?.timestamps || []
  }
}

const TEMPERATURE_UNITS = new Set(['c', '°c', 'degc', 'deg c', 'celsius'])

export function isThermalMetric(metric) {
  const unit = String(metric?.unit ?? '').trim().toLowerCase()
  if (unit) return TEMPERATURE_UNITS.has(unit)
  return /temp|rtsn|thermal/i.test(`${metric?.key || ''} ${metric?.label || ''}`)
}

export function metricAlert(metrics) {
  const critical = metrics.filter((metric) => metric.status === 'critical').length
  const warn = metrics.filter((metric) => metric.status === 'warn').length
  return critical ? { tone: 'critical', count: critical } : warn ? { tone: 'warn', count: warn } : null
}

export function chipKeyTarget(key, index, length) {
  if (!length) return null
  if (key === 'ArrowRight') return (index + 1) % length
  if (key === 'ArrowLeft') return (index - 1 + length) % length
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  return null
}

export function sparkline(values, width, height) {
  const points = (values || []).map((value, index) => ({ index, value })).filter((point) => isNumber(point.value))
  if (points.length < 2) return null
  const numbers = points.map((point) => point.value)
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  const span = max - min || 1
  const steps = Math.max(1, values.length - 1)
  const scaled = points.map((point) => {
    const x = (point.index / steps) * width
    const y = height - ((point.value - min) / span) * (height - 2) - 1
    return `${Number(x.toFixed(1))},${Number(y.toFixed(1))}`
  })
  return { points: scaled.join(' '), min, max, count: points.length }
}

export function thresholdText(metric) {
  const parts = []
  if (isNumber(metric?.warn)) parts.push(`warn at ${formatValue(metric.warn, metric.unit)}`)
  if (isNumber(metric?.critical)) parts.push(`critical at ${formatValue(metric.critical, metric.unit)}`)
  return parts.join(', ')
}

export function traceModel(payload) {
  const trace = payload?.sentinel?.trace || null
  return {
    payload: payload || null,
    active: Boolean(trace),
    id: trace?.id ? String(trace.id) : '',
    name: trace ? String(trace.name || trace.id || 'trace') : '',
    startedAt: trace?.started_at || null,
    note: trace?.note || '',
    tags: Array.isArray(trace?.tags) ? trace.tags.map(String) : [],
    facts: factRows(payload?.sentinel?.summary)
  }
}

function parseTags(text) {
  return String(text || '').split(',').map((tag) => tag.trim()).filter(Boolean)
}

/** The same rules the API applies, checked here so a bad name never reaches the board. */
export function validateTrace({ name, note, tags }) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return { error: 'Name the trace so you can find its run later.' }
  if (trimmed.length > NAME_LIMIT) return { error: `The name can be at most ${NAME_LIMIT} characters.` }
  if (trimmed.includes(',')) return { error: 'The name cannot contain a comma; runs are compared by a comma-separated list of names.' }
  const text = String(note || '').trim()
  if (text.length > NOTE_LIMIT) return { error: `The note can be at most ${NOTE_LIMIT} characters.` }
  const list = parseTags(tags)
  if (list.length > MAX_TAGS) return { error: `At most ${MAX_TAGS} tags can be attached to a trace.` }
  const body = { name: trimmed }
  if (text) body.note = text
  if (list.length) body.tags = list
  return { body }
}

export function traceExtrasSummary(form) {
  const parts = []
  if (String(form?.note || '').trim()) parts.push('a note')
  const tags = parseTags(form?.tags)
  if (tags.length) parts.push(countLabel(tags.length, 'tag'))
  return parts.length ? `${parts.join(' and ')} will be saved with this trace` : ''
}

/** Start stays disabled until the active trace was read, so the start is bound to that board generation. */
export function traceBar(trace, { busy = false } = {}) {
  if (!trace?.active) {
    return { recording: false, disabled: busy || !trace?.payload, submitLabel: busy ? 'Starting…' : 'Start trace' }
  }
  return { recording: true, disabled: busy || !trace.id, stopLabel: busy ? 'Stopping…' : 'Stop trace' }
}

export function runList(payload) {
  const runs = payload?.sentinel?.runs
  if (!Array.isArray(runs)) return []
  return runs
    .filter((run) => run && (run.id || run.name))
    .map((run) => ({
      // The stable id, since another run's name may equal it and Sentinel resolves ids first.
      ref: String(run.id || run.name),
      label: String(run.name || run.id),
      state: String(run.state || ''),
      startedAt: run.started_at || null,
      durationSec: isNumber(run.duration_ms) ? run.duration_ms / 1000 : null,
      energyJoules: isNumber(run.energy_joules) ? run.energy_joules : null,
      samples: isNumber(run.samples) ? run.samples : null,
      note: run.note || '',
      tags: Array.isArray(run.tags) ? run.tags.map(String) : []
    }))
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

function factRows(value, prefix = '', depth = 0, rows = []) {
  if (value === null || value === undefined) return rows
  if (Array.isArray(value)) {
    if (value.length) rows.push([titleCase(prefix), value.map((item) => (item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item))).join(', ')])
  } else if (typeof value === 'object') {
    if (depth <= 2) for (const [key, item] of Object.entries(value)) factRows(item, prefix ? `${prefix}.${key}` : key, depth + 1, rows)
  } else {
    rows.push([titleCase(prefix) || 'Value', typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value)])
  }
  return rows
}

// Cells carry the mean, the statistic Sentinel's baseline_deltas_pct describes.
const RUN_SCALARS = [
  { key: 'duration_ms', label: 'Duration', unit: 's', scale: 0.001 },
  { key: 'energy_joules', label: 'Energy', unit: 'J', scale: 1 },
  { key: 'samples', label: 'Samples', unit: null, scale: 1 }
]

export const DELTA_ABSENCE = {
  not_published: 'Sentinel publishes no change for it.',
  no_baseline: 'the baseline run has no value for that metric.',
  baseline_zero: 'the baseline measured 0, and there is no percentage change from 0.',
  no_value: 'this run has no value for that metric.'
}

function compareCell(column, value, delta, baselineValue, published = true) {
  const has = isNumber(value)
  const deltaPct = column.baseline || !has || !isNumber(delta) ? null : delta
  let deltaAbsence = null
  if (!column.baseline && deltaPct === null) {
    if (!has) deltaAbsence = 'no_value'
    else if (published && !isNumber(baselineValue)) deltaAbsence = 'no_baseline'
    else if (published && baselineValue === 0) deltaAbsence = 'baseline_zero'
    else deltaAbsence = 'not_published'
  }
  return { column: column.key, baseline: column.baseline, value: has ? value : null, deltaPct, deltaAbsence }
}

export function compareTable(payload, definitions = new Map()) {
  const body = payload?.sentinel
  const summaries = body?.summaries
  if (!Array.isArray(body?.runs) || !summaries || typeof summaries !== 'object') return null
  const columns = body.runs.map((entry, index) => {
    // With raw=1 each run is { metadata, metrics, samples }.
    const run = entry?.metadata || entry
    const id = String(run?.id ?? index)
    return { key: id, label: String(run?.name || run?.id || `Run ${index + 1}`), note: String(run?.note || ''), baseline: id === String(body.baseline_id) }
  })
  const baselineColumn = columns.find((column) => column.baseline) || columns[0]
  const deltas = body.baseline_deltas_pct || {}

  const scalarRows = RUN_SCALARS.filter((spec) => columns.some((column) => isNumber(summaries[column.key]?.[spec.key]))).map((spec) => {
    const valueOf = (column) => {
      const raw = summaries[column.key]?.[spec.key]
      return isNumber(raw) ? raw * spec.scale : null
    }
    return {
      key: spec.key,
      kind: 'run',
      label: spec.label,
      unit: spec.unit,
      group: null,
      cells: columns.map((column) => compareCell(column, valueOf(column), null, valueOf(baselineColumn), false))
    }
  })

  const keys = [...new Set(columns.flatMap((column) => Object.keys(summaries[column.key]?.metrics || {})))].sort()
  const metricRows = keys.map((key) => {
    const definition = definitions.get(key)
    const meanOf = (column) => summaries[column.key]?.metrics?.[key]?.mean
    return {
      key,
      kind: 'metric',
      label: definition?.label || titleCase(key),
      unit: definition?.unit || null,
      group: definition?.group || null,
      cells: columns.map((column) => compareCell(column, meanOf(column), deltas[column.key]?.[key], meanOf(baselineColumn)))
    }
  })

  const rows = [...scalarRows, ...metricRows].filter((row) => row.cells.some((cell) => cell.value !== null))
  if (!rows.length) return null
  return { columns, rows, baselineLabel: baselineColumn?.label || '' }
}

export const ALL_GROUPS = 'All'
const RUN_TOTALS = 'Run totals'

function compareRowGroup(row) {
  return row.kind === 'run' ? RUN_TOTALS : row.group || OTHER_GROUP
}

function rowChanged(row) {
  const base = row.cells.find((cell) => cell.baseline) || row.cells[0]
  return row.cells.some((cell) => {
    if (cell === base) return false
    if (isNumber(cell.deltaPct)) return cell.deltaPct !== 0
    return isNumber(cell.value) && isNumber(base.value) && cell.value !== base.value
  })
}

export function compareView(table, { group = ALL_GROUPS, changesOnly = false } = {}) {
  const all = table?.rows || []
  const counts = new Map()
  for (const row of all) counts.set(compareRowGroup(row), (counts.get(compareRowGroup(row)) || 0) + 1)
  const rank = (name) => (name === RUN_TOTALS ? 0 : name === OTHER_GROUP ? 2 : 1)
  const groups = [
    { id: ALL_GROUPS, label: ALL_GROUPS, count: all.length },
    ...[...counts.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((name) => ({ id: name, label: name, count: counts.get(name) }))
  ]
  const active = counts.has(group) ? group : ALL_GROUPS
  const inGroup = active === ALL_GROUPS ? all : all.filter((row) => compareRowGroup(row) === active)
  const rows = changesOnly ? inGroup.filter(rowChanged) : inGroup
  const text = []
  if (rows.length < all.length) text.push(`Showing ${rows.length} of ${all.length} rows; Export CSV still writes all of them.`)
  if (changesOnly && inGroup.length > rows.length) text.push(`Changes only hides ${countLabel(inGroup.length - rows.length, 'row')} where no run differs from the baseline.`)
  return { groups, group: active, rows, text: text.join(' ') }
}

/** One CSV field; text a spreadsheet would run as a formula is prefixed with an apostrophe. */
function csvField(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text
}

function csv(lines) {
  return lines.map((line) => line.map(csvField).join(',')).join('\r\n') + '\r\n'
}

export function compareCsv(table) {
  const header = ['metric_key', 'label', 'group', 'unit']
  for (const column of table.columns) {
    const marks = [column.baseline ? 'baseline' : '', column.note].filter(Boolean)
    const name = marks.length ? `${column.label} (${marks.join('; ')})` : column.label
    header.push(`${name} mean`, `${name} change vs baseline (%)`)
  }
  const rows = table.rows.map((row) => [row.key, row.label, compareRowGroup(row), unitSuffix(row.unit), ...row.cells.flatMap((cell) => [cell.value, cell.deltaPct])])
  return csv([header, ...rows])
}

export function sessionCsv(model) {
  const header = ['timestamp', ...model.metrics.map((metric) => (unitSuffix(metric.unit) ? `${metric.label} (${unitSuffix(metric.unit)})` : metric.label))]
  return csv([header, ...model.timestamps.map((stamp, index) => [stamp, ...model.metrics.map((metric) => model.series[metric.key]?.[index] ?? null)])])
}

function localDay(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function sessionCsvFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `sentinel-session-${localDay(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.csv`
}

/** `sentinel-compare-<baseline>-<YYYY-MM-DD>.csv`; the run name is reduced to filename-safe characters. */
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

/** One saved run, ranked and labelled with the definitions it recorded, not today's. */
export function runDetail(payload) {
  const body = payload?.sentinel || {}
  const samples = Array.isArray(body.samples) ? body.samples : []
  const stamps = samples.map((sample) => sample?.timestamp).filter((stamp) => typeof stamp === 'string')
  const metrics = (Array.isArray(body.metrics) ? body.metrics : []).filter((metric) => metric?.key).map((definition) => {
    let count = 0
    let sum = 0
    let minimum = null
    let maximum = null
    for (const sample of samples) {
      const value = sample?.values?.[definition.key]
      if (!isNumber(value)) continue
      count += 1
      sum += value
      minimum = minimum === null ? value : Math.min(minimum, value)
      maximum = maximum === null ? value : Math.max(maximum, value)
    }
    return {
      key: definition.key,
      label: definition.label || titleCase(definition.key),
      description: definition.description || null,
      group: definition.group || OTHER_GROUP,
      unit: definition.unit || null,
      minimum,
      maximum,
      mean: count ? sum / count : null,
      status: statusOf(maximum, definition.warn, definition.critical)
    }
  })
  metrics.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
  return {
    facts: factRows(body.metadata),
    metrics,
    sampleCount: samples.length,
    range: stamps.length ? formatTimeRange(stamps[0], stamps[stamps.length - 1]) : '',
    crossed: metrics.filter((metric) => metric.status === 'warn' || metric.status === 'critical').length
  }
}

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB']

function formatBytes(value) {
  if (!isNumber(value) || value < 0) return ''
  let size = value
  let unit = 0
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${formatNumber(size)} ${BYTE_UNITS[unit]}`
}

function usageRow(key, label, usage, extra = '') {
  const percent = isNumber(usage?.percent) ? Math.max(0, Math.min(100, usage.percent)) : null
  const used = formatBytes(usage?.used)
  const total = formatBytes(usage?.total)
  const detail = [used && total ? `${used} of ${total}` : '', extra].filter(Boolean).join(' · ')
  return { key, label, percent, value: percent, unit: '%', detail }
}

export function hostMetricsModel(payload) {
  const remote = Boolean(payload?.REMOTE)
  const rows = [
    usageRow('cpu_load', 'CPU load', { percent: payload?.cpu_load }),
    usageRow('memory', 'Memory', payload?.memory),
    usageRow('disk', 'Disk', payload?.disk, payload?.disk?.mount)
  ]
  const temperature = payload?.temperature_celsius_avg
  if (isNumber(temperature) && !(remote && temperature === 0)) {
    rows.push({ key: 'temperature', label: 'Temperature', percent: null, value: temperature, unit: 'C', detail: '' })
  }
  let notice = ''
  if (remote && rows[0].value === null && rows[1].value === null) {
    notice = 'A remote DevKit is configured for this endpoint but is not connected, so it reports nothing.'
  } else if (rows.every((row) => row.value === null)) {
    notice = payload ? 'Insight answered with no CPU, memory or disk reading for this machine.' : 'Reading this machine…'
  }
  return {
    sourceLabel: remote ? 'Remote DevKit from the legacy REMOTE_DEVKIT configuration' : 'The machine Insight runs on',
    notice,
    rows
  }
}
