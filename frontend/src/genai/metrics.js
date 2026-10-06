// Speed figures shown under a reply, like the standalone Studio's metrics:
// how fast speech was heard, how fast the model answered, and how fast the
// answer was spoken. Times are measured in the browser, so they include the
// hop through Insight that the user also waits for.

export function formatSeconds(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

function positive(value) {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
}

// The board's figures from one chat stream event: GenAI Studio puts `tps` and
// `generated_tokens` on its last chunk; OpenAI-style servers send `usage`.
export function chatStreamStats(data) {
  try {
    const parsed = JSON.parse(data)
    const tokens = positive(parsed.generated_tokens) ?? positive(parsed.usage && parsed.usage.completion_tokens)
    const tps = positive(parsed.tps)
    return tokens || tps ? { tokens, tps } : null
  } catch {
    return null
  }
}

// t0: send; tFirst: first text (thinking included); tEnd: last text.
// stats: {tokens, tps} reported by the board, or null.
// Returns [{label, value, title}]; figures that weren't measured are left out
// rather than estimated.
export function replyMetrics({ t0, tFirst, tEnd, stats = null }) {
  if (typeof t0 !== 'number' || typeof tFirst !== 'number') return []
  const out = [
    { label: 'First token', value: formatSeconds(tFirst - t0), title: 'Time to first token: from sending to the first text of the reply' }
  ]
  const tokens = stats && stats.tokens
  let tps = stats && stats.tps
  if (!tps && tokens && typeof tEnd === 'number' && tEnd > tFirst) tps = tokens / ((tEnd - tFirst) / 1000)
  if (tps) out.push({ label: 'Speed', value: `${tps.toFixed(1)} tokens/s`, title: 'Tokens per second while the reply was written' })
  if (tokens) out.push({ label: 'Tokens', value: String(tokens), title: 'Tokens in the reply, as counted by the board' })
  if (typeof tEnd === 'number' && tEnd >= t0) out.push({ label: 'Total', value: formatSeconds(tEnd - t0), title: 'From sending to the end of the reply' })
  return out.filter((m) => m.value)
}

// t0: when the reply was sent (Read replies aloud) or Read aloud was clicked;
// tAudio: when sound started; rtf and engine from the board's X-RTF / X-Engine.
export function speechMetrics({ t0, tAudio, rtf = null, engine = null }) {
  if (typeof t0 !== 'number' || typeof tAudio !== 'number') return []
  const out = [{ label: 'First audio', value: formatSeconds(tAudio - t0), title: 'Time to first audio: until the reply started playing' }]
  const factor = positive(rtf)
  if (factor) {
    out.push({
      label: 'RTF',
      value: factor.toFixed(2),
      title: 'Real-time factor: seconds of compute per second of speech. Below 1 is faster than real time.'
    })
  }
  if (engine) out.push({ label: 'Voice', value: engine, title: 'The speech engine that read it' })
  return out.filter((m) => m.value)
}

// ms: from the end of the recording to the text; language from the board.
export function heardMetrics({ ms, language = null }) {
  const out = []
  const value = formatSeconds(ms)
  if (value) out.push({ label: 'Transcribed', value, title: 'From the end of your recording to the text' })
  if (language) out.push({ label: 'Language', value: language, title: 'The language the speech model heard' })
  return out
}
