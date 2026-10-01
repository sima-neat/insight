import assert from 'node:assert/strict'
import test from 'node:test'

import { pollWhileVisible } from './polling.js'

test('Stats polls only while its browser page is visible', () => {
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
      setInterval(fn) { callback = fn; nextTimer += 1; return nextTimer },
      clearInterval(timer) { cancelled.push(timer); callback = null }
    }
  )

  assert.equal(reads, 0)
  visibilityState = 'visible'
  listener()
  assert.equal(reads, 1)
  callback()
  assert.equal(reads, 2)

  visibilityState = 'hidden'
  listener()
  assert.deepEqual(cancelled, [1])
  visibilityState = 'visible'
  listener()
  assert.equal(reads, 3)

  stop()
  assert.deepEqual(cancelled, [1, 2])
  assert.equal(listener, null)
})
