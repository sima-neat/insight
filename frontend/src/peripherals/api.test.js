import assert from 'node:assert/strict'
import test from 'node:test'

import { readMicrophoneTest } from './api.js'

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
