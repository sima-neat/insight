import { NO_VALUE } from './no-value';

/**
 * A bitrate in bits per second, in SI units: whole kbit/s below 1 Mbit/s ("850 kbit/s"), then
 * Mbit/s to one decimal ("1.8 Mbit/s"). One formatter for every rate the app shows (a slot's
 * publisher, a Viewer channel). `NO_VALUE` for a rate that is missing, not a number or negative.
 */
export function formatBitrate(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps) || bps < 0) return NO_VALUE;
  const kbit = Math.round(bps / 1000);
  return kbit < 1000 ? `${kbit} kbit/s` : `${(bps / 1_000_000).toFixed(1)} Mbit/s`;
}
