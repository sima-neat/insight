import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildSync } from 'esbuild'

// Node cannot import JSX, so bundle the pane with esbuild (Vite's own transform) and call it as a function.
const dir = mkdtempSync(join(tmpdir(), 'preview-pane-'))
const bundle = join(dir, 'PreviewPane.mjs')
const { outputFiles } = buildSync({
  entryPoints: [fileURLToPath(new URL('./PreviewPane.jsx', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false
})
writeFileSync(bundle, outputFiles[0].text)
const { default: PreviewPane } = await import(pathToFileURL(bundle).href)
rmSync(dir, { recursive: true, force: true })

function find(node, match) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) return node.map((child) => find(child, match)).find(Boolean) || null
  if (match(node)) return node
  return find(node.props?.children, match)
}

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
const usbReason = { tier: 'unsupported', reason: 'USB cameras have no camera overlay on this board.' }
const usbCamera = {
  id: 'camera:v4l2:c920',
  name: 'HD Pro Webcam C920',
  connection: 'usb',
  support: usbReason,
  availability: { state: 'free' },
  formats: [{ format: 'MJPG', exportable: false, support: usbReason, sizes: [{ width: 1280, height: 720, fps: [{ value: 30, ...usbReason }] }] }]
}
const streamUrl = (id) => `/api/peripherals/cameras/preview/${id}/stream`

test('Start preview passes no click event, so the request carries the selected mode', () => {
  const calls = []
  const pane = PreviewPane({
    camera: camera('camera:a'),
    selection: { id: 'camera:a', ...mode },
    target: { label: 'board' },
    state: { status: 'idle', session: null, error: null },
    onStart: (...args) => calls.push(args)
  })
  const start = find(pane, (node) => node.type === 'button' && node.props.children === 'Start preview')
  start.props.onClick({ type: 'click' })
  assert.deepEqual(calls, [[]])
})

test("another camera's retained preview is not shown as this camera's video", () => {
  const session = { id: 's1', camera_id: 'camera:a', mode, stream_url: streamUrl('s1') }
  const failed = { status: 'live', session, error: { message: 'Could not stop the preview.', code: 'unreachable', details: {} } }
  const props = { selection: { id: 'camera:b', ...mode }, target: { label: 'board' }, state: failed, onStart() {}, onStop() {} }
  const other = PreviewPane({ ...props, camera: camera('camera:b') })
  assert.equal(find(other, (node) => node.type === 'img'), null)
  assert.equal(find(other, (node) => node.type === 'button' && node.props.children === 'Stop preview'), null)
  const start = find(other, (node) => node.type === 'button' && node.props.children === 'Start preview')
  assert.equal(start.props.disabled, true)
  const reason = find(other, (node) => node.props?.id === 'periph-preview-reason')
  assert.match(reason.props.children, /already running on camera:a/)
  // The camera that owns it still shows its video and the Stop button to retry.
  const owner = PreviewPane({ ...props, camera: camera('camera:a'), selection: { id: 'camera:a', ...mode } })
  assert.ok(find(owner, (node) => node.type === 'img'))
  assert.ok(find(owner, (node) => node.type === 'button' && node.props.children === 'Stop preview'))
})

test('a live preview shows the relayed stream in an img and reports a stream it cannot load', () => {
  const ended = []
  const session = { id: 's1', camera_id: 'camera:a', mode, stream_url: streamUrl('s1'), state: 'live' }
  const pane = PreviewPane({
    camera: camera('camera:a'),
    selection: { id: 'camera:a', ...mode },
    target: { label: 'board' },
    state: { status: 'live', session, error: null },
    onStart() {},
    onStop() {},
    onStreamError: (id) => ended.push(id)
  })
  const img = find(pane, (node) => node.type === 'img')
  assert.equal(img.props.src, streamUrl('s1'))
  assert.equal(img.props.alt, 'Live preview of camera:a')
  assert.equal(find(pane, (node) => node.type === 'iframe'), null)
  img.props.onError()
  assert.deepEqual(ended, ['s1'])

  // A stream address that is not Insight's own API path is never loaded.
  const foreign = PreviewPane({
    camera: camera('camera:a'),
    selection: { id: 'camera:a', ...mode },
    target: { label: 'board' },
    state: { status: 'live', session: { ...session, stream_url: 'https://evil.example/x' }, error: null },
    onStart() {},
    onStop() {}
  })
  assert.equal(find(foreign, (node) => node.type === 'img'), null)
})

test('a USB camera can start a preview of any mode it lists in a format the preview reads', () => {
  const calls = []
  const pane = PreviewPane({
    camera: usbCamera,
    selection: { id: usbCamera.id, format: 'MJPG', width: 1280, height: 720, fps: 30 },
    target: { label: 'board' },
    state: { status: 'idle', session: null, error: null },
    onStart: (...args) => calls.push(args)
  })
  const start = find(pane, (node) => node.type === 'button' && node.props.children === 'Start preview')
  assert.equal(start.props.disabled, false)
  start.props.onClick()
  assert.deepEqual(calls, [[]])
})

test('Start is disabled for a USB format the backend cannot preview, with the reason', () => {
  const h264 = { ...usbCamera, formats: [...usbCamera.formats, { ...usbCamera.formats[0], format: 'H264' }] }
  const pane = PreviewPane({
    camera: h264,
    selection: { id: h264.id, format: 'H264', width: 1280, height: 720, fps: 30 },
    target: { label: 'board' },
    state: { status: 'idle', session: null, error: null },
    onStart() {}
  })
  const start = find(pane, (node) => node.type === 'button' && node.props.children === 'Start preview')
  assert.equal(start.props.disabled, true)
  const reason = find(pane, (node) => node.props?.id === 'periph-preview-reason')
  assert.match(reason.props.children, /not H264\. Choose another format\.$/)
})

test("a live preview shows the session's rate note as a hint, and nothing when the rate was set", () => {
  const note = 'The camera runs at its own rate; Insight could not set it. v4l2-ctl (v4l-utils) is not installed on the board.'
  const session = { id: 's1', camera_id: 'camera:a', mode, stream_url: streamUrl('s1'), state: 'live' }
  const props = { camera: camera('camera:a'), selection: { id: 'camera:a', ...mode }, target: { label: 'board' }, onStart() {}, onStop() {} }
  const hint = (pane) => find(pane, (node) => node.type === 'p' && node.props.className === 'hint')
  const noted = PreviewPane({ ...props, state: { status: 'live', session: { ...session, rate_note: note }, error: null } })
  assert.ok(find(noted, (node) => node.type === 'img'))
  assert.equal(hint(noted).props.children, note)
  const set = PreviewPane({ ...props, state: { status: 'live', session: { ...session, rate_note: null, sensor_rate: { fps: 30, vblank: 1408 } }, error: null } })
  assert.equal(hint(set), null)
})
