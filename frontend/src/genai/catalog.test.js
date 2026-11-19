import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CATALOG_KEY,
  EMPTY_CATALOG,
  boardSummary,
  cardNote,
  cardSummary,
  catalogFromSearch,
  catalogNeedsSync,
  catalogRows,
  filterRows,
  loadCatalog,
  residencyNote,
  resultsLine,
  sameBoardThroughout,
  saveCatalog,
  savedForOtherBoard,
  storageSummary,
  syncedLabel,
  withCard
} from './catalog.js'

const STATUS = {
  catalog: [
    { name: 'Qwen3-0.6B-Autoround-a16w4', type: 'chat', sizeBytes: 893_000_000 },
    { name: 'Llama-3.2-3B-Instruct', type: 'chat', sizeBytes: 3_700_000_000 },
    { name: 'whisper-small-a16w8', type: 'asr', activeAsr: true, sizeBytes: 1_300_000_000 }
  ],
  loaded: ['Llama-3.2-3B-Instruct'],
  asrModel: 'whisper-small-a16w8'
}
const CATALOG = {
  syncedAt: 1000,
  board: null,
  models: [
    { repoId: 'simaai/Qwen3-VL-4B-Instruct-Autoround-a16w4', org: 'simaai', type: 'vlm', sizeBytes: 4_200_000_000, summary: 'Sees images.' },
    { repoId: 'simaai/Qwen3-0.6B-Autoround-a16w4', org: 'simaai', type: 'llm', sizeBytes: null, summary: 'A compact chat model.' },
    { repoId: 'simaai/whisper-medium-a16w8', org: 'simaai', type: 'asr', sizeBytes: null, summary: '' }
  ]
}

function memoryStorage(seed = {}) {
  const items = new Map(Object.entries(seed))
  return { getItem: (k) => (items.has(k) ? items.get(k) : null), setItem: (k, v) => items.set(k, v) }
}

test('the saved catalog survives a reload, and bad or refused storage is an empty catalog', () => {
  const storage = memoryStorage()
  saveCatalog(storage, CATALOG)
  assert.deepEqual(loadCatalog(storage), CATALOG)
  assert.deepEqual(loadCatalog(memoryStorage()), EMPTY_CATALOG)
  assert.deepEqual(loadCatalog(memoryStorage({ [CATALOG_KEY]: '{not json' })), EMPTY_CATALOG)
  assert.deepEqual(loadCatalog(null), EMPTY_CATALOG)
  assert.doesNotThrow(() => saveCatalog(null, CATALOG))
  assert.deepEqual(loadCatalog(memoryStorage({ [CATALOG_KEY]: '{"models":[{"repoId":"a/b"},{"x":1},null]}' })).models, [{ repoId: 'a/b' }], 'an entry with no repository is dropped')
})

test('a sync keeps what the cards already read said', () => {
  const next = catalogFromSearch([{ repoId: 'simaai/whisper-medium-a16w8', type: 'asr', sizeBytes: null }, { repoId: 'simaai/new', org: 'simaai', type: 'llm' }, {}], {
    syncedAt: 1,
    models: [{ repoId: 'simaai/whisper-medium-a16w8', sizeBytes: 5, summary: 'Old card.' }, { repoId: 'simaai/gone', summary: 'Left the list.' }]
  }, 2000)
  assert.equal(next.syncedAt, 2000)
  assert.deepEqual(next.models.map((m) => m.repoId), ['simaai/whisper-medium-a16w8', 'simaai/new'], 'a model Hugging Face stopped listing goes')
  assert.deepEqual([next.models[0].sizeBytes, next.models[0].summary, next.models[0].org], [5, 'Old card.', 'simaai'])
})

test('a card fills in its model; a failed lookup changes nothing', () => {
  const next = withCard(CATALOG, { repoId: CATALOG.models[2].repoId, sizeBytes: 417_000_000, card: 'Speech to text.' })
  assert.deepEqual([next.models[2].sizeBytes, next.models[2].summary], [417_000_000, 'Speech to text.'])
  assert.equal(next.models[0], CATALOG.models[0])
  assert.equal(withCard(CATALOG, { enabled: true, error: 'Could not load model metadata' }), CATALOG)
  assert.equal(withCard(CATALOG, null), CATALOG)
  const kept = withCard(CATALOG, { repoId: CATALOG.models[1].repoId, card: '# Only a heading' })
  assert.equal(kept.models[1].summary, 'A compact chat model.', 'a card with no prose keeps the earlier words')
})

test('a model card reads as its first paragraph of prose', () => {
  const card = '---\ntags:\n- vision\n---\n# Qwen3-VL: Optimized\n\n## Overview\n\nThis repository contains the **Qwen3-VL** model,\ncompiled for [Modalix](https://sima.ai).\n\n- **Size:** 4B\n'
  assert.equal(cardSummary(card), 'This repository contains the Qwen3-VL model, compiled for Modalix.')
  assert.equal(cardSummary('| a | b |\n|---|---|\n\n> quote\n\n- list'), '')
  assert.equal(cardSummary(null), '')
  const long = cardSummary('word '.repeat(100))
  assert.equal(long.length, 240)
  assert.ok(long.endsWith('…'))
})

test('one row per model: in use first, then the board, then what can be downloaded', () => {
  const rows = catalogRows({ status: STATUS, catalog: CATALOG })
  assert.deepEqual(rows.map((r) => [r.name, r.state.label]), [
    ['Llama 3.2 3B', 'Loaded'],
    ['Whisper small', 'In use'],
    ['Qwen3 0.6B', 'On DevKit'],
    ['Qwen3 VL 4B', 'Not downloaded'],
    ['Whisper medium', 'Not downloaded']
  ])
  const qwen = rows.find((r) => r.name === 'Qwen3 0.6B')
  assert.deepEqual([qwen.onBoard, qwen.repoId, qwen.source, qwen.size, qwen.summary], [true, 'simaai/Qwen3-0.6B-Autoround-a16w4', 'simaai/Qwen3-0.6B-Autoround-a16w4', '893 MB', 'A compact chat model.'], 'a model on the board keeps its Hugging Face card')
  const llama = rows[0]
  assert.deepEqual([llama.repoId, llama.source], ['', 'Llama-3.2-3B-Instruct'], 'a model Hugging Face does not list is still shown')
  const vision = rows.find((r) => r.name === 'Qwen3 VL 4B')
  assert.deepEqual([vision.kind.key, vision.onBoard, vision.size, vision.model], ['vision', false, '4.2 GB', null])
  assert.equal(rows.find((r) => r.name === 'Whisper medium').size, '', 'an unknown size is left empty')
})

test('a row matches the board whatever the case of its repository name', () => {
  const rows = catalogRows({ status: { catalog: [{ name: 'qwen3-0.6b', type: 'chat' }] }, catalog: { models: [{ repoId: 'simaai/Qwen3-0.6B', sizeBytes: 9 }] } })
  assert.deepEqual(rows.map((r) => [r.onBoard, r.repoId, r.size]), [[true, 'simaai/Qwen3-0.6B', '9 B']])
})

test('another account\'s model pairs with its <org>@<name> folder on the board', () => {
  const rows = catalogRows({ status: { catalog: [{ name: 'acme@model', type: 'chat' }] }, catalog: { models: [{ repoId: 'acme/model', org: 'acme' }] } })
  assert.equal(rows.length, 1)
})

test('the download in progress shows in its row; a model that can\'t run says so', () => {
  const rows = catalogRows({ status: STATUS, catalog: CATALOG, download: { repoId: CATALOG.models[0].repoId, pct: 40 } })
  assert.deepEqual(rows.find((r) => r.repoId === CATALOG.models[0].repoId).state, { key: 'downloading', label: 'Downloading to DevKit' })
  const blocked = catalogRows({ catalog: { models: [{ repoId: 'simaai/x', unsupportedReason: 'Too big' }] } })
  assert.deepEqual([blocked[0].state.key, blocked[0].unsupportedReason], ['unsupported', 'Too big'])
})

test('a model still downloading stays a download, even once the board lists it', () => {
  const repoId = CATALOG.models[1].repoId
  const rows = catalogRows({ status: STATUS, catalog: CATALOG, download: { repoId, pct: 60 } })
  const row = rows.find((r) => r.repoId === repoId)
  assert.deepEqual([row.onBoard, row.model, row.state.key], [false, null, 'downloading'])
  assert.equal(rows.filter((r) => r.repoId === repoId).length, 1)
})

test('no board status yet still lists the saved catalog', () => {
  assert.equal(catalogRows({ status: null, catalog: CATALOG }).length, 3)
  assert.deepEqual(catalogRows(), [])
})

test('search and the filters narrow the rows together', () => {
  const rows = catalogRows({ status: STATUS, catalog: CATALOG })
  const names = (filter) => filterRows(rows, filter).map((r) => r.name)
  assert.equal(names({}).length, 5)
  assert.deepEqual(names({ query: '  WHISPER ' }), ['Whisper small', 'Whisper medium'])
  assert.deepEqual(names({ query: 'sees images' }), ['Qwen3 VL 4B'], 'the card is searched too')
  assert.deepEqual(names({ query: 'simaai/qwen3-0.6b' }), ['Qwen3 0.6B'], 'so is the repository')
  assert.deepEqual(names({ type: 'speech' }), ['Whisper small', 'Whisper medium'])
  assert.deepEqual(names({ query: 'qwen', type: 'speech' }), [])
})

test('the catalog\'s lines of text', () => {
  assert.equal(resultsLine(8, 8), 'Showing all 8 models · Search filters this saved catalog')
  assert.equal(resultsLine(3, 8), 'Showing 3 of 8 models · Search filters this saved catalog')
  assert.equal(resultsLine(1, 1), 'Showing 1 model · Search filters this saved catalog')
  assert.equal(resultsLine(0, 1), 'Showing 0 of 1 model · Search filters this saved catalog')
  assert.equal(boardSummary(catalogRows({ status: STATUS, catalog: CATALOG })), '3 models on this DevKit')
  assert.equal(boardSummary([{ onBoard: true }]), '1 model on this DevKit')
  assert.equal(boardSummary([{ onBoard: false }]), 'No models on this DevKit yet')
  assert.equal(residencyNote({ maxResident: 2 }), 'Up to 2 chat models can stay loaded. Speech recognition uses a separate model.')
  assert.equal(residencyNote({}), 'One chat model runs at a time. Speech recognition uses a separate model.')
})

test('a row says Reading only while its card can still arrive', () => {
  const row = { repoId: 'simaai/model', summary: '' }
  assert.equal(cardNote(row), 'Reading its model card…')
  assert.equal(cardNote(row, { missed: true }), 'No description could be read from its model card.')
  assert.equal(cardNote(row, { canRead: false }), 'No description could be read from its model card.')
  assert.equal(cardNote({ ...row, summary: 'A model.' }, { missed: true }), 'A model.')
  assert.equal(cardNote({ repoId: '', summary: '' }), 'This model is not in the saved Hugging Face catalog.')
})

test('storage reads from the board, or not at all', () => {
  const disk = storageSummary({ freeBytes: 459_000_000_000, totalBytes: 512_000_000_000 })
  assert.deepEqual([disk.free, disk.total, Math.round(disk.usedPct)], ['459 GB', '512 GB', 10])
  assert.equal(storageSummary(null), null)
  assert.equal(storageSummary({ freeBytes: 5 }), null, 'an older Studio that gives no total')
  assert.equal(storageSummary({ freeBytes: 5, totalBytes: 0 }), null)
})

test('the last sync reads in everyday words', () => {
  const noon = new Date(2026, 10, 5, 12, 0).getTime()
  assert.equal(syncedLabel(null), 'Not synced yet')
  assert.equal(syncedLabel(noon - 5000, noon), 'Last synced just now')
  assert.match(syncedLabel(noon - 3_600_000, noon), /^Last synced today at 11:00/)
  assert.match(syncedLabel(noon - 2 * 86_400_000, noon), /^Last synced Nov 3 at 12:00/)
})

test('a catalog remembers the board it was read from', () => {
  const synced = catalogFromSearch([{ repoId: 'simaai/a', type: 'llm' }], EMPTY_CATALOG, 5, 'https://192.168.2.3:5000')
  assert.equal(synced.board, 'https://192.168.2.3:5000')
  const storage = memoryStorage()
  saveCatalog(storage, synced)
  assert.equal(loadCatalog(storage).board, 'https://192.168.2.3:5000')
  assert.equal(withCard(synced, { repoId: 'simaai/a', sizeBytes: 1 }).board, 'https://192.168.2.3:5000')
})

test('a catalog saved before boards were noted loads without one', () => {
  const storage = memoryStorage({ [CATALOG_KEY]: JSON.stringify({ syncedAt: 1000, models: CATALOG.models }) })
  assert.equal(loadCatalog(storage).board, null)
})

test('opening the model list syncs a catalog saved for the board another tab left', () => {
  // Another tab switched the shared board. This view still holds the old address,
  // so only the address read when the list opens shows the saved list is stale.
  const oldBoard = 'https://192.168.2.3:5000'
  const newBoard = 'https://192.168.2.9:5000'
  const saved = { ...CATALOG, syncedAt: 1_000, board: oldBoard }
  assert.equal(catalogNeedsSync(saved, oldBoard), false)  // the stale address hides it
  assert.equal(catalogNeedsSync(saved, newBoard), true)   // the fresh one does not
  assert.equal(catalogNeedsSync({ ...saved, syncedAt: null }, oldBoard), true)  // never synced
  assert.equal(catalogNeedsSync(saved, oldBoard, { fromOtherBoard: true }), true)
  assert.equal(catalogNeedsSync(saved, null), false)  // address unknown: no claim
})

test('auto-sync runs once per board, again after every later switch', () => {
  const b = 'https://192.168.2.9:5000'
  const c = 'https://192.168.2.11:5000'
  // Synced for B after a switch A -> B made in another tab: B is not synced again.
  const forB = { ...CATALOG, syncedAt: 2_000, board: b }
  assert.equal(catalogNeedsSync(forB, b, { autoSyncedFor: b }), false)
  // A second switch B -> C, also in another tab, syncs once more.
  assert.equal(catalogNeedsSync(forB, c, { autoSyncedFor: b }), true)
  // A failed sync for C keeps B's rows, and is not retried on its own.
  assert.equal(catalogNeedsSync(forB, c, { autoSyncedFor: c }), false)
  // Nothing synced yet, with the board unknown: the first look still fills it.
  assert.equal(catalogNeedsSync({ ...CATALOG, syncedAt: null }, null), true)
  assert.equal(catalogNeedsSync({ ...CATALOG, syncedAt: null }, null, { autoSyncedFor: null }), false)
})

test('a sync keeps its rows only when no board switch happened while it ran', () => {
  assert.equal(sameBoardThroughout(7, 7), true)
  assert.equal(sameBoardThroughout(7, 8), false)  // switched, maybe A -> B -> A: the rows may be mixed
  assert.equal(sameBoardThroughout(null, 8), true)  // unknown: the address labels the rows
  assert.equal(sameBoardThroughout(7, null), true)
})

test('a saved catalog is for another board unless it names the current one', () => {
  const here = 'https://192.168.2.3:5000'
  assert.equal(savedForOtherBoard({ ...CATALOG, board: here }, here), false)
  assert.equal(savedForOtherBoard({ ...CATALOG, board: 'https://192.168.2.9:5000' }, here), true)
  assert.equal(savedForOtherBoard({ ...CATALOG, board: null }, here), true)
  // The board is not known yet: nothing to compare, so no sync is asked for.
  assert.equal(savedForOtherBoard({ ...CATALOG, board: null }, null), false)
})
