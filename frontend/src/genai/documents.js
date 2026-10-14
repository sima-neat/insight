// Answering from the user's documents (RAG): GenAI Studio searches its RAG
// database when a chat request adds "neat_rag" (apps#572) and reports the
// passages it used in X-RAG-Hits / X-RAG-Sources. Kept free of React and DOM
// so `node --test` covers it.

// Whether the board can answer from documents, from /health's `features`
// (absent on GenAI Studio from before apps#572).
export function documentsSupport(health) {
  if (!health || health.httpStatus !== 200) {
    return { available: false, reason: 'Connect to a board to use documents.' }
  }
  const features = health.body && health.body.features
  if (!features || typeof features.rag !== 'boolean') {
    return { available: false, reason: "This board's GenAI Studio can't search documents yet. Update Apps on the board." }
  }
  if (!features.rag) {
    return { available: false, reason: 'Document search is turned off on the board: set app.rag.enabled in config.local.yaml.' }
  }
  return { available: true, reason: '' }
}

// X-RAG-Sources: [{source, heading, score}]; anything unreadable is no sources.
export function parseSources(header) {
  if (!header) return []
  try {
    const list = JSON.parse(header)
    return Array.isArray(list) ? list.filter((s) => s && (s.heading || s.source)) : []
  } catch {
    return []
  }
}

// The note under a reply that used documents.
export function sourcesNote(rag) {
  if (!rag) return ''
  if (!rag.hits) return 'Searched your documents: nothing matched this question.'
  const names = [...new Set(rag.sources.map((s) => s.heading || s.source))]
  if (!names.length) return `Answered from ${rag.hits} passage${rag.hits === 1 ? '' : 's'} of your documents.`
  return `From your documents: ${names.join('; ')}`
}

// The database, in words, from GET /rag/status.
export function documentsSummary(status) {
  if (!status) return 'Checking the documents…'
  if (!status.enabled) return 'Document search is turned off on the board.'
  if (!status.database) return 'No documents yet: upload a Markdown file or reset to the default document.'
  const meta = status.meta || {}
  const file = String(meta.input || '').split('/').pop() || 'a document'
  const sections = typeof meta.chunks === 'number' ? `${meta.chunks} section${meta.chunks === 1 ? '' : 's'} from ` : ''
  const state = status.service === 'ok' ? ''
    : status.service === 'failed' ? ' (the search service stopped: restart GenAI Studio on the board)'
      : ' (the search service is starting)'
  return `${sections}${file}${state}`
}

// The Studio streams upload, reset and clear progress as text lines and ends
// with a line starting ✅ or ❌.
export function progressOutcome(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1] || ''
  const clean = (line) => line.replace(/^[\p{Extended_Pictographic}\u{FE0F}\s]+/u, '')
  if (last.startsWith('✅')) return { done: true, ok: true, message: clean(last), lines: lines.map(clean) }
  if (last.startsWith('❌')) return { done: true, ok: false, message: clean(last), lines: lines.map(clean) }
  return { done: false, ok: false, message: clean(last), lines: lines.map(clean) }
}

// --- what the database holds (GET /rag/inspect) -------------------------------

// Sections asked for at most: enough for a handbook, without loading a huge
// database into the page at once.
export const INSPECT_LIMIT = 2000

export function inspectPath(limit = INSPECT_LIMIT) {
  return `rag/inspect?limit=${limit}`
}

// The heading path of a section: its Header_1, Header_2, … metadata in order.
export function sectionHeading(metadata) {
  const md = metadata && typeof metadata === 'object' ? metadata : {}
  return Object.keys(md)
    .filter((k) => /^header/i.test(k) && md[k])
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((k) => String(md[k]))
    .join(' › ')
}

// GET /rag/inspect in words: summary rows, the sections, and what to say when
// there are none. `count` is the number returned, meta.chunks the database's.
export function inspectSummary(data) {
  if (!data) return { rows: [], sections: [], note: 'Reading the documents…' }
  if (data.enabled === false) return { rows: [], sections: [], note: 'Document search is turned off on the board.' }
  const meta = data.meta || {}
  // Numbered by position: the database's ids are 64-bit and arrive rounded by
  // JSON.parse, so several sections can share one.
  const sections = (Array.isArray(data.documents) ? data.documents : []).map((d, i) => ({
    number: i + 1,
    heading: sectionHeading(d && d.metadata),
    text: String((d && d.text) || '')
  }))
  const total = typeof meta.chunks === 'number' ? meta.chunks : sections.length
  const rows = []
  if (meta.input) rows.push({ label: 'Source', value: String(meta.input).split('/').pop(), title: String(meta.input) })
  rows.push({ label: 'Sections', value: total > sections.length ? `${total} (showing the first ${sections.length})` : String(sections.length) })
  if (meta.embedding_model) rows.push({ label: 'Search model', value: String(meta.embedding_model).replace(/\/+$/, '').split('/').pop(), title: String(meta.embedding_model) })
  if (data.path) rows.push({ label: 'Database', value: String(data.path).split('/').pop(), title: String(data.path) })
  let note = ''
  if (data.error) note = `${data.error}. Restart GenAI Studio on the board if it persists.`
  else if (!sections.length) note = data.exists === false ? 'No documents yet: upload a Markdown file or reset to the default document.' : 'The database holds no sections.'
  return { rows, sections, note }
}

// The sections whose heading or text contains every word of `query`, ignoring case.
export function filterSections(sections, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return sections
  return sections.filter((s) => {
    const hay = `${s.heading}\n${s.text}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}
