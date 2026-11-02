import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ENDED_ERROR,
  createCameraPreview,
  describePreviewError,
  frameAllowsCamera,
  previewConstraints,
  publishingTrackFor,
  streamInfo
} from './cameraPreview.js'

// A camera track as far as the preview uses one: settings, capabilities, stop, clone and 'ended'.
function fakeTrack({ settings = {}, capabilities, readyState = 'live' } = {}) {
  const listeners = new Map()
  const track = {
    kind: 'video',
    readyState,
    clones: [],
    getSettings: () => settings,
    stop() {
      track.readyState = 'ended'
    },
    clone() {
      const copy = fakeTrack({ settings, capabilities })
      track.clones.push(copy)
      return copy
    },
    addEventListener(type, fn) {
      listeners.set(type, fn)
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type)
    },
    // The browser ending the track: it does not call stop().
    end() {
      track.readyState = 'ended'
      listeners.get('ended')?.()
    },
    listening: (type) => listeners.has(type)
  }
  if (capabilities) track.getCapabilities = () => capabilities
  return track
}

const fakeStream = (tracks) => ({ getTracks: () => tracks, getVideoTracks: () => tracks.filter((t) => t.kind === 'video') })

// getUserMedia that answers when the test says so, recording what it was asked for.
function deferredMedia() {
  const calls = []
  return {
    calls,
    mediaDevices: {
      getUserMedia(constraints) {
        let resolve
        let reject
        const promise = new Promise((res, rej) => {
          resolve = res
          reject = rej
        })
        calls.push({ constraints, resolve, reject })
        return promise
      }
    }
  }
}

function preview(options = {}) {
  const states = []
  const controller = createCameraPreview({
    createStream: fakeStream,
    frameAllowsCamera: () => true,
    onState: (s) => states.push(s),
    ...options
  })
  return { controller, states }
}

const camA = { deviceId: 'cam-a', label: 'FaceTime HD Camera' }
const camB = { deviceId: 'cam-b', label: 'USB Camera' }
const errorNamed = (name, extra = {}) => Object.assign(new Error(`${name} message`), { name, ...extra })

test('the preview asks only for the exact camera, never a size or rate', () => {
  assert.deepEqual(previewConstraints('cam-a'), { video: { deviceId: { exact: 'cam-a' } }, audio: false })
})

test('active settings are what the track reports, capabilities stay separate, nothing is invented', () => {
  const info = streamInfo(fakeTrack({
    settings: { width: 1280, height: 720, frameRate: 29.97, resizeMode: 'none', deviceId: 'cam-a' },
    capabilities: { width: { min: 1, max: 1920 }, height: { min: 1, max: 1080 }, frameRate: { min: 1, max: 60 }, facingMode: [] }
  }))
  assert.equal(info.resolution, '1280×720')
  assert.equal(info.frameRate, '30 fps')
  assert.deepEqual(info.active.map((r) => [r.label, r.value]), [
    ['Resolution', '1280×720'],
    ['Frame rate', '30 fps'],
    ['Scaling', 'Native camera mode']
  ])
  assert.deepEqual(info.supported.map((r) => [r.label, r.value]), [
    ['Resolution', 'up to 1920×1080'],
    ['Frame rate', 'up to 60 fps']
  ])
  assert.equal(info.capabilitiesReported, true)
})

test('a browser without getCapabilities or with partial settings shows only what it reported', () => {
  const info = streamInfo(fakeTrack({ settings: { width: 640, frameRate: 0, facingMode: 'user' } }))
  assert.equal(info.resolution, null, 'a width without a height is not a resolution')
  assert.equal(info.frameRate, null, 'a zero rate is unknown, not 0 fps')
  assert.deepEqual(info.active.map((r) => [r.label, r.value]), [['Facing', 'Front (user)']])
  assert.deepEqual(info.supported, [])
  assert.equal(info.capabilitiesReported, false)
  assert.deepEqual(streamInfo(null).active, [])
})

test('a getSettings that throws reads as nothing reported', () => {
  const track = fakeTrack()
  track.getSettings = () => {
    throw new Error('gone')
  }
  assert.deepEqual(streamInfo(track).active, [])
})

test('each failure becomes its own state with something to do', () => {
  assert.equal(describePreviewError(errorNamed('NotAllowedError')).kind, 'denied')
  assert.equal(describePreviewError(errorNamed('SecurityError')).kind, 'denied')
  assert.equal(describePreviewError(errorNamed('NotReadableError')).kind, 'busy')
  assert.equal(describePreviewError(errorNamed('AbortError')).kind, 'busy')
  assert.equal(describePreviewError(errorNamed('NotFoundError')).kind, 'disconnected')
  assert.equal(describePreviewError(errorNamed('OverconstrainedError', { constraint: 'deviceId' })).kind, 'disconnected')
  const unsupported = describePreviewError(errorNamed('OverconstrainedError', { constraint: 'frameRate' }))
  assert.equal(unsupported.kind, 'unsupported')
  assert.match(unsupported.title, /frameRate/)
  assert.equal(describePreviewError(errorNamed('TypeError')).kind, 'unsupported')
  assert.equal(describePreviewError(new Error('odd failure')).title, 'odd failure')
  for (const name of ['NotAllowedError', 'NotReadableError', 'NotFoundError', 'TypeError']) {
    const described = describePreviewError(errorNamed(name))
    assert.ok(described.title && described.action, `${name} has a title and an action`)
  }
})

test('a denial inside a frame that withholds the camera says the frame, not the permission, is why', () => {
  const blocked = describePreviewError(errorNamed('NotAllowedError'), { frameAllowsCamera: false })
  assert.equal(blocked.kind, 'blocked')
  assert.match(blocked.action, /own browser tab/)
  // Unknown (no policy API) stays an ordinary denial.
  assert.equal(describePreviewError(errorNamed('NotAllowedError'), { frameAllowsCamera: null }).kind, 'denied')
})

test('the frame policy is read from permissionsPolicy, then featurePolicy, else unknown', () => {
  assert.equal(frameAllowsCamera({ permissionsPolicy: { allowsFeature: (f) => f !== 'camera' } }), false)
  assert.equal(frameAllowsCamera({ featurePolicy: { allowsFeature: () => true } }), true)
  assert.equal(frameAllowsCamera({}), null)
  assert.equal(frameAllowsCamera(undefined), null)
})

test('selecting a camera goes loading, then live with its stream facts', async () => {
  const media = deferredMedia()
  const { controller, states } = preview({ mediaDevices: media.mediaDevices })
  const done = controller.select(camA)
  assert.deepEqual(states.at(-1), { status: 'loading', camera: camA })
  assert.deepEqual(media.calls[0].constraints, previewConstraints('cam-a'))
  const track = fakeTrack({ settings: { width: 640, height: 480, frameRate: 30 } })
  media.calls[0].resolve(fakeStream([track]))
  await done
  const live = states.at(-1)
  assert.equal(live.status, 'live')
  assert.equal(live.camera, camA)
  assert.equal(live.sharedWith, null)
  assert.equal(live.info.resolution, '640×480')
  assert.equal(track.readyState, 'live')
})

test('switching cameras stops the previous preview tracks before opening the next', async () => {
  const media = deferredMedia()
  const { controller, states } = preview({ mediaDevices: media.mediaDevices })
  const first = controller.select(camA)
  const trackA = fakeTrack()
  media.calls[0].resolve(fakeStream([trackA]))
  await first

  const second = controller.select(camB)
  assert.equal(trackA.readyState, 'ended', 'the first camera is released as soon as another is selected')
  assert.equal(trackA.listening('ended'), false)
  const trackB = fakeTrack()
  media.calls[1].resolve(fakeStream([trackB]))
  await second
  assert.equal(states.at(-1).camera, camB)
  assert.equal(trackB.readyState, 'live')
})

test('a camera that opens after the user moved on is stopped, not shown', async () => {
  const media = deferredMedia()
  const { controller, states } = preview({ mediaDevices: media.mediaDevices })
  const first = controller.select(camA)
  const second = controller.select(camB)
  const trackB = fakeTrack()
  media.calls[1].resolve(fakeStream([trackB]))
  await second
  // The permission prompt for A is answered last.
  const lateA = fakeTrack()
  media.calls[0].resolve(fakeStream([lateA]))
  await first
  assert.equal(lateA.readyState, 'ended')
  assert.equal(states.at(-1).camera, camB)
  assert.equal(trackB.readyState, 'live')
})

test('stopping while the camera is still opening releases it when it arrives', async () => {
  const media = deferredMedia()
  const { controller, states } = preview({ mediaDevices: media.mediaDevices })
  const pending = controller.select(camA)
  controller.stop()
  assert.deepEqual(states.at(-1), { status: 'idle' })
  const track = fakeTrack()
  media.calls[0].resolve(fakeStream([track]))
  await pending
  assert.equal(track.readyState, 'ended')
  assert.deepEqual(states.at(-1), { status: 'idle' })
})

test('stop releases the preview tracks and goes idle; a failure arriving late is ignored', async () => {
  const media = deferredMedia()
  const { controller, states } = preview({ mediaDevices: media.mediaDevices })
  const first = controller.select(camA)
  const track = fakeTrack()
  media.calls[0].resolve(fakeStream([track]))
  await first
  controller.stop()
  assert.equal(track.readyState, 'ended')
  assert.deepEqual(controller.state, { status: 'idle' })

  const failing = controller.select(camB)
  controller.stop()
  media.calls[1].reject(errorNamed('NotAllowedError'))
  await failing
  assert.deepEqual(states.at(-1), { status: 'idle' })
})

test('a camera this tab is publishing is previewed from a clone; stopping the preview leaves the publish alone', async () => {
  const media = deferredMedia()
  const { controller, states } = preview({ mediaDevices: media.mediaDevices })
  const publishing = fakeTrack({ settings: { deviceId: 'cam-a', width: 1920, height: 1080, frameRate: 30 } })
  await controller.select(camA, { shared: { track: publishing, index: 3 } })
  assert.equal(media.calls.length, 0, 'the device is not opened a second time')
  const live = states.at(-1)
  assert.equal(live.status, 'live')
  assert.equal(live.sharedWith, 3)
  assert.equal(live.info.resolution, '1920×1080')
  assert.equal(publishing.clones.length, 1)

  controller.stop()
  assert.equal(publishing.clones[0].readyState, 'ended', 'the clone is the preview\'s and is released')
  assert.equal(publishing.readyState, 'live', 'the publishing track keeps running')
})

test('a publish whose track has ended is not cloned; the device is opened instead', async () => {
  const media = deferredMedia()
  const { controller } = preview({ mediaDevices: media.mediaDevices })
  const done = controller.select(camA, { shared: { track: fakeTrack({ readyState: 'ended' }), index: 1 } })
  assert.equal(media.calls.length, 1)
  media.calls[0].resolve(fakeStream([fakeTrack()]))
  await done
})

test('the camera going away mid-preview shows the disconnected state and releases the stream', async () => {
  const media = deferredMedia()
  const { controller, states } = preview({ mediaDevices: media.mediaDevices })
  const done = controller.select(camA)
  const track = fakeTrack()
  media.calls[0].resolve(fakeStream([track]))
  await done
  track.end()
  assert.deepEqual(states.at(-1), { status: 'error', camera: camA, error: ENDED_ERROR })
  assert.equal(track.listening('ended'), false)
})

test('permission denied, busy and missing cameras each end in an error state for that camera', async () => {
  for (const [name, kind] of [['NotAllowedError', 'denied'], ['NotReadableError', 'busy'], ['NotFoundError', 'disconnected']]) {
    const media = deferredMedia()
    const { controller, states } = preview({ mediaDevices: media.mediaDevices })
    const done = controller.select(camA)
    media.calls[0].reject(errorNamed(name))
    await done
    assert.equal(states.at(-1).status, 'error')
    assert.equal(states.at(-1).camera, camA)
    assert.equal(states.at(-1).error.kind, kind)
  }
})

test('a denial in a frame without camera permission reports the frame', async () => {
  const media = deferredMedia()
  const { controller, states } = preview({ mediaDevices: media.mediaDevices, frameAllowsCamera: () => false })
  const done = controller.select(camA)
  media.calls[0].reject(errorNamed('NotAllowedError'))
  await done
  assert.equal(states.at(-1).error.kind, 'blocked')
})

test('no camera API (an insecure page) and a stream without video are unsupported', async () => {
  const noApi = preview({ mediaDevices: undefined })
  await noApi.controller.select(camA)
  assert.equal(noApi.states.at(-1).error.kind, 'unsupported')
  assert.match(noApi.states.at(-1).error.action, /HTTPS/)

  const media = deferredMedia()
  const { controller, states } = preview({ mediaDevices: media.mediaDevices })
  const done = controller.select(camA)
  const audioOnly = { kind: 'audio', readyState: 'live', stop() { audioOnly.readyState = 'ended' } }
  media.calls[0].resolve(fakeStream([audioOnly]))
  await done
  assert.equal(states.at(-1).error.kind, 'unsupported')
  assert.equal(audioOnly.readyState, 'ended')
})

test('refresh re-reads the settings of the live track', async () => {
  const media = deferredMedia()
  const { controller, states } = preview({ mediaDevices: media.mediaDevices })
  const settings = { width: 640, height: 480 }
  const track = fakeTrack({ settings })
  const done = controller.select(camA)
  media.calls[0].resolve(fakeStream([track]))
  await done
  settings.width = 1280
  settings.height = 720
  controller.refresh()
  assert.equal(states.at(-1).info.resolution, '1280×720')
  controller.stop()
  const count = states.length
  controller.refresh()
  assert.equal(states.length, count, 'refresh does nothing when no preview is live')
})

test('the publishing track is found by its device, or by the slot assignment when settings lack one', () => {
  const live = fakeTrack({ settings: { deviceId: 'cam-a' } })
  const noId = fakeTrack({ settings: {} })
  const ended = fakeTrack({ settings: { deviceId: 'cam-c' }, readyState: 'ended' })
  const sessions = new Map([
    [2, { stream: fakeStream([live]) }],
    [5, { stream: fakeStream([noId]) }],
    [7, { stream: fakeStream([ended]) }],
    [8, { stream: null }]
  ])
  const assignments = { 2: { deviceId: 'cam-a' }, 5: { deviceId: 'cam-b' }, 7: { deviceId: 'cam-c' } }
  assert.deepEqual(publishingTrackFor(sessions, assignments, 'cam-a'), { track: live, index: 2 })
  assert.deepEqual(publishingTrackFor(sessions, assignments, 'cam-b'), { track: noId, index: 5 })
  assert.equal(publishingTrackFor(sessions, assignments, 'cam-c'), null, 'an ended publish is not shared')
  assert.equal(publishingTrackFor(sessions, assignments, 'cam-z'), null)
  assert.equal(publishingTrackFor(null, assignments, 'cam-a'), null)
})

test("Strict Mode's select, stop, select opens the camera once and keeps that capture", async () => {
  const media = deferredMedia()
  const { controller, states } = preview({ mediaDevices: media.mediaDevices })
  const first = controller.select(camA)
  controller.stop()
  const second = controller.select(camA)
  assert.equal(media.calls.length, 1, 'the second select waits for the request already in flight')
  const track = fakeTrack()
  media.calls[0].resolve(fakeStream([track]))
  await Promise.all([first, second])
  assert.equal(track.readyState, 'live', 'the stale select does not stop the stream the current one took over')
  assert.equal(states.at(-1).status, 'live')
  assert.equal(states.at(-1).camera, camA)
  controller.stop()
  assert.equal(track.readyState, 'ended')
})

test('A, B, then A again while A is still opening asks the browser for A only once', async () => {
  const media = deferredMedia()
  const { controller, states } = preview({ mediaDevices: media.mediaDevices })
  const a1 = controller.select(camA)
  const b = controller.select(camB)
  const a2 = controller.select(camA)
  assert.deepEqual(media.calls.map((c) => c.constraints.video.deviceId.exact), ['cam-a', 'cam-b'])
  const trackB = fakeTrack()
  const trackA = fakeTrack()
  media.calls[1].resolve(fakeStream([trackB]))
  media.calls[0].resolve(fakeStream([trackA]))
  await Promise.all([a1, b, a2])
  assert.equal(trackB.readyState, 'ended', 'B was overtaken and is released')
  assert.equal(trackA.readyState, 'live')
  assert.equal(states.at(-1).camera, camA)
})

test('a reused request that is stopped before it opens is released, and a new select opens the camera again', async () => {
  const media = deferredMedia()
  const { controller, states } = preview({ mediaDevices: media.mediaDevices })
  const first = controller.select(camA)
  controller.stop()
  const second = controller.select(camA)
  controller.stop()
  const track = fakeTrack()
  media.calls[0].resolve(fakeStream([track]))
  await Promise.all([first, second])
  assert.equal(track.readyState, 'ended', 'nobody wanted it, so it is stopped')
  assert.deepEqual(states.at(-1), { status: 'idle' })

  // The settled request is forgotten: the next select asks the browser again.
  const third = controller.select(camA)
  assert.equal(media.calls.length, 2)
  media.calls[1].resolve(fakeStream([fakeTrack()]))
  await third
  assert.equal(states.at(-1).status, 'live')
})

test('a reused request that fails shows the error once, for the current select only', async () => {
  const media = deferredMedia()
  const { controller, states } = preview({ mediaDevices: media.mediaDevices })
  const first = controller.select(camA)
  controller.stop()
  const second = controller.select(camA)
  media.calls[0].reject(errorNamed('NotReadableError'))
  await Promise.all([first, second])
  assert.equal(states.filter((s) => s.status === 'error').length, 1)
  assert.equal(states.at(-1).error.kind, 'busy')
})
