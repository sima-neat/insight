// The benchmark panel's logic: the board's /benchmark/run, /status and /stop
// (GenAI Studio's model manager) run a prompt several times on one loaded model
// and report time to first token and tokens per second; the panel runs each
// chosen model in turn and compares them. Kept free of React and DOM so
// `node --test` covers it.

import { friendlyModelName } from './backendState.js'

export const BENCH_LIMITS = {
  runs: { min: 1, max: 50, default: 5 },
  maxTokens: { min: 8, max: 2048, default: 128 }
}

export function clampSetting(value, { min, max, default: fallback }) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

// What a first run tests with no changes: the first loaded chat model, or the
// first one that can run here, which the run then loads (it asks first).
export function defaultChoice(models, loaded) {
  const usable = (models || []).filter((m) => m.supported !== false)
  const first = usable.find((m) => loaded.has(m.name)) || usable[0]
  return first ? [first.name] : []
}

// Whether the board offers the benchmark, from /health's `features`
// (GenAI Studio reports {benchmark: true} when it does).
export function benchmarkSupport(health) {
  const features = health && health.httpStatus === 200 && health.body && health.body.features
  if (features && features.benchmark === true) return { available: true, reason: '' }
  return { available: false, reason: "This board's GenAI Studio doesn't offer the benchmark. Update Apps on the board." }
}

// The request body for POST /benchmark/run.
export function benchmarkRequest({ model, runs, maxTokens, prompt }) {
  return {
    model,
    num_samples: clampSetting(runs, BENCH_LIMITS.runs),
    max_new_tokens: clampSetting(maxTokens, BENCH_LIMITS.maxTokens),
    prompt: String(prompt || '').trim()
  }
}

export function formatNumber(n, digits = 1) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function runCount(runs) {
  return clampSetting(runs, BENCH_LIMITS.runs)
}

export function runsText(n) {
  return n === 1 ? '1 run' : `${n} runs`
}

// The advanced options at a glance: what a run will send, after clamping.
export function settingsText({ runs, maxTokens, prompt }) {
  const tokens = clampSetting(maxTokens, BENCH_LIMITS.maxTokens)
  return `${runsText(runCount(runs))} · ${tokens} tokens · ${String(prompt || '').trim() ? 'your prompt' : 'standard prompt'}`
}

// Whether a result is good, as rules of thumb for chat: a reply that starts
// within 1 second feels instant, and people read about 4 words (5 tokens) a
// second. For display only; the measurements and exports don't use them.
const INSTANT_MS = 1000
const SHORT_PAUSE_MS = 3000
const READING_TPS = 5

export function firstWordVerdict(ms) {
  if (ms < INSTANT_MS) return { label: 'Feels instant', tone: 'ok' }
  if (ms <= SHORT_PAUSE_MS) return { label: 'A short pause', tone: '' }
  return { label: 'A noticeable wait', tone: 'warn' }
}

export function speedVerdict(tps) {
  if (tps >= READING_TPS + 1) return { label: 'Faster than you can read', tone: 'ok' }
  if (tps >= READING_TPS - 1) return { label: 'About reading speed', tone: '' }
  return { label: 'Slower than you can read', tone: 'warn' }
}

export function wordsPerSecondText(tps) {
  const words = Math.round(tps * 0.75)
  if (words < 1) return 'Less than 1 word a second.'
  return words === 1 ? 'About 1 word a second.' : `About ${words} words a second.`
}

// Progress line for one model's run, from /benchmark/status.
export function benchProgress(status) {
  if (!status) return { pct: null, text: '' }
  const total = status.total || 0
  const done = status.done || 0
  const pct = total ? Math.round((done / total) * 100) : null
  const current = status.current
  let text = total ? `Run ${Math.min(done + 1, total)} of ${total}` : ''
  if (!status.running) text = total ? `${done} of ${total} runs done` : ''
  else if (current && current.tokens) {
    const tps = typeof current.tps === 'number' ? ` · ${formatNumber(current.tps)} tokens/s` : ''
    text += ` · ${current.tokens} tokens${tps}`
  }
  return { pct, text }
}

// One row per model for the comparison table; the fastest values are marked.
// entries: [{model, summary, runs, failed}] in the order they ran.
export function comparisonRows(entries) {
  const done = (entries || []).filter((e) => e.summary)
  const bestTps = done.length ? Math.max(...done.map((e) => e.summary.tps.mean)) : null
  const bestTtft = done.length ? Math.min(...done.map((e) => e.summary.ttftMs.mean)) : null
  return (entries || []).map((e) => {
    const s = e.summary
    if (!s) return { model: e.model, failed: e.failed || 'no valid result' }
    return {
      model: e.model,
      tpsMean: s.tps.mean,
      tpsP90: s.tps.p90,
      tpsStdev: s.tps.stdev,
      ttftMean: s.ttftMs.mean,
      tokensMean: s.tokens.mean,
      runs: s.count,
      errors: s.errors,
      bestTps: s.tps.mean === bestTps,
      bestTtft: s.ttftMs.mean === bestTtft
    }
  })
}

// The results in a sentence. rows: comparisonRows().
export function resultsSummary(rows) {
  const measured = (rows || []).filter((r) => !r.failed)
  if (!measured.length) return ''
  const counts = new Set(measured.map((r) => r.runs))
  const [count] = counts
  const average = counts.size > 1 ? "Each number is the average of that model's runs."
    : count === 1 ? 'Each number comes from 1 run.' : `Each number is the average of ${count} runs.`
  const fastest = measured.filter((r) => r.bestTps)
  const quickest = measured.filter((r) => r.bestTtft)
  if (measured.length < 2 || fastest.length !== 1 || quickest.length !== 1) return average
  const [fast, quick] = [friendlyModelName(fastest[0].model), friendlyModelName(quickest[0].model)]
  if (fastest[0] === quickest[0]) return `${fast} was the fastest on both numbers. ${average}`
  return `${quick} started replying first and ${fast} replied fastest. ${average}`
}

// The tag on a model's card when there is more than one to compare.
export function resultBadge(row, measured) {
  if (measured < 2) return ''
  if (row.bestTps && row.bestTtft) return 'Fastest'
  if (row.bestTps) return 'Fastest replies'
  return row.bestTtft ? 'Starts first' : ''
}

const CSV_COLUMNS = ['model', 'tpsMean', 'tpsMedian', 'tpsMin', 'tpsMax', 'tpsP90', 'tpsStdev',
  'ttftMeanMs', 'ttftP90Ms', 'tokensMean', 'validRuns', 'errors']

// The standalone Studio's CSV export: one line per model with a result.
export function benchmarkCsv(entries) {
  const rows = (entries || []).filter((e) => e.summary).map(({ model, summary: s }) => ({
    model,
    tpsMean: s.tps.mean, tpsMedian: s.tps.median, tpsMin: s.tps.min, tpsMax: s.tps.max,
    tpsP90: s.tps.p90, tpsStdev: s.tps.stdev,
    ttftMeanMs: s.ttftMs.mean, ttftP90Ms: s.ttftMs.p90,
    tokensMean: s.tokens.mean, validRuns: s.count, errors: s.errors
  }))
  if (!rows.length) return null
  const cell = (v) => {
    const text = String(v == null ? '' : v)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(','))].join('\n')
}

// The standalone Studio's JSON export: the settings and every run.
export function benchmarkJson(entries, { runs, maxTokens, prompt }, now = new Date()) {
  if (!(entries || []).some((e) => e.summary)) return null
  return JSON.stringify({
    generatedAt: now.toISOString(),
    config: {
      runs: clampSetting(runs, BENCH_LIMITS.runs),
      maxNewTokens: clampSetting(maxTokens, BENCH_LIMITS.maxTokens),
      prompt: String(prompt || '').trim() || '(default)'
    },
    // loadFailed keeps the standalone Studio's field; error says what failed.
    results: entries.map((e) => ({
      model: e.model,
      summary: e.summary || null,
      runs: e.runs || [],
      loadFailed: e.stage === 'load',
      error: e.failed || null
    }))
  }, null, 2)
}

export function benchmarkFilename(ext, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `neat-benchmark-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`
}
