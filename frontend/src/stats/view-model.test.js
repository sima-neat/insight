// The derivations behind the compact Stats layout, which fold detail behind chips and
// disclosures without taking any value off the page.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chipKeyTarget,
  metricGroupChips,
  metricsModel,
  openGroup
} from './model.js'

const group = (name, statuses) => ({
  name,
  metrics: statuses.map((status, index) => ({ key: `${name}-${index}`, label: `${name} ${index}`, status, value: 1 }))
})

test('metric groups become chips that carry their size and anything past a threshold', () => {
  const chips = metricGroupChips([group('CPU', ['ok', 'warn', 'critical', 'critical']), group('Disk', ['ok', 'warn']), group('APU', ['ok'])])
  assert.deepEqual(chips.map((chip) => [chip.label, chip.count]), [['CPU', 4], ['Disk', 2], ['APU', 1]])
  // A group used to open by itself when it held a critical metric. Groups now start closed,
  // so the chip is what says so, and a critical outranks a warning.
  assert.deepEqual(chips[0].alert, { tone: 'critical', count: 2 })
  assert.deepEqual(chips[1].alert, { tone: 'warn', count: 1 })
  assert.equal(chips[2].alert, null)
  assert.deepEqual(metricGroupChips(null), [])
})

test('the open group is remembered by name, so a live refresh keeps it open', () => {
  const first = metricsModel({ groups: [group('CPU', ['ok']), group('Disk', ['ok'])] })
  // Nothing is open until someone opens it.
  assert.equal(openGroup(first.groups, ''), null)
  assert.equal(openGroup(first.groups, 'Disk').name, 'Disk')
  // The next poll builds new objects; the same name still finds the group.
  const next = metricsModel({ groups: [group('CPU', ['warn']), group('Disk', ['critical'])] })
  assert.equal(openGroup(next.groups, 'Disk').metrics[0].status, 'critical')
  // A sample without that group shows nothing rather than another group.
  assert.equal(openGroup(metricsModel({ groups: [group('CPU', ['ok'])] }).groups, 'Disk'), null)
})

test('arrow keys walk the chips in reading order and wrap at both ends', () => {
  assert.equal(chipKeyTarget('ArrowRight', 0, 3), 1)
  assert.equal(chipKeyTarget('ArrowRight', 2, 3), 0)
  assert.equal(chipKeyTarget('ArrowLeft', 0, 3), 2)
  assert.equal(chipKeyTarget('Home', 2, 3), 0)
  assert.equal(chipKeyTarget('End', 0, 3), 2)
  // A focus index that no longer exists starts from the first chip.
  assert.equal(chipKeyTarget('ArrowRight', 7, 3), 1)
  assert.equal(chipKeyTarget('Enter', 0, 3), null)
  assert.equal(chipKeyTarget('ArrowDown', 0, 3), null)
  assert.equal(chipKeyTarget('ArrowRight', 0, 0), null)
})
