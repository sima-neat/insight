import assert from 'node:assert/strict'
import test from 'node:test'

import { canRefreshCatalog, catalogIdentity, createCatalogPolicy, deviceTypes, isExportableMode, modeKey, modeLabel, resolveSelection, validateBoardForm } from './model.js'

test('device tabs are generic, counted, and sorted', () => {
  assert.deepEqual(deviceTypes([
    { type: 'lidar' }, { type: 'camera' }, { type: 'camera' }, { future: true }
  ]), [
    { id: 'camera', count: 2, label: 'Cameras' },
    { id: 'lidar', count: 1, label: 'Lidars' }
  ])
})

test('mode labels retain discrete and ranged camera modes', () => {
  assert.equal(modeLabel({ format: 'NV12', width: 1920, height: 1080, framerate_num: 30, framerate_den: 1 }), 'NV12 · 1920×1080 · 30 fps')
  assert.equal(modeLabel({
    format: 'NV12',
    size_range: { min_width: 640, max_width: 1920, min_height: 480, max_height: 1080 },
    framerate_num: 30000,
    framerate_den: 1001
  }), 'NV12 · 640–1920 × 480–1080 · 29.97 fps')
})

test('only exact supported CameraInput modes can be exported', () => {
  const camera = { camera_name: 'platform/cam0' }
  const mode = { supported: true, width: 1920, height: 1080 }
  assert.equal(isExportableMode(camera, mode), true)
  assert.equal(isExportableMode({}, mode), false)
  assert.equal(isExportableMode(camera, { ...mode, supported: false }), false)
  assert.equal(isExportableMode(camera, { supported: true, size_range: {} }), false)
})

test('daemon restarts invalidate selections even when revisions collide', () => {
  assert.notEqual(
    catalogIdentity({ instance_id: 'daemon-a', revision: 1 }),
    catalogIdentity({ instance_id: 'daemon-b', revision: 1 })
  )
})

test('catalog progress reaches a follow-up scan even when it emits no device event', () => {
  const policy = createCatalogPolicy()
  const initial = { board_generation: 3, instance_id: 'daemon-a', scan_sequence: 4, revision: 2, sequence: 8 }
  const activeScan = { ...initial, scan_sequence: 5, revision: 3, sequence: 9 }
  const unchangedFollowUp = { ...activeScan, scan_sequence: 6 }
  assert.equal(policy.merge(initial), initial)
  assert.equal(policy.merge(activeScan), activeScan)
  assert.equal(policy.merge(unchangedFollowUp), unchangedFollowUp)
  assert.equal(policy.merge(activeScan), unchangedFollowUp)
})

test('a delayed response from a retired daemon instance cannot replace its successor', () => {
  const policy = createCatalogPolicy()
  const oldDaemon = { board_generation: 3, instance_id: 'daemon-a', scan_sequence: 9, revision: 7, sequence: 12 }
  const restarted = { board_generation: 3, instance_id: 'daemon-b', scan_sequence: 1, revision: 1, sequence: 0 }
  assert.equal(policy.merge(oldDaemon), oldDaemon)
  assert.equal(policy.merge(restarted), restarted)
  assert.equal(policy.merge(oldDaemon), restarted)
})

test('an older in-flight response from an unknown daemon cannot replace a newer restart', () => {
  const policy = createCatalogPolicy()
  const original = { board_generation: 3, instance_id: 'daemon-a', scan_sequence: 9, revision: 7, sequence: 12 }
  const delayed = { board_generation: 3, instance_id: 'daemon-b', scan_sequence: 1, revision: 1, sequence: 0 }
  const current = { board_generation: 3, instance_id: 'daemon-c', scan_sequence: 1, revision: 1, sequence: 0 }
  policy.merge(original)
  const delayedRequest = policy.begin()
  const currentRequest = policy.begin()
  assert.equal(policy.merge(current, currentRequest), current)
  assert.equal(policy.merge(delayed, delayedRequest), current)
})

test('refresh stays disabled until it can be bound to a known daemon instance', () => {
  assert.equal(canRefreshCatalog(null), false)
  assert.equal(canRefreshCatalog({ instance_id: '' }), false)
  assert.equal(canRefreshCatalog({ instance_id: 'daemon-a' }), true)
  assert.equal(canRefreshCatalog({ instance_id: 'daemon-a' }, true), false)
})

test('board selection rejects unsafe or invalid endpoint fields', () => {
  assert.deepEqual(validateBoardForm({ host: ' 10.0.0.2 ', port: '22', user: 'sima' }), {
    body: { host: '10.0.0.2', port: 22, user: 'sima' }
  })
  assert.match(validateBoardForm({ host: 'bad host', port: '22', user: 'sima' }).error, /without spaces/)
  assert.match(validateBoardForm({ host: 'board', port: '70000', user: 'sima' }).error, /1 to 65535/)
})

test('the selected device and mode survive a catalog revision while both still exist', () => {
  const mode = (width, height) => ({ format: 'NV12', width, height, framerate_num: 30, framerate_den: 1 })
  const camera = (id, modes) => ({ id, type: 'camera', camera: { modes } })
  const before = [camera('camera:a', [mode(1920, 1080), mode(1280, 720)]), camera('camera:b', [mode(640, 480)])]
  const wanted = modeKey(mode(1280, 720))
  assert.deepEqual(resolveSelection(before, 'camera:a', wanted), { device: before[0], modeIndex: 1 })
  // A device plugged in ahead of it and a mode added ahead of it move nothing.
  const after = [camera('camera:0', []), camera('camera:a', [mode(3840, 2160), mode(1920, 1080), mode(1280, 720)])]
  assert.deepEqual(resolveSelection(after, 'camera:a', wanted), { device: after[1], modeIndex: 2 })
  // A removed mode falls back to the device's first mode; a removed device to the first device.
  assert.deepEqual(resolveSelection([camera('camera:a', [mode(1920, 1080)])], 'camera:a', wanted).modeIndex, 0)
  assert.deepEqual(resolveSelection(after.slice(0, 1), 'camera:a', wanted), { device: after[0], modeIndex: 0 })
  assert.notEqual(modeKey({ ...mode(1280, 720), framerate_num: 60 }), wanted)
})
