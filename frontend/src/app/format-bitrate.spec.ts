import { formatBitrate } from './format-bitrate';
import { NO_VALUE } from './no-value';

describe('formatBitrate', () => {
  it('reads whole kbit/s, then Mbit/s to one decimal', () => {
    expect(formatBitrate(0)).toBe('0 kbit/s');
    expect(formatBitrate(850_000)).toBe('850 kbit/s');
    expect(formatBitrate(999_499)).toBe('999 kbit/s');
    // What would round to 1000 kbit/s reads in the next unit.
    expect(formatBitrate(999_500)).toBe('1.0 Mbit/s');
    expect(formatBitrate(1_800_000)).toBe('1.8 Mbit/s');
  });

  it('is NO_VALUE for a rate that is missing, not a number or negative', () => {
    expect(formatBitrate(null)).toBe(NO_VALUE);
    expect(formatBitrate(undefined)).toBe(NO_VALUE);
    expect(formatBitrate(Number.NaN)).toBe(NO_VALUE);
    expect(formatBitrate(-1)).toBe(NO_VALUE);
  });
});
