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
  const state = status.service === 'ok' ? '' : ' (the search service is starting)'
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
