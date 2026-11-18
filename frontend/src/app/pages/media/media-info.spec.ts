import type { MediaFileInfo } from '../../api.generated';
import { videoInfo } from '../../sources/media.testing';
import { formatDuration, formatFrameRate, mediaInfoRows } from './media-info';

describe('formatFrameRate', () => {
  it('reads ffprobe’s rational rate as frames per second', () => {
    expect(formatFrameRate('30/1')).toBe('30 fps');
    expect(formatFrameRate('30000/1001')).toBe('29.97 fps');
    expect(formatFrameRate('25')).toBe('25 fps');
    expect(formatFrameRate('24000/1001')).toBe('23.98 fps');
  });

  it('says "-" for a rate that is missing or not a rate', () => {
    expect(formatFrameRate(undefined)).toBe('-');
    expect(formatFrameRate('0/0')).toBe('-');
    expect(formatFrameRate('n/a')).toBe('-');
    expect(formatFrameRate('')).toBe('-');
  });
});

describe('formatDuration', () => {
  it('reads milliseconds as m:ss, or h:mm:ss from an hour, to the nearest second', () => {
    expect(formatDuration(134_000)).toBe('2:14');
    expect(formatDuration(9_400)).toBe('0:09');
    expect(formatDuration(59_600)).toBe('1:00');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(0)).toBe('0:00');
  });

  it('rounds a duration that is not whole seconds', () => {
    expect(formatDuration(134_033)).toBe('2:14');
    expect(formatDuration(3_725_500)).toBe('1:02:06');
  });

  it('says "-" for a duration that is unknown', () => {
    expect(formatDuration(undefined)).toBe('-');
    expect(formatDuration(Number.NaN)).toBe('-');
  });
});

describe('mediaInfoRows', () => {
  it('lists a video’s info with readable values', () => {
    const info = videoInfo('people/walk.mp4', { size: 5_452_595 });
    expect(mediaInfoRows(info)).toEqual([
      { label: 'Filename', value: 'walk.mp4' },
      { label: 'Size', value: '5.2 MB' },
      { label: 'Type', value: 'Video' },
      { label: 'Codec', value: 'H.264' },
      { label: 'Width', value: '1280' },
      { label: 'Height', value: '720' },
      { label: 'Duration', value: '2:14' },
      { label: 'Frame rate', value: '30 fps' },
    ]);
  });

  it('names a codec the server gives no display name for in capitals, and "-" for what the probe did not find', () => {
    const info: MediaFileInfo = {
      name: 'clip.webm',
      path: 'clip.webm',
      probe: { kind: 'video', codec: 'vp9', size: 512, streamable: false },
    };
    expect(mediaInfoRows(info)).toEqual([
      { label: 'Filename', value: 'clip.webm' },
      { label: 'Size', value: '512 B' },
      { label: 'Type', value: 'Video' },
      { label: 'Codec', value: 'VP9' },
      { label: 'Width', value: '-' },
      { label: 'Height', value: '-' },
      { label: 'Duration', value: '-' },
      { label: 'Frame rate', value: '-' },
    ]);
  });

  it('lists an image’s type, size and dimensions', () => {
    const info: MediaFileInfo = {
      name: 'still.png',
      path: 'still.png',
      probe: { kind: 'image', size: 2_300_000_000, width: 640, height: 480, streamable: false },
    };
    expect(mediaInfoRows(info)).toEqual([
      { label: 'Filename', value: 'still.png' },
      { label: 'Size', value: '2.14 GB' },
      { label: 'Type', value: 'Image' },
      { label: 'Width', value: '640' },
      { label: 'Height', value: '480' },
    ]);
  });

  it('lists only the name, size and type of a file the probe could not read, and why', () => {
    const info: MediaFileInfo = {
      name: 'notes.txt',
      path: 'notes.txt',
      probe: { kind: 'unknown', size: 2048, streamable: false, problem: 'no video stream' },
    };
    expect(mediaInfoRows(info)).toEqual([
      { label: 'Filename', value: 'notes.txt' },
      { label: 'Size', value: '2.0 KB' },
      { label: 'Type', value: 'Unknown' },
      { label: 'Problem', value: 'no video stream' },
    ]);
  });
});
