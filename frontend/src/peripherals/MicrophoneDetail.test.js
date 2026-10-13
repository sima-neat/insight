import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildSync } from 'esbuild'

// Node cannot import JSX, so bundle the pane with esbuild (Vite's own transform) and call it as a function.
const dir = mkdtempSync(join(tmpdir(), 'microphone-detail-'))
const bundle = join(dir, 'MicrophoneDetail.mjs')
const { outputFiles } = buildSync({
  entryPoints: [fileURLToPath(new URL('./MicrophoneDetail.jsx', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false
})
writeFileSync(bundle, outputFiles[0].text)
const { default: MicrophoneDetail } = await import(pathToFileURL(bundle).href)
rmSync(dir, { recursive: true, force: true })

function find(node, match) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) return node.map((child) => find(child, match)).find(Boolean) || null
  if (match(node)) return node
  return find(node.props?.children, match)
}

const mic = { id: 'microphone:usb:1-1.2:1.0', name: 'Yeti', errors: [] }
const testKey = (generation) => find(MicrophoneDetail({ mic, generation }), (node) => node.props?.mic === mic)?.key

test('a microphone test belongs to one board: another board with the same microphone id starts afresh', () => {
  // Codex 4255505622: keyed by the id alone, board A's recording stayed on screen under board B.
  assert.ok(testKey(1))
  assert.equal(testKey(1), testKey(1))
  assert.notEqual(testKey(1), testKey(2))
})
