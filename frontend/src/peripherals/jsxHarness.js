// Test support: node cannot import JSX, so a component is bundled with esbuild (Vite's own transform)
// and then called as a function, returning its element tree.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildSync } from 'esbuild'

export async function loadComponent(url) {
  const dir = mkdtempSync(join(tmpdir(), 'jsx-harness-'))
  try {
    const { outputFiles } = buildSync({
      entryPoints: [fileURLToPath(url)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      write: false
    })
    const bundle = join(dir, 'component.mjs')
    writeFileSync(bundle, outputFiles[0].text)
    return (await import(pathToFileURL(bundle).href)).default
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function find(node, match) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) return node.map((child) => find(child, match)).find(Boolean) || null
  if (match(node)) return node
  return find(node.props?.children, match)
}

export const button = (tree, label) => find(tree, (node) => node.type === 'button' && node.props.children === label)
