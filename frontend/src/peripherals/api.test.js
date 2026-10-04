import assert from 'node:assert/strict'
import test from 'node:test'

import { copyCameraExport } from './api.js'

const MIPI = { id: 'mipi-0', connection: 'mipi' }
const USB = { id: 'usb-0', connection: 'usb' }
const SELECTION = { format: 'NV12', width: 1920, height: 1080, fps: 30 }
const EXPORT = {
  exports: [
    { id: 'python', content: 'python code' },
    { id: 'cpp', content: 'cpp code' },
    { id: 'json', content: '{}' }
  ]
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, headers: new Map([['content-type', 'application/json']]), json: async () => body }
}

function setGlobal(name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  return () => (previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name])
}

function withGlobals(t, globals) {
  for (const [name, value] of Object.entries(globals)) t.after(setGlobal(name, value))
}

test('copyCameraExport hands the clipboard its pending text inside the click, as Safari requires', async (t) => {
  const response = deferred()
  const requests = []
  const writes = []
  class ClipboardItem {
    constructor(items) { this.items = items }
  }
  withGlobals(t, {
    ClipboardItem,
    fetch: (url, init) => {
      requests.push({ url, init })
      return response.promise
    },
    navigator: { clipboard: { write: async (items) => writes.push(items) } }
  })

  const copied = copyCameraExport({ camera: MIPI, selection: SELECTION, exportId: 'cpp' })

  // The write starts synchronously, before the export has answered.
  assert.equal(writes.length, 1)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/api/peripherals/cameras/export')
  assert.equal(requests[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].init.body), { id: 'mipi-0', format: 'NV12', width: 1920, height: 1080, fps: 30 })

  response.resolve(jsonResponse(EXPORT))
  await copied
  const blob = await writes[0][0].items['text/plain']
  assert.equal(blob.type, 'text/plain')
  assert.equal(await blob.text(), 'cpp code')
})

test('copyCameraExport falls back to writeText without ClipboardItem', async (t) => {
  const written = []
  withGlobals(t, {
    ClipboardItem: undefined,
    fetch: async () => jsonResponse({ exports: [{ id: 'yaml', content: 'camera:\n' }, { id: 'json', content: '{}' }] }),
    navigator: { clipboard: { writeText: async (text) => written.push(text) } }
  })

  await copyCameraExport({ camera: USB, selection: { ...SELECTION, format: 'MJPG' }, exportId: 'yaml' })
  assert.deepEqual(written, ['camera:\n'])
})

test('copyCameraExport copies through a hidden textarea when the page has no clipboard API', async (t) => {
  const commands = []
  const area = { style: {}, setAttribute() {}, select() {}, remove() {} }
  withGlobals(t, {
    ClipboardItem: undefined,
    fetch: async () => jsonResponse(EXPORT),
    navigator: {},
    document: {
      activeElement: null,
      body: { appendChild: (node) => commands.push(['append', node.value]) },
      createElement: () => area,
      execCommand: (command) => commands.push([command]) > 0
    }
  })

  await copyCameraExport({ camera: MIPI, selection: SELECTION, exportId: 'json' })
  assert.deepEqual(commands, [['append', '{}'], ['copy']])
})

test('copyCameraExport copies nothing once the selection has changed', async (t) => {
  const written = []
  withGlobals(t, {
    ClipboardItem: undefined,
    fetch: async () => jsonResponse(EXPORT),
    navigator: { clipboard: { writeText: async (text) => written.push(text) } }
  })

  await assert.rejects(
    copyCameraExport({ camera: MIPI, selection: SELECTION, exportId: 'python', isCurrent: () => false }),
    /selection changed/
  )
  assert.deepEqual(written, [])
})

test('copyCameraExport reports an export error and a missing format', async (t) => {
  const written = []
  let body = { error: 'The board changed.', code: 'stale_snapshot', hint: 'Click Refresh, then export again.' }
  let status = 409
  withGlobals(t, {
    ClipboardItem: undefined,
    fetch: async () => jsonResponse(body, status),
    navigator: { clipboard: { writeText: async (text) => written.push(text) } }
  })

  await assert.rejects(
    copyCameraExport({ camera: MIPI, selection: SELECTION, exportId: 'python' }),
    (err) => err.code === 'stale_snapshot' && err.hint === 'Click Refresh, then export again.'
  )
  body = { exports: [{ id: 'json', content: '{}' }] }
  status = 200
  await assert.rejects(
    copyCameraExport({ camera: MIPI, selection: SELECTION, exportId: 'python' }),
    /Python \(pyneat\) is not available for this mode/
  )
  assert.deepEqual(written, [])
})
