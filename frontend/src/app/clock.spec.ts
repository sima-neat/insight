import { TestBed } from '@angular/core/testing';
import { ticking } from './clock';

describe('ticking', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-10-24T12:00:00Z') });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticking refreshes every interval and stops when its context is destroyed', () => {
    const start = Date.now();
    const now = TestBed.runInInjectionContext(() => ticking(1000));
    expect(now()).toBe(start);

    vi.advanceTimersByTime(999);
    expect(now()).toBe(start);
    vi.advanceTimersByTime(1);
    expect(now()).toBe(start + 1000);
    vi.advanceTimersByTime(2000);
    expect(now()).toBe(start + 3000);

    TestBed.resetTestingModule();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(now()).toBe(start + 3000);
  });
});
