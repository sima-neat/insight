import assert from 'node:assert/strict'
import test from 'node:test'

import { copyText, readMicrophoneTest } from './api.js'

function failing(code) {
  return Object.assign(new Error(code), { code })
}

function requests(...answers) {
  const calls = []
  const request = async () => {
    calls.push(calls.length)
    const answer = answers.shift()
    if (answer instanceof Error) throw answer
    return answer
  }
  return { request, calls }
}

const noWait = async () => {}

test('a transient status failure is retried instead of ending the recording', async () => {
  const status = { test: { token: 't', state: 'recording' } }
  const { request, calls } = requests(failing('network'), failing('peripheral_unavailable'), status)
  assert.deepEqual(await readMicrophoneTest({ request, wait: noWait }), status)
  assert.equal(calls.length, 3)
})

test('a status error that means the test is gone ends it at once', async () => {
  for (const code of ['not_found', 'stale_snapshot']) {
    const { request, calls } = requests(failing(code), { test: null })
    await assert.rejects(readMicrophoneTest({ request, wait: noWait }), { code })
    assert.equal(calls.length, 1)
  }
})

test('retrying stops after the failure limit or once the page is gone', async () => {
  const limited = requests(...Array.from({ length: 5 }, () => failing('network')))
  await assert.rejects(readMicrophoneTest({ request: limited.request, wait: noWait, maxFailures: 3 }), { code: 'network' })
  assert.equal(limited.calls.length, 3)

  const unmounted = requests(failing('network'), { test: null })
  await assert.rejects(readMicrophoneTest({ request: unmounted.request, wait: noWait, isActive: () => false }), { code: 'network' })
  assert.equal(unmounted.calls.length, 1)
})

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
