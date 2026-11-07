import assert from 'node:assert/strict'
import test from 'node:test'

import { tipPosition } from './tooltip.js'

const view = { width: 1000, height: 800 }
const tip = { width: 100, height: 30 }
const anchorAt = (left, top) => ({ left, top, width: 36, height: 36, right: left + 36, bottom: top + 36 })

test('a tooltip sits centred on its preferred side of the button', () => {
  assert.deepEqual(tipPosition(anchorAt(500, 300), tip, view), { top: 342, left: 468 })
  assert.deepEqual(tipPosition(anchorAt(500, 300), tip, view, 'top'), { top: 264, left: 468 })
})

test('a tooltip moves to the other side when its own has no room', () => {
  assert.equal(tipPosition(anchorAt(500, 760), tip, view).top, 724)
  assert.equal(tipPosition(anchorAt(500, 10), tip, view, 'top').top, 52)
})

test('a tooltip stays on its side when neither side has room', () => {
  const short = { width: 1000, height: 60 }
  assert.equal(tipPosition(anchorAt(500, 12), tip, short).top, 54)
  assert.equal(tipPosition(anchorAt(500, 12), tip, short, 'top').top, -24)
})

test('a tooltip by the edge of the window stays inside it', () => {
  assert.equal(tipPosition(anchorAt(960, 300), tip, view).left, 892)
  assert.equal(tipPosition(anchorAt(0, 300), tip, view).left, 8)
})
