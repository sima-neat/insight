import assert from 'node:assert/strict'
import test from 'node:test'

import { createLatestRequest, pollMicrophoneTest } from './api.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('a late old-board response cannot replace the latest request', async () => {
  const first = deferred()
  const second = deferred()
  const latest = createLatestRequest()
  const oldRequest = latest.run(() => first.promise)
  const newRequest = latest.run(() => second.promise)
  second.resolve('new-board')
  assert.deepEqual(await newRequest, { current: true, value: 'new-board' })
  first.resolve('old-board')
  assert.deepEqual(await oldRequest, { current: false })
})

test('a late rejection from a superseded request is ignored', async () => {
  const first = deferred()
  const latest = createLatestRequest()
  const oldRequest = latest.run(() => first.promise)
  const newRequest = latest.run(() => Promise.resolve('new-board'))
  assert.deepEqual(await newRequest, { current: true, value: 'new-board' })
  first.reject(new Error('old board failed'))
  assert.deepEqual(await oldRequest, { current: false })
})

test('cancel prevents an in-flight catalog response from being applied', async () => {
  const pending = deferred()
  const latest = createLatestRequest()
  const request = latest.run(() => pending.promise)
  latest.cancel()
  pending.resolve('stale-catalog')
  assert.deepEqual(await request, { current: false })
})

test('changing a selection invalidates a delayed export', async () => {
  const firstSelection = deferred()
  const exports = createLatestRequest()
  const oldExport = exports.run(() => firstSelection.promise)
  exports.cancel()
  firstSelection.resolve({ device_id: 'camera:a' })
  assert.deepEqual(await oldExport, { current: false })
})

test('microphone status polling recovers after a transient request failure', async () => {
  const statuses = []
  const errors = []
  let requests = 0
  const result = await pollMicrophoneTest('test-token', {
    request: async () => {
      requests += 1
      if (requests === 1) {
        const error = new Error('temporary failure')
        error.code = 'network'
        throw error
      }
      return { test: { state: requests === 2 ? 'recording' : 'ready' } }
    },
    onStatus: (status) => statuses.push(status.state),
    onError: (error) => errors.push(error?.code || null),
    wait: async () => {}
  })
  assert.equal(requests, 3)
  assert.deepEqual(statuses, ['recording', 'ready'])
  assert.deepEqual(errors, ['network', null, null])
  assert.equal(result.state, 'ready')
})

test('microphone status polling does not retry an expired token', async () => {
  let requests = 0
  const error = new Error('expired')
  error.code = 'not_found'
  await assert.rejects(
    pollMicrophoneTest('expired-token', {
      request: async () => { requests += 1; throw error },
      wait: async () => {}
    }),
    error
  )
  assert.equal(requests, 1)
})
