import { allCommitsSucceeded, customRate, FPS_MIN, FPS_STEP } from './fps';

// The tests of `fps.test.js` in sima-neat/insight#170 whose rule is still the app's. The server
// decides when a start needs a rendition (the slot is `preparing`), so that has no test here.
describe('fps', () => {
  it('constants match the backend minimum', () => {
    expect(FPS_MIN).toBe(1);
    expect(FPS_STEP).toBe(5);
  });

  it('customRate is the override when it differs from the native rate, also an unknown one', () => {
    expect(customRate({ native_fps: 30 })).toBeNull();
    expect(customRate({ fps: 30, native_fps: 30 })).toBeNull();
    expect(customRate({ fps: 15, native_fps: 30 })).toBe(15);
    expect(customRate({})).toBeNull();
    // Unknown native rate (the server has not probed the file yet): the start encodes it.
    expect(customRate({ fps: 15 })).toBe(15);
  });

  it('allCommitsSucceeded is false as soon as one pending commit failed', () => {
    // Codex review: Bulk Start must not post when any awaited FPS commit was refused.
    expect(allCommitsSucceeded([])).toBe(true);
    expect(allCommitsSucceeded([{ ok: true }, { ok: true }])).toBe(true);
    expect(allCommitsSucceeded([{ ok: true }, { ok: false }])).toBe(false);
  });
});
