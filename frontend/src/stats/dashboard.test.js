import assert from 'node:assert/strict'
import test from 'node:test'

import { hottestMetric, lastNumber, linePath, stackedPaths, stackTotals, sumMeasured, thresholdLines, tightScale } from './dashboard.js'

test('unmeasured metric groups and stacked samples stay missing rather than becoming zero', () => {
  assert.equal(sumMeasured([null, undefined]), null)
  assert.equal(sumMeasured([0, null]), null)
  assert.equal(sumMeasured([0, 2]), 2)
  assert.deepEqual(stackTotals([[null, 1, 0], [undefined, 2, null]]), [null, 3, null])
  assert.equal((stackedPaths([[1, null, 2], [3, null, 4]], { min: 0, max: 10 }, 2, 10)[0].match(/M/g) || []).length, 2)
})

test('a missing terminal sample stays missing while earlier readings remain in the plot', () => {
  const values = [2, 4, null]
  assert.equal(lastNumber(values), null)
  assert.equal(linePath(values, { min: 0, max: 4 }, 2, 4).line, 'M0 2 L1 0')
})

test('the thermal maximum uses the thresholds of its hottest measured sensor', () => {
  const first = { key: 'temperature-a', value: 80, warn: 70, critical: 90 }
  const hottest = { key: 'temperature-b', value: 90, warn: 100, critical: 110 }
  assert.equal(hottestMetric([first, hottest]), hottest)
  assert.deepEqual(thresholdLines(hottestMetric([first, hottest])), [
    { value: 100, tone: 'warn' },
    { value: 110, tone: 'critical' }
  ])

  const tied = { key: 'temperature-c', value: 90, warn: 120, critical: 130 }
  assert.equal(hottestMetric([hottest, tied]), hottest, 'ties preserve the sensor order')
  assert.equal(hottestMetric([{ key: 'missing', value: null }]), null)
  assert.equal(hottestMetric([]), null)
})

test('a large raw comparison computes its scale without spreading every sample', () => {
  const values = Array.from({ length: 200000 }, (_, index) => index % 11)
  assert.deepEqual(tightScale([values]), { min: -10, max: 20 })
})
