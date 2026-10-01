import assert from 'node:assert/strict'
import test from 'node:test'

import { stackedPaths, stackTotals, sumMeasured } from './dashboard.js'

test('unmeasured metric groups and stacked samples stay missing rather than becoming zero', () => {
  assert.equal(sumMeasured([null, undefined]), null)
  assert.equal(sumMeasured([0, null]), null)
  assert.equal(sumMeasured([0, 2]), 2)
  assert.deepEqual(stackTotals([[null, 1, 0], [undefined, 2, null]]), [null, 3, null])
  assert.equal((stackedPaths([[1, null, 2], [3, null, 4]], { min: 0, max: 10 }, 2, 10)[0].match(/M/g) || []).length, 2)
})
