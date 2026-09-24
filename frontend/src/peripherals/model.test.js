import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PREVIEW_IDLE,
  apiError,
  availabilityInfo,
  blockedFormatSummary,
  boardIndicator,
  cameraDeviceId,
  cameraSubtitle,
  cameraSummaryLine,
  changeSummary,
  defaultTargetText,
  deviceRows,
  deviceTabs,
  formatDuration,
  formatOptions,
  formatRelativeTime,
  fpsOptions,
  groupCameras,
  heartbeatDelay,
  initialBoardForm,
  isSnapshotStale,
  modeLabel,
  nextPreviewState,
  normalizeError,
  previewBlock,
  previewErrorInfo,
  previewStatusInfo,
  resolveCameraId,
  resolveDeviceKind,
  resolveSelection,
  safeHref,
  sameSelection,
  selectionTier,
  sessionMatches,
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

// --- #126 addendum: board indicator, device sub-tabs, declutter, preview ----

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
  assert.deepEqual(deviceTabs([]).map((t) => t.disabled), [false, true, true])
})

test('only an enabled sub-tab can be selected', () => {
  const tabs = deviceTabs(snapshot.items)
  assert.equal(resolveDeviceKind(tabs, 'camera'), 'camera')
  assert.equal(resolveDeviceKind(tabs, 'microphone'), 'camera', 'disabled kinds fall back')
  assert.equal(resolveDeviceKind(tabs, 'nonsense'), 'camera')
  assert.equal(resolveDeviceKind([], 'camera'), null)
})

test('blocked export formats collapse into one line', () => {
  assert.equal(blockedFormatSummary(formatOptions(imx477)), '')
  assert.equal(blockedFormatSummary(formatOptions(imx568)), '1 format cannot be used (RGB888)')
  assert.equal(
    blockedFormatSummary([{ value: 'A', disabled: true }, { value: 'B', disabled: true }, { value: 'C', disabled: false }]),
    '2 formats cannot be used (A, B)'
  )
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

test('the selected mode keeps the tier the board reported for it', () => {
  assert.equal(selectionTier(imx477, { format: 'NV12', width: 1920, height: 1080, fps: 30 }), 'verified')
  assert.equal(selectionTier(imx477, { format: 'NV12', width: 1280, height: 720, fps: 60 }), 'advertised')
  assert.equal(selectionTier(usb, { format: 'MJPG', width: 1280, height: 720, fps: 30 }), 'unsupported')
  assert.equal(selectionTier(imx477, { format: 'NV12', width: 640, height: 480, fps: 30 }), '')
  assert.equal(selectionTier(imx477, null), '')
})

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
  assert.equal(nextPreviewState(live, { type: 'expired', for: 'old-id' }), live)
  assert.equal(nextPreviewState(live, { type: 'stopped', for: 'old-id' }), live)
  assert.equal(nextPreviewState(live, { type: 'stopping', for: 'old-id' }), live)
  assert.equal(nextPreviewState(live, { type: 'failed', for: 'old-id', error: { message: 'boom' } }), live)
  assert.equal(nextPreviewState(live, { type: 'session', session: { ...liveSession, id: 'other' } }), live)

  const expired = nextPreviewState(live, { type: 'expired', for: '8f1c' })
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
  assert.equal(nextPreviewState(live, { type: 'nonsense' }), live)
  assert.equal(nextPreviewState(undefined, { type: 'nonsense' }), PREVIEW_IDLE)
})

test('heartbeats follow the backend interval, clamped to something sane', () => {
  assert.equal(heartbeatDelay(liveSession), 5000)
  assert.equal(heartbeatDelay(null), 5000)
  assert.equal(heartbeatDelay({ heartbeat_interval_ms: 0 }), 5000)
  assert.equal(heartbeatDelay({ heartbeat_interval_ms: 50 }), 1000)
  assert.equal(heartbeatDelay({ heartbeat_interval_ms: 900000 }), 60000)
  assert.equal(heartbeatDelay({ heartbeat_interval_ms: '2500' }), 2500)
})

test('a session belongs to the camera and board generation it was started for', () => {
  assert.equal(sessionMatches(liveSession, imx477.id, 3), true)
  assert.equal(sessionMatches(liveSession, imx477.id, 4), false)
  assert.equal(sessionMatches(liveSession, imx568.id, 3), false)
  assert.equal(sessionMatches(liveSession, imx477.id), true)
  assert.equal(sessionMatches(null, imx477.id, 3), false)
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

  const other = previewErrorInfo(normalizeError(apiError({
    error: 'A preview is already running.',
    code: 'preview_active',
    session: { camera_id: imx568.id }
  }, 409)))
  assert.equal(other.otherCamera, imx568.id)
  assert.match(other.action, /Stop the preview that is already running/)

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
