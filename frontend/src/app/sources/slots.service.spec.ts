import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Slot } from '../api.generated';
import { FakeEventSources } from './jobs.testing';
import { SlotsService } from './slots.service';
import { fileSlot, job, pull, slot, slotList, webcamSlot } from './slots.testing';
import { ApiRequestError } from './stream-lines';

const SLOTS_URL = '/api/slots';
const RENDITIONS_URL = '/api/renditions';

/** The server's error shape, as a route answers a refusal. */
const refusal = (code: string, message: string) => ({ error: { code, message } });

const conflict = { status: 409, statusText: 'Conflict' };
const badGateway = { status: 502, statusText: 'Bad Gateway' };

/** Lets the promise chains behind a flushed request run (real timer: only intervals are faked). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve));

describe('SlotsService', () => {
  let http: HttpTestingController;
  let service: SlotsService;
  let sources: FakeEventSources;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    sources = new FakeEventSources();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), sources.provider()],
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

  /** Answers the pending fetch of the slots with these. */
  const answer = (...slots: Slot[]) => http.expectOne(SLOTS_URL).flush(slotList(slots));

  describe('polling', () => {
    it('asks nothing until watched, polls every 2 s while watched and visible, stops when the last watcher releases, and polls at once on becoming visible', async () => {
      vi.advanceTimersByTime(6000);
      http.expectNone(SLOTS_URL);
      expect(service.slots()).toBeNull();

      const first = service.watch();
      const second = service.watch();
      answer(slot(1));
      await tick();
      expect(service.slots()).toEqual([slot(1)]);

      vi.advanceTimersByTime(2000);
      answer(slot(1), slot(2));
      await tick();
      expect(service.slots()).toHaveLength(2);

      // One watcher is enough to keep polling.
      first();
      vi.advanceTimersByTime(2000);
      answer(slot(1));
      await tick();

      second();
      vi.advanceTimersByTime(10_000);
      http.expectNone(SLOTS_URL);

      // Releasing twice must not release somebody else's hold.
      const third = service.watch();
      answer(slot(1));
      await tick();
      second();
      vi.advanceTimersByTime(2000);
      answer(slot(1));
      await tick();

      setVisibility('hidden');
      vi.advanceTimersByTime(10_000);
      http.expectNone(SLOTS_URL);

      setVisibility('visible');
      answer(slot(1), slot(2), slot(3));
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

      pending.flush(slotList([slot(1)]));
      await tick();
      vi.advanceTimersByTime(2000);
      answer(slot(1));
      release();
    });

    it('keeps the last answer when a poll fails and asks again at the next tick', async () => {
      const release = service.watch();
      answer(fileSlot(1, 'a.mp4'));
      await tick();

      vi.advanceTimersByTime(2000);
      http.expectOne(SLOTS_URL).flush(refusal('mediamtx_unavailable', 'down'), badGateway);
      await tick();
      expect(service.slots()).toEqual([fileSlot(1, 'a.mp4')]);

      vi.advanceTimersByTime(2000);
      answer(slot(1));
      await tick();
      expect(service.slots()).toEqual([slot(1)]);
      release();
    });
  });

  describe('unavailable', () => {
    it('is set by a failed poll, keeps the last answer, and clears at the next success', async () => {
      const release = service.watch();
      answer(fileSlot(1, 'a.mp4'));
      await tick();
      expect(service.unavailable()).toBe(false);

      vi.advanceTimersByTime(2000);
      http.expectOne(SLOTS_URL).flush(refusal('x', 'down'), badGateway);
      await tick();
      expect(service.unavailable()).toBe(true);
      expect(service.slots()).toEqual([fileSlot(1, 'a.mp4')]);

      vi.advanceTimersByTime(2000);
      answer(slot(1));
      await tick();
      expect(service.unavailable()).toBe(false);
      expect(service.slots()).toEqual([slot(1)]);
      release();
    });

    it('is set by a failure before any answer, which leaves slots null', async () => {
      const refreshed = service.refresh();
      http.expectOne(SLOTS_URL).flush(refusal('x', 'down'), badGateway);
      await expect(refreshed).rejects.toMatchObject({ status: 502 });

      expect(service.unavailable()).toBe(true);
      expect(service.slots()).toBeNull();
    });

    it('is not set by an older request that fails after a newer one was sent', async () => {
      const older = service.refresh();
      const first = http.expectOne(SLOTS_URL);
      const newer = service.refresh();
      const second = http.expectOne(SLOTS_URL);

      second.flush(slotList([slot(1)]));
      first.flush(refusal('x', 'timeout'), { status: 504, statusText: 'Gateway Timeout' });
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
      answer(slot(1));
      await tick();
      expect(service.unavailable()).toBe(false);
      release();
    });
  });

  describe('recheck', () => {
    it('fetches the slots again before a question and says whether that worked, never rejecting', async () => {
      const answered = service.recheck();
      answer(fileSlot(3, 'a.mp4'));
      await expect(answered).resolves.toBe(true);
      expect(service.slots()?.[0].file).toBe('a.mp4');

      const failed = service.recheck();
      http.expectOne(SLOTS_URL).flush(refusal('x', 'MediaMTX is down'), badGateway);
      await expect(failed).resolves.toBe(false);
      // The last known slots stay for the question, which then says they may be out of date.
      expect(service.slots()?.[0].file).toBe('a.mp4');
    });
  });

  describe('refresh', () => {
    it('drops an answer older than the newest one', async () => {
      const older = service.refresh();
      const first = http.expectOne(SLOTS_URL);
      const newer = service.refresh();
      const second = http.expectOne(SLOTS_URL);

      second.flush(slotList([fileSlot(1, 'a.mp4', { run: true, state: 'live' })]));
      first.flush(slotList([fileSlot(1, 'a.mp4')]));
      await Promise.all([older, newer]);

      expect(service.slots()?.[0].state).toBe('live');
    });

    it('sends a request even while a poll is in flight, so what follows a change is never a poll started before it', async () => {
      const release = service.watch();
      const poll = http.expectOne(SLOTS_URL);

      const refreshed = service.refresh();
      const fresh = http.expectOne(SLOTS_URL);
      fresh.flush(slotList([fileSlot(1, 'new.mp4')]));
      poll.flush(slotList([fileSlot(1, 'old.mp4')]));
      await refreshed;

      expect(service.slots()?.[0].file).toBe('new.mp4');
      release();
    });

    it("rejects with the server's message when the request fails", async () => {
      const refreshed = service.refresh();
      http.expectOne(SLOTS_URL).flush(refusal('x', 'MediaMTX is down'), badGateway);

      await expect(refreshed).rejects.toMatchObject({ status: 502, message: 'MediaMTX is down' });
      expect(service.slots()).toBeNull();
    });
  });

  describe('actions', () => {
    /** Answers the refresh an action sends once it has settled. */
    const answerRefresh = async (...slots: Slot[]) => {
      await tick();
      answer(...(slots.length > 0 ? slots : [slot(1)]));
    };

    it('assignFile puts a file assignment, with its rate when one is set, and refreshes after success', async () => {
      const done = service.assignFile(3, 'a.mp4', 15);
      const request = http.expectOne(`${SLOTS_URL}/3`);
      expect(request.request.method).toBe('PUT');
      expect(request.request.body).toEqual({ kind: 'file', file: 'a.mp4', fps: 15 });
      request.flush(fileSlot(3, 'a.mp4', { fps: 15 }));
      await answerRefresh(fileSlot(3, 'a.mp4', { fps: 15 }));

      await expect(done).resolves.toEqual(fileSlot(3, 'a.mp4', { fps: 15 }));
      expect(service.slots()?.[0].file).toBe('a.mp4');

      // No rate is the file's own: the field is left out.
      const own = service.assignFile(3, 'a.mp4', null);
      const second = http.expectOne(`${SLOTS_URL}/3`);
      expect(second.request.body).toEqual({ kind: 'file', file: 'a.mp4' });
      second.flush(fileSlot(3, 'a.mp4'));
      await answerRefresh();
      await own;
    });

    it('assignPull and assignWebcam put their kinds; clear deletes the assignment', async () => {
      const cases: [() => Promise<unknown>, string, object | null][] = [
        [
          () => service.assignPull(4, { url: 'rtsp://cam/stream', username: 'u', password: 'p' }),
          'PUT',
          { kind: 'pull', url: 'rtsp://cam/stream', username: 'u', password: 'p' },
        ],
        [() => service.assignWebcam(4), 'PUT', { kind: 'webcam' }],
        [() => service.clear(4), 'DELETE', null],
      ];
      for (const [run, method, body] of cases) {
        const done = run();
        const request = http.expectOne(`${SLOTS_URL}/4`);
        expect(request.request.method).toBe(method);
        expect(request.request.body).toEqual(body);
        request.flush(slot(4));
        await answerRefresh();
        await done;
      }
    });

    it("refreshes after a refusal and rethrows the server's message and code", async () => {
      const done = service.start(2);
      http
        .expectOne(`${SLOTS_URL}/2/start`)
        .flush(refusal('slot_busy', 'src2 is in use by an external publisher (rtsp).'), conflict);
      await answerRefresh(slot(2, { state: 'external' }));

      await expect(done).rejects.toBeInstanceOf(ApiRequestError);
      await expect(done).rejects.toMatchObject({
        status: 409,
        code: 'slot_busy',
        message: 'src2 is in use by an external publisher (rtsp).',
      });
      expect(service.slots()?.[0].state).toBe('external');
    });

    it('does not show a poll answer that was already on its way when the action settled', async () => {
      const release = service.watch();
      const poll = http.expectOne(SLOTS_URL);

      const done = service.stop(1);
      http.expectOne(`${SLOTS_URL}/1/stop`).flush(fileSlot(1, 'a.mp4'));
      await tick();
      // The poll was sent before the stop finished: it may describe the slot as still live.
      const refresh = http.expectOne(SLOTS_URL);
      poll.flush(slotList([fileSlot(1, 'a.mp4', { run: true, state: 'live' })]));
      await tick();
      expect(service.slots()).toBeNull();

      refresh.flush(slotList([fileSlot(1, 'a.mp4')]));
      await done;
      expect(service.slots()?.[0].state).toBe('idle');
      release();
    });

    it("shows the answer to the newest action when two overlap, not the first one's", async () => {
      const first = service.stop(1);
      const second = service.assignFile(1, 'b.mp4');
      http.expectOne(`${SLOTS_URL}/1/stop`).flush(slot(1));
      await tick();
      // The stop settled, so its refresh is sent while the assign is still running.
      const afterStop = http.expectOne(SLOTS_URL);
      http.expectOne(`${SLOTS_URL}/1`).flush(fileSlot(1, 'b.mp4'));
      await tick();
      const afterAssign = http.expectOne(SLOTS_URL);

      afterAssign.flush(slotList([fileSlot(1, 'b.mp4')]));
      afterStop.flush(slotList([slot(1)]));
      await Promise.all([first, second]);

      expect(service.slots()?.[0].file).toBe('b.mp4');
    });

    it('start, stop and takeOver post to their slot; the bulk actions to theirs', async () => {
      const cases: [string, () => Promise<unknown>, object | null, object][] = [
        [`${SLOTS_URL}/1/start`, () => service.start(1), null, slot(1)],
        [`${SLOTS_URL}/1/stop`, () => service.stop(1), null, slot(1)],
        [`${SLOTS_URL}/5/take-over`, () => service.takeOver(5), null, slot(5)],
        [
          `${SLOTS_URL}/start`,
          () => service.startBulk(12),
          { count: 12 },
          { started: [1], already_running: [], skipped_external: [], errors: [] },
        ],
        [
          `${SLOTS_URL}/stop`,
          () => service.stopAll(),
          null,
          { stopped: [1], skipped_external: [] },
        ],
        [`${SLOTS_URL}/reset`, () => service.reset(), null, { stopped: [], skipped_external: [] }],
        [
          `${SLOTS_URL}/auto-assign`,
          () => service.autoAssign(),
          null,
          { assigned: 1, available: 1, skipped_external: [], skipped_pulled: [] },
        ],
      ];
      for (const [url, run, body, result] of cases) {
        const done = run();
        const request = http.expectOne(url);
        expect(request.request.method).toBe('POST');
        expect(request.request.body).toEqual(body);
        request.flush(result);
        await answerRefresh();
        await expect(done).resolves.toEqual(result);
      }
    });

    it('clearRenditions deletes them, returns what was removed and refreshes the usage', async () => {
      const done = service.clearRenditions();
      const request = http.expectOne(RENDITIONS_URL);
      expect(request.request.method).toBe('DELETE');
      request.flush({ removed: 2, freed_bytes: 4096, kept: 1 });
      await answerRefresh();
      http.expectOne(RENDITIONS_URL).flush({ count: 1, bytes: 100, in_use: 1 });

      await expect(done).resolves.toEqual({ removed: 2, freed_bytes: 4096, kept: 1 });
      expect(service.renditions()).toEqual({ count: 1, bytes: 100, in_use: 1 });
    });

    it('does not report the action as failed when only the refresh after it fails', async () => {
      const done = service.stopAll();
      http.expectOne(`${SLOTS_URL}/stop`).flush({ stopped: [1, 2, 3], skipped_external: [] });
      await tick();
      http.expectOne(SLOTS_URL).flush(refusal('x', 'down'), badGateway);

      await expect(done).resolves.toMatchObject({ stopped: [1, 2, 3] });
    });
  });

  describe('encodes', () => {
    const preparing = (id = 'job-1') =>
      fileSlot(2, 'a.mp4', { fps: 15, run: true, state: 'preparing', job: id });

    it('follows the job of a preparing slot and shows how far its encode has got', async () => {
      const refreshed = service.refresh();
      answer(preparing());
      await refreshed;

      // Before its first event, the encode shows as just begun.
      expect(service.encodes().get(2)).toEqual({
        title: 'Encoding rendition…',
        detail: '',
        percent: null,
      });
      const source = sources.of('job-1')!;
      source.send(job({ progress: { phase: 'encode', detail: '00:03 / 00:10', percent: 30.5 } }));
      expect(service.encodes().get(2)).toEqual({
        title: 'Encoding rendition…',
        detail: '00:03 / 00:10',
        percent: 30,
      });
    });

    it('follows each job once however many answers show it, and lets go when no slot shows it', async () => {
      const release = service.watch();
      answer(preparing());
      await tick();
      vi.advanceTimersByTime(2000);
      answer(preparing());
      await tick();
      expect(sources.opened).toHaveLength(1);

      vi.advanceTimersByTime(2000);
      answer(fileSlot(2, 'a.mp4', { fps: 15, run: true, state: 'live' }));
      await tick();
      expect(sources.opened[0].closed).toBe(true);
      expect(service.encodes().size).toBe(0);
      release();
    });

    it('fetches the slots and the rendition usage again when the job ends', async () => {
      const refreshed = service.refresh();
      answer(preparing());
      await refreshed;

      sources.of('job-1')!.send(job({ state: 'done', result: { rendition: '.renditions/a.mp4' } }));
      answer(fileSlot(2, 'a.mp4', { fps: 15, run: true, state: 'starting' }));
      http.expectOne(RENDITIONS_URL).flush({ count: 1, bytes: 10, in_use: 1 });
      await tick();
      expect(service.renditions()).toEqual({ count: 1, bytes: 10, in_use: 1 });
      expect(service.encodes().size).toBe(0);
    });

    it('does not follow a job again whose stream failed, while a slot still shows it', async () => {
      const release = service.watch();
      answer(preparing());
      await tick();
      sources.of('job-1')!.fail();

      vi.advanceTimersByTime(2000);
      answer(preparing());
      await tick();
      expect(sources.opened).toHaveLength(1);
      // The slot still says it prepares.
      expect(service.encodes().get(2)?.title).toBe('Encoding rendition…');
      release();
    });
  });

  describe('assignedTo', () => {
    it('lists the slots assigned to a file in any state', async () => {
      const refreshed = service.refresh();
      answer(
        fileSlot(1, 'a.mp4', { run: true, state: 'live' }),
        fileSlot(2, 'b.mp4', { run: true, state: 'live' }),
        fileSlot(3, 'a.mp4'),
        fileSlot(5, 'a.mp4', { state: 'external' }),
        webcamSlot(6),
        slot(7, { kind: 'pull', pull: pull() }),
        slot(8),
      );
      await refreshed;

      expect(service.assignedTo('a.mp4').map((s) => s.n)).toEqual([1, 3, 5]);
      expect(service.assignedTo('b.mp4').map((s) => s.n)).toEqual([2]);
      expect(service.assignedTo('c.mp4')).toEqual([]);
    });

    it('lists nothing before the first answer, or for the empty path', async () => {
      expect(service.assignedTo('a.mp4')).toEqual([]);

      const refreshed = service.refresh();
      answer(slot(1), fileSlot(2, 'a.mp4'));
      await refreshed;
      expect(service.assignedTo('')).toEqual([]);
    });
  });

  describe('assignedUnder', () => {
    it('lists the slots assigned to a file anywhere in a folder, in number order', async () => {
      const refreshed = service.refresh();
      answer(
        fileSlot(1, 'clips/a.mp4', { run: true, state: 'live' }),
        fileSlot(2, 'clips/deep/b.mp4'),
        fileSlot(3, 'clips.mp4'),
        fileSlot(4, 'clips2/c.mp4'),
        fileSlot(5, 'other/clips/d.mp4'),
        slot(6),
      );
      await refreshed;

      expect(service.assignedUnder('clips').map((s) => s.n)).toEqual([1, 2]);
      expect(service.assignedUnder('clips/deep').map((s) => s.n)).toEqual([2]);
      expect(service.assignedUnder('none')).toEqual([]);
    });
  });
});
