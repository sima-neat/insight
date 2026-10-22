import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ChannelLiveness, liveChannels } from './channel-liveness';

const STATS_URL = '/api/ingest/stats';

/** An ingest stats answer in vf's shape (webrtc/ingest_stats.go), cut to the fields read here. */
const stats = (...live: number[]) => ({
  time: '2026-10-22T12:00:00Z',
  active_ttl_ms: 3000,
  channels: live.map((channel) => ({ channel, udp_port: 9000 + channel, active: true })),
});

describe('liveChannels', () => {
  it('takes the channels vf reports active', () => {
    expect(liveChannels(stats(4, 0))).toEqual(new Set([4, 0]));
  });

  it('skips inactive and malformed entries, and reads a malformed answer as none live', () => {
    expect(
      liveChannels({
        channels: [
          { channel: 1, active: false },
          { channel: '2', active: true },
          { channel: 3.5, active: true },
          null,
          { channel: 6, active: true },
        ],
      }),
    ).toEqual(new Set([6]));
    expect(liveChannels({ channels: 'none' })).toEqual(new Set());
    expect(liveChannels(null)).toEqual(new Set());
  });
});

describe('ChannelLiveness', () => {
  let http: HttpTestingController;
  let liveness: ChannelLiveness;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    TestBed.configureTestingModule({
      providers: [ChannelLiveness, provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    liveness = TestBed.inject(ChannelLiveness);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setVisibility(state: DocumentVisibilityState): void {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('asks nothing until enabled, then polls every 2 s', () => {
    vi.advanceTimersByTime(6000);
    http.expectNone(STATS_URL);
    expect(liveness.live()).toBeNull();

    liveness.setEnabled(true);
    http.expectOne(STATS_URL).flush(stats(1, 2));
    expect(liveness.live()).toEqual(new Set([1, 2]));

    vi.advanceTimersByTime(2000);
    http.expectOne(STATS_URL).flush(stats(2));
    expect(liveness.live()).toEqual(new Set([2]));
  });

  it('stops polling and forgets the live set when disabled', () => {
    liveness.setEnabled(true);
    http.expectOne(STATS_URL).flush(stats(1));

    liveness.setEnabled(false);
    expect(liveness.live()).toBeNull();
    vi.advanceTimersByTime(10_000);
    http.expectNone(STATS_URL);
  });

  it('pauses while the page is hidden and asks again at once when it shows', () => {
    liveness.setEnabled(true);
    http.expectOne(STATS_URL).flush(stats(1));

    setVisibility('hidden');
    vi.advanceTimersByTime(10_000);
    http.expectNone(STATS_URL);
    expect(liveness.live()).toEqual(new Set([1]));

    setVisibility('visible');
    http.expectOne(STATS_URL).flush(stats(3));
    expect(liveness.live()).toEqual(new Set([3]));
  });

  it('does not start polling when enabled while the page is hidden', () => {
    setVisibility('hidden');
    liveness.setEnabled(true);
    vi.advanceTimersByTime(4000);
    http.expectNone(STATS_URL);
  });

  it('the latest response wins over an earlier one that arrives after it', () => {
    liveness.setEnabled(true);
    const first = http.expectOne(STATS_URL);
    vi.advanceTimersByTime(2000);
    const second = http.expectOne(STATS_URL);

    second.flush(stats(2));
    first.flush(stats(1));

    expect(liveness.live()).toEqual(new Set([2]));
  });

  it('is unavailable while the newest request failed, keeping the last answer, until the next one', () => {
    liveness.setEnabled(true);
    const badGateway = { status: 502, statusText: 'Bad Gateway' };
    http.expectOne(STATS_URL).flush({ error: 'vf ingest stats unavailable' }, badGateway);
    expect(liveness.unavailable()).toBe(true);
    expect(liveness.live()).toBeNull();

    vi.advanceTimersByTime(2000);
    http.expectOne(STATS_URL).flush(stats(1));
    expect(liveness.unavailable()).toBe(false);
    expect(liveness.live()).toEqual(new Set([1]));

    // A failure after a good answer keeps that answer: one lost poll must not swing the grid.
    vi.advanceTimersByTime(2000);
    http.expectOne(STATS_URL).flush({ error: 'vf ingest stats unavailable' }, badGateway);
    expect(liveness.unavailable()).toBe(true);
    expect(liveness.live()).toEqual(new Set([1]));

    vi.advanceTimersByTime(2000);
    http.expectOne(STATS_URL).flush(stats(4));
    expect(liveness.unavailable()).toBe(false);
    expect(liveness.live()).toEqual(new Set([4]));

    liveness.setEnabled(false);
    expect(liveness.unavailable()).toBe(false);
    expect(liveness.live()).toBeNull();
  });

  it('an older request that fails after a newer answer changes nothing', () => {
    liveness.setEnabled(true);
    const first = http.expectOne(STATS_URL);
    vi.advanceTimersByTime(2000);
    http.expectOne(STATS_URL).flush(stats(2));

    first.flush({ error: 'timeout' }, { status: 504, statusText: 'Gateway Timeout' });

    expect(liveness.unavailable()).toBe(false);
    expect(liveness.live()).toEqual(new Set([2]));
  });

  it('ignores an answer to a request sent before it was disabled', () => {
    liveness.setEnabled(true);
    const stale = http.expectOne(STATS_URL);
    liveness.setEnabled(false);

    stale.flush(stats(1));

    expect(liveness.live()).toBeNull();
  });

  it('stops polling when destroyed', () => {
    liveness.setEnabled(true);
    http.expectOne(STATS_URL).flush(stats(1));

    TestBed.resetTestingModule();
    vi.advanceTimersByTime(10_000);
    http.expectNone(STATS_URL);
  });
});
