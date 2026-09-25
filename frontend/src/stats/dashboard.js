/**
 * The arithmetic behind the Sentinel dashboard: tabs, chart scales, derived series and SVG
 * paths. It mirrors what Sentinel's own terminal `ops` view charts (fixed scales, an eight-
 * minute window of the daemon's 240 cached samples) and holds no React, so it can be tested.
 */
import { isThermalMetric } from './model.js'

export const DASH_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'thermal', label: 'Thermal' },
  { id: 'power', label: 'Power' },
  { id: 'system', label: 'System' },
  { id: 'storage', label: 'Storage/Net' },
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

/**
 * The fixed scale a chart draws on. Percentages are 0-100 and temperatures 40-90 (widened
 * when a reading leaves that band); anything else runs from 0 to a round number above the
 * largest value seen, so the line never touches the top and the axis stays still between polls.
 */
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

export function lastNumber(values) {
  for (let index = (values || []).length - 1; index >= 0; index -= 1) {
    if (isNumber(values[index])) return values[index]
  }
  return null
}

function round(value) {
  return Number(value.toFixed(2))
}

function yOf(value, scale, height) {
  const span = scale.max - scale.min || 1
  const clamped = Math.min(scale.max, Math.max(scale.min, value))
  return height - ((clamped - scale.min) / span) * height
}

/**
 * The SVG line and filled area for one series on a fixed scale. A missing sample breaks the
 * line and the area instead of being drawn as zero; `last` is where the newest reading sits.
 */
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

/**
 * Stacked areas, bottom band first: each series is drawn on top of the ones before it, so the
 * top edge is the total. A missing reading counts as zero inside the stack.
 */
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

function duration(total) {
  const whole = Math.max(0, Math.round(total))
  if (whole < 60) return `${whole}s`
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return rest && minutes < 10 ? `${minutes}m ${rest}s` : `${minutes}m`
}

/** How far back the oldest sample is, from the newest one: "7m ago". Board time only, no host clock. */
export function spanLabel(timestamps) {
  const first = seconds(timestamps?.[0])
  const last = seconds(timestamps?.[timestamps.length - 1])
  if (first === null || last === null || last <= first) return ''
  const span = last - first
  // Whole minutes, as the terminal's axis reads: 7m 58s of samples is "7m ago".
  return span < 60 ? `${Math.round(span)}s ago` : `${Math.floor(span / 60)}m ago`
}

/** How long before the newest sample a given one was taken: "1m 20s ago", or "now". */
export function agoLabel(timestamps, index) {
  const at = seconds(timestamps?.[index])
  const last = seconds(timestamps?.[timestamps.length - 1])
  if (at === null || last === null) return ''
  const gap = last - at
  return gap < 1 ? 'now' : `${duration(gap)} ago`
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

/** An axis label: few digits, no unit. */
export function axisLabel(value) {
  if (!isNumber(value)) return ''
  if (Math.abs(value) >= 1000) return `${Number((value / 1000).toFixed(1))}k`
  return String(Number(value.toFixed(value < 10 ? 1 : 0)))
}

/**
 * The series Compare Runs can overlay, as Sentinel's own Compare Runs tab offers them. Thermal
 * maximum is derived per sample from every temperature sensor the runs recorded.
 */
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

/**
 * Every compared run's samples of one series against elapsed time, as Sentinel's Compare Runs
 * overlays them, with a summary row per run. The baseline comes first. `overlap` is the time all
 * runs cover; the chart draws that window, where the runs can be compared side by side.
 */
export function compareOverlay(payload, seriesId) {
  const body = payload?.sentinel || payload || {}
  const available = compareSeriesAvailable(payload)
  const spec = available.find((entry) => entry.id === seriesId) || available[0]
  const runs = (body.runs || []).filter((run) => run?.metadata?.id && Array.isArray(run.samples) && run.samples.length)
  if (!spec || !runs.length) return null
  const defs = runs[0].metrics || []
  const thermalKeys = defs.filter(isThermalMetric).map((definition) => definition.key)
  const definition = spec.thermal ? null : defs.find((entry) => entry.key === spec.key)
  const unit = spec.thermal ? 'C' : definition?.unit ?? ''
  const baselineId = body.baseline_id

  const lines = runs.map((run) => {
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
  return { spec, available, unit, lines, overlap: overlap > 0 ? overlap : Math.max(0, ...ends), rows }
}

/**
 * A scale fitted to the readings, for comparing runs: differences of a few percent are the
 * point of a comparison, and a scale from zero would draw them as one flat line. Padded by a
 * sixth of the spread (or 5% of the value when all runs read the same) and rounded outwards.
 */
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

/**
 * One run's points in the window, as an SVG line on a fixed scale. The first point past the
 * window is kept too, so the line runs to the edge (the plot clips it) instead of stopping short.
 */
export function elapsedPath(points, window, scale, width, height) {
  const list = points || []
  const past = list.findIndex((point) => point.t > window + 1e-9)
  const inside = past < 0 ? list : list.slice(0, past + 1)
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
