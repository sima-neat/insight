import assert from 'node:assert/strict'
import test from 'node:test'

import { button, find, loadComponent } from './jsxHarness.js'

const CameraDetail = await loadComponent(new URL('./CameraDetail.jsx', import.meta.url))

const MIPI_NAME = 'mipi-sensor 5-001a'
const USB_NAME = '/base/pci@7000000000-1.2:1.0-1a2b:3c4d'
const tier = { tier: 'available', reason: '' }
const camera = (connection, device) => ({
  id: `camera:${connection}`,
  name: 'Camera',
  connection,
  support: tier,
  device,
  formats: [{ format: 'MJPG', exportable: true, support: tier, sizes: [{ width: 1280, height: 720, fps: [{ value: 30, tier: 'available' }] }] }]
})
const selection = { format: 'MJPG', width: 1280, height: 720, fps: 30 }

// The Camera ID disclosure beside the camera's title, rendered; null when the camera has none.
function disclosure(shown, onStatus) {
  const row = find(CameraDetail({ camera: shown, selection, onStatus }), (node) => node.props?.className === 'periph-title-row')
  assert.equal(row.props.children[0].type, 'h3', 'sits right after the camera name')
  const id = find(row, (node) => node.type?.name === 'NeatCameraName')
  return id && id.type(id.props)
}

function withClipboard(t, clipboard) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true, writable: true })
  // Node 20 has no global navigator to restore.
  t.after(() => (previous ? Object.defineProperty(globalThis, 'navigator', previous) : delete globalThis.navigator))
}

const text = (node) => find(node, (n) => n.type === 'code').props.children

test('a MIPI or USB camera folds its Camera ID beside its name, and Copy copies exactly the ID', async (t) => {
  const written = []
  withClipboard(t, { writeText: async (value) => written.push(value) })
  for (const [shown, name] of [
    [camera('mipi', { camera_name: MIPI_NAME, camera_name_source: 'media-graph' }), MIPI_NAME],
    [camera('usb', { video_node: '/dev/video0', camera_name: USB_NAME }), USB_NAME]
  ]) {
    const statuses = []
    const tree = disclosure(shown, (message) => statuses.push(message))
    assert.equal(tree.type, 'details')
    assert.equal(tree.props.open, undefined, 'folded until opened')
    assert.equal(find(tree, (n) => n.type === 'summary').props.children, 'Camera ID')
    assert.equal(text(tree), name)
    await button(tree, 'Copy ID').props.onClick()
    await new Promise(setImmediate)
    assert.equal(written.at(-1), name)
    assert.deepEqual(statuses, [`Copied the camera ID: ${name}`])
  }
})

// A `details` element and the document, with just the event wiring the disclosure uses.
function fakeDetails() {
  const listeners = { details: {}, document: {} }
  const on = (store) => ({
    addEventListener: (type, fn) => (store[type] = [...(store[type] || []), fn]),
    removeEventListener: (type, fn) => (store[type] = (store[type] || []).filter((entry) => entry !== fn))
  })
  const inside = {}
  const details = { open: true, contains: (target) => target === inside, ...on(listeners.details) }
  const document = on(listeners.document)
  const fire = (where, type, event) => (listeners[where][type] || []).slice().forEach((fn) => fn(event))
  return { details, document, inside, fire, listening: () => Object.values(listeners.document).flat().length }
}

test('the open Camera ID closes on a pointer anywhere outside it or on Escape, and only then stops listening', (t) => {
  const previous = globalThis.document
  t.after(() => (previous === undefined ? delete globalThis.document : (globalThis.document = previous)))
  for (const dismiss of [(fake) => fake.fire('document', 'pointerdown', { target: {} }), (fake) => fake.fire('document', 'keydown', { key: 'Escape' })]) {
    const fake = fakeDetails()
    globalThis.document = fake.document
    const onToggle = disclosure(camera('usb', { camera_name: USB_NAME })).props.onToggle
    onToggle({ currentTarget: fake.details })
    assert.equal(fake.listening(), 2, 'listens while open')
    fake.fire('document', 'pointerdown', { target: fake.inside })
    fake.fire('document', 'keydown', { key: 'Enter' })
    assert.equal(fake.details.open, true, 'a pointer inside or another key keeps it open')
    dismiss(fake)
    assert.equal(fake.details.open, false)
    fake.fire('details', 'toggle')
    assert.equal(fake.listening(), 0, 'the close toggle removes the listeners')
  }
  // Toggling closed by hand, with nothing open, adds no listeners.
  const fake = fakeDetails()
  globalThis.document = fake.document
  fake.details.open = false
  disclosure(camera('usb', { camera_name: USB_NAME })).props.onToggle({ currentTarget: fake.details })
  assert.equal(fake.listening(), 0)
})

test('a camera without a camera ID shows no disclosure', () => {
  assert.equal(disclosure(camera('usb', { video_node: '/dev/video0' })), null)
  assert.equal(disclosure(camera('mipi', { camera_name: '' })), null)
})

test('a failed copy says why and still gives the ID', async (t) => {
  withClipboard(t, undefined)
  const statuses = []
  await button(disclosure(camera('usb', { camera_name: USB_NAME }), (message) => statuses.push(message)), 'Copy ID').props.onClick()
  await new Promise(setImmediate)
  assert.equal(statuses.length, 1)
  assert.match(statuses[0], /^Could not copy: .*Camera ID: \/base\/pci@7000000000-1\.2:1\.0-1a2b:3c4d$/)
})
