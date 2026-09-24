import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiError,
  availabilityInfo,
  blockedFormatSummary,
  boardIndicator,
  cameraDeviceId,
  cameraSubtitle,
  cameraSummaryLine,
  changeSummary,
  createBoardSync,
  defaultTargetText,
  deviceRows,
  deviceTabs,
  formatDuration,
  formatOptions,
  formatRangeLabel,
  formatRelativeTime,
  fpsOptions,
  groupCameras,
  initialBoardForm,
  isSnapshotStale,
  modeLabel,
  normalizeError,
  resolveCameraId,
  resolveDeviceKind,
  resolveSelection,
  safeHref,
  sameSelection,
  sizeOptions,
  sortIssues,
  sourceLabel,
  tierInfo,
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
  board: { label: 'sima@192.168.2.2', source: 'sdk-env', hostname: 'modalix', machine: 'aarch64', build_version: '2.0.0', fingerprint: 'SHA256:abc' },
  generation: 3,
  scanned_at: '2026-09-21T10:00:00Z',
  scan_ms: 3400,
  platform: {
    tools: { cam: true, 'v4l2-ctl': false, 'media-ctl': true, 'gst-inspect-1.0': true, fuser: false },
    libcamerasrc: { present: true, external_buffer_mode: true, buffer_count: true },
    availability_method: 'proc-user'
  },
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
  assert.deepEqual(groups.map((g) => g.label), ['MIPI (libcamera)', 'USB (V4L2)'])
  assert.deepEqual(groups[0].items.map((c) => c.id), [imx477.id, imx568.id, inUse.id])
  assert.deepEqual(groups[1].items.map((c) => c.id), [usb.id])
  assert.deepEqual(groupCameras([]), [])
})

test('format options disable non-exportable formats and keep their reason', () => {
  const [nv12, rgb] = formatOptions(imx568)
  assert.equal(nv12.disabled, false)
  assert.equal(nv12.label, 'NV12 (YUV 4:2:0) — advertised')
  assert.deepEqual(nv12.range.max_width, 2432)
  assert.equal(rgb.disabled, true)
  assert.equal(rgb.label, 'RGB888 — not usable')
  assert.equal(rgb.reason, 'Core CameraInput outputs NV12 only.')
})

test('size and fps options are labelled with their best support tier', () => {
  assert.deepEqual(sizeOptions(imx477, 'NV12').map((o) => o.label), ['1920×1080 — verified', '1280×720 — advertised'])
  assert.deepEqual(fpsOptions(imx477, 'NV12', 1920, 1080).map((o) => o.label), ['30 fps — verified', '60 fps — advertised'])
  assert.deepEqual(fpsOptions(imx568, 'NV12', 1920, 1080).map((o) => o.value), ['30', '59.94'])
  assert.deepEqual(sizeOptions(imx477, 'RGB888'), [])
})

test('the default selection is preselected when it is exportable', () => {
  assert.deepEqual(resolveSelection(imx477, null), { format: 'NV12', width: 1920, height: 1080, fps: 30 })
  assert.deepEqual(resolveSelection(usb, null), { format: 'MJPG', width: 1280, height: 720, fps: 30 })
})

test('a missing or non-exportable default falls back to the best exportable mode', () => {
  assert.deepEqual(resolveSelection(imx568, null), { format: 'NV12', width: 2432, height: 2048, fps: 30 })
  const rgbDefault = { ...imx568, default_selection: { format: 'RGB888', width: 1920, height: 1080, fps: 30 } }
  assert.equal(resolveSelection(rgbDefault, null).format, 'NV12')
  assert.equal(resolveSelection({ ...imx568, formats: [imx568.formats[1]] }, null), null)
})

test('changing one level keeps the rest of the selection when it is still offered', () => {
  assert.deepEqual(resolveSelection(usb, { format: 'YUYV' }), { format: 'YUYV', width: 640, height: 480, fps: 30 })
  assert.deepEqual(
    resolveSelection(usb, { format: 'YUYV', width: 640, height: 480, fps: 30 }),
    { format: 'YUYV', width: 640, height: 480, fps: 30 }
  )
  assert.deepEqual(
    resolveSelection(usb, { format: 'YUYV', width: 1280, height: 720, fps: 30 }),
    { format: 'YUYV', width: 640, height: 480, fps: 30 }
  )
  assert.deepEqual(resolveSelection(usb, { format: 'MJPG' }), { format: 'MJPG', width: 1280, height: 720, fps: 30 })
  assert.deepEqual(
    resolveSelection(imx477, { format: 'NV12', width: 1280, height: 720, fps: 30 }),
    { format: 'NV12', width: 1280, height: 720, fps: 60 }
  )
  assert.deepEqual(
    resolveSelection(imx568, { format: 'NV12', width: 1920, height: 1080, fps: 59.94 }),
    { format: 'NV12', width: 1920, height: 1080, fps: 59.94 }
  )
})

test('a selection that disappears after refresh falls back instead of clearing', () => {
  const refreshed = { ...imx477, formats: [{ ...imx477.formats[0], sizes: [imx477.formats[0].sizes[0]] }] }
  assert.deepEqual(
    resolveSelection(refreshed, { format: 'NV12', width: 1280, height: 720, fps: 60 }),
    { format: 'NV12', width: 1920, height: 1080, fps: 60 }
  )
  assert.deepEqual(
    resolveSelection(refreshed, { format: 'NV12', width: 1280, height: 720, fps: 15 }),
    { format: 'NV12', width: 1920, height: 1080, fps: 30 }
  )
  assert.equal(resolveSelection(usb, { format: 'H264', width: 1920, height: 1080, fps: 30 }).format, 'MJPG')
})

test('the selected camera id survives refreshes and removals', () => {
  assert.equal(resolveCameraId(snapshot, null), imx477.id)
  assert.equal(resolveCameraId(snapshot, usb.id), usb.id)
  assert.equal(resolveCameraId(snapshot, 'mipi:gone'), 'mipi:gone', 'removed cameras stay selected so the UI can explain')
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

test('labels for tiers, availability, sources, and defaults', () => {
  assert.equal(tierInfo('verified').label, 'Verified with Core')
  assert.equal(tierInfo('advertised').label, 'Advertised, unverified')
  assert.equal(tierInfo('unsupported').label, 'Not supported by Core CameraInput')
  assert.equal(tierInfo('bogus').short, 'unknown')
  assert.equal(availabilityInfo(inUse.availability).label, 'In use by gst-launch-1.0 (pid 812)')
  assert.deepEqual(availabilityInfo(imx568.availability), { label: 'Availability unknown', tone: '', reason: 'fuser is not installed on the board.' })
  assert.equal(availabilityInfo(available).label, 'Available')
  assert.equal(sourceLabel('on-board'), 'On this board')
  assert.equal(sourceLabel('sdk-env'), 'SDK DevKit')
  assert.equal(sourceLabel('manual'), 'Manual')
  assert.equal(defaultTargetText({ on_board: false, sdk_env: { host: '192.168.2.2', port: 22, user: 'sima' } }), 'sima@192.168.2.2:22 (paired SDK DevKit)')
  assert.equal(defaultTargetText({ on_board: false, sdk_env: null }), '')
})

test('identity rows list only known device fields', () => {
  assert.equal(cameraDeviceId(imx477), imx477.device.camera_name)
  assert.equal(cameraDeviceId(usb), usb.device.by_id)
  const rows = Object.fromEntries(deviceRows(usb))
  assert.equal(rows['USB ID'], '046d:0825')
  assert.equal(rows['USB speed'], '480 Mb/s')
  assert.equal('Serial' in rows, false)
  assert.equal('Media device' in rows, false)
  assert.equal(Object.fromEntries(deviceRows(imx568))['Name source'], 'media-graph')
})

test('a subtitle never repeats what the name already says', () => {
  // "imx477 5-001a" carries the model, so the subtitle beneath it must not read "imx477" again.
  assert.equal(cameraSubtitle(imx477), '')
  // The USB camera reports its product string as both name and model, so only the device id is news.
  assert.equal(cameraSubtitle(usb), usb.device.by_id)
  assert.equal(cameraSubtitle({ name: 'C270', model: 'C270' }), '')
  assert.equal(cameraSubtitle({ name: 'cam', model: 'imx477' }), 'imx477')
})

test('issues sort by severity and changes read as sentences', () => {
  assert.deepEqual(sortIssues(snapshot.issues).map((i) => i.severity), ['error', 'warning', 'info'])
  assert.deepEqual(changeSummary(snapshot.changes), ['Disconnected since last refresh: imx219', 'New: HD Webcam C270'])
  assert.deepEqual(changeSummary(null), [])
})

test('relative times and durations', () => {
  const now = Date.parse('2026-09-21T10:00:00Z')
  assert.equal(formatRelativeTime('2026-09-21T09:59:58Z', now), 'just now')
  assert.equal(formatRelativeTime('2026-09-21T09:59:30Z', now), '30 s ago')
  assert.equal(formatRelativeTime('2026-09-21T09:55:00Z', now), '5 min ago')
  assert.equal(formatRelativeTime('2026-09-21T07:00:00Z', now), '3 h ago')
  assert.equal(formatRelativeTime('2026-09-19T10:00:00Z', now), '2 d ago')
  assert.equal(formatRelativeTime(null, now), '')
  assert.equal(formatDuration(3400), '3.4 s')
  assert.equal(formatDuration(250), '250 ms')
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

test('mode labels and selection equality drive the fallback notice', () => {
  const mode = { format: 'NV12', width: 1920, height: 1080, fps: 30 }
  assert.equal(modeLabel(mode), 'NV12 1920×1080 @ 30 fps')
  assert.equal(modeLabel({ ...mode, fps: 59.94 }), 'NV12 1920×1080 @ 59.94 fps')
  assert.equal(modeLabel(null), '')
  assert.ok(sameSelection(mode, { ...mode, fps: '30' }))
  assert.ok(!sameSelection(mode, { ...mode, width: 1280, height: 720 }))
  assert.ok(!sameSelection(mode, { ...mode, format: 'YUYV' }))
  assert.ok(sameSelection(null, null))
  assert.ok(!sameSelection(null, mode))
})

test('board form defaults and validation', () => {
  const board = { target: { mode: 'local' }, saved: null, defaults: { on_board: false, sdk_env: { host: '192.168.2.2', port: 22, user: 'sima' } } }
  assert.deepEqual(initialBoardForm(board), { host: '192.168.2.2', port: '22', user: 'sima' })
  assert.deepEqual(initialBoardForm(null), { host: '', port: '22', user: 'sima' })
  assert.deepEqual(validateBoardForm({ host: ' devkit.local ', port: '2222', user: 'sima' }), { body: { host: 'devkit.local', port: 2222, user: 'sima' } })
  assert.ok(validateBoardForm({ host: '', port: '22', user: 'sima' }).error)
  assert.ok(validateBoardForm({ host: 'a b', port: '22', user: 'sima' }).error)
  assert.ok(validateBoardForm({ host: 'devkit', port: '70000', user: 'sima' }).error)
  assert.ok(validateBoardForm({ host: 'devkit', port: '22', user: ' ' }).error)
})

test('only http(s) links are rendered', () => {
  assert.equal(safeHref(CORE_838.url), CORE_838.url)
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref(undefined), null)
})

// --- #126 addendum: board indicator, device sub-tabs, declutter ------------

test('the masthead board indicator collapses board state into a label and a short pill', () => {
  assert.deepEqual(boardIndicator(null).state.short, 'Loading…')
  const none = boardIndicator({ target: null, status: { state: 'unknown' } })
  assert.equal(none.label, 'No board')
  assert.equal(none.state.short, 'Not selected')
  // The masthead names the machine the way the SDK does; sima@host is a connection string and
  // stays in the panel.
  const connected = boardIndicator({
    target: { label: 'sima@192.168.2.2', mode: 'ssh', source: 'sdk-env', host: '192.168.2.2' },
    status: { state: 'connected' }
  })
  assert.equal(connected.label, 'DevKit: 192.168.2.2')
  assert.equal(connected.state.short, 'Connected')
  assert.equal(connected.state.tone, 'ok')
  assert.match(connected.title, /^sima@192\.168\.2\.2 — Connected/, 'the full target stays in the tooltip')
  const manual = boardIndicator({
    target: { label: 'sima@10.0.0.4', mode: 'ssh', source: 'manual', host: '10.0.0.4' },
    status: { state: 'connected' }
  })
  assert.equal(manual.label, 'Board: 10.0.0.4', 'a hand-entered board is not called a DevKit')
  assert.equal(boardIndicator({ target: { label: 'This board', mode: 'local', source: 'on-board' }, status: null }).label, 'This board')
  const failed = boardIndicator({ target: { label: 'This board' }, status: { state: 'error' } })
  assert.equal(failed.state.short, 'Error')
  assert.equal(failed.state.label, 'Connection failed', 'the card keeps the long label')
  assert.equal(boardIndicator({ target: { label: 'This board' }, status: null }).state.short, 'Not checked')
})

test('device sub-tabs come from the snapshot kinds and keep unbuilt kinds disabled', () => {
  const tabs = deviceTabs(snapshot.items)
  assert.deepEqual(tabs.map((t) => t.id), ['camera', 'microphone', 'lidar'])
  assert.deepEqual(tabs.map((t) => t.label), ['Cameras', 'Microphones', 'LiDAR'])
  assert.equal(tabs[0].count, 4)
  assert.equal(tabs[0].disabled, false)
  assert.equal(tabs[1].count, 1, 'the microphone in the snapshot is counted')
  assert.equal(tabs[1].disabled, true)
  assert.match(tabs[1].note, /cannot show microphones yet/)
  assert.equal(tabs[2].count, 0)
  assert.equal(tabs[2].note, 'Not supported yet')
})

test('a kind the backend invents appears automatically, after the known ones', () => {
  const tabs = deviceTabs([{ kind: 'camera' }, { kind: 'radar' }, { kind: 'radar' }, { kind: null }])
  assert.deepEqual(tabs.map((t) => t.id), ['camera', 'microphone', 'lidar', 'radar'])
  const radar = tabs.at(-1)
  assert.equal(radar.label, 'Radars')
  assert.equal(radar.count, 2)
  assert.equal(radar.disabled, true)
  assert.equal(radar.icon, 'device', 'an unknown kind gets the generic icon')
  assert.deepEqual(deviceTabs([]).map((t) => t.disabled), [true, true, true], 'no cameras detected greys cameras too')
})

test('each rail icon carries a count bubble, an accessible name and the reason it is greyed', () => {
  const tabs = deviceTabs(snapshot.items)
  assert.deepEqual(tabs.map((t) => t.icon), ['camera', 'microphone', 'lidar'])
  assert.deepEqual(tabs.map((t) => t.badge), ['4', '1', ''], 'no bubble for a kind with nothing detected')
  assert.deepEqual(tabs.map((t) => t.name), ['Cameras, 4 devices', 'Microphones, 1 device', 'LiDAR, 0 devices'])
  assert.equal(tabs[0].note, '', 'a selectable kind needs no explanation')
  assert.equal(tabs[0].tooltip, 'Cameras, 4 devices')
  assert.equal(tabs[1].tooltip, 'Microphones — 1 device detected; Insight cannot show microphones yet.')
  assert.equal(tabs[2].tooltip, 'LiDAR — Not supported yet')
  const one = deviceTabs([{ kind: 'camera' }])[0]
  assert.equal(one.name, 'Cameras, 1 device')
  assert.equal(one.disabled, false)
  assert.equal(deviceTabs(Array.from({ length: 120 }, () => ({ kind: 'camera' })))[0].badge, '99+')
})

test('a supported kind with nothing detected is greyed but says why', () => {
  const [cameras] = deviceTabs([{ kind: 'microphone' }])
  assert.equal(cameras.supported, true)
  assert.equal(cameras.disabled, true)
  assert.equal(cameras.note, 'No cameras detected')
  assert.equal(cameras.name, 'Cameras, 0 devices')
  assert.equal(cameras.tooltip, 'Cameras — No cameras detected')
  const [unscanned, , lidar] = deviceTabs(undefined, { scanned: false })
  assert.equal(unscanned.note, 'Not scanned yet', 'before a scan nothing is claimed about the count')
  assert.equal(unscanned.name, 'Cameras')
  assert.equal(unscanned.badge, '')
  assert.equal(lidar.note, 'Not supported yet', 'unsupported wins over not scanned')
})

test('only an enabled sub-tab can be selected', () => {
  const tabs = deviceTabs(snapshot.items)
  assert.equal(resolveDeviceKind(tabs, 'camera'), 'camera')
  assert.equal(resolveDeviceKind(tabs, 'microphone'), 'camera', 'disabled kinds fall back')
  assert.equal(resolveDeviceKind(tabs, 'nonsense'), 'camera')
  assert.equal(resolveDeviceKind([], 'camera'), null)
})

test('with nothing selectable the panel keeps showing the camera view', () => {
  assert.equal(resolveDeviceKind(deviceTabs([]), 'camera'), 'camera', 'no cameras: the camera view explains it')
  assert.equal(resolveDeviceKind(deviceTabs([], { scanned: false }), 'lidar'), 'camera')
  assert.equal(resolveDeviceKind(deviceTabs([{ kind: 'radar' }]), 'radar'), 'camera', 'unsupported kinds never become the view')
})

test('blocked export formats collapse into one line', () => {
  assert.equal(blockedFormatSummary(formatOptions(imx477)), '')
  assert.equal(blockedFormatSummary(formatOptions(imx568)), '1 format cannot be used (RGB888)')
  assert.equal(
    blockedFormatSummary([{ value: 'A', disabled: true }, { value: 'B', disabled: true }, { value: 'C', disabled: false }]),
    '2 formats cannot be used (A, B)'
  )
})

test('stepwise and continuous format ranges keep their bounds and steps visible', () => {
  assert.equal(
    formatRangeLabel({ min_width: 16, min_height: 16, max_width: 1920, max_height: 1080, step_width: 16, step_height: 8 }),
    '16–1920×16–1080 in 16×8 steps'
  )
  const option = formatOptions({ formats: [format('YUYV', 'YUYV', false, support('unsupported', 'Discrete sizes are unavailable.'), [], {
    min_width: 16, min_height: 16, max_width: 1920, max_height: 1080, step_width: 16, step_height: 16
  })] })[0]
  assert.match(option.reason, /Reported range: 16–1920×16–1080 in 16×16 steps\./)
})

test('the detail pane shows one explanation line, chosen by priority', () => {
  assert.match(cameraSummaryLine(inUse), /^In use by gst-launch-1\.0 \(pid 812\)\. Stop that process/)
  assert.equal(cameraSummaryLine(imx568), imx568.support.reason, 'an unverified tier wins over unknown availability')
  // A verified, available camera says nothing: the mode menus carry the verified/advertised labels.
  assert.equal(cameraSummaryLine(imx477), '')
  assert.equal(
    cameraSummaryLine({ ...imx477, support: support('verified', ''), availability: imx568.availability }),
    'Availability unknown: fuser is not installed on the board.'
  )
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
