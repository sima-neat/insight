import { neatDuration } from '@sima/neat-ui';

/**
 * A length of time in milliseconds, as the API and the browser's clock give it, in the kit's one
 * style (`neatDuration`): "34 s", "5 min 07 s", "2 h 05 min", "3 d 04 h", each unit cut to whole
 * units as a clock shows them. `NO_VALUE` for a length that is missing or not a number.
 */
export function formatDuration(ms: number | null | undefined): string {
  return neatDuration(ms == null ? null : ms / 1000);
}

/**
 * The time from `since` to `now` (ms since the epoch) as `formatDuration` words it, for a time that
 * counts up while something runs ("Scanning… 3 s", how long a stream has been live). Never below
 * zero, should the clock step back; `NO_VALUE` for a `since` that is not a number (an unparsable
 * time).
 */
export function formatElapsed(since: number, now: number): string {
  return formatDuration(Math.max(0, now - since));
}
