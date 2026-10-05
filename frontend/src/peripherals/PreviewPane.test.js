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
const tier = { tier: 'verified', reason: '' }
const camera = (id) => ({
  id,
  name: id,
  support: tier,
  availability: { state: 'free' },
  formats: [{ format: 'NV12', exportable: true, support: tier, sizes: [{ width: 1920, height: 1080, fps: [{ value: 30, tier: 'verified' }] }] }]
})

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
  const session = { id: 's1', camera_id: 'camera:a', mode, viewer_url: 'https://insight.local:8081/static/viewer.html?src=3' }
  const failed = { status: 'live', session, error: { message: 'Could not stop the preview.', code: 'unreachable', details: {} } }
  const props = { selection: { id: 'camera:b', ...mode }, target: { label: 'board' }, state: failed, onStart() {}, onStop() {} }
  const other = PreviewPane({ ...props, camera: camera('camera:b') })
  assert.equal(find(other, (node) => node.type === 'iframe'), null)
  assert.equal(find(other, (node) => node.type === 'button' && node.props.children === 'Stop preview'), null)
  const start = find(other, (node) => node.type === 'button' && node.props.children === 'Start preview')
  assert.equal(start.props.disabled, true)
  const reason = find(other, (node) => node.props?.id === 'periph-preview-reason')
  assert.match(reason.props.children, /already running on camera:a/)
  // The camera that owns it still shows its video and the Stop button to retry.
  const owner = PreviewPane({ ...props, camera: camera('camera:a'), selection: { id: 'camera:a', ...mode } })
  assert.ok(find(owner, (node) => node.type === 'iframe'))
  assert.ok(find(owner, (node) => node.type === 'button' && node.props.children === 'Stop preview'))
})
