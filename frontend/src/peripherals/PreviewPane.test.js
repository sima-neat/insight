import assert from 'node:assert/strict'
import test from 'node:test'

import { button, find, loadComponent } from './jsxHarness.js'

const PreviewPane = await loadComponent(new URL('./PreviewPane.jsx', import.meta.url))

const mode = { format: 'NV12', width: 1920, height: 1080, fps: 30 }
const tier = { tier: 'available', reason: '' }
const camera = (id) => ({
  id,
  name: id,
  connection: 'mipi',
  support: tier,
  availability: { state: 'free' },
  formats: [{ format: 'NV12', exportable: true, support: tier, sizes: [{ width: 1920, height: 1080, fps: [{ value: 30, tier: 'available' }] }] }]
})
const usbReason = { tier: 'unsupported', reason: 'Update SiMa Sentinel on the board to check USB cameras.' }
const usbMode = { format: 'MJPG', width: 1280, height: 720, fps: 30 }
const usbCamera = {
  id: 'camera:v4l2:c920',
  name: 'HD Pro Webcam C920',
  connection: 'usb',
  support: usbReason,
  availability: { state: 'free' },
  formats: [{ format: 'MJPG', exportable: false, support: usbReason, sizes: [{ width: 1280, height: 720, fps: [{ value: 30, ...usbReason }] }] }]
}
const streamUrl = (id) => `/api/peripherals/cameras/preview/${id}/stream`
const session = { id: 's1', camera_id: 'camera:a', mode, stream_url: streamUrl('s1'), state: 'live' }
const idle = { status: 'idle', session: null, error: null }
const live = (overrides = {}) => ({ status: 'live', session: { ...session, ...overrides }, error: null })

// Camera A with its default mode, idle, on a selected board; each test overrides what it is about.
const render = (props = {}) => PreviewPane({
  camera: camera('camera:a'),
  selection: { id: 'camera:a', ...mode },
  target: { label: 'board' },
  state: idle,
  onStart() {},
  onStop() {},
  ...props
})
const img = (pane) => find(pane, (node) => node.type === 'img')
const reason = (pane) => find(pane, (node) => node.props?.id === 'periph-preview-reason').props.children

test('Start preview passes no click event, so the request carries the selected mode', () => {
  const calls = []
  button(render({ onStart: (...args) => calls.push(args) }), 'Start preview').props.onClick({ type: 'click' })
  assert.deepEqual(calls, [[]])
})

test("another camera's retained preview is not shown as this camera's video", () => {
  const failed = { status: 'live', session, error: { message: 'Could not stop the preview.', code: 'unreachable', details: {} } }
  const other = render({ camera: camera('camera:b'), selection: { id: 'camera:b', ...mode }, state: failed })
  assert.equal(img(other), null)
  assert.equal(button(other, 'Stop preview'), null)
  assert.equal(button(other, 'Start preview').props.disabled, true)
  assert.match(reason(other), /already running on camera:a/)
  // The camera that owns it still shows its video and the Stop button to retry.
  const owner = render({ state: failed })
  assert.ok(img(owner))
  assert.ok(button(owner, 'Stop preview'))
})

test('a live preview shows the relayed stream in an img and reports a stream it cannot load', () => {
  const ended = []
  const pane = render({ state: live(), onStreamError: (id) => ended.push(id) })
  assert.equal(img(pane).props.src, streamUrl('s1'))
  assert.equal(img(pane).props.alt, 'Live preview of camera:a')
  assert.equal(find(pane, (node) => node.type === 'iframe'), null)
  img(pane).props.onError()
  assert.deepEqual(ended, ['s1'])

  // A stream address that is not Insight's own API path is never loaded.
  assert.equal(img(render({ state: live({ stream_url: 'https://evil.example/x' }) })), null)
})

test('a USB camera can start a preview of any mode it lists in a format the preview reads', () => {
  const calls = []
  const start = button(render({ camera: usbCamera, selection: { id: usbCamera.id, ...usbMode }, onStart: (...args) => calls.push(args) }), 'Start preview')
  assert.equal(start.props.disabled, false)
  start.props.onClick()
  assert.deepEqual(calls, [[]])
})

test('Start is disabled for a USB format the backend cannot preview, with the reason', () => {
  const h264 = { ...usbCamera, formats: [...usbCamera.formats, { ...usbCamera.formats[0], format: 'H264' }] }
  const pane = render({ camera: h264, selection: { id: h264.id, ...usbMode, format: 'H264' } })
  assert.equal(button(pane, 'Start preview').props.disabled, true)
  assert.match(reason(pane), /not H264\. Choose another format\.$/)
})

// The pane is called as a function, so its ModeBadges element is rendered here the same way.
function badgeTexts(pane, label) {
  const element = find(pane, (node) => typeof node.type === 'function' && node.props?.label === label)
  const group = element && element.type(element.props)
  if (!group) return null
  return { aria: group.props['aria-label'], texts: [group.props.children].flat().filter(Boolean).map((child) => child.props.children) }
}

test("a running preview's mode chip shows the camera's rate once known, and only format and size before", () => {
  for (const camera_fps of [undefined, null]) {
    assert.deepEqual(badgeTexts(render({ state: live({ camera_fps }) }), 'Streaming'), { aria: 'Streaming: NV12 1920×1080', texts: ['NV12', '1920×1080'] })
  }
  // A MIPI camera's rate is its sensor's most in this mode (Sentinel's max_fps), not a measured rate.
  assert.deepEqual(badgeTexts(render({ state: live({ camera_fps: 66.18 }) }), 'Streaming'),
    { aria: 'Streaming: NV12 1920×1080 at up to 66 fps', texts: ['NV12', '1920×1080', 'up to 66 fps'] })
  const usb = render({
    camera: usbCamera,
    selection: { id: usbCamera.id, ...usbMode },
    state: live({ camera_id: usbCamera.id, mode: usbMode, camera_fps: 30 })
  })
  assert.deepEqual(badgeTexts(usb, 'Streaming').texts, ['MJPG', '1280×720', '30 fps'])
})

test('the mode chip before a preview names no rate: Insight sets none', () => {
  assert.deepEqual(badgeTexts(render(), 'Mode'), { aria: 'Mode: NV12 1920×1080', texts: ['NV12', '1920×1080'] })
})

test('a preview another tab shows is one row with Stop, never a second stream', () => {
  const pane = render({ state: { status: 'elsewhere', session: { ...session, viewer: true }, error: null } })
  assert.equal(img(pane), null)
  const row = find(pane, (n) => n.props?.className === 'periph-actions periph-preview-progress')
  assert.ok(row)
  assert.ok(find(row, (n) => n.props?.children === 'This preview is showing in another tab or window.'))
  assert.ok(button(row, 'Stop preview'))
})

test("a failed start's board output is folded, so the error stays one row", () => {
  const error = { message: 'The preview pipeline could not start.', code: 'command_failed', details: { detail: 'ERROR: from element /GstPipeline...' } }
  const pane = render({ state: { status: 'error', session: null, error } })
  const block = find(pane, (n) => typeof n.type === 'function' && n.props?.error === error)
  const details = find(block.type(block.props), (n) => n.type === 'details')
  assert.ok(details, 'the board output is in a <details>')
  assert.notEqual(details.props.open, true)
  assert.ok(find(details, (n) => n.type === 'pre'))
})

test('a start with no session yet offers no Stop, since there is no preview to stop', () => {
  // Codex 4263048510: Stop on a start without a session did nothing while the start kept running.
  assert.equal(button(render({ state: { status: 'starting', session: null, error: null } }), 'Stop preview'), null)
  // An adopted start that already has its session keeps Stop.
  assert.notEqual(button(render({ state: { status: 'starting', session, error: null } }), 'Stop preview'), null)
})
