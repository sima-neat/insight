import assert from 'node:assert/strict'
import test from 'node:test'

import { pollStats, pollWhileVisible } from './polling.js'

test('Stats polls only while its browser page is visible', async () => {
  let visibilityState = 'hidden'
  let listener = null
  let callback = null
  let nextTimer = 0
  const cancelled = []
  const page = {
    get visibilityState() { return visibilityState },
    addEventListener(name, value) { if (name === 'visibilitychange') listener = value },
    removeEventListener(name, value) { if (name === 'visibilitychange' && listener === value) listener = null }
  }
  let reads = 0
  const stop = pollWhileVisible(
    () => { reads += 1 },
    2000,
    {
      document: page,
      setTimeout(fn) { callback = fn; nextTimer += 1; return nextTimer },
      clearTimeout(timer) { cancelled.push(timer); callback = null }
    }
  )

  assert.equal(reads, 0)
  visibilityState = 'visible'
  listener()
  assert.equal(reads, 1)
  await Promise.resolve()
  callback()
  assert.equal(reads, 2)
  await Promise.resolve()

  visibilityState = 'hidden'
  listener()
  assert.deepEqual(cancelled, [2])
  visibilityState = 'visible'
  listener()
  assert.equal(reads, 3)
  await Promise.resolve()

  stop()
  assert.deepEqual(cancelled, [2, 3])
  assert.equal(listener, null)
})

test('Stats refreshes an externally started trace while its local trace state is idle', async () => {
  let metrics = 0
  let traces = 0
  await pollStats(
    () => { metrics += 1 },
    () => { traces += 1 }
  )
  assert.deepEqual({ metrics, traces }, { metrics: 1, traces: 1 })
})

test('a changed retry delay is awaited before the next request', async () => {
  let delay = 2000
  let reads = 0
  const timers = []
  const stop = pollWhileVisible(
    () => { reads += 1; delay *= 2 },
    () => delay,
    {
      document: {
        visibilityState: 'visible',
        addEventListener() {},
        removeEventListener() {}
      },
      setTimeout(callback, ms) { timers.push({ callback, ms }); return timers.length },
      clearTimeout() {}
    }
  )

  assert.equal(reads, 1)
  await Promise.resolve()
  assert.equal(reads, 1, 'changing the delay does not restart the poll immediately')
  assert.equal(timers[0].ms, 4000)

  timers.shift().callback()
  assert.equal(reads, 2)
  await Promise.resolve()
  assert.equal(timers[0].ms, 8000)
  stop()
})
