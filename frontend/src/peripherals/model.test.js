import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiError,
  blockedFormatSummary,
  boardCameraSetup,
  boardIndicator,
  cameraSetupRows,
  cameraDeviceId,
  cameraSelectable,
  cameraSubtitle,
  noUsableCameraNotice,
  cameraSummaryLine,
  cameraTierPill,
  CONNECTED_PILL,
  changeSummary,
  createBoardSync,
  createFocusReturn,
  defaultTargetText,
  deviceRows,
  deviceTabs,
  formatDuration,
  formatOptions,
  formatRangeLabel,
  formatRelativeTime,
  groupOptions,
  groupCameras,
  initialBoardForm,
  isSnapshotStale,
  modeLabel,
  normalizeError,
  optionTier,
  overlayName,
  rateLabel,
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

const ISP_SIZE = 'The ISP cannot output this size.'
const NOT_IN_OVERLAYS = "IMX568 is not in this board's camera overlays."
const USB_REASON = 'USB cameras have no camera overlay on this board.'
const NO_BOARD = "This board's SiMa Sentinel does not report camera overlays; update Sentinel."
const support = (tier, reason = '') => ({ tier, reason })
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
  support: support('available'),
  modes_source: 'live',
  formats: [
    format('NV12', 'NV12 (YUV 4:2:0)', true, support('available'), [
      size(1920, 1080, [30, 'available'], [60, 'available']),
      size(1280, 720, [60, 'unsupported'])
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
  support: support('unsupported', NOT_IN_OVERLAYS),
  modes_source: 'live',
  formats: [
    format('NV12', 'NV12 (YUV 4:2:0)', false, support('unsupported', NOT_IN_OVERLAYS), [
      size(2432, 2048, [30, 'unsupported']),
      size(1920, 1080, [30, 'unsupported'], [59.94, 'unsupported'])
    ], { min_width: 64, min_height: 64, max_width: 2432, max_height: 2048, step_width: 2, step_height: 2 }),
    format('RGB888', 'RGB888', false, support('unsupported', NOT_IN_OVERLAYS), [size(1920, 1080)])
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
  support: support('unsupported', USB_REASON),
  modes_source: 'live',
  formats: [
    format('MJPG', 'Motion-JPEG', false, support('unsupported', USB_REASON), [size(1280, 720, [30, 'unsupported']), size(640, 480, [30, 'unsupported'])]),
    format('YUYV', 'YUYV 4:2:2', false, support('unsupported', USB_REASON), [size(640, 480, [30, 'unsupported'], [15, 'unsupported'])])
  ],
  default_selection: null,
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
  assert.deepEqual(groups.map((g) => g.label), ['MIPI', 'USB'])
  assert.deepEqual(groups[0].items.map((c) => c.id), [imx477.id, imx568.id, inUse.id])
  assert.deepEqual(groups[1].items.map((c) => c.id), [usb.id])
  assert.deepEqual(groupCameras([]), [])
})

test('unsupported formats stay selectable; only a format without a size and rate is disabled', () => {
  const [nv12, rgb] = formatOptions(imx568)
  assert.equal(nv12.disabled, false)
  assert.equal(nv12.label, 'NV12 (YUV 4:2:0)')
  assert.equal(nv12.tier, 'unsupported')
  assert.deepEqual(nv12.range.max_width, 2432)
  assert.equal(rgb.disabled, true)
  assert.equal(rgb.label, 'RGB888')
  assert.equal(rgb.tier, 'unsupported')
  assert.equal(rgb.reason, 'no sizes with a frame rate were reported for it.')
  assert.deepEqual(formatOptions(usb).map((o) => [o.value, o.disabled, o.tier]), [['MJPG', false, 'unsupported'], ['YUYV', false, 'unsupported']])
  assert.equal(formatOptions(imx477)[0].tier, 'available')
})

test('size options carry their best state, for the pill beside the menu', () => {
  assert.deepEqual(sizeOptions(imx477, 'NV12').map((o) => [o.label, o.tier]), [['1920×1080', 'available'], ['1280×720', 'unsupported']])
  assert.deepEqual(sizeOptions(imx477, 'RGB888'), [])
})

test('a USB resolution names the rate the page uses for that mode; a MIPI resolution names none', () => {
  assert.deepEqual(sizeOptions(usb, 'MJPG').map((o) => o.label), ['1280×720 · 30 fps', '640×480 · 30 fps'])
  // Highest Available rate, else the highest: what resolveSelection picks for the mode.
  const webcam = {
    ...usb,
    formats: [format('YUYV', 'YUYV 4:2:2', true, support('available'), [
      size(640, 480, [60, 'unsupported'], [30, 'available']),
      size(320, 240, [29.97, 'unsupported'], [15, 'unsupported']),
      size(160, 120, [7.5, 'unsupported'])
    ])]
  }
  assert.deepEqual(sizeOptions(webcam, 'YUYV').map((o) => [o.value, o.label]),
    [['640x480', '640×480 · 30 fps'], ['320x240', '320×240 · 30 fps'], ['160x120', '160×120 · 7.5 fps']])
  assert.equal(resolveSelection(webcam, { format: 'YUYV', width: 640, height: 480 }).fps, 30)
  for (const camera of [imx477, imx568]) {
    for (const option of sizeOptions(camera, 'NV12')) assert.doesNotMatch(option.label, /fps/)
  }
})

test('a rate reads as a whole number within 1% of one, else as reported', () => {
  assert.equal(rateLabel(30), '30 fps')
  assert.equal(rateLabel(66.18), '66 fps')
  assert.equal(rateLabel(29.97), '30 fps')
  assert.equal(rateLabel('59.94'), '60 fps')
  assert.equal(rateLabel(7.5), '7.5 fps')
  assert.equal(rateLabel(12.345), '12.35 fps')
  for (const unknown of [null, undefined, '', 0, -5, NaN, Infinity, 'x']) assert.equal(rateLabel(unknown), '')
})

test('the default selection is preselected; without one an Available mode is preferred', () => {
  assert.deepEqual(resolveSelection(imx477, null), { format: 'NV12', width: 1920, height: 1080, fps: 30 })
  // A USB camera has no Available mode and no default; its first reported mode is shown.
  assert.deepEqual(resolveSelection(usb, null), { format: 'MJPG', width: 1280, height: 720, fps: 30 })
  const mixed = {
    ...imx477,
    default_selection: null,
    formats: [
      format('AR24', 'AR24', false, support('unsupported', ISP_SIZE), [size(4056, 3040, [30, 'unsupported'])]),
      format('NV12', 'NV12', true, support('available'), [size(4056, 3040, [30, 'unsupported']), size(1920, 1080, [15, 'unsupported'], [30, 'available'])])
    ]
  }
  assert.deepEqual(resolveSelection(mixed, null), { format: 'NV12', width: 1920, height: 1080, fps: 30 })
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
  // An Unsupported camera cannot be selected, so a stale selection of one falls back to the first usable camera.
  assert.equal(resolveCameraId(snapshot, usb.id), imx477.id)
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

test('labels for tiers, sources, and defaults', () => {
  assert.deepEqual(tierInfo('available'), { label: 'Available', tone: 'ok' })
  assert.deepEqual(tierInfo('unsupported'), { label: 'Unsupported', tone: 'periph-danger' })
  assert.deepEqual(tierInfo('bogus'), tierInfo('unsupported'), 'every mode is one of the two states')
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
  // The USB camera reports its product string as both name and model, and its kernel path stays in Device details.
  assert.equal(cameraSubtitle(usb), '')
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
  // A MIPI mode's rate is not known before it runs, so only a USB mode names one.
  assert.equal(modeLabel(mode, imx477), 'NV12 1920×1080')
  assert.equal(modeLabel(mode), 'NV12 1920×1080')
  assert.equal(modeLabel(mode, usb), 'NV12 1920×1080 @ 30 fps')
  assert.equal(modeLabel({ ...mode, fps: 59.94 }, usb), 'NV12 1920×1080 @ 59.94 fps')
  assert.equal(modeLabel(null, usb), '')
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
  assert.equal(safeHref('https://github.com/sima-neat/core/issues/883'), 'https://github.com/sima-neat/core/issues/883')
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
  const option = formatOptions({ formats: [format('YUYV', 'YUYV', false, support('unsupported', USB_REASON), [], {
    min_width: 16, min_height: 16, max_width: 1920, max_height: 1080, step_width: 16, step_height: 16
  })] })[0]
  assert.match(option.reason, /Reported range: 16–1920×16–1080 in 16×16 steps\./)
})

test('when no detected camera can be used, the panel says which and why', () => {
  assert.equal(noUsableCameraNotice([usb, imx477]), null, 'an Available camera means something can be selected')
  assert.equal(noUsableCameraNotice([]), null)
  assert.deepEqual(noUsableCameraNotice([usb]), {
    title: 'HD Webcam C270 cannot be used with Neat',
    reasons: [{ reason: USB_REASON, names: ['HD Webcam C270'] }],
    hint: 'Connect a MIPI camera (power the board off first), then Refresh.'
  })
  const both = noUsableCameraNotice([usb, imx568])
  assert.equal(both.title, 'No camera on this board can be used with Neat')
  // In list order: MIPI cameras come before USB ones.
  assert.deepEqual(both.reasons.map((r) => r.reason), [NOT_IN_OVERLAYS, USB_REASON])
  assert.match(both.hint, /camera overlay/)
})

test('every camera row shows its verdict pill, and only Available cameras can be selected', () => {
  assert.deepEqual(cameraTierPill(imx477), { label: 'Available', tone: 'ok' })
  assert.deepEqual(cameraTierPill(imx568), { label: 'Unsupported', tone: 'periph-danger' })
  assert.equal(cameraSelectable(imx477), true)
  assert.equal(cameraSelectable(imx568), false)
  assert.equal(cameraSelectable(usb), false)
  assert.deepEqual(CONNECTED_PILL, { label: 'Connected', tone: '' })
  assert.deepEqual(cameraTierPill(usb), { label: 'Unsupported', tone: 'periph-danger' })
  assert.deepEqual(cameraTierPill({ ...imx477, support: support('unsupported', NO_BOARD) }), { label: 'Unsupported', tone: 'periph-danger' })
})

test('the detail pane shows one explanation line, chosen by priority', () => {
  assert.equal(cameraSummaryLine(imx568), NOT_IN_OVERLAYS)
  assert.equal(cameraSummaryLine({ ...imx477, support: support('unsupported', NO_BOARD) }), NO_BOARD)
  // An Available camera says nothing: the mode menus carry the Available/Unsupported labels.
  assert.equal(cameraSummaryLine(imx477), '')
  // Whether another program holds the camera is not a scan fact: Sentinel's availability is passed
  // through untouched and never becomes a sentence; a preview that cannot open the camera says so.
  assert.equal(cameraSummaryLine(inUse), '')
  assert.equal(cameraSummaryLine({ ...imx477, availability: imx568.availability }), '')
  assert.equal(cameraSummaryLine(usb), '', 'an unsupported USB camera gets no sentence; its pill says it')
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

test('a mode menu groups its entries as Available and Unsupported, and the pill names the chosen one', () => {
  const sizes = sizeOptions(imx477, 'NV12')
  assert.deepEqual(groupOptions(sizes).map((g) => [g.label, g.options.map((o) => o.label)]),
    [['Available', ['1920×1080']], ['Unsupported', ['1280×720']]])
  assert.deepEqual(optionTier(sizes, sizes[1].value), { label: 'Unsupported', tone: 'periph-danger' })
  assert.equal(optionTier(sizes, 'no-such-size'), null)
  const formats = formatOptions(imx568)
  assert.deepEqual(groupOptions(formats).map((g) => g.label), ['Unsupported'])
  assert.deepEqual(optionTier(formats, 'RGB888'), { label: 'Unsupported', tone: 'periph-danger' })
  assert.deepEqual(optionTier([{ value: '30', tier: 'available' }], 30), { label: 'Available', tone: 'ok' }, 'a numeric selection matches its string option')
  assert.deepEqual(groupOptions([]), [])
})

const cameraSetup = {
  model: 'SiMa.ai Modalix SoM 16Gig Board',
  overlays: ['modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo']
}

test('the board card names the model and camera overlays only when Sentinel reports them', () => {
  assert.deepEqual(cameraSetupRows(cameraSetup), [
    ['Model', 'SiMa.ai Modalix SoM 16Gig Board'],
    ['Camera setup', 'modalix-som-waveshare-ARDU-IMX477-1CAM']
  ])
  assert.deepEqual(cameraSetupRows({ model: null, overlays: ['a.dtbo', '/boot/overlays/b.DTBO'] }), [['Camera setup', 'a, b']])
  assert.deepEqual(cameraSetupRows({ model: '', overlays: [] }), [])
  assert.deepEqual(cameraSetupRows(null), [])
  assert.equal(overlayName('modalix-som-imx219.dtbo'), 'modalix-som-imx219')
  assert.equal(overlayName('no-extension'), 'no-extension')
})

test('the camera setup belongs to the board that was scanned', () => {
  const snapshot = { generation: 3, scanned_at: '2026-10-06T00:00:00+00:00', camera_setup: cameraSetup }
  assert.equal(boardCameraSetup({ generation: 3 }, snapshot), cameraSetup)
  assert.equal(boardCameraSetup({ generation: 4 }, snapshot), null, 'the selected board changed since the scan')
  assert.equal(boardCameraSetup({ generation: 3 }, { ...snapshot, scanned_at: null }), null, 'not scanned yet')
  assert.equal(boardCameraSetup({ generation: 3 }, { ...snapshot, camera_setup: null }), null, 'an older Sentinel')
  assert.equal(boardCameraSetup(null, snapshot), null)
  assert.equal(boardCameraSetup({ generation: 3 }, null), null)
})
