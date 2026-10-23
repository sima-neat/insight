import { TestBed } from '@angular/core/testing';
import { LatestOnly, visiblePoller } from './polling';

describe('visiblePoller', () => {
  let visibility: DocumentVisibilityState;
  let poll: ReturnType<typeof vi.fn<() => void>>;
  let poller: ReturnType<typeof visiblePoller>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    poll = vi.fn<() => void>();
    poller = TestBed.runInInjectionContext(() => visiblePoller(1000, poll));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setVisibility(state: DocumentVisibilityState): void {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('does nothing until activated, then polls at once and every interval', () => {
    vi.advanceTimersByTime(5000);
    expect(poll).not.toHaveBeenCalled();

    poller.setActive(true);
    expect(poll).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(poll).toHaveBeenCalledTimes(4);
  });

  it('starts one timer however often it is activated, and stops when deactivated', () => {
    poller.setActive(true);
    poller.setActive(true);
    vi.advanceTimersByTime(2000);
    expect(poll).toHaveBeenCalledTimes(3);

    poller.setActive(false);
    vi.advanceTimersByTime(5000);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('pauses while hidden and polls at once when the page shows, but not when inactive', () => {
    poller.setActive(true);
    setVisibility('hidden');
    vi.advanceTimersByTime(5000);
    expect(poll).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    expect(poll).toHaveBeenCalledTimes(2);

    poller.setActive(false);
    setVisibility('hidden');
    setVisibility('visible');
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('does not start while hidden', () => {
    setVisibility('hidden');
    poller.setActive(true);
    vi.advanceTimersByTime(3000);
    expect(poll).not.toHaveBeenCalled();
  });

  it('stops, and stops listening, when its injection context is destroyed', () => {
    poller.setActive(true);
    expect(poll).toHaveBeenCalledTimes(1);

    TestBed.resetTestingModule();
    vi.advanceTimersByTime(5000);
    setVisibility('hidden');
    setVisibility('visible');
    expect(poll).toHaveBeenCalledTimes(1);
  });
});

describe('LatestOnly', () => {
  it('accepts answers in order and refuses one older than an answer taken', () => {
    const latest = new LatestOnly();
    const first = latest.next();
    const second = latest.next();

    expect(latest.accept(second)).toBe(true);
    expect(latest.accept(first)).toBe(false);
  });

  it('accepts an older answer that arrives before a newer one, but only the last request is newest', () => {
    const latest = new LatestOnly();
    const first = latest.next();
    const second = latest.next();

    expect(latest.isNewest(first)).toBe(false);
    expect(latest.isNewest(second)).toBe(true);
    expect(latest.accept(first)).toBe(true);
  });

  it('refuses the answers of every request sent before a discard, and not of later ones', () => {
    const latest = new LatestOnly();
    const before = latest.next();
    latest.discard();
    const after = latest.next();

    expect(latest.accept(before)).toBe(false);
    expect(latest.accept(after)).toBe(true);
  });
});
