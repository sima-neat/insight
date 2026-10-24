import {
  allCommitsSucceeded,
  formatFpsProgress,
  FPS_MIN,
  FPS_STEP,
  customRate,
  needsRendition,
  parseFps,
  stepFps,
  withCommittedFps,
} from './fps';

// #170's `fps.test.js`, ported with its assertions unchanged. `renditionMayHaveChanged` and its
// test are left out (ruling Q13): `SlotsService`'s `startedCustomFps` is the app's one rule for it.
describe('fps', () => {
  it('constants match the backend minimum', () => {
    expect(FPS_MIN).toBe(1);
    expect(FPS_STEP).toBe(5);
  });

  it('stepFps moves by 5, stops at the minimum and has no upper bound', () => {
    expect(stepFps(30, 1)).toBe(35);
    expect(stepFps(30, -1)).toBe(25);
    expect(stepFps(3, -1)).toBe(1);
    expect(stepFps(240, 1)).toBe(245);
    expect(stepFps(1, -1)).toBe(1);
  });

  it('parseFps accepts any whole number from 1', () => {
    // Owner review (O5): a 300 fps file must be able to go back to 300.
    expect(parseFps('30')).toBe(30);
    expect(parseFps(' 15 ')).toBe(15);
    expect(parseFps('300')).toBe(300);
    expect(parseFps('1000')).toBe(1000);
    expect(parseFps('1')).toBe(1);
  });

  it('customRate is the override when it differs from the native rate, also an unknown one', () => {
    expect(customRate({ fps: null, native_fps: 30 })).toBeNull();
    expect(customRate({ fps: 30, native_fps: 30 })).toBeNull();
    expect(customRate({ fps: 15, native_fps: 30 })).toBe(15);
    expect(customRate({ fps: null, native_fps: null })).toBeNull();
    // Unknown native rate (the server has not probed the file yet): the start encodes it.
    expect(customRate({ fps: 15, native_fps: null })).toBe(15);
    expect(customRate({ fps: 15 })).toBe(15);
  });

  it('parseFps rejects invalid input', () => {
    for (const text of ['', '0', '-3', 'abc', '29.97', '1e2', null, undefined]) {
      expect(parseFps(text), `expected ${JSON.stringify(text)} to be rejected`).toBeNull();
    }
  });

  it('formatFpsProgress renders m:ss pairs', () => {
    expect(formatFpsProgress({ seconds: 25, total: 60 })).toBe('0:25 / 1:00');
    expect(formatFpsProgress({ seconds: 3725.4, total: null })).toBe('1:02:05');
  });

  it('needsRendition is true only for an fps that differs from the native rate', () => {
    expect(needsRendition(null)).toBe(false);
    expect(needsRendition({ fps: null, native_fps: 30 })).toBe(false);
    expect(needsRendition({ fps: 30, native_fps: 30 })).toBe(false);
    expect(needsRendition({ fps: 15, native_fps: 30 })).toBe(true);
    expect(needsRendition({ fps: 15, native_fps: null })).toBe(true);
  });

  it('withCommittedFps applies a settled commit and leaves the row alone otherwise', () => {
    // Codex review: Play must see the fps the stepper just committed, not the stale row.
    const row = { index: 1, fps: 30, native_fps: 30 };
    expect(withCommittedFps(row, { ok: true, fps: 15 })).toEqual({
      index: 1,
      fps: 15,
      native_fps: 30,
    });
    expect(withCommittedFps(row, undefined)).toBe(row);
    expect(withCommittedFps(row, { ok: false })).toBeNull();
    expect(withCommittedFps(null, { ok: true, fps: 15 })).toBeNull();
  });

  it('allCommitsSucceeded is false as soon as one pending commit failed', () => {
    // Codex review: Bulk Start must not post when any awaited FPS commit was refused.
    expect(allCommitsSucceeded([])).toBe(true);
    expect(
      allCommitsSucceeded([
        { ok: true, fps: 15 },
        { ok: true, fps: 20 },
      ]),
    ).toBe(true);
    expect(allCommitsSucceeded([{ ok: true, fps: 15 }, { ok: false }])).toBe(false);
  });
});
