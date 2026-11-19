import {
  allCommitsSucceeded,
  clock,
  customRate,
  FPS_MIN,
  FPS_STEP,
  parseFps,
  stepFps,
} from './fps';

// The tests of `fps.test.js` in sima-neat/insight#170 whose rule is still the app's. The server
// decides when a start needs a rendition (the slot is `preparing`), so that has no test here.
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
    // A 300 fps file must be able to go back to 300.
    expect(parseFps('30')).toBe(30);
    expect(parseFps(' 15 ')).toBe(15);
    expect(parseFps('300')).toBe(300);
    expect(parseFps('1000')).toBe(1000);
    expect(parseFps('1')).toBe(1);
  });

  it('customRate is the override when it differs from the native rate, also an unknown one', () => {
    expect(customRate({ native_fps: 30 })).toBeNull();
    expect(customRate({ fps: 30, native_fps: 30 })).toBeNull();
    expect(customRate({ fps: 15, native_fps: 30 })).toBe(15);
    expect(customRate({})).toBeNull();
    // Unknown native rate (the server has not probed the file yet): the start encodes it.
    expect(customRate({ fps: 15 })).toBe(15);
  });

  it('parseFps rejects invalid input', () => {
    for (const text of ['', '0', '-3', 'abc', '29.97', '1e2', null, undefined]) {
      expect(parseFps(text), `expected ${JSON.stringify(text)} to be rejected`).toBeNull();
    }
  });

  it('clock is m:ss, h:mm:ss from an hour on, cut to whole seconds', () => {
    expect(clock(9.9)).toBe('0:09');
    expect(clock(134)).toBe('2:14');
    expect(clock(3725)).toBe('1:02:05');
    expect(clock(-3)).toBe('0:00');
  });

  it('allCommitsSucceeded is false as soon as one pending commit failed', () => {
    // Codex review: Bulk Start must not post when any awaited FPS commit was refused.
    expect(allCommitsSucceeded([])).toBe(true);
    expect(allCommitsSucceeded([{ ok: true }, { ok: true }])).toBe(true);
    expect(allCommitsSucceeded([{ ok: true }, { ok: false }])).toBe(false);
  });
});
