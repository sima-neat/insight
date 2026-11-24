import { neatSecondsAgo } from '@sima/neat-ui';

/**
 * How long ago `iso` was at `now` (ms since the epoch), in the kit's one relative-time style
 * (`neatSecondsAgo`): "just now" under 10 s, then seconds, minutes, hours and days, each cut to
 * whole units. An absent or unparsable time reads as ''. Pair it with `ticking()` so the text ages
 * while it is shown.
 */
export function formatRelativeTime(iso: string | null, now: number): string {
  const time = Date.parse(iso ?? '');
  if (!Number.isFinite(time)) return '';
  return neatSecondsAgo((now - time) / 1000);
}
