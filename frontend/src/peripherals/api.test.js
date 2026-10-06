import assert from 'node:assert/strict'
import test from 'node:test'

import { copyText } from './api.js'

function setGlobal(name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  return () => (previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name])
}

function withGlobals(t, globals) {
  for (const [name, value] of Object.entries(globals)) t.after(setGlobal(name, value))
}

test('copyText writes a ClipboardItem when the browser has one', async (t) => {
  const writes = []
  class ClipboardItem {
    constructor(items) { this.items = items }
  }
  withGlobals(t, {
    ClipboardItem,
    navigator: { clipboard: { write: async (items) => writes.push(items) } }
  })

  await copyText('ssh-copy-id sima@192.168.2.2')
  const blob = await writes[0][0].items['text/plain']
  assert.equal(blob.type, 'text/plain')
  assert.equal(await blob.text(), 'ssh-copy-id sima@192.168.2.2')
})

test('copyText falls back to writeText without ClipboardItem', async (t) => {
  const written = []
  withGlobals(t, {
    ClipboardItem: undefined,
    navigator: { clipboard: { writeText: async (text) => written.push(text) } }
  })

  await copyText('sima@192.168.2.2')
  assert.deepEqual(written, ['sima@192.168.2.2'])
})

test('copyText copies through a hidden textarea when the page has no clipboard API', async (t) => {
  const commands = []
  const area = { style: {}, setAttribute() {}, select() {}, remove() {} }
  withGlobals(t, {
    ClipboardItem: undefined,
    navigator: {},
    document: {
      activeElement: null,
      body: { appendChild: (node) => commands.push(['append', node.value]) },
      createElement: () => area,
      execCommand: (command) => commands.push([command]) > 0
    }
  })

  await copyText('{}')
  assert.deepEqual(commands, [['append', '{}'], ['copy']])
})
