import assert from 'node:assert/strict'
import test from 'node:test'

import { button, find, loadComponent } from '../peripherals/jsxHarness.js'
import { ENDED_ERROR, describePreviewError } from './cameraPreview.js'

const CameraPreviewPane = await loadComponent(new URL('./CameraPreview.jsx', import.meta.url))

const camera = { deviceId: 'cam-a', label: 'FaceTime HD Camera' }
const info = {
  resolution: '1280×720',
  frameRate: '30 fps',
  active: [{ key: 'resolution', label: 'Resolution', value: '1280×720' }, { key: 'frameRate', label: 'Frame rate', value: '30 fps' }],
  supported: [{ key: 'resolution', label: 'Resolution', value: 'up to 1920×1080' }],
  capabilitiesReported: true
}
const stream = { id: 'stream-1' }
const live = (overrides = {}) => ({ status: 'live', camera, stream, info, sharedWith: null, ...overrides })
const failed = (name) => ({ status: 'error', camera, error: describePreviewError(Object.assign(new Error(name), { name })) })

// Renders nested components too (they are all pure), so a test can reach any element.
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return node.props?.children === undefined ? node : { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const render = (state, props = {}) => expand(CameraPreviewPane({ state, onStop() {}, onRetry() {}, onRefreshCameras() {}, ...props }))
const byTestId = (tree, id) => find(tree, (node) => node.props?.['data-testid'] === id)
const textOf = (node) => {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

test('the pane names the camera and says the preview does not publish', () => {
  const pane = render(live())
  assert.equal(textOf(byTestId(pane, 'camera-preview-name')), 'FaceTime HD Camera')
  assert.match(textOf(pane), /does not assign a Streaming slot or publish the camera/)
})

test('a live preview plays the stream with the active settings on the chip and in their own table', () => {
  const pane = render(live())
  const video = byTestId(pane, 'camera-preview-video')
  assert.equal(video.type, 'video')
  assert.equal(video.props.muted, true)
  const el = { srcObject: null }
  video.ref(el)
  assert.equal(el.srcObject, stream)
  assert.match(textOf(pane), /1280×720/)
  const active = byTestId(pane, 'camera-active-settings')
  assert.match(textOf(active), /Frame rate30 fps/)
  const capabilities = byTestId(pane, 'camera-capabilities')
  assert.match(textOf(capabilities), /up to 1920×1080/)
  assert.doesNotMatch(textOf(active), /up to/, 'capabilities never appear as active settings')
})

test('a browser that does not report capabilities says so instead of listing guesses', () => {
  const pane = render(live({ info: { ...info, supported: [], capabilitiesReported: false } }))
  assert.equal(byTestId(pane, 'camera-capabilities'), null)
  assert.match(textOf(byTestId(pane, 'camera-capabilities-missing')), /does not report/)
})

test('a camera previewed from this tab\'s publish says which slot it shares', () => {
  assert.match(textOf(byTestId(render(live({ sharedWith: 4 })), 'camera-preview-shared')), /src4/)
  assert.equal(byTestId(render(live()), 'camera-preview-shared'), null)
})

test('Stop preview and the video events reach their handlers', () => {
  const calls = []
  const pane = render(live(), { onStop: () => calls.push('stop'), onVideoSettled: () => calls.push('settled') })
  button(pane, 'Stop preview').props.onClick()
  byTestId(pane, 'camera-preview-video').props.onLoadedMetadata()
  assert.deepEqual(calls, ['stop', 'settled'])
})

test('loading shows progress and can be cancelled, with no video yet', () => {
  const calls = []
  const pane = render({ status: 'loading', camera }, { onStop: () => calls.push('stop') })
  assert.ok(byTestId(pane, 'camera-preview-loading'))
  assert.equal(byTestId(pane, 'camera-preview-video'), null)
  button(pane, 'Cancel').props.onClick()
  assert.deepEqual(calls, ['stop'])
})

test('denied and busy cameras offer Try again; a disconnected one offers Refresh cameras', () => {
  for (const name of ['NotAllowedError', 'NotReadableError']) {
    const calls = []
    const pane = render(failed(name), { onRetry: () => calls.push('retry') })
    assert.equal(byTestId(pane, 'camera-preview-video'), null)
    button(pane, 'Try again').props.onClick()
    assert.deepEqual(calls, ['retry'], name)
    assert.equal(button(pane, 'Refresh cameras'), null)
  }
  for (const state of [failed('NotFoundError'), { status: 'error', camera, error: ENDED_ERROR }]) {
    const calls = []
    const pane = render(state, { onRefreshCameras: () => calls.push('refresh') })
    button(pane, 'Refresh cameras').props.onClick()
    assert.deepEqual(calls, ['refresh'])
    assert.equal(button(pane, 'Try again'), null)
  }
})

test('every error state shows its action text and a Close button', () => {
  for (const name of ['NotAllowedError', 'NotReadableError', 'NotFoundError', 'TypeError']) {
    const state = failed(name)
    const pane = render(state)
    assert.equal(textOf(byTestId(pane, 'camera-preview-error')), state.error.action)
    assert.equal(byTestId(pane, 'camera-preview-error').props['data-kind'], state.error.kind)
    assert.ok(button(pane, 'Close'), name)
  }
})

test('a frame that withholds the camera offers no retry that cannot work', () => {
  const state = { status: 'error', camera, error: describePreviewError({ name: 'NotAllowedError' }, { frameAllowsCamera: false }) }
  const pane = render(state)
  assert.equal(button(pane, 'Try again'), null)
  assert.match(textOf(pane), /own browser tab/)
})
