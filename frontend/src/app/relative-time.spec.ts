import { formatRelativeTime } from './relative-time';

describe('formatRelativeTime', () => {
  // #170's "relative times and durations", the time half (durations are not ported).
  it('relative times', () => {
    const now = Date.parse('2026-09-21T10:00:00Z');
    for (const [at, label] of [
      ['2026-09-21T09:59:58Z', 'just now'],
      ['2026-09-21T09:59:30Z', '30 s ago'],
      ['2026-09-21T09:55:00Z', '5 min ago'],
      ['2026-09-21T07:00:00Z', '3 h ago'],
      ['2026-09-19T10:00:00Z', '2 d ago'],
      [null, ''],
    ] as const) {
      expect(formatRelativeTime(at, now)).toBe(label);
    }
  });

  it('switches unit at 10 s, a minute, an hour and a day, and reads an unparsable time as none', () => {
    const now = Date.parse('2026-09-21T10:00:00Z');
    const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
    expect(formatRelativeTime(ago(9), now)).toBe('just now');
    expect(formatRelativeTime(ago(10), now)).toBe('10 s ago');
    expect(formatRelativeTime(ago(59), now)).toBe('59 s ago');
    expect(formatRelativeTime(ago(60), now)).toBe('1 min ago');
    expect(formatRelativeTime(ago(3599), now)).toBe('59 min ago');
    expect(formatRelativeTime(ago(3600), now)).toBe('1 h ago');
    expect(formatRelativeTime(ago(86_399), now)).toBe('23 h ago');
    expect(formatRelativeTime(ago(86_400), now)).toBe('1 d ago');
    expect(formatRelativeTime('yesterday', now)).toBe('');
  });
});
