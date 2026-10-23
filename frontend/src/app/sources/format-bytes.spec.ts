import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  it('reads as #170 does: B, then KB and MB to one decimal, then GB to two', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.20 GB');
    // No larger unit: a terabyte still reads in GB.
    expect(formatBytes(3 * 1024 ** 4)).toBe('3072.00 GB');
  });

  it('shows "-" for a count that is not a number', () => {
    expect(formatBytes(Number.NaN)).toBe('-');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('-');
  });
});
