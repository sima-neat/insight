import test from 'node:test'
import assert from 'node:assert/strict'
import { FPS_MIN, FPS_STEP, allCommitsSucceeded, formatFpsProgress, isNativeRate, needsRendition, parseFps, renditionMayHaveChanged, stepFps, withCommittedFps } from './fps.js'

test('constants match the backend minimum', () => {
  assert.equal(FPS_MIN, 1)
  assert.equal(FPS_STEP, 5)
})

test('stepFps moves by 5, stops at the minimum and has no upper bound', () => {
  assert.equal(stepFps(30, 1), 35)
  assert.equal(stepFps(30, -1), 25)
  assert.equal(stepFps(3, -1), 1)
  assert.equal(stepFps(240, 1), 245)
  assert.equal(stepFps(1, -1), 1)
})

test('parseFps accepts any whole number from 1', () => {
  // Owner review (O5): a 300 fps file must be able to go back to 300.
  assert.equal(parseFps('30'), 30)
  assert.equal(parseFps(' 15 '), 15)
  assert.equal(parseFps('300'), 300)
  assert.equal(parseFps('1000'), 1000)
  assert.equal(parseFps('1'), 1)
})

test('isNativeRate is true for no override or one equal to the native rate', () => {
  assert.equal(isNativeRate(null, 30), true)
  assert.equal(isNativeRate(30, 30), true)
  assert.equal(isNativeRate(15, 30), false)
  assert.equal(isNativeRate(null, null), true)
  assert.equal(isNativeRate(15, null), false)  // unknown native rate: an override may need a rendition
})

test('parseFps rejects invalid input', () => {
  for (const text of ['', '0', '-3', 'abc', '29.97', '1e2', null, undefined]) {
    assert.equal(parseFps(text), null, `expected ${JSON.stringify(text)} to be rejected`)
  }
})

test('formatFpsProgress renders m:ss pairs', () => {
  assert.equal(formatFpsProgress({ seconds: 25, total: 60 }), '0:25 / 1:00')
  assert.equal(formatFpsProgress({ seconds: 3725.4, total: null }), '1:02:05')
})

test('needsRendition is true only for an fps that differs from the native rate', () => {
  assert.equal(needsRendition(null), false)
  assert.equal(needsRendition({ fps: null, native_fps: 30 }), false)
  assert.equal(needsRendition({ fps: 30, native_fps: 30 }), false)
  assert.equal(needsRendition({ fps: 15, native_fps: 30 }), true)
  assert.equal(needsRendition({ fps: 15, native_fps: null }), true)
})

test('withCommittedFps applies a settled commit and leaves the row alone otherwise', () => {
  // Codex review: Play must see the fps the stepper just committed, not the stale row.
  const row = { index: 1, fps: 30, native_fps: 30 }
  assert.deepEqual(withCommittedFps(row, { ok: true, fps: 15 }), { index: 1, fps: 15, native_fps: 30 })
  assert.equal(withCommittedFps(row, undefined), row)
  assert.equal(withCommittedFps(row, { ok: false }), null)
  assert.equal(withCommittedFps(null, { ok: true, fps: 15 }), null)
})

test('allCommitsSucceeded is false as soon as one pending commit failed', () => {
  // Codex review: Bulk Start must not post when any awaited FPS commit was refused.
  assert.equal(allCommitsSucceeded([]), true)
  assert.equal(allCommitsSucceeded([{ ok: true, fps: 15 }, { ok: true, fps: 20 }]), true)
  assert.equal(allCommitsSucceeded([{ ok: true, fps: 15 }, { ok: false }]), false)
})

test('renditionMayHaveChanged spots a slot that started playing at a custom FPS', () => {
  // Owner review (O9): the 2 s poll asks for rendition usage only when a start may have made one.
  const slot = (state, fps, file = 'clip.mp4') => ({ index: 1, file, fps, state })
  assert.equal(renditionMayHaveChanged([slot('stopped', 15)], [slot('playing', 15)]), true)
  assert.equal(renditionMayHaveChanged([slot('playing', 15)], [slot('playing', 20)]), true, 'restarted at another rate')
  assert.equal(renditionMayHaveChanged([slot('playing', 15)], [slot('playing', 15, 'other.mp4')]), true, 'restarted with another file')
  assert.equal(renditionMayHaveChanged([], [slot('playing', 15)]), true, 'first poll')
  assert.equal(renditionMayHaveChanged([slot('playing', 15)], [slot('playing', 15)]), false, 'still playing')
  assert.equal(renditionMayHaveChanged([slot('stopped', null)], [slot('playing', null)]), false, 'native rate makes no rendition')
  assert.equal(renditionMayHaveChanged([slot('playing', 15)], [slot('stopped', 15)]), false, 'a stop keeps the rendition')
})
