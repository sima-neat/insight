import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiError,
  cameraSummaryLine,
  createBoardSync,
  createFocusReturn,
  deviceRows,
  deviceTabs,
  formatOptions,
  fpsOptions,
  groupCameras,
  groupOptions,
  initialBoardForm,
  isSnapshotStale,
  normalizeError,
  optionTier,
  resolveCameraId,
  resolveDeviceKind,
  resolveSelection,
  safeHref,
  sameSelection,
  sizeOptions,
  sortIssues,
  validateBoardForm
} from './model.js'

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

const snapshot = {
  generation: 3,
  scanned_at: '2026-09-21T10:00:00Z',
  items: [usb, imx477, { id: 'mic:0', kind: 'microphone', connection: 'usb', name: 'USB mic' }, imx568, inUse],
  issues: [
    { severity: 'info', code: 'no_usb_power', message: 'USB hub reports low power.', hint: 'Use a powered hub.' },
    { severity: 'error', code: 'tool_missing', message: 'v4l2-ctl is missing.', hint: 'Install v4l-utils on the board.' },
    { severity: 'warning', code: 'no_fuser', message: 'Availability is unknown.', hint: 'Install psmisc.' }
  ],
  changes: { added: [{ id: usb.id, name: usb.name }], removed: [{ id: 'mipi:gone', name: 'imx219' }] }
}

test('cameras are grouped MIPI first, then USB, and other kinds are ignored', () => {
  const groups = groupCameras(snapshot.items)
  assert.deepEqual(groups.map((g) => g.id), ['mipi', 'usb'])
  assert.deepEqual(groups[0].items.map((c) => c.id), [imx477.id, imx568.id, inUse.id])
  assert.deepEqual(groups[1].items.map((c) => c.id), [usb.id])
  assert.deepEqual(groupCameras([]), [])
})

test('format options disable non-exportable formats and keep their reason', () => {
  const [nv12, rgb] = formatOptions(imx568)
  assert.deepEqual([nv12.disabled, nv12.tier, nv12.range.max_width], [false, 'advertised', 2432])
  assert.deepEqual([rgb.disabled, rgb.tier, rgb.reason], [true, 'unsupported', 'Core CameraInput outputs NV12 only.'])
  const ranged = formatOptions({ formats: [format('YUYV', 'YUYV', false, support('unsupported', 'No discrete sizes.'), [], {
    min_width: 16, min_height: 16, max_width: 1920, max_height: 1080, step_width: 16, step_height: 16
  })] })[0]
  assert.match(ranged.reason, /Reported range: 16–1920×16–1080 in 16×16 steps\./)
})

test('size and fps options carry their best support tier', () => {
  assert.deepEqual(sizeOptions(imx477, 'NV12').map((o) => [o.value, o.tier]), [['1920x1080', 'verified'], ['1280x720', 'advertised']])
  assert.deepEqual(fpsOptions(imx477, 'NV12', 1920, 1080).map((o) => [o.value, o.tier]), [['30', 'verified'], ['60', 'advertised']])
  assert.deepEqual(fpsOptions(imx568, 'NV12', 1920, 1080).map((o) => o.value), ['30', '59.94'])
  assert.deepEqual(sizeOptions(imx477, 'RGB888'), [])
})

test('resolveSelection prefers the wanted mode, then the default, then the best exportable mode', () => {
  const mode = (format, width, height, fps) => ({ format, width, height, fps })
  const shrunk = { ...imx477, formats: [{ ...imx477.formats[0], sizes: [imx477.formats[0].sizes[0]] }] }
  const cases = [
    [imx477, null, mode('NV12', 1920, 1080, 30)],
    [usb, null, mode('MJPG', 1280, 720, 30)],
    [imx568, null, mode('NV12', 2432, 2048, 30)],
    [{ ...imx568, default_selection: mode('RGB888', 1920, 1080, 30) }, null, mode('NV12', 2432, 2048, 30)],
    [{ ...imx568, formats: [imx568.formats[1]] }, null, null],
    [usb, { format: 'YUYV' }, mode('YUYV', 640, 480, 30)],
    [usb, mode('YUYV', 1280, 720, 30), mode('YUYV', 640, 480, 30)],
    [usb, { format: 'MJPG' }, mode('MJPG', 1280, 720, 30)],
    [usb, mode('H264', 1920, 1080, 30), mode('MJPG', 1280, 720, 30)],
    [imx477, mode('NV12', 1280, 720, 30), mode('NV12', 1280, 720, 60)],
    [imx568, mode('NV12', 1920, 1080, 59.94), mode('NV12', 1920, 1080, 59.94)],
    [shrunk, mode('NV12', 1280, 720, 60), mode('NV12', 1920, 1080, 60)],
    [shrunk, mode('NV12', 1280, 720, 15), mode('NV12', 1920, 1080, 30)]
  ]
  for (const [camera, wanted, expected] of cases) {
    assert.deepEqual(resolveSelection(camera, wanted), expected, `${camera.id} ${JSON.stringify(wanted)}`)
  }
})

test('the selected camera id survives refreshes and removals', () => {
  assert.equal(resolveCameraId(snapshot, null), imx477.id)
  assert.equal(resolveCameraId(snapshot, usb.id), usb.id)
  assert.equal(resolveCameraId(snapshot, 'mipi:gone'), 'mipi:gone')
  assert.equal(resolveCameraId(snapshot, 'usb:unknown'), imx477.id)
  assert.equal(resolveCameraId({ items: [] }, 'usb:unknown'), null)
  assert.equal(resolveCameraId(null, null), null)
})

test('a snapshot is stale only when it was scanned for another board generation', () => {
  assert.equal(isSnapshotStale({ generation: 3 }, snapshot), false)
  assert.equal(isSnapshotStale({ generation: 4 }, snapshot), true)
  assert.equal(isSnapshotStale({ generation: 4 }, { ...snapshot, scanned_at: null }), false)
  assert.equal(isSnapshotStale(null, snapshot), false)
})

test('identity rows list only known device fields', () => {
  const rows = Object.fromEntries(deviceRows(usb))
  assert.equal(rows['USB ID'], '046d:0825')
  assert.equal(rows['USB speed'], '480 Mb/s')
  assert.equal('Serial' in rows, false)
  assert.equal('Media device' in rows, false)
  assert.equal(Object.fromEntries(deviceRows(imx568))['Name source'], 'media-graph')
})

test('issues sort by severity', () => {
  assert.deepEqual(sortIssues(snapshot.issues).map((i) => i.severity), ['error', 'warning', 'info'])
})

test('API errors keep code, hint, and extra fields', () => {
  const body = {
    error: 'Host key changed',
    code: 'host_key_changed',
    hint: 'Confirm the board was reflashed.',
    host: '192.168.2.2',
    expected_fingerprint: 'SHA256:old',
    presented_fingerprint: 'SHA256:new'
  }
  const err = apiError(body, 409)
  assert.equal(err.message, 'Host key changed')
  const normalized = normalizeError(err)
  assert.equal(normalized.code, 'host_key_changed')
  assert.equal(normalized.hint, 'Confirm the board was reflashed.')
  assert.equal(normalized.details.presented_fingerprint, 'SHA256:new')
  assert.deepEqual(normalizeError(body), normalized)
  assert.equal(apiError(null, 502).message, 'Request failed: 502')
  assert.deepEqual(normalizeError('boom'), { message: 'boom', code: '', hint: '', details: {} })
  assert.equal(normalizeError(null), null)
})

test('selection equality compares fps numerically', () => {
  const mode = { format: 'NV12', width: 1920, height: 1080, fps: 30 }
  assert.ok(sameSelection(mode, { ...mode, fps: '30' }))
  assert.ok(!sameSelection(mode, { ...mode, width: 1280, height: 720 }))
  assert.ok(!sameSelection(mode, { ...mode, format: 'YUYV' }))
  assert.ok(sameSelection(null, null))
  assert.ok(!sameSelection(null, mode))
})

test('board form defaults and validation', () => {
  const board = { target: { mode: 'local' }, saved: null, defaults: { on_board: false, sdk_env: { host: '192.168.2.2', port: 22, user: 'sima' } } }
  assert.deepEqual(initialBoardForm(board), { host: '192.168.2.2', port: '22', user: 'sima' })
  assert.deepEqual(validateBoardForm({ host: ' devkit.local ', port: '2222', user: 'sima' }), { body: { host: 'devkit.local', port: 2222, user: 'sima' } })
  assert.ok(validateBoardForm({ host: 'devkit', port: '70000', user: 'sima' }).error)
})

test('only http(s) links are rendered', () => {
  assert.equal(safeHref(CORE_838.url), CORE_838.url)
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref(undefined), null)
})

test('device kinds: only a supported kind with detections is selectable', () => {
  const summary = (tabs) => tabs.map((t) => [t.id, t.count, t.disabled, t.badge])
  const none = [['camera', 0, true, ''], ['microphone', 0, true, ''], ['lidar', 0, true, '']]
  const cases = [
    [deviceTabs(snapshot.items), [['camera', 4, false, '4'], ['microphone', 1, true, '1'], ['lidar', 0, true, '']]],
    [deviceTabs([{ kind: 'camera' }, { kind: 'radar' }, { kind: 'radar' }, { kind: null }]),
      [['camera', 1, false, '1'], ['microphone', 0, true, ''], ['lidar', 0, true, ''], ['radar', 2, true, '2']]],
    [deviceTabs([]), none],
    [deviceTabs(undefined, { scanned: false }), none]
  ]
  for (const [tabs, expected] of cases) assert.deepEqual(summary(tabs), expected)
  assert.equal(deviceTabs([{ kind: 'radar' }]).at(-1).icon, 'device')
  assert.equal(deviceTabs(Array.from({ length: 120 }, () => ({ kind: 'camera' })))[0].badge, '99+')
})

test('only an enabled kind can be selected, and camera is the fallback view', () => {
  const tabs = deviceTabs(snapshot.items)
  const cases = [
    [tabs, 'camera', 'camera'],
    [tabs, 'microphone', 'camera'],
    [tabs, 'nonsense', 'camera'],
    [[], 'camera', null],
    [deviceTabs([]), 'camera', 'camera'],
    [deviceTabs([], { scanned: false }), 'lidar', 'camera'],
    [deviceTabs([{ kind: 'radar' }]), 'radar', 'camera']
  ]
  for (const [list, wanted, expected] of cases) assert.equal(resolveDeviceKind(list, wanted), expected, wanted)
})

test('the detail pane shows one explanation line, chosen by priority', () => {
  assert.match(cameraSummaryLine(inUse), /^In use by gst-launch-1\.0 \(pid 812\)\./)
  assert.equal(cameraSummaryLine(imx568), imx568.support.reason)
  assert.equal(cameraSummaryLine(imx477), '')
  assert.match(cameraSummaryLine({ ...imx477, support: support('verified', ''), availability: imx568.availability }), /fuser is not installed/)
  assert.equal(cameraSummaryLine({}), '')
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

test('a board read sent after a change applies normally', async () => {
  const { sync, requests, state } = boardSyncHarness()
  sync.apply(boardA)
  const load = sync.load()
  assert.equal(state.loading, true)
  requests[0].resolve(boardB)
  assert.equal(await load, boardB)
  assert.equal(state.board, boardB)
  assert.equal(state.loading, false)
})

function fakeControl(name, { disabled = false, connected = true } = {}) {
  return { name, disabled, isConnected: connected, focused: 0, focus() { this.focused += 1 } }
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

test('when the opener is gone too, focus goes to the next control still on the page', () => {
  const change = fakeControl('change')
  const section = fakeControl('section')
  const focusReturn = createFocusReturn()
  focusReturn.request(() => [null, fakeControl('test', { disabled: true }), fakeControl('old', { connected: false }), change, section])
  assert.equal(focusReturn.flush(), change)
  assert.equal(change.focused, 1)
  focusReturn.request(() => [null])
  assert.equal(focusReturn.flush(), null)
})

test('renders without a collapse leave focus where it is', () => {
  const change = fakeControl('change')
  const focusReturn = createFocusReturn()
  assert.equal(focusReturn.flush(), null)
  focusReturn.request(() => [change])
  focusReturn.flush()
  // The effect runs after every render, e.g. each keystroke in the board form.
  assert.equal(focusReturn.flush(), null)
  assert.equal(change.focused, 1)
})

test('a mode menu groups its entries by tier, and the pill names the chosen one', () => {
  const sizes = sizeOptions(imx477, 'NV12')
  assert.deepEqual(groupOptions(sizes).map((g) => [g.id, g.options.map((o) => o.value)]), [['verified', ['1920x1080']], ['advertised', ['1280x720']]])
  assert.equal(optionTier(sizes, sizes[1].value).tone, 'warn')
  assert.equal(optionTier(sizes, 'no-such-size'), null)
  const formats = formatOptions(imx568)
  assert.deepEqual(groupOptions(formats).map((g) => g.id), ['advertised', 'unsupported'])
  assert.equal(optionTier(formats, 'RGB888').tone, 'periph-danger')
  assert.equal(optionTier(fpsOptions(imx477, 'NV12', 1920, 1080), 30).tone, 'ok')
  assert.deepEqual(groupOptions([]), [])
})
