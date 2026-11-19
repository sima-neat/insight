import { BoardProblem, problemOf } from '../board/board-error';
import type { PreviewSession } from './api';
import { resolveSelection } from './camera-modes';
import { imx477, imx568, previewSession, sel } from './cameras.testing';
import {
  adoptedSelection,
  type CameraSelection,
  nextPreviewState,
  PREVIEW_IDLE,
  type PreviewEvent,
  previewNeedsRestart,
  type PreviewStartDeps,
  previewStatus,
  previewStatusEvent,
  previewStreamUrl,
  type PreviewTimer,
  restartSelection,
  runPreviewStart,
  sessionMatches,
  sessionToAdopt,
  startSuperseded,
  streamEndedEvent,
  streamErrorEvent,
  watchPreview,
} from './preview-state';

// The reads take `CameraPreview.current()`, the one reader of the board's preview, so they answer
// the session itself; the watch is paced by a timer the test fires.

const liveSession = previewSession();
/** The board of `liveSession`, and another one. */
const BOARD = liveSession.board;
const OTHER_BOARD = 'ssh:sima@10.0.0.9:22';

/** A failure as the preview shows it. */
const problem = (message: string, code = ''): BoardProblem => new BoardProblem(message, code, '');

/** Lets the promise chains behind an answer run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

/** A watch's timer that ticks only when the test fires it. */
function manualTimer() {
  let tick: (() => void) | null = null;
  const timer: PreviewTimer = {
    start: (next) => {
      tick = next;
    },
    stop: () => {
      tick = null;
    },
  };
  return {
    timer,
    get running() {
      return tick !== null;
    },
    async fire() {
      tick?.();
      await settle();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

describe('preview state', () => {
  it('preview transitions: start, live, stop', () => {
    const starting = nextPreviewState(PREVIEW_IDLE, { type: 'start' });
    expect(starting).toEqual({ status: 'starting', session: null, error: null });
    expect(previewStatus(starting).label).toBe('Starting…');

    const live = nextPreviewState(starting, { type: 'session', session: liveSession });
    expect(live.status).toBe('live');
    expect(live.session?.id).toBe('8f1c');
    expect(previewStatus(live).label).toBe('Live');

    const stopping = nextPreviewState(live, { type: 'stopping', for: '8f1c' });
    expect(stopping.status).toBe('stopping');
    // The session stays on screen while the board stops.
    expect(stopping.session?.id).toBe('8f1c');
    expect(nextPreviewState(stopping, { type: 'stopped', for: '8f1c' })).toEqual(PREVIEW_IDLE);

    // No session in a start's answer ends the preview too.
    expect(nextPreviewState(live, { type: 'session', session: null })).toEqual(PREVIEW_IDLE);
  });

  it('preview transitions: a start that was never adopted still releases the page', () => {
    // Selecting another camera mid-start: the response belongs to the old camera, so the page stops
    // that session instead of adopting it. Those events carry an id the page never held.
    const starting = nextPreviewState(PREVIEW_IDLE, { type: 'start' });
    expect(starting.status).toBe('starting');
    expect(starting.session).toBeNull();
    const stopping = nextPreviewState(starting, { type: 'stopping', for: 'never-adopted' });
    expect(stopping.status).toBe('stopping');
    const stopped = nextPreviewState(stopping, { type: 'stopped', for: 'never-adopted' });
    expect(stopped).toEqual(PREVIEW_IDLE);
  });

  it('preview transitions: a late event from the previous preview leaves a new start alone', () => {
    // The previous preview's stream check answers after the user started the next one.
    const starting = nextPreviewState(PREVIEW_IDLE, { type: 'start' });
    expect(nextPreviewState(starting, streamEndedEvent('previous'))).toBe(starting);
    expect(
      nextPreviewState(starting, { type: 'failed', for: 'previous', error: problem('boom') }),
    ).toBe(starting);
    expect(
      nextPreviewState(starting, { type: 'elsewhere', for: 'previous', session: liveSession }),
    ).toBe(starting);
    // The new start's answer is still shown.
    expect(nextPreviewState(starting, { type: 'session', session: liveSession }).status).toBe(
      'live',
    );
  });

  it('preview transitions: a stale session id never disturbs a newer one', () => {
    const live = nextPreviewState(nextPreviewState(PREVIEW_IDLE, { type: 'start' }), {
      type: 'session',
      session: liveSession,
    });
    expect(nextPreviewState(live, streamEndedEvent('old-id'))).toBe(live);
    expect(nextPreviewState(live, { type: 'stopped', for: 'old-id' })).toBe(live);
    expect(nextPreviewState(live, { type: 'stopping', for: 'old-id' })).toBe(live);
    expect(nextPreviewState(live, { type: 'failed', for: 'old-id', error: problem('boom') })).toBe(
      live,
    );
    expect(
      nextPreviewState(live, { type: 'session', session: { ...liveSession, id: 'other' } }),
    ).toBe(live);

    const ended = nextPreviewState(live, streamEndedEvent('8f1c'));
    expect(ended.status).toBe('idle');
    expect(ended.session).toBeNull();
    expect(ended.error?.message).toBe('The preview stream stopped.');
    // A stopped stream always offers a way back.
    expect(ended.error?.hint).toBeTruthy();
  });

  it("a live preview's status read ends it once the board no longer runs this session", async () => {
    const live = nextPreviewState(nextPreviewState(PREVIEW_IDLE, { type: 'start' }), {
      type: 'session',
      session: liveSession,
    });
    let reads = 0;
    const reply = (session: PreviewSession | null) => async () => {
      reads++;
      return session;
    };

    // Still the board's current session: nothing changes.
    expect(await previewStatusEvent(reply(liveSession), '8f1c')).toBeNull();
    expect(reads).toBe(1);

    // No session, or another session: the stream is over.
    for (const session of [null, { ...liveSession, id: 'other' }]) {
      const event = await previewStatusEvent(reply(session), '8f1c');
      expect(event, JSON.stringify(session)).toEqual(streamEndedEvent('8f1c'));
      const ended = nextPreviewState(live, event!);
      expect(ended.status).toBe('idle');
      expect(ended.error?.code).toBe('stream_ended');
    }

    // A read that fails proves nothing about the stream.
    expect(
      await previewStatusEvent(async () => {
        throw new Error('network');
      }, '8f1c'),
    ).toBeNull();
  });

  it('a restart starts the mode selected once its stop finished, not the one selected before it', () => {
    const b: CameraSelection = { id: 'camera:a', format: 'MJPG', width: 640, height: 480, fps: 30 };
    const c: CameraSelection = { ...b, width: 1280, height: 720 };
    const requested = { cameraId: 'camera:a', board: BOARD };
    // Mode C was picked while the stop for the switch to B ran.
    expect(
      restartSelection(requested, { cameraId: 'camera:a', board: BOARD, selection: c }),
    ).toEqual(c);
    // Another camera or board meanwhile: nothing is started.
    expect(
      restartSelection(requested, {
        cameraId: 'camera:b',
        board: BOARD,
        selection: { ...c, id: 'camera:b' },
      }),
    ).toBeNull();
    expect(
      restartSelection(requested, { cameraId: 'camera:a', board: OTHER_BOARD, selection: c }),
    ).toBeNull();
    expect(
      restartSelection(requested, { cameraId: 'camera:a', board: BOARD, selection: null }),
    ).toBeNull();
  });

  it('every step of a start that resumes after an await acts only for the view read at that step', async () => {
    const a: CameraSelection = { id: 'camera:a', format: 'MJPG', width: 640, height: 480, fps: 30 };
    const b: CameraSelection = { ...a, width: 1280, height: 720 };
    const c: CameraSelection = { ...a, width: 1920, height: 1080 };
    const sessionFor = (mode: CameraSelection): PreviewSession =>
      previewSession({
        id: 's1',
        camera: 'camera:a',
        board: BOARD,
        mode: { format: mode.format, width: mode.width, height: mode.height, fps: mode.fps },
      });
    // A page whose selection the test changes while a request is in flight.
    function page(selection: CameraSelection) {
      const log: [string, string | number][] = [];
      const current = { cameraId: 'camera:a', board: BOARD, selection };
      const deps: Omit<PreviewStartDeps, 'post' | 'lookup'> = {
        dispatch: (event) => log.push(['dispatch', event.type]),
        adopt: (session) => {
          log.push(['adopt', session.id]);
          return true;
        },
        start: (mode) => log.push(['start', mode.width]),
        stop: async (session) => {
          log.push(['stop', session.id]);
          return true;
        },
        view: () => ({ ...current }),
        normalize: problemOf,
        reloadBoard: () => log.push(['reload', 'board']),
      };
      return { log, current, deps };
    }
    const requested = { cameraId: 'camera:a', board: BOARD, mode: a };
    const refused = async (): Promise<PreviewSession> => {
      throw { code: 'preview_active', message: 'busy' };
    };
    const startedA = async () => sessionFor(a);

    // A refused start looks up the preview another tab runs; B is picked during that look-up, so the
    // other tab's session is not adopted (which would switch the menus back) and the pane resets.
    let p = page(a);
    await runPreviewStart(requested, {
      ...p.deps,
      post: refused,
      lookup: async () => {
        p.current.selection = b;
        return sessionFor(a);
      },
    });
    expect(p.log).toEqual([
      ['dispatch', 'start'],
      ['dispatch', 'reset'],
    ]);

    // Unchanged during the look-up: the running preview is adopted.
    p = page(a);
    await runPreviewStart(requested, {
      ...p.deps,
      post: refused,
      lookup: async () => sessionFor(a),
    });
    expect(p.log).toEqual([
      ['dispatch', 'start'],
      ['adopt', 's1'],
    ]);

    // A running preview the page cannot show (its camera is not listed) is not taken up: the
    // refusal shows, with the camera it names.
    p = page(a);
    await runPreviewStart(requested, {
      ...p.deps,
      post: refused,
      lookup: async () => sessionFor(a),
      adopt: (session) => {
        p.log.push(['adopt', session.id]);
        return false;
      },
    });
    expect(p.log).toEqual([
      ['dispatch', 'start'],
      ['adopt', 's1'],
      ['dispatch', 'failed'],
    ]);

    // A start for A answers after B was picked, so it is stopped; C is picked during that stop, so C is
    // started, not B.
    p = page(b);
    await runPreviewStart(requested, {
      ...p.deps,
      post: startedA,
      lookup: async () => null,
      stop: async (session) => {
        p.log.push(['stop', session.id]);
        p.current.selection = c;
        return true;
      },
    });
    expect(p.log).toEqual([
      ['dispatch', 'start'],
      ['stop', 's1'],
      ['start', 1920],
    ]);

    // The camera changed during that stop: nothing is started.
    p = page(b);
    await runPreviewStart(requested, {
      ...p.deps,
      post: startedA,
      lookup: async () => null,
      stop: async () => {
        p.current.cameraId = 'camera:b';
        p.current.selection = { ...c, id: 'camera:b' };
        return true;
      },
    });
    expect(p.log).toEqual([
      ['dispatch', 'start'],
      ['dispatch', 'reset'],
    ]);

    // Nothing changed: the session is shown.
    p = page(a);
    await runPreviewStart(requested, { ...p.deps, post: startedA, lookup: async () => null });
    expect(p.log).toEqual([
      ['dispatch', 'start'],
      ['dispatch', 'session'],
    ]);
  });

  it('a start answered after the board changed is stopped, not restarted on the new board', async () => {
    const mode: CameraSelection = { id: imx477.id, ...sel('NV12', 1920, 1080, 30) };
    const log: [string, string | number][] = [];
    let board = BOARD;
    await runPreviewStart(
      { cameraId: imx477.id, board: BOARD, mode },
      {
        post: async () => {
          board = OTHER_BOARD;
          return previewSession({ id: 's4' });
        },
        lookup: async () => null,
        stop: async (session) => {
          log.push(['stop', session.id]);
          return true;
        },
        start: (next) => log.push(['start', next.width]),
        adopt: (session) => {
          log.push(['adopt', session.id]);
          return true;
        },
        dispatch: (event) => log.push(['dispatch', event.type]),
        view: () => ({ cameraId: imx477.id, board, selection: mode }),
        normalize: problemOf,
        reloadBoard: () => log.push(['reload', 'board']),
      },
    );
    expect(log).toEqual([
      ['dispatch', 'start'],
      ['stop', 's4'],
      ['dispatch', 'reset'],
    ]);
  });

  it('a start refused because its board is no longer selected reads the boards again', async () => {
    const mode: CameraSelection = { id: imx477.id, ...sel('NV12', 1920, 1080, 30) };
    const log: [string, string | number][] = [];
    await runPreviewStart(
      { cameraId: imx477.id, board: BOARD, mode },
      {
        post: async () => {
          throw problem('Not the selected board.', 'not_found');
        },
        lookup: async () => null,
        stop: async () => true,
        start: () => undefined,
        adopt: () => true,
        dispatch: (event) => log.push(['dispatch', event.type]),
        view: () => ({ cameraId: imx477.id, board: BOARD, selection: mode }),
        normalize: problemOf,
        reloadBoard: () => log.push(['reload', 'board']),
      },
    );
    expect(log).toEqual([
      ['dispatch', 'start'],
      ['reload', 'board'],
      ['dispatch', 'failed'],
    ]);
  });

  it('a failed Stop of a preview shown in another tab keeps it there, with the failure', () => {
    const elsewhere = nextPreviewState(PREVIEW_IDLE, {
      type: 'adopt',
      session: { ...liveSession, viewer: true },
    });
    const stopping = nextPreviewState(elsewhere, { type: 'stopping', for: liveSession.id });
    const failed = nextPreviewState(stopping, {
      type: 'stop-failed',
      for: liveSession.id,
      from: 'elsewhere',
      error: problem('SSH failed'),
    });
    expect(failed.status).toBe('elsewhere');
    expect(failed.session?.id).toBe(liveSession.id);
    expect(failed.error?.message).toBe('SSH failed');
  });

  it('a start is superseded once the camera, board, or mode it was sent for is no longer the one shown', () => {
    const mode = { format: 'MJPG', width: 640, height: 480, fps: 30 };
    const requested = { cameraId: 'camera:a', board: BOARD, mode: { id: 'camera:a', ...mode } };
    const latest = { cameraId: 'camera:a', board: BOARD, selection: { id: 'camera:a', ...mode } };
    expect(startSuperseded(requested, latest)).toBe(false);
    expect(startSuperseded(requested, { ...latest, cameraId: 'camera:b' })).toBe(true);
    expect(startSuperseded(requested, { ...latest, board: OTHER_BOARD })).toBe(true);
    expect(
      startSuperseded(requested, { ...latest, selection: { ...latest.selection, fps: 15 } }),
    ).toBe(true);
    expect(startSuperseded(requested, { ...latest, selection: null })).toBe(true);
    // An unknown board compares on camera and mode alone.
    expect(startSuperseded({ ...requested, board: null }, latest)).toBe(false);
  });

  it('a stream refused because another tab claimed it first shows the preview there, not as ended', async () => {
    // Both tabs found the session unclaimed and went live; the backend gave the stream to the other tab.
    const live = nextPreviewState(PREVIEW_IDLE, {
      type: 'adopt',
      session: { ...liveSession, viewer: false },
    });
    expect(live.status).toBe('live');
    const reply = (session: PreviewSession | null) => async () => session;

    const claimed = { ...liveSession, viewer: true };
    const refused = await streamErrorEvent(reply(claimed), '8f1c');
    const shown = nextPreviewState(live, refused);
    expect(shown.status).toBe('elsewhere');
    expect(shown.error).toBeNull();
    expect(shown.session?.id).toBe('8f1c');

    // Nobody holds it, it is gone, another session runs, or the read failed: the stream is over.
    for (const request of [
      reply({ ...liveSession, viewer: false }),
      reply(null),
      reply({ ...claimed, id: 'other' }),
      async (): Promise<PreviewSession | null> => {
        throw new Error('network');
      },
    ]) {
      const event = await streamErrorEvent(request, '8f1c');
      expect(event).toEqual(streamEndedEvent('8f1c'));
      expect(nextPreviewState(live, event).error?.code).toBe('stream_ended');
    }

    // Only a live pane moves: a Stop in progress or a newer session is left alone.
    const stopping = nextPreviewState(live, { type: 'stopping', for: '8f1c' });
    expect(nextPreviewState(stopping, refused)).toBe(stopping);
    expect(nextPreviewState(live, { ...refused, for: 'older' })).toBe(live);
  });

  it('a watched live preview is read until the backend no longer runs it, and cancelling stops the reads', async () => {
    const replies: (PreviewSession | null)[] = [liveSession, liveSession, null];
    let reads = 0;
    const read = async () => {
      reads++;
      return replies.shift() ?? null;
    };
    const events: PreviewEvent[] = [];
    const clock = manualTimer();
    watchPreview(read, '8f1c', (event) => events.push(event), clock.timer);
    expect(clock.running).toBe(true);
    for (let i = 0; i < 3; i++) await clock.fire();
    expect(events).toEqual([streamEndedEvent('8f1c')]);
    expect(reads).toBe(3);
    // Reading stops once the preview ended.
    expect(clock.running).toBe(false);
    await clock.fire();
    expect(reads).toBe(3);

    let count = 0;
    const idle = manualTimer();
    const cancel = watchPreview(
      async () => {
        count += 1;
        return null;
      },
      '8f1c',
      (event) => events.push(event),
      idle.timer,
    );
    cancel();
    await idle.fire();
    expect(count).toBe(0);
    expect(idle.running).toBe(false);
    expect(events.length).toBe(1);

    // Cancelled while a read is in flight: its answer is dropped. A tick while it is out sends no
    // second read.
    const answer = deferred<PreviewSession | null>();
    let slowReads = 0;
    const slowClock = manualTimer();
    const slow = watchPreview(
      () => {
        slowReads++;
        return answer.promise;
      },
      '8f1c',
      (event) => events.push(event),
      slowClock.timer,
    );
    await slowClock.fire();
    await slowClock.fire();
    expect(slowReads).toBe(1);
    slow();
    answer.resolve(null);
    await settle();
    expect(events.length).toBe(1);
  });

  it("a live preview's status read passes on the camera's rate once the backend knows it", async () => {
    const live = nextPreviewState(nextPreviewState(PREVIEW_IDLE, { type: 'start' }), {
      type: 'session',
      session: liveSession,
    });
    const reply = (session: PreviewSession | null) => async () => session;
    // Unknown (a MIPI sensor before Sentinel answers, or one it could not read): nothing to pass on.
    expect(
      await previewStatusEvent(reply({ ...liveSession, camera_fps: null }), '8f1c'),
    ).toBeNull();
    const event = await previewStatusEvent(reply({ ...liveSession, camera_fps: 66.18 }), '8f1c');
    expect(event).toEqual({ type: 'camera-fps', for: '8f1c', fps: 66.18 });
    if (!event) throw new Error('the rate was not passed on');
    const known = nextPreviewState(live, event);
    expect(known.status).toBe('live');
    expect(known.session?.camera_fps).toBe(66.18);
    expect(known.session?.id).toBe(liveSession.id);
    // An unchanged rate keeps the state.
    expect(nextPreviewState(known, event)).toBe(known);
    // Another session's rate is ignored.
    expect(nextPreviewState(live, { ...event, for: 'other' })).toBe(live);
    expect(nextPreviewState(PREVIEW_IDLE, event)).toBe(PREVIEW_IDLE);

    // Reading goes on after the rate arrives, until the preview ends.
    const replies: (PreviewSession | null)[] = [
      liveSession,
      { ...liveSession, camera_fps: 66.18 },
      null,
    ];
    const events: PreviewEvent[] = [];
    const clock = manualTimer();
    watchPreview(
      async () => replies.shift() ?? null,
      '8f1c',
      (e) => events.push(e),
      clock.timer,
    );
    for (let i = 0; i < 3; i++) await clock.fire();
    expect(events).toEqual([event, streamEndedEvent('8f1c')]);
  });

  it('preview transitions: failures, reset, and adopting an existing session', () => {
    const starting = nextPreviewState(PREVIEW_IDLE, { type: 'start' });
    const failed = nextPreviewState(starting, {
      type: 'failed',
      error: problem('Camera in use', 'camera_in_use'),
    });
    expect(failed.status).toBe('error');
    expect(previewStatus(failed).label).toBe('Could not start');
    // A late response from the failed attempt must not put the pane back in "live".
    expect(nextPreviewState(failed, { type: 'session', session: liveSession })).toBe(failed);
    expect(nextPreviewState(failed, { type: 'reset' })).toEqual(PREVIEW_IDLE);

    const adopted = nextPreviewState(PREVIEW_IDLE, { type: 'adopt', session: liveSession });
    expect(adopted.status).toBe('live');
    expect(adopted.session).toBe(liveSession);
    expect(nextPreviewState(PREVIEW_IDLE, { type: 'adopt', session: null })).toEqual(PREVIEW_IDLE);

    // A session another page already shows (its one viewer) is not opened here: the pane offers Stop.
    const shown = { ...liveSession, viewer: true };
    const elsewhere = nextPreviewState(PREVIEW_IDLE, { type: 'adopt', session: shown });
    expect(elsewhere.status).toBe('elsewhere');
    expect(previewStatus(elsewhere).label).toBe('In another tab');
    expect(nextPreviewState(elsewhere, { type: 'session', session: shown }).status).toBe(
      'elsewhere',
    );
    expect(nextPreviewState(elsewhere, streamEndedEvent(liveSession.id))).toEqual(PREVIEW_IDLE);
    expect(nextPreviewState(elsewhere, { type: 'stopping', for: liveSession.id }).status).toBe(
      'stopping',
    );

    const live = nextPreviewState(starting, { type: 'session', session: liveSession });
    // Stop closes the stream, so its end can arrive before the stop's own answer: that is the stop, not a failure,
    // and the stop's answer afterwards changes nothing.
    const stoppingLive = nextPreviewState(live, { type: 'stopping', for: liveSession.id });
    expect(previewStatus(stoppingLive).label).toBe('Stopping…');
    const endedByStop = nextPreviewState(stoppingLive, streamEndedEvent(liveSession.id));
    expect(endedByStop).toEqual(PREVIEW_IDLE);
    expect(nextPreviewState(endedByStop, { type: 'stopped', for: liveSession.id })).toEqual(
      PREVIEW_IDLE,
    );
    const stopping = nextPreviewState(starting, {
      type: 'stopping',
      for: liveSession.id,
      session: liveSession,
    });
    const stopFailed = nextPreviewState(stopping, {
      type: 'stop-failed',
      for: liveSession.id,
      from: 'live',
      error: problem('SSH failed'),
    });
    expect(stopFailed.status).toBe('live');
    expect(stopFailed.session?.id).toBe(liveSession.id);
    expect(stopFailed.error?.message).toBe('SSH failed');
    expect(previewStatus(PREVIEW_IDLE)).toEqual({ label: 'Not running', tone: 'neutral' });
  });

  it('a session belongs to the camera and board it was started for', () => {
    expect(sessionMatches(liveSession, imx477.id, BOARD)).toBe(true);
    expect(sessionMatches(liveSession, imx477.id, BOARD, liveSession.mode)).toBe(true);
    expect(sessionMatches(liveSession, imx477.id, BOARD, { ...liveSession.mode, fps: 60 })).toBe(
      false,
    );
    expect(sessionMatches(liveSession, imx477.id, OTHER_BOARD)).toBe(false);
    expect(sessionMatches(liveSession, imx568.id, BOARD)).toBe(false);
    expect(sessionMatches(liveSession, imx477.id)).toBe(true);
    expect(sessionMatches(null, imx477.id, BOARD)).toBe(false);
  });

  it("the preview stream is the board's preview route, naming the camera and the preview", () => {
    expect(previewStreamUrl(liveSession)).toBe(
      `/api/boards/${encodeURIComponent(BOARD)}/cameras/${encodeURIComponent(imx477.id)}/preview.mjpg?preview=8f1c`,
    );
    // An id or a camera that is not a plain word stays inside its path segment or parameter.
    expect(previewStreamUrl({ ...liveSession, camera: '../stop', id: 'a&b' })).toBe(
      `/api/boards/${encodeURIComponent(BOARD)}/cameras/..%2Fstop/preview.mjpg?preview=a%26b`,
    );
    expect(previewStreamUrl(null)).toBeNull();
  });

  it('an adopted preview selects the camera and the mode it streams, not the defaults', () => {
    const session = previewSession({
      id: 's1',
      camera: imx477.id,
      mode: sel('NV12', 1920, 1080, 60),
    });
    const wanted = adoptedSelection(session);
    expect(wanted).toEqual({ id: imx477.id, format: 'NV12', width: 1920, height: 1080, fps: 60 });
    expect(resolveSelection(imx477, wanted)).toEqual(session.mode);
    expect(adoptedSelection({ ...session, camera: '' })).toBeNull();
  });

  it('a start refused because another tab started a preview adopts that preview', () => {
    const session = previewSession({
      id: 's1',
      camera: imx477.id,
      mode: sel('NV12', 1920, 1080, 60),
    });
    const active = problem('A preview is already running.', 'preview_active');
    expect(sessionToAdopt(active, session)).toBe(session);
    const adopted = nextPreviewState(nextPreviewState(PREVIEW_IDLE, { type: 'start' }), {
      type: 'adopt',
      session: sessionToAdopt(active, session),
    });
    // The pane shows its video and Stop.
    expect(adopted).toEqual({ status: 'live', session, error: null });
    // Nothing to adopt: the other preview already stopped, or the start failed for another reason.
    expect(sessionToAdopt(active, null)).toBeNull();
    expect(sessionToAdopt(problem('busy', 'camera_in_use'), session)).toBeNull();
  });

  it('changing the mode restarts a preview, but only the one it belongs to', () => {
    const mode = sel('NV12', 1920, 1080, 30);
    const session = previewSession({ id: 's1', camera: 'cam-a', mode });
    const live = { status: 'live' as const, session, error: null };
    // A different rate needs a restart.
    expect(previewNeedsRestart(live, 'cam-a', { ...mode, fps: 60 })).toBe(true);
    expect(previewNeedsRestart(live, 'cam-a', { ...mode, width: 1280, height: 720 })).toBe(true);
    expect(previewNeedsRestart(live, 'cam-a', { ...mode, format: 'RGB888' })).toBe(true);
    // Re-selecting the mode it is already streaming must not interrupt the picture.
    expect(previewNeedsRestart(live, 'cam-a', { ...mode })).toBe(false);
    // A preview belongs to one camera; another camera's menus must not touch it.
    expect(previewNeedsRestart(live, 'cam-b', { ...mode, fps: 60 })).toBe(false);
    expect(
      previewNeedsRestart({ status: 'starting', session, error: null }, 'cam-a', {
        ...mode,
        fps: 60,
      }),
    ).toBe(true);
    expect(previewNeedsRestart(PREVIEW_IDLE, 'cam-a', { ...mode, fps: 60 })).toBe(false);
    expect(
      previewNeedsRestart({ status: 'stopping', session, error: null }, 'cam-a', {
        ...mode,
        fps: 60,
      }),
    ).toBe(false);
    expect(previewNeedsRestart(live, 'cam-a', null)).toBe(false);
  });
});
