import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Slot } from './api';
import { SlotsService } from './slots.service';
import { ApiRequestError, type StreamEvent } from './stream-lines';

const SLOTS_URL = '/api/mediasrc';
const RENDITIONS_URL = '/api/mediasrc/renditions';

/** A slot in the shape `GET /api/mediasrc` answers, with the fields these tests do not care about filled in. */
function slot(index: number, overrides: Partial<Slot> = {}): Slot {
  return {
    index,
    file: '',
    state: 'stopped',
    transport: '',
    codec: '',
    type: 'file',
    allowed_transports: [],
    urls: {},
    ...overrides,
  };
}

const conflict = { status: 409, statusText: 'Conflict' };

/** Lets the promise chains behind a flushed request run (real timer: only intervals are faked). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve));

describe('SlotsService', () => {
  let http: HttpTestingController;
  let service: SlotsService;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(SlotsService);
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

  describe('polling', () => {
    it('asks nothing until watched, polls every 2 s while watched and visible, stops when the last watcher releases, and polls at once on becoming visible', async () => {
      vi.advanceTimersByTime(6000);
      http.expectNone(SLOTS_URL);
      expect(service.slots()).toBeNull();

      const first = service.watch();
      const second = service.watch();
      http.expectOne(SLOTS_URL).flush([slot(1)]);
      await tick();
      expect(service.slots()).toEqual([slot(1)]);

      vi.advanceTimersByTime(2000);
      http.expectOne(SLOTS_URL).flush([slot(1), slot(2)]);
      await tick();
      expect(service.slots()).toHaveLength(2);

      // One watcher is enough to keep polling.
      first();
      vi.advanceTimersByTime(2000);
      http.expectOne(SLOTS_URL).flush([slot(1)]);
      await tick();

      second();
      vi.advanceTimersByTime(10_000);
      http.expectNone(SLOTS_URL);

      // Releasing twice must not release somebody else's hold.
      const third = service.watch();
      http.expectOne(SLOTS_URL).flush([slot(1)]);
      await tick();
      second();
      vi.advanceTimersByTime(2000);
      http.expectOne(SLOTS_URL).flush([slot(1)]);
      await tick();

      setVisibility('hidden');
      vi.advanceTimersByTime(10_000);
      http.expectNone(SLOTS_URL);

      setVisibility('visible');
      http.expectOne(SLOTS_URL).flush([slot(1), slot(2), slot(3)]);
      await tick();
      expect(service.slots()).toHaveLength(3);
      third();
    });

    it('does not start polling when watched while the page is hidden', () => {
      setVisibility('hidden');
      const release = service.watch();
      vi.advanceTimersByTime(4000);
      http.expectNone(SLOTS_URL);
      release();
    });

    it('keeps one poll in flight: a tick while one is pending sends nothing', async () => {
      const release = service.watch();
      const pending = http.expectOne(SLOTS_URL);

      vi.advanceTimersByTime(6000);
      http.expectNone(SLOTS_URL);

      pending.flush([slot(1)]);
      await tick();
      vi.advanceTimersByTime(2000);
      http.expectOne(SLOTS_URL).flush([slot(1)]);
      release();
    });

    it('keeps the last answer when a poll fails and asks again at the next tick', async () => {
      const release = service.watch();
      http.expectOne(SLOTS_URL).flush([slot(1, { file: 'a.mp4' })]);
      await tick();

      vi.advanceTimersByTime(2000);
      http
        .expectOne(SLOTS_URL)
        .flush({ error: 'down' }, { status: 502, statusText: 'Bad Gateway' });
      await tick();
      expect(service.slots()).toEqual([slot(1, { file: 'a.mp4' })]);

      vi.advanceTimersByTime(2000);
      http.expectOne(SLOTS_URL).flush([slot(1)]);
      await tick();
      expect(service.slots()).toEqual([slot(1)]);
      release();
    });
  });

  describe('unavailable', () => {
    const badGateway = { status: 502, statusText: 'Bad Gateway' };

    it('is set by a failed poll, keeps the last answer, and clears at the next success', async () => {
      const release = service.watch();
      http.expectOne(SLOTS_URL).flush([slot(1, { file: 'a.mp4' })]);
      await tick();
      expect(service.unavailable()).toBe(false);

      vi.advanceTimersByTime(2000);
      http.expectOne(SLOTS_URL).flush({ error: 'down' }, badGateway);
      await tick();
      expect(service.unavailable()).toBe(true);
      expect(service.slots()).toEqual([slot(1, { file: 'a.mp4' })]);

      vi.advanceTimersByTime(2000);
      http.expectOne(SLOTS_URL).flush([slot(1)]);
      await tick();
      expect(service.unavailable()).toBe(false);
      expect(service.slots()).toEqual([slot(1)]);
      release();
    });

    it('is set by a failure before any answer, which leaves slots null', async () => {
      const refreshed = service.refresh();
      http.expectOne(SLOTS_URL).flush({ error: 'down' }, badGateway);
      await expect(refreshed).rejects.toMatchObject({ status: 502 });

      expect(service.unavailable()).toBe(true);
      expect(service.slots()).toBeNull();
    });

    it('is not set by an older request that fails after a newer one was sent', async () => {
      const older = service.refresh();
      const first = http.expectOne(SLOTS_URL);
      const newer = service.refresh();
      const second = http.expectOne(SLOTS_URL);

      second.flush([slot(1)]);
      first.flush({ error: 'timeout' }, { status: 504, statusText: 'Gateway Timeout' });
      await newer;
      await expect(older).rejects.toMatchObject({ status: 504 });

      expect(service.unavailable()).toBe(false);
      expect(service.slots()).toEqual([slot(1)]);
    });

    it('treats a poll that never answers as failed, so the next tick polls again', async () => {
      const release = service.watch();
      const hung = http.expectOne(SLOTS_URL);

      vi.advanceTimersByTime(10_000);
      await tick();
      expect(hung.cancelled).toBe(true);
      expect(service.unavailable()).toBe(true);

      vi.advanceTimersByTime(2000);
      http.expectOne(SLOTS_URL).flush([slot(1)]);
      await tick();
      expect(service.unavailable()).toBe(false);
      release();
    });
  });

  describe('refresh', () => {
    it('drops an answer older than the newest one', async () => {
      const older = service.refresh();
      const first = http.expectOne(SLOTS_URL);
      const newer = service.refresh();
      const second = http.expectOne(SLOTS_URL);

      second.flush([slot(1, { state: 'playing' })]);
      first.flush([slot(1, { state: 'stopped' })]);
      await Promise.all([older, newer]);

      expect(service.slots()?.[0].state).toBe('playing');
    });

    it('sends a request even while a poll is in flight, so what follows a change is never a poll started before it', async () => {
      const release = service.watch();
      const poll = http.expectOne(SLOTS_URL);

      const refreshed = service.refresh();
      const fresh = http.expectOne(SLOTS_URL);
      fresh.flush([slot(1, { file: 'new.mp4' })]);
      poll.flush([slot(1, { file: 'old.mp4' })]);
      await refreshed;

      expect(service.slots()?.[0].file).toBe('new.mp4');
      release();
    });

    it('rejects with the server message when the request fails', async () => {
      const refreshed = service.refresh();
      http
        .expectOne(SLOTS_URL)
        .flush({ error: 'MediaMTX is down' }, { status: 502, statusText: 'Bad Gateway' });

      await expect(refreshed).rejects.toMatchObject({ status: 502, message: 'MediaMTX is down' });
      expect(service.slots()).toBeNull();
    });
  });

  describe('actions', () => {
    /** Answers the refresh an action sends once it has settled. */
    const answerRefresh = async (slots: Slot[] = [slot(1)]) => {
      await tick();
      http.expectOne(SLOTS_URL).flush(slots);
    };

    it('assign posts the request and refreshes after success', async () => {
      const done = service.assign({ index: 3, file: 'a.mp4', fps: 15 });
      const request = http.expectOne('/api/mediasrc/assign');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ index: 3, file: 'a.mp4', fps: 15 });
      request.flush({ success: true });
      await answerRefresh([slot(3, { file: 'a.mp4' })]);

      await expect(done).resolves.toEqual({ success: true });
      expect(service.slots()?.[0].file).toBe('a.mp4');
    });

    it('refreshes after a 409 and rethrows the server message', async () => {
      const done = service.start({ index: 2 });
      http
        .expectOne('/api/mediasrc/start')
        .flush({ error: 'src2 is in use by an external publisher.' }, conflict);
      await answerRefresh([slot(2, { state: 'external' })]);
      http.expectOne(RENDITIONS_URL).flush({ count: 0, bytes: 0 });

      await expect(done).rejects.toBeInstanceOf(ApiRequestError);
      await expect(done).rejects.toMatchObject({
        status: 409,
        message: 'src2 is in use by an external publisher.',
      });
      expect(service.slots()?.[0].state).toBe('external');
    });

    it("keeps the body of a refusal, such as the pull route's auth_failed", async () => {
      const done = service.pull({ index: 4, url: 'rtsp://cam/stream' });
      http
        .expectOne('/api/mediasrc/pull')
        .flush(
          { error: 'The camera requires a username and password', reason: 'auth_failed' },
          { status: 400, statusText: 'Bad Request' },
        );
      await answerRefresh();

      await expect(done).rejects.toMatchObject({ body: { reason: 'auth_failed' } });
    });

    it('does not show a poll answer that was already on its way when the action settled', async () => {
      const release = service.watch();
      const poll = http.expectOne(SLOTS_URL);

      const done = service.stop({ index: 1 });
      http.expectOne('/api/mediasrc/stop').flush({ success: true });
      await tick();
      // The poll was sent before the stop finished: it may describe the slot as still playing.
      const refresh = http.expectOne(SLOTS_URL);
      poll.flush([slot(1, { state: 'playing' })]);
      await tick();
      expect(service.slots()).toBeNull();

      refresh.flush([slot(1, { state: 'stopped' })]);
      await done;
      expect(service.slots()?.[0].state).toBe('stopped');
      release();
    });

    it("shows the answer to the newest action when two overlap, not the first one's", async () => {
      const first = service.stop({ index: 1 });
      const second = service.assign({ index: 1, file: 'b.mp4' });
      http.expectOne('/api/mediasrc/stop').flush({ success: true });
      await tick();
      // The stop settled, so its refresh is sent while the assign is still running.
      const afterStop = http.expectOne(SLOTS_URL);
      http.expectOne('/api/mediasrc/assign').flush({ success: true });
      await tick();
      const afterAssign = http.expectOne(SLOTS_URL);

      afterAssign.flush([slot(1, { file: 'b.mp4' })]);
      afterStop.flush([slot(1, { file: '' })]);
      await Promise.all([first, second]);

      expect(service.slots()?.[0].file).toBe('b.mp4');
    });

    it('assignWebcam, start, startBulk, stop and takeOver each map to their endpoint', async () => {
      const cases: [string, () => Promise<unknown>, object][] = [
        ['/api/mediasrc/assign-webcam', () => service.assignWebcam({ index: 1 }), { index: 1 }],
        [
          '/api/mediasrc/start',
          () => service.start({ index: 1, expect_type: 'webcam' }),
          { index: 1, expect_type: 'webcam' },
        ],
        ['/api/mediasrc/start-bulk', () => service.startBulk(12), { count: 12 }],
        [
          '/api/mediasrc/stop',
          () => service.stop({ index: 1, publisher_released: true, publisher_session: 's' }),
          { index: 1, publisher_released: true, publisher_session: 's' },
        ],
        ['/api/mediasrc/takeover', () => service.takeOver(5), { index: 5 }],
      ];
      for (const [url, run, body] of cases) {
        const done = run();
        const request = http.expectOne(url);
        expect(request.request.method).toBe('POST');
        expect(request.request.body).toEqual(body);
        request.flush({ success: true });
        await answerRefresh();
        // Starting can encode a rendition, so those two fetch the usage too.
        http.match(RENDITIONS_URL).forEach((usage) => usage.flush({ count: 0, bytes: 0 }));
        await done;
      }
    });

    it('stopAll, reset and autoAssign send the released webcams', async () => {
      const released = [{ index: 2, session: 'abc' }];
      const cases: [string, () => Promise<unknown>][] = [
        ['/api/mediasrc/stop-all', () => service.stopAll(released)],
        ['/api/mediasrc/reset', () => service.reset(released)],
        ['/api/mediasrc/auto-assign-all', () => service.autoAssign(released)],
      ];
      for (const [url, run] of cases) {
        const done = run();
        const request = http.expectOne(url);
        expect(request.request.body).toEqual({ released_webcams: released });
        request.flush({ success: true });
        await answerRefresh();
        await done;
      }
    });

    it('start refreshes the rendition usage too, since a start can encode', async () => {
      const done = service.start({ index: 1 });
      http.expectOne('/api/mediasrc/start').flush({ success: true });
      await answerRefresh();
      http.expectOne(RENDITIONS_URL).flush({ count: 1, bytes: 2048 });
      await done;
      expect(service.renditions()).toEqual({ count: 1, bytes: 2048 });
    });

    it('clearRenditions posts, returns what was removed and refreshes the usage', async () => {
      const done = service.clearRenditions();
      const request = http.expectOne('/api/mediasrc/renditions/clear');
      expect(request.request.method).toBe('POST');
      request.flush({ removed: 2, freed_bytes: 4096, kept: ['.renditions/a.mp4'] });
      await answerRefresh();
      http.expectOne(RENDITIONS_URL).flush({ count: 1, bytes: 100 });

      await expect(done).resolves.toEqual({
        removed: 2,
        freed_bytes: 4096,
        kept: ['.renditions/a.mp4'],
      });
      expect(service.renditions()).toEqual({ count: 1, bytes: 100 });
    });

    it('does not report the action as failed when only the refresh after it fails', async () => {
      const done = service.stopAll([]);
      http.expectOne('/api/mediasrc/stop-all').flush({ success: true, stopped_count: 3 });
      await tick();
      http
        .expectOne(SLOTS_URL)
        .flush({ error: 'down' }, { status: 502, statusText: 'Bad Gateway' });

      await expect(done).resolves.toMatchObject({ stopped_count: 3 });
    });
  });

  describe('renditions', () => {
    const playing = (fps: number | null, native: number | null = 30) =>
      slot(1, { file: 'a.mp4', state: 'playing', fps, native_fps: native });

    it('are fetched again when a poll shows a slot newly streaming at a custom frame rate', async () => {
      const release = service.watch();
      http.expectOne(SLOTS_URL).flush([slot(1, { file: 'a.mp4' })]);
      await tick();
      http.expectNone(RENDITIONS_URL);

      vi.advanceTimersByTime(2000);
      http.expectOne(SLOTS_URL).flush([playing(15)]);
      await tick();
      http.expectOne(RENDITIONS_URL).flush({ count: 1, bytes: 10 });
      await tick();
      expect(service.renditions()).toEqual({ count: 1, bytes: 10 });

      // Still the same stream, or at the file's own rate: nothing new to count.
      vi.advanceTimersByTime(2000);
      http.expectOne(SLOTS_URL).flush([playing(15)]);
      await tick();
      vi.advanceTimersByTime(2000);
      http.expectOne(SLOTS_URL).flush([playing(30)]);
      await tick();
      http.expectNone(RENDITIONS_URL);
      release();
    });
  });

  describe('prepare', () => {
    function prepare(): {
      events: StreamEvent[];
      error: () => unknown;
      subscription: { unsubscribe(): void };
    } {
      const events: StreamEvent[] = [];
      let error: unknown;
      const subscription = service.prepare(2).subscribe({
        next: (event) => events.push(event),
        error: (failure: unknown) => (error = failure),
      });
      return { events, error: () => error, subscription };
    }

    it('streams the server lines, then refreshes the slots and the rendition usage', () => {
      const { events } = prepare();
      const request = http.expectOne('/api/mediasrc/prepare');
      expect(request.request.body).toEqual({ index: 2 });
      request.event({
        type: HttpEventType.DownloadProgress,
        loaded: 3,
        partialText: 'Encoding a.mp4 at 15 fps (libx264)...\n',
      });
      request.flush('Encoding a.mp4 at 15 fps (libx264)...\nRendition ready: .renditions/a.mp4\n');
      http.expectOne(SLOTS_URL).flush([slot(2)]);
      http.expectOne(RENDITIONS_URL).flush({ count: 1, bytes: 1 });

      expect(events.map((event) => event.kind)).toEqual(['line', 'line', 'done']);
    });

    it('refreshes and passes on the server message when the route refuses', () => {
      const { error } = prepare();
      http
        .expectOne('/api/mediasrc/prepare')
        .flush({ error: 'src2 is pulling a network stream.' }, conflict);
      http.expectOne(SLOTS_URL).flush([slot(2, { state: 'pulled' })]);
      http.expectOne(RENDITIONS_URL).flush({ count: 0, bytes: 0 });

      expect(error()).toMatchObject({ status: 409, message: 'src2 is pulling a network stream.' });
    });

    it('refreshes when the subscriber cancels the encode', () => {
      const { subscription } = prepare();
      const request = http.expectOne('/api/mediasrc/prepare');
      subscription.unsubscribe();
      expect(request.cancelled).toBe(true);
      http.expectOne(SLOTS_URL).flush([slot(2)]);
      http.expectOne(RENDITIONS_URL).flush({ count: 0, bytes: 0 });
    });
  });

  describe('assignedTo', () => {
    it('lists the slots assigned to a file in any state', async () => {
      const refreshed = service.refresh();
      http
        .expectOne(SLOTS_URL)
        .flush([
          slot(1, { file: 'a.mp4', state: 'playing' }),
          slot(2, { file: 'b.mp4', state: 'playing' }),
          slot(3, { file: 'a.mp4', state: 'stopped' }),
          slot(4, { file: 'a.mp4', state: 'pulled' }),
          slot(5, { file: 'a.mp4', state: 'external' }),
          slot(6, { type: 'webcam' }),
          slot(7),
        ]);
      await refreshed;

      expect(service.assignedTo('a.mp4').map((s) => s.index)).toEqual([1, 3, 4, 5]);
      expect(service.assignedTo('b.mp4').map((s) => s.index)).toEqual([2]);
      expect(service.assignedTo('c.mp4')).toEqual([]);
    });

    it('lists nothing for the empty path (unassigned slots) and before the first answer', async () => {
      expect(service.assignedTo('a.mp4')).toEqual([]);

      const refreshed = service.refresh();
      http.expectOne(SLOTS_URL).flush([slot(1), slot(2, { file: 'a.mp4' })]);
      await refreshed;
      expect(service.assignedTo('')).toEqual([]);
    });
  });
});
