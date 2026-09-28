import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PREVIEW_IDLE,
  apiError,
  createBoardSync,
  createFocusReturn,
  nextPreviewState,
  normalizeError,
  previewBlock,
  previewErrorInfo,
  previewStatusInfo,
  safeHref
} from './model.js'

test('only http(s) links are rendered', () => {
  assert.equal(safeHref('https://github.com/sima-neat/core/issues/838'), 'https://github.com/sima-neat/core/issues/838')
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref(undefined), null)
})

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function boardSyncHarness() {
  const requests = []
  const state = { board: null, error: null, loading: false, errors: 0 }
  const sync = createBoardSync({
    fetchBoard: () => {
      const request = deferred()
      requests.push(request)
      return request.promise
    },
    onBoard: (data) => { state.board = data; state.error = null },
    onError: (err) => { state.error = err; state.errors += 1 },
    onLoading: (value) => { state.loading = value }
  })
  return { sync, requests, state }
}

const boardA = { target: { label: 'sima@192.168.2.2' }, generation: 1 }
const boardB = { target: { label: 'sima@192.168.2.9' }, generation: 2 }

test('a board read that was sent before a board change cannot undo it', async () => {
  const { sync, requests, state } = boardSyncHarness()
  const load = sync.load()
  sync.apply(boardB) // the POST that selected B answered first
  requests[0].resolve(boardA) // then the older GET, answered before the change
  assert.equal(await load, boardB, 'the superseded read reports the state that won')
  assert.equal(state.board, boardB)
  assert.equal(state.loading, false)
})

test('a failed board read that was superseded does not raise an error', async () => {
  const { sync, requests, state } = boardSyncHarness()
  const load = sync.load()
  sync.apply(boardB)
  requests[0].reject(new Error('network'))
  await load
  assert.equal(state.errors, 0)
  assert.equal(state.board, boardB)
})

test('overlapping board reads keep the newest answer, whatever order they arrive in', async () => {
  const { sync, requests, state } = boardSyncHarness()
  const first = sync.load()
  const second = sync.load()
  requests[1].resolve(boardB)
  requests[0].resolve(boardA)
  assert.deepEqual([await first, await second], [boardB, boardB])
  assert.equal(state.board, boardB)
  assert.equal(state.loading, false)
})

function fakeControl(name) {
  return { name, disabled: false, isConnected: true, focused: 0, focus() { this.focused += 1 } }
}

test('collapsing a disclosure gives focus back to the control that opened it', () => {
  const refs = { trust: null, change: fakeControl('change'), section: fakeControl('section') }
  const focusReturn = createFocusReturn()
  // Cancel is pressed while the confirmation is open: its opener is not rendered yet.
  focusReturn.request(() => [refs.trust, refs.change, refs.section])
  refs.trust = fakeControl('trust') // the re-render puts "Trust new key…" back
  assert.equal(focusReturn.flush(), refs.trust)
  assert.equal(refs.trust.focused, 1)
  assert.equal(refs.change.focused, 0)
})

const CORE_838 = { label: 'core#838', url: 'https://github.com/sima-neat/core/issues/838' }
const support = (tier, reason = '', links = []) => ({ tier, reason, links })
const rates = (...pairs) => pairs.map(([value, tier]) => ({ value, tier }))
const size = (width, height, ...pairs) => ({ width, height, fps: rates(...pairs) })
const format = (name, label, exportable, formatSupport, sizes, range = null) => ({ format: name, label, exportable, support: formatSupport, range, sizes })
const available = { state: 'available', users: [], reason: null }

const imx477 = {
  id: 'mipi:/base/axi/pcie@120000/rp1/i2c@80000/imx477@1a',
  kind: 'camera',
  connection: 'mipi',
  name: '/base/axi/pcie@120000/rp1/i2c@80000/imx477@1a',
  model: 'imx477',
  device: {
    camera_name: '/base/axi/pcie@120000/rp1/i2c@80000/imx477@1a',
    camera_name_source: 'libcamera',
    media_device: '/dev/media0',
    bus_info: 'platform:csi2video@1',
    csi: 'csidev-40c3000.csi',
    video_node: '/dev/video3'
  },
  availability: available,
  support: support('verified', 'imx477 NV12 1920x1080 at 30 fps is verified with Core CameraInput.'),
  modes_source: 'live',
  formats: [
    format('NV12', 'NV12 (YUV 4:2:0)', true, support('verified'), [
      size(1920, 1080, [30, 'verified'], [60, 'advertised']),
      size(1280, 720, [60, 'advertised'])
    ])
  ],
  default_selection: { format: 'NV12', width: 1920, height: 1080, fps: 30 },
  notes: [],
  errors: []
}

const imx568 = {
  id: 'mipi:econ-imx568-fpga 5-0042',
  kind: 'camera',
  connection: 'mipi',
  name: 'econ-imx568-fpga 5-0042',
  model: 'imx568',
  device: { camera_name: 'econ-imx568-fpga 5-0042', camera_name_source: 'media-graph', media_device: '/dev/media0' },
  availability: { state: 'unknown', users: [], reason: 'fuser is not installed on the board.' },
  support: support('advertised', 'imx568 is enumerated by libcamera but not verified with Core.', [CORE_838]),
  modes_source: 'live',
  formats: [
    format('NV12', 'NV12 (YUV 4:2:0)', true, support('advertised'), [
      size(2432, 2048, [30, 'advertised']),
      size(1920, 1080, [30, 'advertised'], [59.94, 'advertised'])
    ], { min_width: 64, min_height: 64, max_width: 2432, max_height: 2048, step_width: 2, step_height: 2 }),
    format('RGB888', 'RGB888', false, support('unsupported', 'Core CameraInput outputs NV12 only.'), [size(1920, 1080, [30, 'unsupported'])])
  ],
  default_selection: null,
  notes: ['Sensor crop rectangle could not be read; defaults were used.'],
  errors: []
}

const inUse = {
  ...imx477,
  id: 'mipi:/base/axi/i2c@88000/imx477@1a',
  name: '/base/axi/i2c@88000/imx477@1a',
  device: { camera_name: '/base/axi/i2c@88000/imx477@1a', camera_name_source: 'libcamera' },
  availability: { state: 'in_use', users: [{ pid: 812, command: 'gst-launch-1.0' }], reason: null },
  modes_source: 'previous-scan'
}

const usb = {
  id: 'usb:046d:0825:1-1.2',
  kind: 'camera',
  connection: 'usb',
  name: 'HD Webcam C270',
  model: 'HD Webcam C270',
  device: {
    video_node: '/dev/video0',
    by_id: '/dev/v4l/by-id/usb-046d_0825_2F6D4A10-video-index0',
    usb: { vendor_id: '046d', product_id: '0825', manufacturer: 'Logitech', product: 'HD Webcam C270', serial: null, bus_path: '1-1.2', speed_mbps: 480 }
  },
  availability: available,
  support: support('unsupported', 'Core CameraInput supports MIPI (libcamera) cameras only.', [CORE_838]),
  modes_source: 'live',
  formats: [
    format('MJPG', 'Motion-JPEG', true, support('unsupported'), [size(1280, 720, [30, 'unsupported']), size(640, 480, [30, 'unsupported'])]),
    format('YUYV', 'YUYV 4:2:2', true, support('unsupported'), [size(640, 480, [30, 'unsupported'], [15, 'unsupported'])])
  ],
  default_selection: { format: 'MJPG', width: 1280, height: 720, fps: 30 },
  notes: [],
  errors: []
}

const mipiMode = { format: 'NV12', width: 1920, height: 1080, fps: 30 }
const boardTarget = { mode: 'ssh', label: 'sima@192.168.2.2' }
const liveSession = {
  id: '8f1c',
  camera_id: imx477.id,
  mode: mipiMode,
  channel: 3,
  viewer_url: 'https://host:8081/static/viewer.html?mode=light&src=3',
  generation: 3,
  heartbeat_interval_ms: 5000,
  state: 'live'
}

test('Start preview is blocked with the reason for every state that forbids it', () => {
  assert.deepEqual(previewBlock({ camera: imx477, selection: mipiMode, target: boardTarget }), { blocked: false, reason: '' })

  assert.match(previewBlock({ camera: imx477, selection: mipiMode, target: null }).reason, /No board is selected/)
  assert.match(previewBlock({ camera: null, selection: null, target: boardTarget }).reason, /Select a camera/)
  assert.match(previewBlock({ camera: imx477, selection: mipiMode, target: boardTarget, stale: true }).reason, /board changed/)

  // A camera Core cannot open (USB, core#838) can still be exported, never previewed.
  assert.equal(previewBlock({ camera: usb, selection: { format: 'MJPG', width: 1280, height: 720, fps: 30 }, target: boardTarget }).reason, usb.support.reason)

  assert.match(previewBlock({ camera: imx477, selection: null, target: boardTarget }).reason, /no mode Insight can start/)

  const unvalidated = { ...imx477, formats: [format('NV12', 'NV12', true, support('advertised'), [size(1920, 1080, [30, 'unsupported'])])] }
  assert.match(previewBlock({ camera: unvalidated, selection: mipiMode, target: boardTarget }).reason, /is not validated on this board/)

  assert.match(previewBlock({ camera: inUse, selection: mipiMode, target: boardTarget }).reason, /In use by gst-launch-1\.0 \(pid 812\)/)

  const elsewhere = previewBlock({ camera: imx477, selection: mipiMode, target: boardTarget, session: { ...liveSession, camera_id: imx568.id } })
  assert.match(elsewhere.reason, /already running on mipi:econ-imx568-fpga 5-0042/)
  assert.equal(previewBlock({ camera: imx477, selection: mipiMode, target: boardTarget, session: liveSession }).blocked, false)
})

test('preview transitions: start, live, stop', () => {
  const starting = nextPreviewState(PREVIEW_IDLE, { type: 'start' })
  assert.deepEqual(starting, { status: 'starting', session: null, error: null })

  const pending = nextPreviewState(starting, { type: 'session', session: { ...liveSession, state: 'starting' } })
  assert.equal(pending.status, 'starting')
  assert.equal(pending.session.id, '8f1c')

  const live = nextPreviewState(pending, { type: 'session', session: liveSession })
  assert.equal(live.status, 'live')
  assert.equal(previewStatusInfo(live).label, 'Live')

  const stopping = nextPreviewState(live, { type: 'stopping', for: '8f1c' })
  assert.equal(stopping.status, 'stopping')
  assert.equal(stopping.session.id, '8f1c', 'the channel stays on screen while the board stops')
  assert.deepEqual(nextPreviewState(stopping, { type: 'stopped', for: '8f1c' }), PREVIEW_IDLE)

  // The board reporting "stopped" on a heartbeat ends the session too.
  assert.deepEqual(nextPreviewState(live, { type: 'session', session: { ...liveSession, state: 'stopped' } }), PREVIEW_IDLE)
})

test('preview transitions: a start that was never adopted still releases the page', () => {
  // Selecting another camera mid-start: the response belongs to the old camera, so the page stops
  // that session instead of adopting it. Those events carry an id the page never held.
  const starting = nextPreviewState(PREVIEW_IDLE, { type: 'start' })
  assert.equal(starting.status, 'starting')
  assert.equal(starting.session, null)
  const stopping = nextPreviewState(starting, { type: 'stopping', for: 'never-adopted' })
  assert.equal(stopping.status, 'stopping')
  const stopped = nextPreviewState(stopping, { type: 'stopped', for: 'never-adopted' })
  assert.deepEqual(stopped, PREVIEW_IDLE)
})

test('preview transitions: a stale session id never disturbs a newer one', () => {
  const live = nextPreviewState(nextPreviewState(PREVIEW_IDLE, { type: 'start' }), { type: 'session', session: liveSession })
  assert.equal(nextPreviewState(live, { type: 'ended', for: 'old-id' }), live)
  assert.equal(nextPreviewState(live, { type: 'stopped', for: 'old-id' }), live)
  assert.equal(nextPreviewState(live, { type: 'stopping', for: 'old-id' }), live)
  assert.equal(nextPreviewState(live, { type: 'failed', for: 'old-id', error: { message: 'boom' } }), live)
  assert.equal(nextPreviewState(live, { type: 'session', session: { ...liveSession, id: 'other' } }), live)

  const expired = nextPreviewState(live, { type: 'ended', for: '8f1c' })
  assert.equal(expired.status, 'idle')
  assert.equal(expired.session, null)
  assert.match(expired.error.message, /stopped receiving heartbeats/)
  assert.ok(expired.error.hint, 'an expiry always offers a way back')
})

test('preview transitions: failures, reset, and adopting an existing session', () => {
  const starting = nextPreviewState(PREVIEW_IDLE, { type: 'start' })
  const failed = nextPreviewState(starting, { type: 'failed', error: { message: 'Camera in use', code: 'camera_in_use' } })
  assert.equal(failed.status, 'error')
  assert.equal(previewStatusInfo(failed).label, 'Could not start')
  // A late response from the failed attempt must not put the pane back in "live".
  assert.equal(nextPreviewState(failed, { type: 'session', session: liveSession }), failed)
  assert.deepEqual(nextPreviewState(failed, { type: 'reset' }), PREVIEW_IDLE)

  const adopted = nextPreviewState(PREVIEW_IDLE, { type: 'adopt', session: liveSession })
  assert.equal(adopted.status, 'live')
  assert.equal(adopted.session.channel, 3)
  assert.deepEqual(nextPreviewState(PREVIEW_IDLE, { type: 'adopt', session: { ...liveSession, state: 'stopped' } }), PREVIEW_IDLE)
  assert.deepEqual(nextPreviewState(PREVIEW_IDLE, { type: 'adopt', session: null }), PREVIEW_IDLE)

  const live = nextPreviewState(starting, { type: 'session', session: liveSession })
  const stopping = nextPreviewState(starting, { type: 'stopping', for: liveSession.id, session: liveSession })
  const stopFailed = nextPreviewState(stopping, { type: 'stop-failed', for: liveSession.id, error: { message: 'SSH failed' } })
  assert.equal(stopFailed.status, 'live')
  assert.equal(stopFailed.session.id, liveSession.id)
  assert.equal(stopFailed.error.message, 'SSH failed')
  assert.equal(nextPreviewState(live, { type: 'nonsense' }), live)
  assert.equal(nextPreviewState(undefined, { type: 'nonsense' }), PREVIEW_IDLE)
})

test('every preview failure carries a recovery action and nothing destructive', () => {
  assert.equal(previewErrorInfo(null), null)

  const busy = previewErrorInfo(normalizeError(apiError({
    error: 'The camera is already open.',
    code: 'camera_in_use',
    hint: 'gst-launch-1.0 (pid 812) has /dev/video3 open.'
  }, 409)))
  assert.equal(busy.hint, 'gst-launch-1.0 (pid 812) has /dev/video3 open.')
  assert.match(busy.action, /Insight never stops it for you/)

  // The backend puts camera_id at the top level of the 409 body.
  const flat = previewErrorInfo(normalizeError(apiError({ error: 'x', code: 'preview_active', camera_id: usb.id }, 409)))
  assert.equal(flat.otherCamera, usb.id)

  assert.match(previewErrorInfo(normalizeError(apiError({ error: 'x', code: 'no_channel' }, 409))).action, /Stop a stream on the Streaming page/)
  // The two failures that come from the network between the board and Insight must say so.
  assert.match(previewErrorInfo(normalizeError(apiError({ error: 'x', code: 'no_video' }, 502))).action, /firewall/)
  assert.match(previewErrorInfo(normalizeError(apiError({ error: 'x', code: 'viewer_unavailable' }, 502))).action, /video viewer/)
  assert.match(previewErrorInfo(normalizeError(apiError({ error: 'x', code: 'invalid_request' }, 400))).action, /verified or advertised/)

  const failed = previewErrorInfo(normalizeError(apiError({ error: 'x', code: 'command_failed', detail: 'gst: no element' }, 502)))
  assert.equal(failed.detail, 'gst: no element')
  assert.equal(previewErrorInfo(normalizeError(apiError({ error: 'x', code: 'unreachable' }, 502))).action, '')
})

test('a preview viewer address is only loaded when it is an http(s) URL', () => {
  assert.equal(safeHref(liveSession.viewer_url), liveSession.viewer_url)
  assert.equal(safeHref('javascript:alert(1)'), null)
})

