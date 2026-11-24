import type { MediaFileInfo, MediaProbe } from '../../api.generated';
import { formatDuration } from '../../duration';
import { formatBytes } from '../../format-bytes';
import { NO_VALUE } from '../../no-value';
import { codecLabel } from '../../sources/slot-row';

/** One row of the side panel's info table. */
export interface InfoRow {
  readonly label: string;
  readonly value: string;
}

const KIND_LABELS: Record<MediaProbe['kind'], string> = {
  video: 'Video',
  image: 'Image',
  unknown: 'Unknown',
};

/**
 * ffprobe's frame rate, often rational (`30/1`, `30000/1001`), as `30 fps` or `29.97 fps`: at most
 * two decimals, none when whole. `NO_VALUE` for a rate that is missing or zero (`0/0`).
 */
export function formatFrameRate(rate: string | undefined): string {
  const [numerator, denominator = '1'] = (rate ?? '').split('/');
  const fps = Number(numerator) / Number(denominator);
  if (!numerator || !Number.isFinite(fps) || fps <= 0) return NO_VALUE;
  return `${Number(fps.toFixed(2))} fps`;
}

const count = (value: number | undefined) => (value === undefined ? NO_VALUE : String(value));

/**
 * `/api/media/info` as the side panel lists it, in readable values (the size in KB/MB/GB, the
 * duration as "2 min 14 s" rather than "134.00 sec", the frame rate as `30 fps` rather than
 * `30/1`).
 * There is no "Normalized Codec" row: for the codecs Insight streams it would read the same as
 * the codec row, and a file it cannot stream is tagged in the list.
 * Why ffprobe could not read a file, when it could not, is the last row.
 */
export function mediaInfoRows(info: MediaFileInfo): InfoRow[] {
  const probe = info.probe;
  const rows: InfoRow[] = [
    { label: 'Filename', value: info.name },
    { label: 'Size', value: formatBytes(probe.size) },
    { label: 'Type', value: KIND_LABELS[probe.kind] },
  ];
  if (probe.kind === 'video') {
    rows.push(
      { label: 'Codec', value: probe.codec_name || codecLabel(probe.codec) },
      { label: 'Width', value: count(probe.width) },
      { label: 'Height', value: count(probe.height) },
      { label: 'Duration', value: formatDuration(probe.duration_ms) },
      { label: 'Frame rate', value: formatFrameRate(probe.frame_rate) },
    );
  } else if (probe.kind === 'image') {
    rows.push(
      { label: 'Width', value: count(probe.width) },
      { label: 'Height', value: count(probe.height) },
    );
  }
  if (probe.problem) rows.push({ label: 'Problem', value: probe.problem });
  return rows;
}
