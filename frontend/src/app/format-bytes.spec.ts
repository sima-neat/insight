import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  it('reads B, then KB and MB to one decimal, then GB to two', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.20 GB');
  });

  it('reads the sizes of the machine Insight runs on in the same style', () => {
    expect([0, 2048, 8 * 1024 ** 3, 1536 * 1024 ** 2].map(formatBytes)).toEqual([
      '0 B',
      '2.0 KB',
      '8.00 GB',
      '1.50 GB',
    ]);
  });

  it('goes on to TB and PB, and reads a larger count in PB', () => {
    expect(formatBytes(1024 ** 4 - 1)).toBe('1024.00 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.00 TB');
    expect(formatBytes(3.5 * 1024 ** 4)).toBe('3.50 TB');
    expect(formatBytes(3 * 1024 ** 5)).toBe('3.00 PB');
    expect(formatBytes(2 * 1024 ** 6)).toBe('2048.00 PB');
  });

  it('shows "-" for a count that is not a number', () => {
    expect(formatBytes(Number.NaN)).toBe('-');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('-');
  });
});
