// The model catalog in Settings, Models: the models on the board and the ones
// Hugging Face offers it, in one list. The Hugging Face side is saved in this
// browser, so it can be browsed and searched while Hugging Face is out of reach.
// Kept free of React and DOM so `node --test` covers it.
import { chatModels, formatBytes, friendlyModelName, speechModels } from './backendState.js'
import { catalogNameFor } from './firstModel.js'
import { residentLimit } from './models.js'
import { modelKind, modelRow } from './settingsCards.js'

export const CATALOG_KEY = 'neat-insight:genai-model-catalog'

export const EMPTY_CATALOG = { syncedAt: null, models: [] }

export function loadCatalog(storage) {
  try {
    const saved = JSON.parse(storage.getItem(CATALOG_KEY))
    if (saved && Array.isArray(saved.models)) {
      return {
        syncedAt: Number.isFinite(saved.syncedAt) ? saved.syncedAt : null,
        models: saved.models.filter((m) => m && typeof m.repoId === 'string' && m.repoId)
      }
    }
  } catch {
    // Unreadable or refused storage: the next sync saves it again.
  }
  return EMPTY_CATALOG
}

export function saveCatalog(storage, catalog) {
  try {
    storage.setItem(CATALOG_KEY, JSON.stringify(catalog))
  } catch {
    // Private windows may refuse storage; the catalog then lasts this visit.
  }
}

// results: GET models/hub/search's list. Hugging Face's listing has no sizes or
// descriptions, so what the cards already read said stays.
export function catalogFromSearch(results, previous = EMPTY_CATALOG, syncedAt = Date.now()) {
  const known = new Map(previous.models.map((m) => [m.repoId, m]))
  return {
    syncedAt,
    models: (results || []).filter((r) => r && r.repoId).map((r) => {
      const before = known.get(r.repoId) || {}
      return {
        repoId: r.repoId,
        org: r.org || r.repoId.split('/')[0],
        type: r.type,
        sizeBytes: r.sizeBytes || before.sizeBytes || null,
        summary: before.summary || '',
        unsupportedReason: r.unsupportedReason || ''
      }
    })
  }
}

// card: GET models/hub/card's answer. One without a repoId is a failed lookup.
export function withCard(catalog, card) {
  if (!card || !card.repoId) return catalog
  return {
    ...catalog,
    models: catalog.models.map((m) => (m.repoId === card.repoId
      ? { ...m, sizeBytes: card.sizeBytes || m.sizeBytes, summary: cardSummary(card.card) || m.summary }
      : m))
  }
}

// The first paragraph of prose in a model card, without its Markdown marks.
export function cardSummary(text) {
  const body = String(text || '').replace(/^---\n[\s\S]*?\n---\n/, '')
  for (const block of body.split(/\n\s*\n/)) {
    const line = block.trim()
    if (!line || /^(#|\||[-*+] |>|```|<|!\[)/.test(line)) continue
    const plain = line
      .replace(/\s+/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|`|\*/g, '')
      .trim()
    if (plain) return plain.length > 240 ? `${plain.slice(0, 239).trimEnd()}…` : plain
  }
  return ''
}

const rowRank = (row) => (row.on || row.state.key === 'loading' ? 0 : row.onBoard ? 1 : 2)

// One row per model: what is in use first, then the rest of the board, then
// what can be downloaded, each in the order the board or Hugging Face gave.
// activeName: as for modelRow. download: the download in progress, if any.
export function catalogRows({ status = null, catalog = EMPTY_CATALOG, activeName, download = null } = {}) {
  const offered = new Map(catalog.models.map((m) => [catalogNameFor(m.repoId).toLowerCase(), m]))
  const onBoard = [...chatModels(status), ...speechModels(status)].map((model) => {
    const key = model.name.toLowerCase()
    const card = offered.get(key)
    offered.delete(key)
    const row = modelRow(model, status, activeName)
    return {
      ...row,
      key: model.name,
      model,
      onBoard: true,
      repoId: card ? card.repoId : '',
      source: card ? card.repoId : model.name,
      size: row.size || (card && card.sizeBytes ? formatBytes(card.sizeBytes) : ''),
      summary: card ? card.summary : ''
    }
  })
  const available = [...offered.values()].map((card) => ({
    key: card.repoId,
    model: null,
    name: friendlyModelName(card.repoId.split('/').pop()),
    kind: modelKind(card),
    onBoard: false,
    on: false,
    repoId: card.repoId,
    source: card.repoId,
    size: card.sizeBytes ? formatBytes(card.sizeBytes) : '',
    summary: card.summary,
    unsupportedReason: card.unsupportedReason || '',
    state: download && download.repoId === card.repoId ? { key: 'downloading', label: 'Downloading to DevKit' }
      : card.unsupportedReason ? { key: 'unsupported', label: "Can't run here" }
        : { key: 'available', label: 'Not downloaded' }
  }))
  return [...onBoard, ...available]
    .map((row, i) => ({ row, i }))
    .sort((a, b) => rowRank(a.row) - rowRank(b.row) || a.i - b.i)
    .map(({ row }) => row)
}

// type: all, or a modelKind key.
export function filterRows(rows, { query = '', type = 'all' } = {}) {
  const text = query.trim().toLowerCase()
  return rows.filter((row) => `${row.name} ${row.kind.label} ${row.source} ${row.summary}`.toLowerCase().includes(text) &&
    (type === 'all' || row.kind.key === type))
}

export function resultsLine(shown, total) {
  const models = `${total === 1 ? 'model' : 'models'}`
  const count = shown === total ? `${total === 1 ? '' : 'all '}${total}` : `${shown} of ${total}`
  return `Showing ${count} ${models} · Search filters this saved catalog`
}

export function boardSummary(rows) {
  const count = rows.filter((r) => r.onBoard).length
  if (!count) return 'No models on this DevKit yet'
  return `${count} model${count === 1 ? '' : 's'} on this DevKit`
}

export function residencyNote(status) {
  const limit = residentLimit(status)
  const chat = limit > 1 ? `Up to ${limit} chat models can stay loaded.` : 'One chat model runs at a time.'
  return `${chat} Speech recognition uses a separate model.`
}

// disk: /models/status's {freeBytes, totalBytes}; null when the board doesn't say.
export function storageSummary(disk) {
  if (!disk || typeof disk.freeBytes !== 'number' || !(disk.totalBytes > 0)) return null
  return {
    free: formatBytes(disk.freeBytes),
    total: formatBytes(disk.totalBytes),
    usedPct: Math.min(100, Math.max(0, (1 - disk.freeBytes / disk.totalBytes) * 100))
  }
}

export function syncedLabel(syncedAt, now = Date.now()) {
  if (!syncedAt) return 'Not synced yet'
  if (now - syncedAt < 60_000) return 'Last synced just now'
  const at = new Date(syncedAt)
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (at.toDateString() === new Date(now).toDateString()) return `Last synced today at ${time}`
  return `Last synced ${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`
}
