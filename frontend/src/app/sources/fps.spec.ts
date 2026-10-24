import type { SlotState } from './api';
import {
  allCommitsSucceeded,
  formatFpsProgress,
  FPS_MIN,
  FPS_STEP,
  isNativeRate,
  needsRendition,
  parseFps,
  renditionMayHaveChanged,
  stepFps,
  withCommittedFps,
} from './fps';

// #170's `fps.test.js`, ported with its assertions unchanged.
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

  it('isNativeRate is true for no override or one equal to the native rate', () => {
    expect(isNativeRate(null, 30)).toBe(true);
    expect(isNativeRate(30, 30)).toBe(true);
    expect(isNativeRate(15, 30)).toBe(false);
    expect(isNativeRate(null, null)).toBe(true);
    // Unknown native rate: an override may need a rendition.
    expect(isNativeRate(15, null)).toBe(false);
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

  it('renditionMayHaveChanged spots a slot that started playing at a custom FPS', () => {
    // Owner review (O9): the 2 s poll asks for rendition usage only when a start may have made one.
    const slot = (state: SlotState, fps: number | null, file = 'clip.mp4') => ({
      index: 1,
      file,
      fps,
      state,
    });
    expect(renditionMayHaveChanged([slot('stopped', 15)], [slot('playing', 15)])).toBe(true);
    expect(
      renditionMayHaveChanged([slot('playing', 15)], [slot('playing', 20)]),
      'restarted at another rate',
    ).toBe(true);
    expect(
      renditionMayHaveChanged([slot('playing', 15)], [slot('playing', 15, 'other.mp4')]),
      'restarted with another file',
    ).toBe(true);
    expect(renditionMayHaveChanged([], [slot('playing', 15)]), 'first poll').toBe(true);
    expect(
      renditionMayHaveChanged([slot('playing', 15)], [slot('playing', 15)]),
      'still playing',
    ).toBe(false);
    expect(
      renditionMayHaveChanged([slot('stopped', null)], [slot('playing', null)]),
      'native rate makes no rendition',
    ).toBe(false);
    expect(
      renditionMayHaveChanged([slot('playing', 15)], [slot('stopped', 15)]),
      'a stop keeps the rendition',
    ).toBe(false);
  });
});
