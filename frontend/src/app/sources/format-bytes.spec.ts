import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  it('reads in the largest binary unit that keeps the number at 1 or more, to one decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
    expect(formatBytes(3 * 1024 ** 4)).toBe('3.0 TB');
  });
});
