import { formatDuration, formatElapsed, formatRunDuration } from './duration';
import { NO_VALUE } from './no-value';

describe('formatDuration', () => {
  it("words milliseconds in the kit's style, cut to whole units", () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(34_400)).toBe('34 s');
    expect(formatDuration(59_999)).toBe('59 s');
    expect(formatDuration(134_000)).toBe('2 min 14 s');
    expect(formatDuration(3_725_000)).toBe('1 h 02 min');
    expect(formatDuration(97_200_000)).toBe('1 d 03 h');
  });

  it('is NO_VALUE for a length that is missing or not a number', () => {
    expect(formatDuration(undefined)).toBe(NO_VALUE);
    expect(formatDuration(null)).toBe(NO_VALUE);
    expect(formatDuration(Number.NaN)).toBe(NO_VALUE);
    expect(formatDuration(-1)).toBe(NO_VALUE);
  });
});

describe('formatRunDuration', () => {
  it('reads a run closely: tenths of a second under a minute, as formatDuration from one', () => {
    expect(formatRunDuration(850)).toBe('0.8 s');
    expect(formatRunDuration(34_400)).toBe('34.4 s');
    expect(formatRunDuration(59_999)).toBe('59.9 s');
    expect(formatRunDuration(134_000)).toBe('2 min 14 s');
  });

  it('is NO_VALUE for a length that is missing or not a number', () => {
    expect(formatRunDuration(null)).toBe(NO_VALUE);
    expect(formatRunDuration(Number.NaN)).toBe(NO_VALUE);
  });
});

describe('formatElapsed', () => {
  const since = Date.parse('2026-09-21T10:00:00Z');

  it('counts up from a moment as a stopwatch does', () => {
    expect(formatElapsed(since, since)).toBe('0 s');
    expect(formatElapsed(since, since + 1999)).toBe('1 s');
    expect(formatElapsed(since, since + 724_000)).toBe('12 min 04 s');
    expect(formatElapsed(since, since + 3_720_000)).toBe('1 h 02 min');
  });

  it('reads a clock that stepped back as just started, and an unparsable moment as none', () => {
    expect(formatElapsed(since, since - 3000)).toBe('0 s');
    expect(formatElapsed(Date.parse(''), since)).toBe(NO_VALUE);
  });
});
