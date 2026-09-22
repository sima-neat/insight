// Pure helpers behind the media folder browser (issue #113). The tree is the payload of
// GET /api/media-files: folder nodes carry `children` and `streamable_count`, file nodes carry
// `streamable`. Folder paths are relative POSIX paths; '' is the media root.

export const MEDIA_ROOT = ''

function folderName(node) {
  return node.name.startsWith('/') ? node.name.slice(1) : node.name
}

// The children of `folderPath`, or null when that folder is not in `tree`.
export function childrenAt(tree, folderPath) {
  let nodes = Array.isArray(tree) ? tree : []
  if (!folderPath) return nodes
  for (const segment of folderPath.split('/')) {
    const next = nodes.find((node) => node.type === 'folder' && folderName(node) === segment)
    if (!next) return null
    nodes = next.children || []
  }
  return nodes
}

export function folderExists(tree, folderPath) {
  return childrenAt(tree, folderPath) !== null
}

// Folders first (server order), then streamable files. Unsupported files are counted, not listed.
export function listFolder(tree, folderPath) {
  const nodes = childrenAt(tree, folderPath) || []
  const folders = nodes
    .filter((node) => node.type === 'folder')
    .map((node) => ({ name: folderName(node), path: node.path, count: Number(node.streamable_count || 0) }))
  const files = nodes
    .filter((node) => node.type === 'file' && node.streamable)
    .map((node) => ({ name: node.name, path: node.path }))
  const hidden = nodes.filter((node) => node.type === 'file' && !node.streamable).length
  return { folders, files, hidden }
}

export function parentPath(folderPath) {
  if (!folderPath) return MEDIA_ROOT
  const index = folderPath.lastIndexOf('/')
  return index === -1 ? MEDIA_ROOT : folderPath.slice(0, index)
}

// [{ name: 'Media Root', path: '' }, { name: '30FPS', path: '30FPS' }, ...]
export function breadcrumbs(folderPath) {
  const crumbs = [{ name: 'Media Root', path: MEDIA_ROOT }]
  if (!folderPath) return crumbs
  let acc = ''
  for (const segment of folderPath.split('/')) {
    acc = acc ? `${acc}/${segment}` : segment
    crumbs.push({ name: segment, path: acc })
  }
  return crumbs
}

// Streamable files anywhere below `folderPath` whose path relative to that folder contains
// `query`, case-insensitively. `relative` is what the list shows, `path` is the library path.
export function searchFolder(tree, folderPath, query) {
  const q = String(query || '').trim().toLowerCase()
  const nodes = childrenAt(tree, folderPath)
  if (!q || nodes === null) return []
  const prefix = folderPath ? `${folderPath}/` : ''
  const matches = []
  const walk = (list) => {
    for (const node of list) {
      if (node.type === 'folder') {
        walk(node.children || [])
      } else if (node.streamable) {
        const relative = node.path.startsWith(prefix) ? node.path.slice(prefix.length) : node.path
        if (relative.toLowerCase().includes(q)) matches.push({ name: node.name, path: node.path, relative })
      }
    }
  }
  walk(nodes)
  return matches
}

// The folder itself when it still exists after a reload, otherwise its nearest existing ancestor.
export function nearestExistingFolder(tree, folderPath) {
  let candidate = folderPath || MEDIA_ROOT
  while (candidate && !folderExists(tree, candidate)) candidate = parentPath(candidate)
  return candidate
}

// Every streamable file path in tree order (folders first, as the server sorts them).
export function streamableFiles(tree, acc = []) {
  for (const node of tree || []) {
    if (node.type === 'file' && node.streamable) acc.push(node.path)
    if (node.type === 'folder') streamableFiles(node.children || [], acc)
  }
  return acc
}
