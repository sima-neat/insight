import type { MediaInfo } from '../../sources/api';
import { formatDuration, formatFrameRate, mediaInfoRows } from './media-info';

describe('formatFrameRate', () => {
  it('reads ffprobe’s rational rate as frames per second', () => {
    expect(formatFrameRate('30/1')).toBe('30 fps');
    expect(formatFrameRate('30000/1001')).toBe('29.97 fps');
    expect(formatFrameRate('25')).toBe('25 fps');
    expect(formatFrameRate('24000/1001')).toBe('23.98 fps');
  });

  it('says "-" for a rate that is missing or not a rate', () => {
    expect(formatFrameRate(null)).toBe('-');
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

  it('says "-" for a duration that is unknown', () => {
    expect(formatDuration(null)).toBe('-');
    expect(formatDuration(Number.NaN)).toBe('-');
  });
});

describe('mediaInfoRows', () => {
  it('lists a video’s info with readable values', () => {
    const info: MediaInfo = {
      filename: 'walk.mp4',
      size_bytes: 5_452_595,
      type: 'video',
      codec: 'H.264',
      normalized_codec: 'h264',
      width: 1280,
      height: 720,
      duration_ms: 134_000,
      frame_rate: '30/1',
    };
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

  it('names a codec Insight does not stream in capitals, and "-" for what the probe did not find', () => {
    const info: MediaInfo = {
      filename: 'clip.webm',
      size_bytes: 512,
      type: 'video',
      codec: 'vp9',
      normalized_codec: null,
      width: null,
      height: null,
      duration_ms: null,
      frame_rate: null,
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

  it('lists an image’s type, size, mode and format (#170)', () => {
    const info: MediaInfo = {
      filename: 'still.png',
      size_bytes: 2_300_000_000,
      type: 'image',
      width: 640,
      height: 480,
      mode: 'RGB',
      format: 'PNG',
    };
    expect(mediaInfoRows(info)).toEqual([
      { label: 'Filename', value: 'still.png' },
      { label: 'Size', value: '2.14 GB' },
      { label: 'Type', value: 'Image' },
      { label: 'Width', value: '640' },
      { label: 'Height', value: '480' },
      { label: 'Mode', value: 'RGB' },
      { label: 'Format', value: 'PNG' },
    ]);
  });

  it('lists only the name, size and type of a file the probe could not read', () => {
    expect(mediaInfoRows({ filename: 'notes.txt', size_bytes: 2048, type: 'unknown' })).toEqual([
      { label: 'Filename', value: 'notes.txt' },
      { label: 'Size', value: '2.0 KB' },
      { label: 'Type', value: 'Unknown' },
    ]);
  });
});
