import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  PREVIEW_IDLE,
  USB_PREVIEW_FORMATS,
  adoptedSelection,
  apiError,
  captureModes,
  blockedFormatSummary,
  boardCameraSetup,
  boardIndicator,
  cameraSetupRows,
  cameraDeviceId,
  cameraSubtitle,
  cameraSummaryLine,
  cameraTierPill,
  CONNECTED_PILL,
  connectionPill,
  changeSummary,
  createBoardSync,
  createShellInfoSync,
  createFocusReturn,
  defaultTargetText,
  deviceTabs,
  formatDuration,
  formatOptions,
  formatRangeLabel,
  formatRelativeTime,
  groupOptions,
  groupCameras,
  groupMicrophones,
  initialBoardForm,
  isSnapshotStale,
  microphoneSubtitle,
  micLevelNotice,
  micStartMayHaveRun,
  micTestAfterFailedStart,
  micTestToResume,
  micTestAction,
  micTestErrorAction,
  MIC_TEST_IDLE,
  nextMicTestState,
  formatClock,
  meterSegments,
  segmentTone,
  modeLabel,
  nextPreviewState,
  normalizeError,
  optionTier,
  overlayName,
  previewBlock,
  previewErrorInfo,
  previewNeedsRestart,
  previewStatusEvent,
  previewStatusInfo,
  previewStreamUrl,
  rateLabel,
  resolveCameraId,
  resolveDeviceKind,
  resolveMicrophoneId,
  resolveSelection,
  restartSelection,
  runPreviewStart,
  safeHref,
  sameSelection,
  selectionTier,
  sessionMatches,
  sessionToAdopt,
  sampleRateLabel,
  sizeOptions,
  sortIssues,
  sourceLabel,
  streamEndedEvent,
  startSuperseded,
  streamErrorEvent,
  tierInfo,
  validateBoardForm,
  watchPreview
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
const sel = (format, width, height, fps) => ({ format, width, height, fps })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const imx477 = {
  id: 'mipi:/base/axi/pcie@120000/rp1/i2c@80000/imx477@1a',
  kind: 'camera',
  connection: 'mipi',
  name: '/base/axi/pcie@120000/rp1/i2c@80000/imx477@1a',
  model: 'imx477',
  device: {
    camera_name: '/base/axi/pcie@120000/rp1/i2c@80000/imx477@1a', camera_name_source: 'libcamera',
    media_device: '/dev/media0', bus_info: 'platform:csi2video@1', csi: 'csidev-40c3000.csi', video_node: '/dev/video3'
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

// The Blue Yeti Nano item exactly as the real DevKit scan returned it.
const yeti = {
  id: 'microphone:alsa:3ff3d77bf791d455',
  kind: 'microphone',
  connection: 'usb',
  name: 'Yeti Nano',
  device: {
    card_index: 0, card_id: 'Nano', card_name: 'Yeti Nano', card_driver: 'USB-Audio',
    pcm_device: 0, pcm_node: '/dev/snd/pcmC0D0c', alsa_name: 'hw:CARD=Nano,DEV=0',
    by_path: '/dev/snd/by-path/platform-7ff0000000.pci-pci-0003:01:00.0-usb-0:3.1:1.0',
    by_id: '/dev/snd/by-id/usb-Blue_Microphones_Yeti_Nano_2127SG00CBA8_888-000441040606-00',
    usb: { vendor_id: 'b58e', product_id: '0005', manufacturer: 'Blue Microphones', product: 'Yeti Nano', serial: '2127SG00CBA8_888-000441040606', bus_path: '1-3.1', speed_mbps: 12 }
  },
  availability: available,
  capture: [{ format: 'S24_3LE', channels: 2, bits: 24, rates: [32000, 44100, 48000], rate_range: null, channel_map: ['FL', 'FR'] }],
  notes: [],
  errors: []
}

const onboardMic = {
  id: 'microphone:alsa:0a1b2c3d4e5f6071',
  kind: 'microphone',
  connection: 'onboard',
  name: 'sima-audio',
  device: { card_index: 1, card_id: 'simaaudio', card_name: 'sima-audio', card_driver: 'simple-card', pcm_device: 0, pcm_node: '/dev/snd/pcmC1D0c', alsa_name: 'hw:CARD=simaaudio,DEV=0' },
  availability: available,
  capture: null,
  notes: ['Capture formats cannot be read without opening the device.'],
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
  items: [usb, imx477, yeti, imx568, inUse],
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

test('a resolution names its size only, for USB and MIPI cameras alike', () => {
  assert.deepEqual(sizeOptions(usb, 'MJPG').map((o) => o.label), ['1280×720', '640×480'])
  // The rate is still chosen (highest Available, else highest) and carried in the selection, just not shown.
  const webcam = {
    ...usb,
    formats: [format('YUYV', 'YUYV 4:2:2', true, support('available'), [
      size(640, 480, [60, 'unsupported'], [30, 'available']),
      size(320, 240, [29.97, 'unsupported'], [15, 'unsupported']),
      size(160, 120, [7.5, 'unsupported'])
    ])]
  }
  assert.deepEqual(sizeOptions(webcam, 'YUYV').map((o) => [o.value, o.label]),
    [['640x480', '640×480'], ['320x240', '320×240'], ['160x120', '160×120']])
  assert.equal(resolveSelection(webcam, { format: 'YUYV', width: 640, height: 480 }).fps, 30)
  for (const camera of [imx477, imx568]) {
    for (const option of sizeOptions(camera, 'NV12')) assert.doesNotMatch(option.label, /fps/)
  }
})

test('a rate reads as a whole number within 1% of one, else as reported', () => {
  for (const [rate, label] of [[30, '30 fps'], [66.18, '66 fps'], [29.97, '30 fps'], ['59.94', '60 fps'], [7.5, '7.5 fps'], [12.345, '12.35 fps']]) {
    assert.equal(rateLabel(rate), label)
  }
  for (const unknown of [null, undefined, '', 0, -5, NaN, Infinity, 'x']) assert.equal(rateLabel(unknown), '')
})

test('the default selection is preselected; without one an Available mode is preferred', () => {
  assert.deepEqual(resolveSelection(imx477, null), sel('NV12', 1920, 1080, 30))
  // A USB camera has no Available mode and no default; its first reported mode is shown.
  assert.deepEqual(resolveSelection(usb, null), sel('MJPG', 1280, 720, 30))
  const mixed = {
    ...imx477,
    default_selection: null,
    formats: [
      format('AR24', 'AR24', false, support('unsupported', ISP_SIZE), [size(4056, 3040, [30, 'unsupported'])]),
      format('NV12', 'NV12', true, support('available'), [size(4056, 3040, [30, 'unsupported']), size(1920, 1080, [15, 'unsupported'], [30, 'available'])])
    ]
  }
  assert.deepEqual(resolveSelection(mixed, null), sel('NV12', 1920, 1080, 30))
})

test('a missing or non-exportable default falls back to the best exportable mode', () => {
  assert.deepEqual(resolveSelection(imx568, null), sel('NV12', 2432, 2048, 30))
  const rgbDefault = { ...imx568, default_selection: sel('RGB888', 1920, 1080, 30) }
  assert.equal(resolveSelection(rgbDefault, null).format, 'NV12')
  assert.equal(resolveSelection({ ...imx568, formats: [imx568.formats[1]] }, null), null)
})

test('changing one level keeps the rest of the selection when it is still offered', () => {
  assert.deepEqual(resolveSelection(usb, { format: 'YUYV' }), sel('YUYV', 640, 480, 30))
  assert.deepEqual(resolveSelection(usb, sel('YUYV', 640, 480, 30)), sel('YUYV', 640, 480, 30))
  assert.deepEqual(resolveSelection(usb, sel('YUYV', 1280, 720, 30)), sel('YUYV', 640, 480, 30))
  assert.deepEqual(resolveSelection(usb, { format: 'MJPG' }), sel('MJPG', 1280, 720, 30))
  assert.deepEqual(resolveSelection(imx477, sel('NV12', 1280, 720, 30)), sel('NV12', 1280, 720, 60))
  assert.deepEqual(resolveSelection(imx568, sel('NV12', 1920, 1080, 59.94)), sel('NV12', 1920, 1080, 59.94))
})

test('a selection that disappears after refresh falls back instead of clearing', () => {
  const refreshed = { ...imx477, formats: [{ ...imx477.formats[0], sizes: [imx477.formats[0].sizes[0]] }] }
  assert.deepEqual(resolveSelection(refreshed, sel('NV12', 1280, 720, 60)), sel('NV12', 1920, 1080, 60))
  assert.deepEqual(resolveSelection(refreshed, sel('NV12', 1280, 720, 15)), sel('NV12', 1920, 1080, 30))
  assert.equal(resolveSelection(usb, sel('H264', 1920, 1080, 30)).format, 'MJPG')
})

test('the selected camera id survives refreshes and removals', () => {
  assert.equal(resolveCameraId(snapshot, null), imx477.id)
  assert.equal(resolveCameraId(snapshot, usb.id), usb.id, 'an Unsupported camera opens like any other')
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
  assert.deepEqual(tierInfo('unverified'), { label: 'Unverified', tone: 'warn' })
  assert.deepEqual(tierInfo('bogus'), tierInfo('unsupported'), 'every mode is one of the three states')
  for (const [source, label] of [['on-board', 'On this board'], ['sdk-env', 'SDK DevKit'], ['manual', 'Manual']]) assert.equal(sourceLabel(source), label)
  assert.equal(defaultTargetText({ on_board: false, sdk_env: { host: '192.168.2.2', port: 22, user: 'sima' } }), 'sima@192.168.2.2:22 (paired SDK DevKit)')
  assert.equal(defaultTargetText({ on_board: false, sdk_env: null }), '')
})

test('a camera id prefers the stable name', () => {
  assert.equal(cameraDeviceId(imx477), imx477.device.camera_name)
  assert.equal(cameraDeviceId(usb), usb.device.by_id)
})

test('a subtitle never repeats what the name already says', () => {
  // "imx477 5-001a" carries the model, so the subtitle beneath it must not read "imx477" again.
  assert.equal(cameraSubtitle(imx477), '')
  // The USB camera reports its product string as both name and model, and its kernel path is not shown.
  assert.equal(cameraSubtitle(usb), '')
  assert.equal(cameraSubtitle({ name: 'C270', model: 'C270' }), '')
  assert.equal(cameraSubtitle({ name: 'cam', model: 'imx477' }), 'imx477')
})

test('changing the mode restarts a preview, but only the one it belongs to', () => {
  const mode = sel('NV12', 1920, 1080, 30)
  const live = { status: 'live', session: { id: 's1', camera_id: 'cam-a', mode } }
  assert.equal(previewNeedsRestart(live, 'cam-a', { ...mode, fps: 60 }), true, 'a different rate needs a restart')
  assert.equal(previewNeedsRestart(live, 'cam-a', { ...mode, width: 1280, height: 720 }), true)
  assert.equal(previewNeedsRestart(live, 'cam-a', { ...mode, format: 'RGB888' }), true)
  // Re-selecting the mode it is already streaming must not interrupt the picture.
  assert.equal(previewNeedsRestart(live, 'cam-a', { ...mode }), false)
  // A preview belongs to one camera; another camera's menus must not touch it.
  assert.equal(previewNeedsRestart(live, 'cam-b', { ...mode, fps: 60 }), false)
  assert.equal(previewNeedsRestart({ status: 'starting', session: live.session }, 'cam-a', { ...mode, fps: 60 }), true)
  assert.equal(previewNeedsRestart({ status: 'idle', session: null }, 'cam-a', { ...mode, fps: 60 }), false)
  assert.equal(previewNeedsRestart({ status: 'stopping', session: live.session }, 'cam-a', { ...mode, fps: 60 }), false)
  assert.equal(previewNeedsRestart(live, 'cam-a', null), false)
})

test('issues sort by severity and changes read as sentences', () => {
  assert.deepEqual(sortIssues(snapshot.issues).map((i) => i.severity), ['error', 'warning', 'info'])
  assert.deepEqual(changeSummary(snapshot.changes), ['Disconnected since last refresh: imx219', 'New: HD Webcam C270'])
  assert.deepEqual(changeSummary(null), [])
})

test('relative times and durations', () => {
  const now = Date.parse('2026-09-21T10:00:00Z')
  for (const [at, label] of [
    ['2026-09-21T09:59:58Z', 'just now'], ['2026-09-21T09:59:30Z', '30 s ago'], ['2026-09-21T09:55:00Z', '5 min ago'],
    ['2026-09-21T07:00:00Z', '3 h ago'], ['2026-09-19T10:00:00Z', '2 d ago'], [null, '']
  ]) assert.equal(formatRelativeTime(at, now), label)
  assert.equal(formatDuration(3400), '3.4 s')
  assert.equal(formatDuration(250), '250 ms')
})

test('API errors keep code, hint, and extra fields', () => {
  const body = {
    error: 'Host key changed', code: 'host_key_changed', hint: 'Confirm the board was reflashed.',
    host: '192.168.2.2', expected_fingerprint: 'SHA256:old', presented_fingerprint: 'SHA256:new'
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
  const mode = sel('NV12', 1920, 1080, 30)
  // No camera's rate is named before it runs, USB included.
  assert.equal(modeLabel(mode), 'NV12 1920×1080')
  assert.equal(modeLabel({ ...mode, fps: 59.94 }), 'NV12 1920×1080')
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
  for (const [host, port, user] of [['', '22', 'sima'], ['a b', '22', 'sima'], ['devkit', '70000', 'sima'], ['devkit', '22', ' ']]) {
    assert.ok(validateBoardForm({ host, port, user }).error, JSON.stringify({ host, port, user }))
  }
})

test('only http(s) links are rendered', () => {
  assert.equal(safeHref('https://github.com/sima-neat/core/issues/883'), 'https://github.com/sima-neat/core/issues/883')
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

test('device sub-tabs come from the snapshot kinds; microphones are selectable, unbuilt kinds disabled', () => {
  const tabs = deviceTabs(snapshot.items)
  assert.deepEqual(tabs.map((t) => t.id), ['camera', 'microphone', 'lidar'])
  assert.deepEqual(tabs.map((t) => t.label), ['Cameras', 'Microphones', 'LiDAR'])
  assert.equal(tabs[0].count, 4)
  assert.equal(tabs[0].disabled, false)
  assert.equal(tabs[1].count, 1, 'the microphone in the snapshot is counted')
  assert.equal(tabs[1].supported, true)
  assert.equal(tabs[1].disabled, false)
  assert.equal(tabs[1].note, '')
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
  assert.equal(tabs[1].tooltip, 'Microphones, 1 device')
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
  assert.equal(resolveDeviceKind(tabs, 'microphone'), 'microphone')
  assert.equal(resolveDeviceKind(tabs, 'lidar'), 'camera', 'disabled kinds fall back')
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

test('every camera row shows its verdict pill beside Connected', () => {
  assert.deepEqual(cameraTierPill(imx477), { label: 'Available', tone: 'ok' })
  assert.deepEqual(cameraTierPill(imx568), { label: 'Unsupported', tone: 'periph-danger' })
  assert.deepEqual(CONNECTED_PILL, { label: 'Connected', tone: '' })
  assert.equal(connectionPill({ modes_source: 'live' }), CONNECTED_PILL)
  assert.deepEqual(connectionPill({ modes_source: 'previous-scan' }), { label: 'Last scan', tone: '' })
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
  assert.equal(cameraSummaryLine(usb), '', 'a USB camera is always Unsupported, so it gets no sentence')
  assert.equal(cameraSummaryLine({}), '')
})

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// A request that stays pending until the test answers it, in the order requests were sent.
function queued(requests) {
  const request = deferred()
  requests.push(request)
  return request.promise
}

function boardSyncHarness() {
  const requests = []
  const state = { board: null, error: null, loading: false, errors: 0 }
  const sync = createBoardSync({
    fetchBoard: () => queued(requests),
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

test('the selected mode keeps the tier the board reported for it', () => {
  assert.equal(selectionTier(imx477, sel('NV12', 1920, 1080, 30)), 'available')
  assert.equal(selectionTier(imx477, sel('NV12', 1280, 720, 60)), 'unsupported')
  assert.equal(selectionTier(usb, sel('MJPG', 1280, 720, 30)), 'unsupported')
  assert.equal(selectionTier(imx477, sel('NV12', 640, 480, 30)), '')
  assert.equal(selectionTier(imx477, null), '')
})

const mipiMode = sel('NV12', 1920, 1080, 30)
const boardTarget = { mode: 'ssh', label: 'sima@192.168.2.2' }
const liveSession = {
  id: '8f1c',
  camera_id: imx477.id,
  mode: mipiMode,
  stream_url: '/api/peripherals/cameras/preview/8f1c/stream',
  generation: 3,
  state: 'live'
}

test('Start preview is blocked with the reason for every state that forbids it', () => {
  const block = (camera, selection, extra) => previewBlock({ camera, selection, target: boardTarget, ...extra })
  const open = { blocked: false, reason: '' }
  assert.deepEqual(block(imx477, mipiMode), open)

  assert.match(block(imx477, mipiMode, { target: null }).reason, /No board is selected/)
  assert.match(block(null, null).reason, /Select a camera/)
  assert.match(block(imx477, mipiMode, { stale: true }).reason, /board changed/)

  // A USB camera has no camera overlay, so its modes are Unsupported, and it previews any listed mode.
  assert.deepEqual(block(usb, sel('MJPG', 1280, 720, 30)), open)
  assert.match(block(usb, null).reason, /no mode Insight can start/)
  // A camera the scan says is in use is not blocked up front: the start reports a busy camera itself.
  assert.deepEqual(block({ ...usb, availability: inUse.availability }, sel('YUYV', 640, 480, 15)), open)

  // Only the formats the backend previews: MJPG and the raw FourCCs GStreamer converts.
  for (const fmt of ['MJPG', 'YUYV', 'GREY']) assert.equal(block(usb, sel(fmt, 640, 480, 30)).blocked, false, fmt)
  const h264 = block(usb, sel('H264', 1280, 720, 30))
  assert.equal(h264.blocked, true)
  assert.match(h264.reason, /not H264\. Choose another format\.$/)
  assert.ok(Object.isFrozen(USB_PREVIEW_FORMATS))

  assert.match(block(imx477, null).reason, /no mode Insight can start/)

  const unsupported = { ...imx477, formats: [format('NV12', 'NV12', false, support('unsupported', ISP_SIZE), [size(1920, 1080, [30, 'unsupported'])])] }
  assert.match(block(unsupported, mipiMode).reason, /is Unsupported on this board/)
  // The backend previews Available modes only: an Unsupported rate, or one with no state, must not leave Start enabled.
  for (const tier of ['', 'unsupported']) {
    const unjudged = block({ ...imx477, formats: [format('NV12', 'NV12', true, support('available'), [size(1920, 1080, [30, tier])])] }, mipiMode)
    assert.equal(unjudged.blocked, true, `tier ${JSON.stringify(tier)}`)
    assert.match(unjudged.reason, /is Unsupported on this board\. Choose an Available mode\.$/)
  }

  // The scan's availability never blocks Start; a busy camera is reported by the start itself.
  assert.deepEqual(block(inUse, mipiMode), open)

  assert.match(block(imx477, mipiMode, { session: { ...liveSession, camera_id: imx568.id } }).reason, /already running on mipi:econ-imx568-fpga 5-0042/)
  assert.equal(block(imx477, mipiMode, { session: liveSession }).blocked, false)
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
  assert.equal(stopping.session.id, '8f1c', 'the session stays on screen while the board stops')
  assert.deepEqual(nextPreviewState(stopping, { type: 'stopped', for: '8f1c' }), PREVIEW_IDLE)

  // A session reported as "stopped" ends the preview too.
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

test('preview transitions: a late event from the previous preview leaves a new start alone', () => {
  // The previous preview's stream check answers after the user started the next one.
  const starting = nextPreviewState(PREVIEW_IDLE, { type: 'start' })
  assert.equal(nextPreviewState(starting, streamEndedEvent('previous')), starting)
  assert.equal(nextPreviewState(starting, { type: 'failed', for: 'previous', error: { message: 'boom' } }), starting)
  assert.equal(nextPreviewState(starting, { type: 'elsewhere', for: 'previous', session: liveSession }), starting)
  // The new start's answer is still shown.
  assert.equal(nextPreviewState(starting, { type: 'session', session: liveSession }).status, 'live')
})

test('preview transitions: a stale session id never disturbs a newer one', () => {
  const live = nextPreviewState(nextPreviewState(PREVIEW_IDLE, { type: 'start' }), { type: 'session', session: liveSession })
  assert.equal(nextPreviewState(live, streamEndedEvent('old-id')), live)
  assert.equal(nextPreviewState(live, { type: 'stopped', for: 'old-id' }), live)
  assert.equal(nextPreviewState(live, { type: 'stopping', for: 'old-id' }), live)
  assert.equal(nextPreviewState(live, { type: 'failed', for: 'old-id', error: { message: 'boom' } }), live)
  assert.equal(nextPreviewState(live, { type: 'session', session: { ...liveSession, id: 'other' } }), live)

  const ended = nextPreviewState(live, streamEndedEvent('8f1c'))
  assert.equal(ended.status, 'idle')
  assert.equal(ended.session, null)
  assert.equal(ended.error.message, 'The preview stream stopped.')
  assert.ok(previewErrorInfo(ended.error).hint, 'a stopped stream always offers a way back')
})

test("a live preview's status read ends it once the backend no longer runs this session", async () => {
  const live = nextPreviewState(nextPreviewState(PREVIEW_IDLE, { type: 'start' }), { type: 'session', session: liveSession })
  const reads = []
  const reply = (body) => async (url) => {
    reads.push(url)
    return body
  }

  // Still the backend's current session: nothing changes.
  assert.equal(await previewStatusEvent(reply({ session: liveSession }), '8f1c'), null)
  assert.deepEqual(reads, ['/api/peripherals/preview'])

  // No session, another session, or this one stopped: the stream is over.
  for (const body of [{ session: null }, { session: { ...liveSession, id: 'other' } }, { session: { ...liveSession, state: 'stopped' } }]) {
    const event = await previewStatusEvent(reply(body), '8f1c')
    assert.deepEqual(event, streamEndedEvent('8f1c'), JSON.stringify(body))
    const ended = nextPreviewState(live, event)
    assert.equal(ended.status, 'idle')
    assert.equal(ended.error.code, 'stream_ended')
  }

  // A read that fails proves nothing about the stream.
  assert.equal(await previewStatusEvent(async () => { throw new Error('network') }, '8f1c'), null)
})

test('a restart starts the mode selected once its stop finished, not the one selected before it', () => {
  const b = { id: 'camera:a', format: 'MJPG', width: 640, height: 480, fps: 30 }
  const c = { ...b, width: 1280, height: 720 }
  const requested = { cameraId: 'camera:a', generation: 3 }
  // Mode C was picked while the stop for the switch to B ran.
  assert.deepEqual(restartSelection(requested, { cameraId: 'camera:a', generation: 3, selection: c }), c)
  // Another camera or board meanwhile: nothing is started.
  assert.equal(restartSelection(requested, { cameraId: 'camera:b', generation: 3, selection: { ...c, id: 'camera:b' } }), null)
  assert.equal(restartSelection(requested, { cameraId: 'camera:a', generation: 4, selection: c }), null)
  assert.equal(restartSelection(requested, { cameraId: 'camera:a', generation: 3, selection: null }), null)
})

test('every step of a start that resumes after an await acts only for the view read at that step', async () => {
  const a = { id: 'camera:a', format: 'MJPG', width: 640, height: 480, fps: 30 }
  const b = { ...a, width: 1280, height: 720 }
  const c = { ...a, width: 1920, height: 1080 }
  const sessionFor = (mode) => ({ id: 's1', camera_id: 'camera:a', generation: 3, state: 'live', mode: { format: mode.format, width: mode.width, height: mode.height, fps: mode.fps } })
  // A page whose selection the test changes while a request is in flight.
  function page(selection) {
    const log = []
    const current = { cameraId: 'camera:a', generation: 3, selection }
    return {
      log,
      current,
      deps: {
        dispatch: (event) => log.push(['dispatch', event.type]),
        adopt: (session) => log.push(['adopt', session.id]),
        start: (mode) => log.push(['start', mode.width]),
        stop: async (session) => { log.push(['stop', session.id]); return true },
        view: () => ({ ...current }),
        normalize: (err) => err
      }
    }
  }
  const requested = { cameraId: 'camera:a', generation: 3, mode: a }
  const refused = async () => { throw { code: 'preview_active', message: 'busy' } }
  const startedA = async () => ({ session: sessionFor(a) })

  // A refused start looks up the preview another tab runs; B is picked during that look-up, so the
  // other tab's session is not adopted (which would switch the menus back) and the pane resets.
  let p = page(a)
  await runPreviewStart(requested, { ...p.deps, post: refused, lookup: async () => { p.current.selection = b; return sessionFor(a) } })
  assert.deepEqual(p.log, [['dispatch', 'start'], ['dispatch', 'reset']])

  // Unchanged during the look-up: the running preview is adopted.
  p = page(a)
  await runPreviewStart(requested, { ...p.deps, post: refused, lookup: async () => sessionFor(a) })
  assert.deepEqual(p.log, [['dispatch', 'start'], ['adopt', 's1']])

  // A start for A answers after B was picked, so it is stopped; C is picked during that stop, so C is
  // started, not B.
  p = page(b)
  await runPreviewStart(requested, {
    ...p.deps,
    post: startedA,
    stop: async (session) => { p.log.push(['stop', session.id]); p.current.selection = c; return true }
  })
  assert.deepEqual(p.log, [['dispatch', 'start'], ['stop', 's1'], ['start', 1920]])

  // The camera changed during that stop: nothing is started.
  p = page(b)
  await runPreviewStart(requested, {
    ...p.deps,
    post: startedA,
    stop: async () => { p.current.cameraId = 'camera:b'; p.current.selection = { ...c, id: 'camera:b' }; return true }
  })
  assert.deepEqual(p.log, [['dispatch', 'start'], ['dispatch', 'reset']])

  // Nothing changed: the session is shown.
  p = page(a)
  await runPreviewStart(requested, { ...p.deps, post: startedA })
  assert.deepEqual(p.log, [['dispatch', 'start'], ['dispatch', 'session']])
})

test('a start is superseded once the camera, board, or mode it was sent for is no longer the one shown', () => {
  const mode = { format: 'MJPG', width: 640, height: 480, fps: 30 }
  const requested = { cameraId: 'camera:a', generation: 3, mode }
  const latest = { cameraId: 'camera:a', generation: 3, selection: { id: 'camera:a', ...mode } }
  assert.equal(startSuperseded(requested, latest), false)
  assert.equal(startSuperseded(requested, { ...latest, cameraId: 'camera:b' }), true)
  assert.equal(startSuperseded(requested, { ...latest, generation: 4 }), true)
  assert.equal(startSuperseded(requested, { ...latest, selection: { ...latest.selection, fps: 15 } }), true)
  assert.equal(startSuperseded(requested, { ...latest, selection: null }), true)
  // A board without a generation (none reported yet) compares on camera and mode alone.
  assert.equal(startSuperseded({ ...requested, generation: undefined }, latest), false)
})

test('a stream refused because another tab claimed it first shows the preview there, not as ended', async () => {
  // Both tabs found the session unclaimed and went live; the backend gave the stream to the other tab.
  const live = nextPreviewState(PREVIEW_IDLE, { type: 'adopt', session: { ...liveSession, viewer: false } })
  assert.equal(live.status, 'live')
  const reply = (body) => async () => body

  const claimed = { ...liveSession, viewer: true }
  const refused = await streamErrorEvent(reply({ session: claimed }), '8f1c')
  const shown = nextPreviewState(live, refused)
  assert.equal(shown.status, 'elsewhere')
  assert.equal(shown.error, null)
  assert.equal(shown.session.id, '8f1c')

  // Nobody holds it, it is gone, another session runs, or the read failed: the stream is over.
  for (const request of [
    reply({ session: { ...liveSession, viewer: false } }),
    reply({ session: null }),
    reply({ session: { ...claimed, id: 'other' } }),
    reply({ session: { ...claimed, state: 'stopped' } }),
    async () => { throw new Error('network') }
  ]) {
    const event = await streamErrorEvent(request, '8f1c')
    assert.deepEqual(event, streamEndedEvent('8f1c'))
    assert.equal(nextPreviewState(live, event).error.code, 'stream_ended')
  }

  // Only a live pane moves: a Stop in progress or a newer session is left alone.
  const stopping = nextPreviewState(live, { type: 'stopping', for: '8f1c' })
  assert.equal(nextPreviewState(stopping, refused), stopping)
  assert.equal(nextPreviewState(live, { ...refused, for: 'older' }), live)
})

test('a watched live preview is read until the backend no longer runs it, and cancelling stops the reads', async () => {
  const replies = [{ session: liveSession }, { session: liveSession }, { session: null }]
  const reads = []
  const requestJson = async (url) => {
    reads.push(url)
    return replies.shift() || { session: null }
  }
  const events = []
  watchPreview(requestJson, '8f1c', (event) => events.push(event), 1)
  const deadline = Date.now() + 2000
  while (!events.length && Date.now() < deadline) await sleep(5)
  assert.deepEqual(events, [streamEndedEvent('8f1c')])
  assert.equal(reads.length, 3)
  await sleep(20)
  assert.equal(reads.length, 3, 'reading stops once the preview ended')

  let count = 0
  const cancel = watchPreview(async () => {
    count += 1
    return { session: null }
  }, '8f1c', (event) => events.push(event), 1)
  cancel()
  await sleep(20)
  assert.equal(count, 0)
  assert.equal(events.length, 1)

  // Cancelled while a read is in flight: its answer is dropped.
  let answer
  const slow = watchPreview(() => new Promise((resolve) => { answer = resolve }), '8f1c', (event) => events.push(event), 1)
  while (!answer) await sleep(1)
  slow()
  answer({ session: null })
  await sleep(10)
  assert.equal(events.length, 1)
})

test("a live preview's status read passes on the camera's rate once the backend knows it", async () => {
  const live = nextPreviewState(nextPreviewState(PREVIEW_IDLE, { type: 'start' }), { type: 'session', session: liveSession })
  const reply = (body) => async () => body
  // Unknown (a MIPI sensor before Sentinel answers, or one it could not read): nothing to pass on.
  assert.equal(await previewStatusEvent(reply({ session: { ...liveSession, camera_fps: null } }), '8f1c'), null)
  const event = await previewStatusEvent(reply({ session: { ...liveSession, camera_fps: 66.18 } }), '8f1c')
  assert.deepEqual(event, { type: 'camera-fps', for: '8f1c', fps: 66.18 })
  const known = nextPreviewState(live, event)
  assert.equal(known.status, 'live')
  assert.equal(known.session.camera_fps, 66.18)
  assert.equal(known.session.stream_url, liveSession.stream_url)
  assert.equal(nextPreviewState(known, event), known, 'an unchanged rate keeps the state')
  assert.equal(nextPreviewState(live, { ...event, for: 'other' }), live, "another session's rate is ignored")
  assert.equal(nextPreviewState(PREVIEW_IDLE, event), PREVIEW_IDLE)

  // Reading goes on after the rate arrives, until the preview ends.
  const replies = [{ session: liveSession }, { session: { ...liveSession, camera_fps: 66.18 } }, { session: null }]
  const events = []
  watchPreview(async () => replies.shift() || { session: null }, '8f1c', (e) => events.push(e), 1)
  const deadline = Date.now() + 2000
  while (events.length < 2 && Date.now() < deadline) await sleep(5)
  assert.deepEqual(events, [event, streamEndedEvent('8f1c')])
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
  assert.equal(adopted.session.stream_url, liveSession.stream_url)
  assert.deepEqual(nextPreviewState(PREVIEW_IDLE, { type: 'adopt', session: { ...liveSession, state: 'stopped' } }), PREVIEW_IDLE)
  assert.deepEqual(nextPreviewState(PREVIEW_IDLE, { type: 'adopt', session: null }), PREVIEW_IDLE)

  // A session another page already shows (its one viewer) is not opened here: the pane offers Stop.
  const shown = { ...liveSession, viewer: true }
  const elsewhere = nextPreviewState(PREVIEW_IDLE, { type: 'adopt', session: shown })
  assert.equal(elsewhere.status, 'elsewhere')
  assert.equal(nextPreviewState(elsewhere, { type: 'session', session: shown }).status, 'elsewhere')
  assert.deepEqual(nextPreviewState(elsewhere, streamEndedEvent(liveSession.id)), PREVIEW_IDLE)
  assert.equal(nextPreviewState(elsewhere, { type: 'stopping', for: liveSession.id }).status, 'stopping')

  const live = nextPreviewState(starting, { type: 'session', session: liveSession })
  // Stop closes the stream, so its end can arrive before the stop's own answer: that is the stop, not a failure,
  // and the stop's answer afterwards changes nothing.
  const stoppingLive = nextPreviewState(live, { type: 'stopping', for: liveSession.id })
  const endedByStop = nextPreviewState(stoppingLive, streamEndedEvent(liveSession.id))
  assert.deepEqual(endedByStop, PREVIEW_IDLE)
  assert.deepEqual(nextPreviewState(endedByStop, { type: 'stopped', for: liveSession.id }), PREVIEW_IDLE)
  const stopping = nextPreviewState(starting, { type: 'stopping', for: liveSession.id, session: liveSession })
  const stopFailed = nextPreviewState(stopping, { type: 'stop-failed', for: liveSession.id, error: { message: 'SSH failed' } })
  assert.equal(stopFailed.status, 'live')
  assert.equal(stopFailed.session.id, liveSession.id)
  assert.equal(stopFailed.error.message, 'SSH failed')
  assert.equal(nextPreviewState(live, { type: 'nonsense' }), live)
  assert.equal(nextPreviewState(undefined, { type: 'nonsense' }), PREVIEW_IDLE)
})

test('a session belongs to the camera and board generation it was started for', () => {
  assert.equal(sessionMatches(liveSession, imx477.id, 3), true)
  assert.equal(sessionMatches(liveSession, imx477.id, 3, liveSession.mode), true)
  assert.equal(sessionMatches(liveSession, imx477.id, 3, { ...liveSession.mode, fps: 60 }), false)
  assert.equal(sessionMatches(liveSession, imx477.id, 4), false)
  assert.equal(sessionMatches(liveSession, imx568.id, 3), false)
  assert.equal(sessionMatches(liveSession, imx477.id), true)
  assert.equal(sessionMatches(null, imx477.id, 3), false)
})

test('every preview failure carries a recovery action and nothing destructive', () => {
  const info = (body, status) => previewErrorInfo(normalizeError(apiError(body, status)))
  assert.equal(previewErrorInfo(null), null)

  const busy = info({ error: 'The camera is already open.', code: 'camera_in_use', hint: 'gst-launch-1.0 (pid 812) has /dev/video3 open.' }, 409)
  assert.equal(busy.hint, 'gst-launch-1.0 (pid 812) has /dev/video3 open.')
  assert.match(busy.action, /Insight never stops it for you/)

  const other = info({ error: 'A preview is already running.', code: 'preview_active', session: { camera_id: imx568.id } }, 409)
  assert.equal(other.otherCamera, imx568.id)
  assert.match(other.action, /Stop the preview that is already running/)

  // The backend puts camera_id at the top level of the 409 body.
  assert.equal(info({ error: 'x', code: 'preview_active', camera_id: usb.id }, 409).otherCamera, usb.id)

  assert.match(info({ error: 'x', code: 'invalid_request' }, 400).action, /^Choose a mode Insight lists as Available; /)
  assert.equal(info({ error: 'x', code: 'command_failed', detail: 'gst: no element' }, 502).detail, 'gst: no element')
  assert.equal(info({ error: 'x', code: 'unreachable' }, 502).action, '')
})

test('the preview stream is only loaded from its same-origin API path', () => {
  assert.equal(previewStreamUrl(liveSession), liveSession.stream_url)
  for (const url of ['https://evil.example/api/peripherals/cameras/preview/8f1c/stream', 'javascript:alert(1)',
    '/api/peripherals/cameras/preview/../stop/stream', '//evil.example/api/peripherals/cameras/preview/8f1c/stream', '', undefined]) {
    assert.equal(previewStreamUrl({ ...liveSession, stream_url: url }), null, String(url))
  }
  assert.equal(previewStreamUrl(null), null)
})

test('an adopted preview selects the camera and the mode it streams, not the defaults', () => {
  const session = { id: 's1', camera_id: imx477.id, mode: sel('NV12', 1920, 1080, 60), state: 'live' }
  const wanted = adoptedSelection(session)
  assert.deepEqual(wanted, { id: imx477.id, format: 'NV12', width: 1920, height: 1080, fps: 60 })
  assert.deepEqual(resolveSelection(imx477, wanted), session.mode)
  assert.equal(adoptedSelection({ id: 's2', mode: session.mode }), null)
})

test('a start refused because another tab started a preview adopts that preview', () => {
  const session = { id: 's1', camera_id: imx477.id, mode: sel('NV12', 1920, 1080, 60), state: 'live' }
  const active = { code: 'preview_active', message: 'A preview is already running.' }
  assert.equal(sessionToAdopt(active, session), session)
  const adopted = nextPreviewState(nextPreviewState(PREVIEW_IDLE, { type: 'start' }), { type: 'adopt', session: sessionToAdopt(active, session) })
  assert.deepEqual(adopted, { status: 'live', session, error: null }, 'the pane shows its video and Stop')
  // Nothing to adopt: the other preview already stopped, or the start failed for another reason.
  assert.equal(sessionToAdopt(active, null), null)
  assert.equal(sessionToAdopt(active, { ...session, state: 'stopped' }), null)
  assert.equal(sessionToAdopt({ code: 'camera_in_use' }, session), null)
})

test('with no microphone detected the kind stays greyed and says so', () => {
  const [, mics] = deviceTabs([imx477])
  assert.equal(mics.supported, true)
  assert.equal(mics.disabled, true)
  assert.equal(mics.note, 'No microphones detected')
  assert.equal(mics.tooltip, 'Microphones — No microphones detected')
  assert.equal(resolveDeviceKind(deviceTabs([imx477]), 'microphone'), 'camera')
  assert.equal(resolveDeviceKind(deviceTabs([yeti]), 'camera'), 'microphone', 'a board with only a mic opens on it')
})

test('microphones are grouped USB first, then on-board, and cameras are left out', () => {
  const groups = groupMicrophones([onboardMic, imx477, yeti])
  assert.deepEqual(groups.map((g) => g.label), ['USB (ALSA)', 'On-board (ALSA)'])
  assert.deepEqual(groups.map((g) => g.items.map((m) => m.id)), [[yeti.id], [onboardMic.id]])
  assert.deepEqual(groupCameras([yeti]), [], 'a microphone never shows in the camera list')
})

test('the selected microphone survives refreshes and removals', () => {
  const items = { items: [yeti, onboardMic], changes: { added: [], removed: [{ id: 'usb:0c76:161f:1-3.2:c0', name: 'USB PnP Audio Device' }] } }
  assert.equal(resolveMicrophoneId(items, null), yeti.id)
  assert.equal(resolveMicrophoneId(items, onboardMic.id), onboardMic.id)
  assert.equal(resolveMicrophoneId(items, 'usb:0c76:161f:1-3.2:c0'), 'usb:0c76:161f:1-3.2:c0')
  assert.equal(resolveMicrophoneId(items, imx477.id), yeti.id, 'a camera id is not a microphone selection')
})

test('the real Yeti Nano reads as capture tags', () => {
  assert.equal(microphoneSubtitle(yeti), '', 'the ALSA name is not shown under the title')
  assert.deepEqual(captureModes(yeti), [{ key: '0-S24_3LE-2-24', badges: ['S24_3LE', '2 ch', '24-bit', '32 · 44.1 · 48 kHz'] }])
})

test('capture tags cover mono, several formats, single rates and continuous ranges', () => {
  const modes = captureModes({
    capture: [
      { format: 'S32_LE', channels: 2, bits: 24, rates: [44100, 48000, 88200, 96000], rate_range: null, channel_map: ['FL', 'FR'] },
      { format: 'S16_LE', channels: 1, bits: 16, rates: [16000], rate_range: null, channel_map: ['MONO'] },
      { format: 'S24_3LE', channels: 1, bits: 24, rates: [], rate_range: { min: 8000, max: 48000 }, channel_map: null },
      { format: 'S16_LE', channels: 1, bits: 16, rates: [11025], rate_range: { min: 11025, max: 96000 }, channel_map: null }
    ]
  })
  assert.deepEqual(modes.map((mode) => mode.badges), [
    ['S32_LE', '2 ch', '24-bit', '44.1 · 48 · 88.2 · 96 kHz'],
    ['S16_LE', '1 ch', '16-bit', '16 kHz'],
    ['S24_3LE', '1 ch', '24-bit', '8–48 kHz'],
    ['S16_LE', '1 ch', '16-bit', '11.025–96 kHz']
  ], 'a continuous range stays one range')
  assert.deepEqual(captureModes({ capture: [{ format: null, channels: null, bits: null, rates: [], rate_range: null }] })[0].badges, [],
    'a field the kernel did not print is left out, not shown empty')
  assert.equal(new Set(modes.map((m) => m.key)).size, 4, 'every combination keeps its own row')
  assert.equal(sampleRateLabel(22050), '22.05 kHz')
})

test('a card without readable capabilities omits its capture modes', () => {
  assert.equal(captureModes(onboardMic), null)
  assert.deepEqual(captureModes({ capture: [] }), [])
  const bare = {
    ...yeti,
    name: 'USB Device 0x1234:0x5678',
    device: { card_index: 3, pcm_device: 0, pcm_node: '/dev/snd/pcmC3D0c', usb: { vendor_id: '1234', product_id: '5678', manufacturer: null, product: null, serial: null, bus_path: '1-2', speed_mbps: null } }
  }
  assert.equal(microphoneSubtitle(bare), '')
})

test('a webcam microphone names the camera it is part of', () => {
  const webcamMic = { ...yeti, device: { ...yeti.device, alsa_name: 'hw:CARD=C920,DEV=0', part_of: { id: usb.id, name: 'HD Pro Webcam C920' } } }
  assert.equal(microphoneSubtitle(webcamMic), 'Part of HD Pro Webcam C920')
})

test('microphone test: record, play back, replay, and never a late answer out of turn', () => {
  const recording = nextMicTestState(MIC_TEST_IDLE, { type: 'record' })
  assert.equal(recording.status, 'recording')
  const test = { token: 'a', audio_url: '/x.wav', level: { silent: false } }
  const playing = nextMicTestState(recording, { type: 'recorded', test })
  assert.deepEqual(playing, { status: 'playing', test, error: null }, 'playback starts by itself')
  const done = nextMicTestState(playing, { type: 'played' })
  assert.equal(done.status, 'done')
  assert.equal(nextMicTestState(done, { type: 'replay' }).status, 'playing')
  assert.equal(nextMicTestState(recording, { type: 'replay' }), recording, 'nothing to replay while recording')
  const failed = nextMicTestState(recording, { type: 'failed', error: { code: 'microphone_in_use' } })
  assert.equal(failed.status, 'error')
  assert.equal(nextMicTestState(MIC_TEST_IDLE, { type: 'recorded', test }), MIC_TEST_IDLE, 'an answer nobody is waiting for is dropped')
  assert.equal(nextMicTestState(done, { type: 'failed', error: {} }), done)
  assert.equal(nextMicTestState(done, { type: 'record' }).status, 'recording', 'test again from a finished test')
  assert.deepEqual(nextMicTestState(failed, { type: 'reset' }), MIC_TEST_IDLE)
  assert.equal(nextMicTestState(undefined, { type: 'nonsense' }), MIC_TEST_IDLE)
})

test('microphone test: a failed stop keeps the test recording, so Stop can be retried and the recording is taken up', () => {
  // Codex 4263048526: a failed stop turned the test into an error, and the board's recording was then ignored.
  const recording = nextMicTestState(MIC_TEST_IDLE, { type: 'record' })
  const error = { code: 'network', message: 'Could not reach Insight.' }
  const stopFailed = nextMicTestState(recording, { type: 'stop-failed', error })
  assert.deepEqual(stopFailed, { status: 'recording', test: null, error })
  const test = { token: 'a', audio_url: '/x.wav', level: { silent: false } }
  assert.deepEqual(nextMicTestState(stopFailed, { type: 'recorded', test }), { status: 'playing', test, error: null })
  const done = { status: 'done', test, error: null }
  assert.equal(nextMicTestState(done, { type: 'stop-failed', error }), done, 'only a recording test is stopped')
})

test('microphone test: a detail mounted mid-test takes up the board\'s test for its own microphone', () => {
  const recording = { token: 't', id: yeti.id, state: 'recording', elapsed_ms: 1200, level_dbfs: -20 }
  const ready = { token: 't', id: yeti.id, state: 'ready', audio_url: '/t.wav', level: { silent: false } }
  assert.equal(micTestToResume(yeti.id, recording), recording)
  assert.equal(micTestToResume(yeti.id, ready), ready, 'a recording finished while another mic was shown is kept')
  assert.equal(micTestToResume(onboardMic.id, recording), null, 'another microphone\'s test is not shown here')
  assert.equal(micTestToResume(yeti.id, { ...recording, state: 'failed' }), null)
  assert.equal(micTestToResume(yeti.id, null), null)
  assert.deepEqual(nextMicTestState(MIC_TEST_IDLE, { type: 'resume', test: recording }), { status: 'recording', test: null, error: null })
  assert.deepEqual(nextMicTestState(MIC_TEST_IDLE, { type: 'resume', test: ready }), { status: 'done', test: ready, error: null })
  const started = nextMicTestState(MIC_TEST_IDLE, { type: 'record' })
  assert.equal(nextMicTestState(started, { type: 'resume', test: ready }), started, 'a test started here is not replaced')
})

test('microphone test: a start whose answer was lost takes up the recording it began', () => {
  const recording = { token: 'new', id: yeti.id, state: 'recording', elapsed_ms: 400, level_dbfs: -30 }
  const ready = { ...recording, state: 'ready', audio_url: '/new.wav' }
  const lost = { code: 'network', message: 'Could not reach the Insight server.' }
  assert.equal(micTestAfterFailedStart(yeti.id, lost, recording, null), recording)
  assert.equal(micTestAfterFailedStart(yeti.id, { code: 'test_running' }, recording, 'old'), recording, 'a retry refused by its own recording')
  assert.equal(micTestAfterFailedStart(yeti.id, { code: '', message: 'Request failed: 504' }, ready, null), ready, 'a gateway error without an API body')
  assert.equal(micTestAfterFailedStart(yeti.id, lost, { ...ready, token: 'old' }, 'old'), null, 'the recording shown before Test is not new')
  assert.equal(micTestAfterFailedStart(onboardMic.id, { code: 'test_running' }, recording, null), null, 'another microphone is recording')
  assert.equal(micTestAfterFailedStart(yeti.id, lost, { ...recording, state: 'failed' }, null), null)
  assert.equal(micTestAfterFailedStart(yeti.id, lost, null, null), null)
  assert.equal(micTestAfterFailedStart(yeti.id, { code: 'microphone_in_use' }, recording, null), null, 'the backend answered: its error stands')
  assert.deepEqual([lost, { code: 'test_running' }, { code: '' }, { code: 'not_found' }].map(micStartMayHaveRun), [true, true, true, false], 'only these read the current test')
})

test('microphone test: the scan never disables Test; the start request checks the board', () => {
  assert.equal(micTestAction('idle', false).disabled, false)
  const source = readFileSync(new URL('./MicrophoneDetail.jsx', import.meta.url), 'utf8')
  assert.match(source, /disabled=\{button\.disabled\}/, 'only the button state disables Test, not the scan')
})

test('the level meter lights green, then amber, then red, from -50 dBFS to full scale', () => {
  for (const [dbfs, lit] of [[null, 0], [-80, 0], [-50, 0], [-25, 10], [0, 20], [6, 20]]) assert.equal(meterSegments(dbfs, 20), lit, String(dbfs))
  assert.deepEqual([0, 13, 14, 17, 18, 19].map((i) => segmentTone(i, 20)), ['low', 'low', 'mid', 'mid', 'high', 'high'])
})

test('microphone test: it only speaks up about silence', () => {
  assert.match(micLevelNotice({ silent: true, peak_dbfs: null }), /Nothing was picked up/)
  assert.equal(micLevelNotice({ silent: false, peak_dbfs: -9 }), '')
  assert.equal(micLevelNotice(null), '')
  assert.match(micTestErrorAction({ code: 'microphone_in_use' }), /never stops it/)
  assert.match(micTestErrorAction({ code: 'tool_missing' }), /alsa-utils/)
  assert.equal(micTestErrorAction({ code: 'command_failed', hint: 'See detail.' }), 'See detail.')
  for (const [seconds, clock] of [[0, '0:00'], [4.9, '0:04'], [75, '1:15']]) assert.equal(formatClock(seconds), clock)
})

test('microphone test: one button records, stops the recording, then stops the playback', () => {
  assert.deepEqual(micTestAction('idle', false), { label: 'Test microphone', action: 'record', disabled: false })
  assert.deepEqual(micTestAction('recording', false), { label: 'Stop recording', action: 'stop', disabled: false },
    'Stop is available the moment recording starts')
  assert.deepEqual(micTestAction('recording', true), { label: 'Stopping…', action: 'stop', disabled: true })
  assert.deepEqual(micTestAction('playing', false), { label: 'Stop playing', action: 'stop-playing', disabled: false })
  assert.equal(micTestAction('done', false).action, 'record')
  assert.equal(micTestAction('error', false).action, 'record')
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

// Codex (5878ec6): shell details read for an earlier board answered last and overwrote the newer board's.
test('shell details read for an earlier board cannot overwrite the newer board', async () => {
  const requests = []
  const shown = []
  const sync = createShellInfoSync({ fetchShell: () => queued(requests), onShell: (info) => shown.push(info) })
  const first = sync.load()
  const second = sync.load()
  requests[1].resolve({ available: true, target: 'B' })
  requests[0].resolve({ available: false, target: 'A' })
  await Promise.all([first, second])
  assert.deepEqual(shown, [{ available: true, target: 'B' }])
  const failed = sync.load()
  requests[2].reject(new Error('offline'))
  await failed
  assert.deepEqual(shown.at(-1), null)
})

test('an Unverified 3.0 sensor size is listed between Available and Unsupported and can be previewed', () => {
  const UNVERIFIED = 'SiMa Sentinel cannot confirm libcamera streams this exact size; start a preview to check.'
  const camera = {
    ...imx477,
    formats: [
      format('NV12', 'NV12 (YUV 4:2:0)', true, support('available'), [
        size(1332, 990, [30, 'unverified']),
        size(1920, 1080, [30, 'available']),
        size(4056, 3040, [30, 'unsupported'])
      ])
    ]
  }
  const groups = groupOptions(sizeOptions(camera, 'NV12'))
  assert.deepEqual(groups.map((g) => [g.label, g.options.map((o) => o.label)]),
    [['Available', ['1920×1080']], ['Unverified', ['1332×990']], ['Unsupported', ['4056×3040']]])
  assert.deepEqual(resolveSelection({ ...camera, default_selection: null }, null), sel('NV12', 1920, 1080, 30),
    'an Available size is preferred over an Unverified one')
  const target = { host: '192.168.2.2' }
  assert.equal(previewBlock({ camera, selection: sel('NV12', 1332, 990, 30), target }).blocked, false)
  assert.equal(previewBlock({ camera, selection: sel('NV12', 4056, 3040, 30), target }).blocked, true)

  const onlyUnverified = { ...camera, support: support('unverified', UNVERIFIED), default_selection: null,
    formats: [format('NV12', 'NV12', false, support('unverified', UNVERIFIED), [size(1332, 990, [30, 'unverified'])])] }
  assert.deepEqual(cameraTierPill(onlyUnverified), { label: 'Unverified', tone: 'warn' })
  assert.equal(cameraSummaryLine(onlyUnverified), UNVERIFIED)
  assert.equal(previewBlock({ camera: onlyUnverified, selection: sel('NV12', 1332, 990, 30), target }).blocked, false)
})
