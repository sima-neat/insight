/**
 * How long ago `iso` was at `now` (ms since the epoch), in #170's words: "just now" under 10 s,
 * then seconds, minutes, hours and days, each cut to whole units. An absent or unparsable time
 * reads as ''. Pair it with `ticking()` so the text ages while it is shown.
 */
export function formatRelativeTime(iso: string | null, now: number): string {
  const time = Date.parse(iso ?? '');
  if (!Number.isFinite(time)) return '';
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

/**
 * The whole seconds from `since` to `now` (ms since the epoch), for a count that ticks while
 * something runs ("Scanning… 3 s"); never below zero, should the clock step back.
 */
export function elapsedSeconds(since: number, now: number): number {
  return Math.max(0, Math.round((now - since) / 1000));
}
