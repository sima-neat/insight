import type { NeatInsightVideoStats } from '@sima/neat-ui/insight';
import { formatBitrate } from '../format-bitrate';

/** The codecs as people write them, by the name the browser reports. */
const CODEC_LABELS: Readonly<Record<string, string>> = { H264: 'H.264', H265: 'H.265' };

/**
 * A connected channel's status line: `H.264 · 1280×720 · 30.0 fps · 2.1 Mbit/s · 30 msg/s`, each
 * part the browser has not reported yet left out. Empty while the channel is not connected: what
 * keeps it from showing is the tile's notice, and the channel number is the tile's label.
 */
export function formatChannelStats(
  stats: NeatInsightVideoStats | null,
  messagesPerSecond: number,
): string {
  if (stats === null) return '';
  const { codec, width, height, framesPerSecond, bitsPerSecond } = stats;
  return [
    codec === null ? null : (CODEC_LABELS[codec] ?? codec),
    width === null || height === null ? null : `${width}×${height}`,
    framesPerSecond === null ? null : `${framesPerSecond.toFixed(1)} fps`,
    formatBitrate(bitsPerSecond),
    `${messagesPerSecond} msg/s`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}
