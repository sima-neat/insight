import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// The nested tree from the design spec. Video files are generated with ffmpeg at seed time.
export const TREE = {
  videos: ['30FPS/highway.mp4', '30FPS/indoor/lobby.mp4', '30FPS/indoor/cam-a/deep.mp4', '120FPS-720p-h264/drone.mp4'],
  others: ['30FPS/indoor/notes.txt', 'readme.md'],
  emptyFolders: ['empty'],
}

export function mediaRoot() {
  const root = process.env.INSIGHT_MEDIA_ROOT
  if (!root) throw new Error('INSIGHT_MEDIA_ROOT is not set; run through scripts/test-folder-navigation.sh')
  return root
}

// A two-second 320x240 H.264 clip with periodic keyframes and no B-frames, like an Insight upload.
export function makeVideo(target, seconds = 2) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  execFileSync('ffmpeg', [
    '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15',
    '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-bf', '0',
    target,
  ])
}

// Creates a unique top-level folder under the media root and returns how to remove it.
export function seedTree() {
  const name = `folder-nav-test-${Date.now().toString(36)}`
  const dir = path.join(mediaRoot(), name)
  try {
    for (const rel of TREE.videos) makeVideo(path.join(dir, rel))
    for (const rel of TREE.others) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), 'not a video\n')
    }
    for (const rel of TREE.emptyFolders) fs.mkdirSync(path.join(dir, rel), { recursive: true })
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw err
  }
  return { name, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
