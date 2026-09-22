import assert from 'node:assert/strict'
import test from 'node:test'

import { breadcrumbs, childrenAt, listFolder, nearestExistingFolder, parentPath, searchFolder, streamableFiles } from './mediaTree.js'

const file = (path, streamable = true) => ({ name: path.split('/').pop(), path, type: 'file', streamable })
const folder = (path, children) => ({
  name: '/' + path.split('/').pop(), path, type: 'folder', children,
  streamable_count: streamableFiles(children).length,
})

const tree = [
  folder('120FPS-720p-h264', [file('120FPS-720p-h264/drone.mp4')]),
  folder('30FPS', [
    folder('30FPS/indoor', [
      folder('30FPS/indoor/cam-a', [file('30FPS/indoor/cam-a/deep.mp4')]),
      file('30FPS/indoor/lobby.mp4'),
      file('30FPS/indoor/notes.txt', false),
    ]),
    file('30FPS/highway.mp4'),
  ]),
  folder('empty', []),
  file('readme.md', false),
  file('video.mp4'),
]

test('childrenAt walks nested folders and reports a missing folder as null', () => {
  assert.equal(childrenAt(tree, '').length, 5)
  assert.equal(childrenAt(tree, '30FPS/indoor/cam-a').length, 1)
  assert.equal(childrenAt(tree, '30FPS/missing'), null)
  assert.equal(childrenAt(undefined, '').length, 0)
})

test('listFolder lists folders with counts, then streamable files, and counts hidden files', () => {
  const root = listFolder(tree, '')
  assert.deepEqual(root.folders.map((f) => [f.name, f.count]), [['120FPS-720p-h264', 1], ['30FPS', 3], ['empty', 0]])
  assert.deepEqual(root.files.map((f) => f.path), ['video.mp4'])
  assert.equal(root.hidden, 1)
  const indoor = listFolder(tree, '30FPS/indoor')
  assert.deepEqual(indoor.folders.map((f) => f.path), ['30FPS/indoor/cam-a'])
  assert.deepEqual(indoor.files.map((f) => f.path), ['30FPS/indoor/lobby.mp4'])
  assert.equal(indoor.hidden, 1)
  assert.deepEqual(listFolder(tree, 'nope'), { folders: [], files: [], hidden: 0 })
})

test('breadcrumbs start at Media Root and accumulate one segment per level', () => {
  assert.deepEqual(breadcrumbs(''), [{ name: 'Media Root', path: '' }])
  assert.deepEqual(breadcrumbs('30FPS/indoor/cam-a').map((c) => c.path), ['', '30FPS', '30FPS/indoor', '30FPS/indoor/cam-a'])
  assert.equal(breadcrumbs('30FPS/indoor').at(-1).name, 'indoor')
})

test('parentPath goes up one level and stops at the root', () => {
  assert.equal(parentPath('30FPS/indoor/cam-a'), '30FPS/indoor')
  assert.equal(parentPath('30FPS'), '')
  assert.equal(parentPath(''), '')
})

test('searchFolder matches streamable files below the folder by their relative path', () => {
  assert.deepEqual(searchFolder(tree, '30FPS', 'deep'), [
    { name: 'deep.mp4', path: '30FPS/indoor/cam-a/deep.mp4', relative: 'indoor/cam-a/deep.mp4' },
  ])
  assert.deepEqual(searchFolder(tree, '30FPS', 'drone'), [])
  assert.equal(searchFolder(tree, '30FPS', 'CAM-A').length, 1)
  assert.deepEqual(searchFolder(tree, '30FPS', 'notes'), [])
  assert.deepEqual(searchFolder(tree, '30FPS', '  '), [])
  assert.equal(searchFolder(tree, '', 'mp4').length, 5)
})

test('nearestExistingFolder falls back to the closest ancestor that still exists', () => {
  assert.equal(nearestExistingFolder(tree, '30FPS/indoor/cam-a'), '30FPS/indoor/cam-a')
  assert.equal(nearestExistingFolder(tree, '30FPS/indoor/gone/deeper'), '30FPS/indoor')
  assert.equal(nearestExistingFolder(tree, 'vanished/x'), '')
  assert.equal(nearestExistingFolder(tree, ''), '')
})

test('streamableFiles flattens only streamable files in tree order', () => {
  assert.deepEqual(streamableFiles(tree), [
    '120FPS-720p-h264/drone.mp4',
    '30FPS/indoor/cam-a/deep.mp4',
    '30FPS/indoor/lobby.mp4',
    '30FPS/highway.mp4',
    'video.mp4',
  ])
})
