import { isThermalMetric, statusOf, unitSuffix } from './model.js'

const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

export function completeTotal(values) {
  return values.length && values.every(isNumber) ? values.reduce((sum, value) => sum + value, 0) : null
}

function plural(count, unit) {
  return `${count} ${unit}${count === 1 ? '' : 's'}`
}

function durationWords(totalSeconds, { precise = false } = {}) {
  const total = Math.max(0, Math.round(Number(totalSeconds) || 0))
  if (total < 60) return plural(total, 'second')
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return precise && total % 60 ? `${plural(minutes, 'minute')} ${plural(total % 60, 'second')}` : plural(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${plural(hours, 'hour')} ${plural(minutes % 60, 'minute')}` : plural(hours, 'hour')
  return plural(Math.floor(hours / 24), 'day')
}

export function niceCeil(value) {
  if (!isNumber(value) || value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const step = NICE_STEPS.find((candidate) => candidate * power >= value - power * 1e-9)
  return Number((step * power).toPrecision(6))
}

export function scaleFor(unit, valueLists, ceiling = null) {
  const values = valueLists.flat().filter(isNumber)
  const key = String(unit ?? '').trim().toLowerCase()
  if (key === '%') return { min: 0, max: 100 }
  if (key === 'c' || key === '°c') {
    const low = Math.min(40, ...values.map((value) => Math.floor(value / 10) * 10))
    const high = Math.max(90, ...values.map((value) => Math.ceil(value / 10) * 10))
    return { min: low, max: high }
  }
  if (isNumber(ceiling) && ceiling > 0) return { min: 0, max: ceiling }
  return { min: 0, max: niceCeil((values.length ? Math.max(...values) : 0) * 1.1) }
}

export function thermalMaxSeries(model) {
  const lists = model.metrics.filter(isThermalMetric).map((metric) => model.series[metric.key] || [])
  const length = Math.max(0, ...lists.map((list) => list.length))
  return Array.from({ length }, (_, index) => {
    const values = lists.map((list) => list[index]).filter(isNumber)
    return values.length ? Math.max(...values) : null
  })
}

export function lastNumber(values) {
  const value = values?.[values.length - 1]
  return isNumber(value) ? value : null
}

function round(value) {
  return Number(value.toFixed(2))
}

function yOf(value, scale, height) {
  const span = scale.max - scale.min || 1
  const clamped = Math.min(scale.max, Math.max(scale.min, value))
  return height - ((clamped - scale.min) / span) * height
}

/** A missing sample breaks the line and the area instead of being drawn as zero. */
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
  const line = segments.map((points) => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')).join(' ')
  const area = segments
    .filter((points) => points.length > 1)
    .map((points) => `M${points[0][0]} ${height} ${points.map(([x, y]) => `L${x} ${y}`).join(' ')} L${points[points.length - 1][0]} ${height} Z`)
    .join(' ')
  const tail = segments.length ? segments[segments.length - 1] : null
  const lastPoint = tail && tail[tail.length - 1][0] === round(((list.length - 1) / steps) * width) ? tail[tail.length - 1] : null
  return { line, area, last: lastPoint ? { x: lastPoint[0], y: lastPoint[1] } : null }
}

export function stackTotals(lists) {
  const length = Math.max(0, ...lists.map((list) => list.length))
  return Array.from({ length }, (_, index) => lists.reduce((sum, list) => sum + (isNumber(list[index]) ? list[index] : 0), 0))
}

export function stackedPaths(lists, scale, width, height) {
  const length = Math.max(0, ...lists.map((list) => list.length))
  const steps = Math.max(1, length - 1)
  const base = new Array(length).fill(0)
  const x = (index) => round((index / steps) * width)
  return lists.map((list) => {
    const lower = base.slice()
    for (let index = 0; index < length; index += 1) base[index] += isNumber(list[index]) ? list[index] : 0
    if (!length) return ''
    const top = base.map((value, index) => `${index ? 'L' : 'M'}${x(index)} ${round(yOf(value, scale, height))}`).join(' ')
    const bottom = lower.map((value, index) => `L${x(index)} ${round(yOf(value, scale, height))}`).reverse().join(' ')
    return `${top} ${bottom} Z`
  })
}

function seconds(timestamp) {
  const time = Date.parse(timestamp || '')
  return Number.isFinite(time) ? time / 1000 : null
}

export function spanLabel(timestamps) {
  const first = seconds(timestamps?.[0])
  const last = seconds(timestamps?.[timestamps.length - 1])
  if (first === null || last === null || last <= first) return ''
  return `${durationWords(last - first)} ago`
}

export function agoLabel(timestamps, index) {
  const at = seconds(timestamps?.[index])
  const last = seconds(timestamps?.[timestamps.length - 1])
  if (at === null || last === null) return ''
  return last - at < 1 ? 'Now' : `${durationWords(last - at, { precise: true })} ago`
}

export function indexAt(fraction, length) {
  if (!length) return -1
  return Math.min(length - 1, Math.max(0, Math.round(fraction * (length - 1))))
}

export function thresholdLines(metric) {
  const lines = []
  if (isNumber(metric?.warn)) lines.push({ value: metric.warn, tone: 'warn' })
  if (isNumber(metric?.critical)) lines.push({ value: metric.critical, tone: 'critical' })
  return lines
}

export function axisLabel(value) {
  if (!isNumber(value)) return ''
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString('en-US')
  return String(Number(value.toFixed(value < 10 ? 1 : 0)))
}

export function unitAfter(unit) {
  const suffix = unitSuffix(unit)
  if (!suffix) return ''
  return suffix === '%' ? '%' : ` ${suffix}`
}

export function fixedValue(value, unit, digits) {
  return isNumber(value) ? `${value.toFixed(digits)}${unitAfter(unit)}` : '—'
}

function mean(values) {
  const numbers = values.filter(isNumber)
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null
}

function columnMeans(values, columns = 48) {
  if (values.length <= columns) return values.map((value) => (isNumber(value) ? value : null))
  const size = values.length / columns
  return Array.from({ length: columns }, (_, column) => mean(values.slice(Math.floor(column * size), Math.floor((column + 1) * size))))
}

export function loadColor(percent) {
  if (!isNumber(percent)) return 'var(--surface-soft)'
  const p = Math.min(100, Math.max(0, percent)) / 100
  const mix = (from, to) => Math.round(from + (to - from) * p)
  return `rgb(${mix(236, 12)} ${mix(243, 64)} ${mix(250, 140)})`
}

export function coreSummary(cores, series) {
  const rows = cores.map((core) => {
    const values = series[core.key] || []
    const recent = mean(values.slice(-30))
    return { key: core.key, name: core.short || core.label, label: core.label, cells: columnMeans(values), recent, tone: statusOf(recent, core.warn, core.critical) }
  })
  const reporting = rows.filter((row) => isNumber(row.recent))
  const busiest = reporting.reduce((top, row) => (!top || row.recent > top.recent ? row : top), null)
  const average = reporting.length ? reporting.reduce((sum, row) => sum + row.recent, 0) / reporting.length : null
  return { rows, average, busiest }
}

const COMPARE_SERIES = [
  { id: 'power', label: 'Total power', key: 'power_current_watts' },
  { id: 'thermal', label: 'Thermal maximum', thermal: true },
  { id: 'cpu', label: 'CPU utilization', key: 'cpu_usage_pct' },
  { id: 'load', label: 'CPU load', key: 'cpu_load_1' },
  { id: 'ram', label: 'RAM used', key: 'linux_mem_used_mb' },
  { id: 'mla', label: 'MLA memory', key: 'mla_mem_allocated_mb' },
  { id: 'cma', label: 'EV74 CMA', key: 'ev74_cma_used_mb' }
]

function stats(values) {
  const sorted = values.filter(isNumber).sort((a, b) => a - b)
  if (!sorted.length) return { count: 0, minimum: null, mean: null, median: null, p95: null, maximum: null }
  const middle = Math.floor(sorted.length / 2)
  return {
    count: sorted.length,
    minimum: sorted[0],
    mean: mean(sorted),
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)],
    maximum: sorted[sorted.length - 1]
  }
}

export function compareOverlay(payload, seriesId) {
  const body = payload?.sentinel || {}
  const runs = (body.runs || []).filter((run) => run?.metadata?.id && Array.isArray(run.samples) && run.samples.length)
  const definitions = runs.flatMap((run) => run.metrics || [])
  const available = COMPARE_SERIES.filter((spec) => (spec.thermal ? definitions.some(isThermalMetric) : definitions.some((d) => d.key === spec.key)))
  const spec = available.find((entry) => entry.id === seriesId) || available[0]
  if (!spec) return null
  const unit = spec.thermal ? 'C' : definitions.find((entry) => entry.key === spec.key)?.unit ?? ''

  const lines = runs.map((run) => {
    const thermalKeys = (run.metrics || []).filter(isThermalMetric).map((definition) => definition.key)
    const start = seconds(run.samples[0].timestamp)
    const points = run.samples.map((sample) => {
      const values = sample?.values || {}
      const temperatures = thermalKeys.map((key) => values[key]).filter(isNumber)
      const value = spec.thermal ? (temperatures.length ? Math.max(...temperatures) : null) : values[spec.key]
      const at = seconds(sample?.timestamp)
      return { t: start === null || at === null ? null : at - start, v: isNumber(value) ? value : null }
    }).filter((point) => isNumber(point.t) && point.t >= 0)
    return { id: run.metadata.id, name: String(run.metadata.name || run.metadata.id), baseline: run.metadata.id === body.baseline_id, points }
  }).sort((a, b) => Number(b.baseline) - Number(a.baseline))

  const ends = lines.map((line) => (line.points.length ? line.points[line.points.length - 1].t : 0))
  const overlap = Math.min(...ends)
  const baselineMean = stats(lines.find((line) => line.baseline)?.points.map((point) => point.v) || []).mean
  const rows = lines.map((line) => {
    const summary = spec.thermal ? null : body.summaries?.[line.id]?.metrics?.[spec.key]
    const figures = isNumber(summary?.count) ? summary : stats(line.points.map((point) => point.v))
    let delta = spec.thermal ? null : body.baseline_deltas_pct?.[line.id]?.[spec.key]
    if (spec.thermal && isNumber(figures.mean) && isNumber(baselineMean) && baselineMean !== 0) {
      delta = ((figures.mean - baselineMean) / baselineMean) * 100
    }
    const energy = body.summaries?.[line.id]?.energy_joules
    return { ...figures, id: line.id, name: line.name, baseline: line.baseline, delta: isNumber(delta) ? delta : null, energy: isNumber(energy) ? energy : null }
  })
  return { spec, available, unit, lines, overlap: overlap > 0 ? overlap : Math.max(0, ...ends), rows }
}

export function tightScale(valueLists) {
  let low = null
  let high = null
  for (const values of valueLists) {
    for (const value of values) {
      if (!isNumber(value)) continue
      low = low === null ? value : Math.min(low, value)
      high = high === null ? value : Math.max(high, value)
    }
  }
  if (low === null) return { min: 0, max: 1 }
  const pad = (high - low) / 6 || Math.abs(high) * 0.05 || 1
  const step = 10 ** Math.floor(Math.log10(high - low + 2 * pad))
  const clean = (value) => Number(value.toPrecision(12))
  return { min: clean(Math.floor((low - pad) / step) * step), max: clean(Math.ceil((high + pad) / step) * step) }
}

export function elapsedPath(points, window, scale, width, height) {
  const past = points.findIndex((point) => point.t > window + 1e-9)
  const inside = past < 0 ? points : points.slice(0, past + 1)
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

export function valueNear(points, t) {
  let best = null
  for (const point of points) {
    if (isNumber(point.v) && (!best || Math.abs(point.t - t) < Math.abs(best.t - t))) best = point
  }
  return best
}
