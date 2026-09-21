import test from 'node:test'
import assert from 'node:assert/strict'
import { FPS_MAX, FPS_MIN, FPS_STEP, formatFpsProgress, parseFps, stepFps } from './fps.js'

test('constants match the backend range', () => {
  assert.equal(FPS_MIN, 1)
  assert.equal(FPS_MAX, 240)
  assert.equal(FPS_STEP, 5)
})

test('stepFps moves by 5 and clamps to the range', () => {
  assert.equal(stepFps(30, 1), 35)
  assert.equal(stepFps(30, -1), 25)
  assert.equal(stepFps(3, -1), 1)
  assert.equal(stepFps(238, 1), 240)
  assert.equal(stepFps(240, 1), 240)
  assert.equal(stepFps(1, -1), 1)
})

test('parseFps accepts whole numbers in range', () => {
  assert.equal(parseFps('30'), 30)
  assert.equal(parseFps(' 15 '), 15)
  assert.equal(parseFps('240'), 240)
  assert.equal(parseFps('1'), 1)
})

test('parseFps rejects invalid input', () => {
  for (const text of ['', '0', '-3', 'abc', '29.97', '241', '1e2', null, undefined]) {
    assert.equal(parseFps(text), null, `expected ${JSON.stringify(text)} to be rejected`)
  }
})

test('formatFpsProgress renders m:ss pairs', () => {
  assert.equal(formatFpsProgress({ seconds: 25, total: 60 }), '0:25 / 1:00')
  assert.equal(formatFpsProgress({ seconds: 3725.4, total: null }), '1:02:05')
})
