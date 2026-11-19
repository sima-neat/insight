import type { MediaEntry, MediaFileInfo, MediaProbe } from '../api.generated';

/** Media library answers for the specs, as `GET /api/media` and its routes give them. */

const nameOf = (path: string) => path.split('/').pop() ?? path;

/** A file of the library, probed: streamable unless said otherwise. */
export function mediaFile(path: string, streamable = true): MediaEntry {
  return {
    name: nameOf(path),
    path,
    folder: false,
    streamable,
    probe: { kind: streamable ? 'video' : 'unknown', size: 1024, streamable },
  };
}

/** A folder of the library with its entries, counting the streamable files below it. */
export function mediaFolder(path: string, children: readonly MediaEntry[]): MediaEntry {
  const streamable_count = children.reduce(
    (count, child) =>
      count + (child.folder ? (child.streamable_count ?? 0) : child.streamable ? 1 : 0),
    0,
  );
  return {
    name: nameOf(path),
    path,
    folder: true,
    streamable: streamable_count > 0,
    streamable_count,
    probe: null,
    ...(children.length > 0 ? { children } : {}),
  };
}

/** `GET /api/media`: the root folder holding `entries`. */
export function mediaRoot(entries: readonly MediaEntry[]): MediaEntry {
  return { ...mediaFolder('', entries), name: '', path: '' };
}

/** `GET /api/media/info` for a video at `path`. */
export function videoInfo(path: string, overrides: Partial<MediaProbe> = {}): MediaFileInfo {
  return {
    name: nameOf(path),
    path,
    probe: {
      kind: 'video',
      codec: 'h264',
      codec_name: 'H.264',
      width: 1280,
      height: 720,
      fps: 30,
      frame_rate: '30/1',
      duration_ms: 134_000,
      size: 2_400_000,
      streamable: true,
      ...overrides,
    },
  };
}
