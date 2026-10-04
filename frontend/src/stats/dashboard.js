/** Pure dashboard arithmetic matching Sentinel's fixed-scale, 240-sample ops view. */
import { durationWords, isThermalMetric, unitSuffix } from './model.js'

export const DASH_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'thermal', label: 'Thermal' },
  { id: 'power', label: 'Power' },
  { id: 'system', label: 'System' },
  { id: 'storage', label: 'Storage & Network' },
  { id: 'runs', label: 'Runs' }
]
export const DASH_TAB_KEY = 'neat-insight:sentinel-tab'

export function dashTabFrom(saved) {
  return DASH_TABS.some((tab) => tab.id === saved) ? saved : DASH_TABS[0].id
}

// Temperatures share one band, as Sentinel's thermal charts do, so sensors compare at a glance.
export const THERMAL_SCALE = { min: 40, max: 90 }
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The smallest "round" number (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 times a power of ten) at or above `value`. */
export function niceCeil(value) {
  if (!isNumber(value) || value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const step = NICE_STEPS.find((candidate) => candidate * power >= value - power * 1e-9)
  return Number((step * power).toPrecision(6))
}

/** Fixed percent/temperature scales; other units get a rounded ceiling above their peak. */
export function scaleFor(unit, valueLists, ceiling = null) {
  const values = valueLists.flat().filter(isNumber)
  const key = String(unit ?? '').trim().toLowerCase()
  if (key === '%') return { min: 0, max: 100 }
  if (key === 'c' || key === '°c') {
    const low = Math.min(THERMAL_SCALE.min, ...values.map((value) => Math.floor(value / 10) * 10))
    const high = Math.max(THERMAL_SCALE.max, ...values.map((value) => Math.ceil(value / 10) * 10))
    return { min: low, max: high }
  }
  if (isNumber(ceiling) && ceiling > 0) return { min: 0, max: ceiling }
  const top = values.length ? Math.max(...values) : 0
  return { min: 0, max: niceCeil(top * 1.1) }
}

export function metricByKey(model, key) {
  return (model?.metrics || []).find((metric) => metric.key === key) || null
}

export function seriesOf(model, key) {
  return model?.series?.[key] || []
}

/** A current aggregate exists only when every constituent reading is available. */
export function currentTotal(values) {
  return values.length && values.every(isNumber) ? values.reduce((sum, value) => sum + value, 0) : null
}

export function currentValue(values) {
  const value = values?.[values.length - 1]
  return isNumber(value) ? value : null
}

/** Per sample, the highest reading among the board's temperature sensors (null where none reported). */
export function thermalMaxSeries(model) {
  const lists = (model?.metrics || []).filter(isThermalMetric).map((metric) => seriesOf(model, metric.key))
  const length = Math.max(0, ...lists.map((list) => list.length))
  return Array.from({ length }, (_, index) => {
    const values = lists.map((list) => list[index]).filter(isNumber)
    return values.length ? Math.max(...values) : null
  })
}

/** Per sample, the sum of the given series; null only where none of them reported. */
export function sumSeries(model, keys) {
  const lists = keys.map((key) => seriesOf(model, key))
  const length = Math.max(0, ...lists.map((list) => list.length))
  return Array.from({ length }, (_, index) => {
    const values = lists.map((list) => list[index]).filter(isNumber)
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null
  })
}

function round(value) {
  return Number(value.toFixed(2))
}

function yOf(value, scale, height) {
  const span = scale.max - scale.min || 1
  const clamped = Math.min(scale.max, Math.max(scale.min, value))
  return height - ((clamped - scale.min) / span) * height
}

/** SVG line and area; missing samples break the path rather than becoming zero. */
export function linePath(values, scale, width, height) {
  const list = values || []
  const steps = Math.max(1, list.length - 1)
  const segments = []
  let current = []
  list.forEach((value, index) => {
    if (!isNumber(value)) {
      if (current.length) segments.push(current)
      current = []
      return
    }
    current.push([round((index / steps) * width), round(yOf(value, scale, height))])
  })
  if (current.length) segments.push(current)
  const line = segments
    .map((points) => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' '))
    .join(' ')
  const area = segments
    .filter((points) => points.length > 1)
    .map((points) => `M${points[0][0]} ${height} ${points.map(([x, y]) => `L${x} ${y}`).join(' ')} L${points[points.length - 1][0]} ${height} Z`)
    .join(' ')
  const tail = segments.length ? segments[segments.length - 1] : null
  const lastPoint = tail && tail[tail.length - 1][0] === round(((list.length - 1) / steps) * width) ? tail[tail.length - 1] : null
  return { line, area, last: lastPoint ? { x: lastPoint[0], y: lastPoint[1] } : null }
}

/** Stacked areas, bottom band first; missing readings count as zero within the stack. */
export function stackedPaths(lists, scale, width, height) {
  const length = Math.max(0, ...lists.map((list) => (list || []).length))
  const steps = Math.max(1, length - 1)
  const base = new Array(length).fill(0)
  return lists.map((list) => {
    const lower = base.slice()
    for (let index = 0; index < length; index += 1) {
      const value = (list || [])[index]
      base[index] += isNumber(value) ? value : 0
    }
    if (!length) return ''
    const x = (index) => round((index / steps) * width)
    const top = base.map((value, index) => `${index ? 'L' : 'M'}${x(index)} ${round(yOf(value, scale, height))}`).join(' ')
    const bottom = lower.map((value, index) => `L${x(index)} ${round(yOf(value, scale, height))}`).reverse().join(' ')
    return `${top} ${bottom} Z`
  })
}

/** The totals a stack reaches, for choosing its scale. */
export function stackTotals(lists) {
  const length = Math.max(0, ...lists.map((list) => (list || []).length))
  return Array.from({ length }, (_, index) =>
    lists.reduce((sum, list) => sum + (isNumber((list || [])[index]) ? list[index] : 0), 0))
}

function seconds(timestamp) {
  const time = Date.parse(timestamp || '')
  return Number.isFinite(time) ? time / 1000 : null
}

/** How far back the oldest sample is, from the newest one: "7 minutes ago". Board time only. */
export function spanLabel(timestamps) {
  const first = seconds(timestamps?.[0])
  const last = seconds(timestamps?.[timestamps.length - 1])
  if (first === null || last === null || last <= first) return ''
  return `${durationWords(last - first)} ago`
}

/** How long before the newest sample a given one was taken: "4 minutes 46 seconds ago", or "Now". */
export function agoLabel(timestamps, index) {
  const at = seconds(timestamps?.[index])
  const last = seconds(timestamps?.[timestamps.length - 1])
  if (at === null || last === null) return ''
  const gap = last - at
  return gap < 1 ? 'Now' : `${durationWords(gap, { precise: true })} ago`
}

/** The sample index under a pointer at `fraction` (0..1) of the plot's width. */
export function indexAt(fraction, length) {
  if (!length) return -1
  return Math.min(length - 1, Math.max(0, Math.round(fraction * (length - 1))))
}

/** The board's temperature sensors under Sentinel's own group names, in Sentinel's order. */
export function thermalGroups(model) {
  const groups = []
  for (const metric of (model?.metrics || []).filter(isThermalMetric)) {
    let group = groups.find((entry) => entry.name === metric.group)
    if (!group) {
      group = { name: metric.group, metrics: [] }
      groups.push(group)
    }
    group.metrics.push(metric)
  }
  return groups
}

/** Metrics whose key matches, in Sentinel's order: the per-core CPUs, the power rails. */
export function metricsMatching(model, pattern) {
  return (model?.metrics || []).filter((metric) => pattern.test(metric.key))
}

/** The warn and critical lines a chart draws, from the metric's own thresholds. */
export function thresholdLines(metric) {
  const lines = []
  if (isNumber(metric?.warn)) lines.push({ value: metric.warn, tone: 'warn' })
  if (isNumber(metric?.critical)) lines.push({ value: metric.critical, tone: 'critical' })
  return lines
}

/** An axis label: few digits, thousands separated, no unit. */
export function axisLabel(value) {
  if (!isNumber(value)) return ''
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString('en-US')
  return String(Number(value.toFixed(value < 10 ? 1 : 0)))
}

/** A unit as it follows a number: "°C", "%" with no space before it, else " W". */
export function unitAfter(unit) {
  const suffix = unitSuffix(unit)
  if (!suffix) return ''
  return suffix === '%' ? '%' : ` ${suffix}`
}

/** A value to fixed decimals with its unit, so figures in a row line up: "12.0 W", "0.56 W". */
export function fixedValue(value, unit, digits) {
  if (!isNumber(value)) return '—'
  return `${value.toFixed(digits)}${unitAfter(unit)}`
}

/** "0–100%", "40–90 °C", "0–1,000 MB": a scale as a reader says it. */
export function scaleText(scale, unit) {
  return `${axisLabel(scale.min)}–${axisLabel(scale.max)}${unitAfter(unit)}`
}

// Per-core heatmap: 48 columns over the window (10 s each at Sentinel's 2 s cadence), and a
// one-minute average beside each core, so the view changes slowly rather than every sample.
export const HEAT_COLUMNS = 48
export const RECENT_SAMPLES = 30

function mean(values) {
  const numbers = (values || []).filter(isNumber)
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null
}

/** A series split into `columns` equal slices of time, each the mean of its samples. */
export function columnMeans(values, columns = HEAT_COLUMNS) {
  const list = values || []
  if (!list.length) return []
  if (list.length <= columns) return list.map((value) => (isNumber(value) ? value : null))
  const size = list.length / columns
  return Array.from({ length: columns }, (_, column) => mean(list.slice(Math.floor(column * size), Math.floor((column + 1) * size))))
}

/** A 0-100 load as one blue: pale when idle, deep when busy. Missing reads as the empty track. */
export function loadColor(percent) {
  if (!isNumber(percent)) return 'var(--surface-soft)'
  const p = Math.min(100, Math.max(0, percent)) / 100
  const mix = (from, to) => Math.round(from + (to - from) * p)
  return `rgb(${mix(236, 12)} ${mix(243, 64)} ${mix(250, 140)})`
}

function toneOf(value, warn, critical) {
  if (!isNumber(value)) return 'unavailable'
  if (isNumber(critical) && value >= critical) return 'critical'
  if (isNumber(warn) && value >= warn) return 'warn'
  return 'ok'
}

/** Heatmap rows plus one-minute average and busiest-core summaries. */
export function coreSummary(cores, series) {
  const rows = (cores || []).map((core) => {
    const values = series?.[core.key] || []
    const recent = mean(values.slice(-RECENT_SAMPLES))
    return {
      key: core.key,
      name: core.short || core.label,
      label: core.label,
      cells: columnMeans(values),
      recent,
      tone: toneOf(recent, core.warn, core.critical)
    }
  })
  const reporting = rows.filter((row) => isNumber(row.recent))
  const busiest = reporting.reduce((top, row) => (!top || row.recent > top.recent ? row : top), null)
  const average = reporting.length ? reporting.reduce((sum, row) => sum + row.recent, 0) / reporting.length : null
  return { rows, average, busiest }
}

/** Series offered by Sentinel Compare Runs; thermal maximum is derived per sample. */
export const COMPARE_SERIES = [
  { id: 'power', label: 'Total power', key: 'power_current_watts' },
  { id: 'thermal', label: 'Thermal maximum', thermal: true },
  { id: 'cpu', label: 'CPU utilization', key: 'cpu_usage_pct' },
  { id: 'load', label: 'CPU load', key: 'cpu_load_1' },
  { id: 'ram', label: 'RAM used', key: 'linux_mem_used_mb' },
  { id: 'mla', label: 'MLA memory', key: 'mla_mem_allocated_mb' },
  { id: 'cma', label: 'EV74 CMA', key: 'ev74_cma_used_mb' }
]

function percentile(sorted, p) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

function stats(values) {
  const sorted = values.filter(isNumber).sort((a, b) => a - b)
  if (!sorted.length) return { count: 0, minimum: null, mean: null, median: null, p95: null, maximum: null }
  const middle = Math.floor(sorted.length / 2)
  return {
    count: sorted.length,
    minimum: sorted[0],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: percentile(sorted, 95),
    maximum: sorted[sorted.length - 1]
  }
}

/** The series in COMPARE_SERIES that these runs actually recorded. */
export function compareSeriesAvailable(payload) {
  const runs = (payload?.sentinel || payload || {}).runs || []
  const defs = runs[0]?.metrics || []
  const keys = new Set(defs.map((definition) => definition.key))
  return COMPARE_SERIES.filter((spec) => (spec.thermal ? defs.some(isThermalMetric) : keys.has(spec.key)))
}

/** Compared samples and summaries, baseline first, over the runs' common time window. */
export function compareOverlay(payload, seriesId) {
  const body = payload?.sentinel || payload || {}
  const available = compareSeriesAvailable(payload)
  const spec = available.find((entry) => entry.id === seriesId) || available[0]
  const runs = (body.runs || []).filter((run) => run?.metadata?.id && Array.isArray(run.samples) && run.samples.length)
  if (!spec || !runs.length) return null
  const defs = runs[0].metrics || []
  const definition = spec.thermal ? null : defs.find((entry) => entry.key === spec.key)
  const unit = spec.thermal ? 'C' : definition?.unit ?? ''
  const baselineId = body.baseline_id

  const lines = runs.map((run) => {
    // Each run's own sensors: a run recorded on another build can name its temperatures differently.
    const thermalKeys = (Array.isArray(run.metrics) ? run.metrics : defs).filter(isThermalMetric).map((entry) => entry.key)
    const start = seconds(run.samples[0].timestamp)
    const points = run.samples.map((sample) => {
      const values = sample?.values || {}
      const value = spec.thermal
        ? thermalKeys.map((key) => values[key]).filter(isNumber).reduce((max, next) => (max === null || next > max ? next : max), null)
        : values[spec.key]
      const at = seconds(sample?.timestamp)
      return { t: start === null || at === null ? null : at - start, v: isNumber(value) ? value : null }
    }).filter((point) => isNumber(point.t) && point.t >= 0)
    return { id: run.metadata.id, name: String(run.metadata.name || run.metadata.id), baseline: run.metadata.id === baselineId, points }
  }).sort((a, b) => Number(b.baseline) - Number(a.baseline))

  const ends = lines.map((line) => (line.points.length ? line.points[line.points.length - 1].t : 0))
  const overlap = Math.min(...ends)
  const baselineStats = stats(lines.find((line) => line.baseline)?.points.map((point) => point.v) || [])
  const rows = lines.map((line) => {
    const summary = spec.thermal ? null : body.summaries?.[line.id]?.metrics?.[spec.key]
    const figures = summary && isNumber(summary.count) ? summary : stats(line.points.map((point) => point.v))
    let delta = spec.thermal ? null : body.baseline_deltas_pct?.[line.id]?.[spec.key]
    if (spec.thermal && isNumber(figures.mean) && isNumber(baselineStats.mean) && baselineStats.mean !== 0) {
      delta = ((figures.mean - baselineStats.mean) / baselineStats.mean) * 100
    }
    return {
      id: line.id,
      name: line.name,
      baseline: line.baseline,
      samples: figures.count ?? line.points.length,
      minimum: figures.minimum ?? null,
      mean: figures.mean ?? null,
      median: figures.median ?? null,
      p95: figures.p95 ?? null,
      maximum: figures.maximum ?? null,
      delta: isNumber(delta) ? delta : null,
      energy: isNumber(body.summaries?.[line.id]?.energy_joules) ? body.summaries[line.id].energy_joules : null
    }
  })
  return { spec, available, unit, lines, overlap, rows }
}

/** A padded, outward-rounded comparison scale that keeps small differences visible. */
export function tightScale(valueLists) {
  const values = valueLists.flat().filter(isNumber)
  if (!values.length) return { min: 0, max: 1 }
  const low = Math.min(...values)
  const high = Math.max(...values)
  const pad = (high - low) / 6 || Math.abs(high) * 0.05 || 1
  // Round to a tenth of the padded spread's order of magnitude: 8.44-9.11 W becomes 8.4-9.2.
  const step = 10 ** Math.floor(Math.log10(high - low + 2 * pad))
  const clean = (value) => Number(value.toPrecision(12))
  return { min: clean(Math.floor((low - pad) / step) * step), max: clean(Math.ceil((high + pad) / step) * step) }
}

/** One run as an SVG line, retaining the first clipped point beyond the window. */
export function windowPoints(points, window) {
  const list = points || []
  if (window <= 0) return list.filter((point) => Math.abs(point.t) <= 1e-9)
  const past = list.findIndex((point) => point.t > window + 1e-9)
  return past < 0 ? list : list.slice(0, past + 1)
}

export function elapsedPath(points, window, scale, width, height) {
  const inside = windowPoints(points, window)
  if (window <= 0) {
    const value = inside.find((point) => isNumber(point.v))?.v
    if (!isNumber(value)) return ''
    const middle = round(width / 2)
    const y = round(yOf(value, scale, height))
    return `M${middle - 1} ${y} L${middle + 1} ${y}`
  }
  const segments = []
  let current = []
  for (const point of inside) {
    if (!isNumber(point.v)) {
      if (current.length) segments.push(current)
      current = []
      continue
    }
    current.push([round(window > 0 ? (point.t / window) * width : 0), round(yOf(point.v, scale, height))])
  }
  if (current.length) segments.push(current)
  return segments.map((segment) => segment.map(([x, y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ')).join(' ')
}

/** The reading nearest to elapsed time `t`, for the hover readout. */
export function valueNear(points, t) {
  let best = null
  for (const point of points || []) {
    if (!isNumber(point.v)) continue
    if (!best || Math.abs(point.t - t) < Math.abs(best.t - t)) best = point
  }
  return best
}
