// The benchmark panel's logic: the board's /benchmark/run, /status and /stop
// (GenAI Studio's model manager) run a prompt several times on one loaded model
// and report time to first token and tokens per second; the panel runs each
// chosen model in turn and compares them. Kept free of React and DOM so
// `node --test` covers it.

export const BENCH_LIMITS = {
  runs: { min: 1, max: 50, default: 5 },
  maxTokens: { min: 8, max: 2048, default: 128 }
}

export function clampSetting(value, { min, max, default: fallback }) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
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
    results: entries.map((e) => ({ model: e.model, summary: e.summary || null, runs: e.runs || [], loadFailed: Boolean(e.failed) }))
  }, null, 2)
}

export function benchmarkFilename(ext, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `neat-benchmark-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`
}
