import type { MediaInfo } from '../../sources/api';
import { formatBytes } from '../../sources/format-bytes';
import { clock } from '../../sources/fps';
import { codecLabel } from '../../sources/slot-row';

/** One row of the side panel's info table. */
export interface InfoRow {
  readonly label: string;
  readonly value: string;
}

/** What a row shows for a value the probe did not find, as #170 does. */
const NONE = '-';

const TYPE_LABELS: Record<MediaInfo['type'], string> = {
  video: 'Video',
  image: 'Image',
  unknown: 'Unknown',
};

/**
 * ffprobe's frame rate, often rational (`30/1`, `30000/1001`), as `30 fps` or `29.97 fps`: at most
 * two decimals, none when whole. "-" for a rate that is missing or zero (`0/0`).
 */
export function formatFrameRate(rate: string | null): string {
  const [numerator, denominator = '1'] = (rate ?? '').split('/');
  const fps = Number(numerator) / Number(denominator);
  if (!numerator || !Number.isFinite(fps) || fps <= 0) return NONE;
  return `${Number(fps.toFixed(2))} fps`;
}

/** A duration in milliseconds as `2:14`, or `1:02:05` from an hour on, to the nearest second. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return NONE;
  return clock(Math.round(ms / 1000));
}

const count = (value: number | null) => (value === null ? NONE : String(value));

/**
 * `/api/media-info` as the side panel lists it: #170's rows with readable values (the size in
 * KB/MB/GB, the duration as `2:14` rather than "134.00 sec", the frame rate as `30 fps` rather
 * than `30/1`). #170's "Normalized Codec" row is left out (ruling Q15): for the codecs Insight
 * streams it reads the same as the codec row, and a file it cannot stream is tagged in the list.
 */
export function mediaInfoRows(info: MediaInfo): InfoRow[] {
  const rows: InfoRow[] = [
    { label: 'Filename', value: info.filename },
    { label: 'Size', value: formatBytes(info.size_bytes) },
    { label: 'Type', value: TYPE_LABELS[info.type] },
  ];
  if (info.type === 'video') {
    rows.push(
      { label: 'Codec', value: codecLabel(info.codec ?? '') },
      { label: 'Width', value: count(info.width) },
      { label: 'Height', value: count(info.height) },
      { label: 'Duration', value: formatDuration(info.duration_ms) },
      { label: 'Frame rate', value: formatFrameRate(info.frame_rate) },
    );
  } else if (info.type === 'image') {
    rows.push(
      { label: 'Width', value: String(info.width) },
      { label: 'Height', value: String(info.height) },
      { label: 'Mode', value: info.mode },
      { label: 'Format', value: info.format },
    );
  }
  return rows;
}
