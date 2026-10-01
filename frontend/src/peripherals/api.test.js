import assert from 'node:assert/strict'
import test from 'node:test'

import { createLatestRequest } from './api.js'

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
