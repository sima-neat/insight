import {
  camerasFromDevices,
  closeAllWebcamSessions,
  closeWebcamSession,
  confirmWebcamPublishing,
  createDisconnectWatcher,
  describeWebcamError,
  pinH264,
  publishWebcamOffer,
  recordWebcamStopsOnExit,
  resolveDeleteUrl,
  selectH264Codecs,
  sessionIdFromResponse,
  type ClosableSession,
  type DeviceInfo,
  type WhipResponse,
} from './webcam-publishing';

// These are the 40 tests of #170's `webcamPublishing.test.js` (node:test) with their assertions
// unchanged: only the harness differs (Vitest's `expect`, and types where the original was plain
// JavaScript).

/** What a `publishWebcamOffer` call needs of a peer connection; this one fails on waiting for gathering. */
function fakePeerConnection(overrides: object = {}) {
  return {
    iceGatheringState: 'new',
    localDescription: null as { sdp: string } | null,
    async createOffer(): Promise<RTCSessionDescriptionInit> {
      return { type: 'offer', sdp: 'v=0\r\n' };
    },
    async setLocalDescription(offer: RTCSessionDescriptionInit): Promise<void> {
      this.localDescription = { sdp: offer.sdp ?? '' };
      this.iceGatheringState = 'gathering';
    },
    addEventListener() {
      throw new Error('must not wait for gathering; it blocks on the STUN server');
    },
    ...overrides,
  };
}

function response({
  ok = true,
  status = 201,
  body = 'v=0\r\n',
  location = null,
  id = null,
}: {
  ok?: boolean;
  status?: number;
  body?: string;
  location?: string | null;
  id?: string | null;
} = {}): WhipResponse {
  return {
    ok,
    status,
    headers: { get: (name) => (name === 'Location' ? location : name === 'Id' ? id : null) },
    async text() {
      return body;
    },
  };
}

/** The error a promise rejected with; fails the test when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('webcam publishing', () => {
  it('the webcam offer is posted without waiting for candidate gathering', async () => {
    const peerConnection = fakePeerConnection();
    let request:
      | { url: string; options: { method: string; headers: Record<string, string>; body: string } }
      | undefined;

    const { answerSdp } = await publishWebcamOffer(
      peerConnection,
      'https://insight.local:8889/cam1/whip',
      async (url, options) => {
        request = { url, options };
        return response({ body: 'v=0\r\nanswer' });
      },
    );

    expect(request!.url).toBe('https://insight.local:8889/cam1/whip');
    expect(request!.options.method).toBe('POST');
    expect(request!.options.headers['Content-Type']).toBe('application/sdp');
    expect(request!.options.body).toBe('v=0\r\n');
    expect(peerConnection.iceGatheringState).toBe('gathering'); // posted before gathering finished
    expect(answerSdp).toBe('v=0\r\nanswer');
  });

  it('a rejected publish reports the HTTP status', async () => {
    const error = (await rejection(
      publishWebcamOffer(fakePeerConnection(), 'https://insight.local:8889/cam1/whip', async () =>
        response({ ok: false, status: 400 }),
      ),
    )) as Error & { status: number };

    expect(error.message).toMatch(/HTTP 400/);
    expect(error.status).toBe(400);
  });

  it("a transport failure reports actionable setup guidance, not 'Failed to fetch'", async () => {
    // fetch throws a TypeError when the endpoint is unreachable or its certificate
    // is rejected; the raw browser message ("Failed to fetch") is useless, so the
    // publish must surface something the user can act on (#120).
    const error = (await rejection(
      publishWebcamOffer(fakePeerConnection(), 'https://insight.local:8889/cam1/whip', async () => {
        throw new TypeError('Failed to fetch');
      }),
    )) as Error & { transport: boolean };

    expect(error.transport).toBe(true);
    expect(error.message).toMatch(/certificate is trusted/);
    expect(error.message).toMatch(/reachable/);
    expect(error.message).not.toMatch(/Failed to fetch/);
  });

  it('the session delete URL is resolved against the publish URL', async () => {
    const { deleteUrl } = await publishWebcamOffer(
      fakePeerConnection(),
      'https://insight.local:8889/cam1/whip',
      async () => response({ location: '/cam1/whip/session/abc123' }),
    );

    expect(deleteUrl).toBe('https://insight.local:8889/cam1/whip/session/abc123');
  });

  it('a missing Location does not fail the publish', async () => {
    const { deleteUrl, answerSdp } = await publishWebcamOffer(
      fakePeerConnection(),
      'https://insight.local:8889/cam1/whip',
      async () => response({ location: null, body: 'v=0\r\nanswer' }),
    );

    expect(deleteUrl).toBe(null);
    expect(answerSdp).toBe('v=0\r\nanswer'); // the publish itself still succeeded
  });

  it('an unresolvable Location yields no delete URL rather than throwing', () => {
    // A relative Location resolves against any valid base, so the only way to
    // reach the null path is a base URL that is not itself absolute.
    expect(resolveDeleteUrl('/session/abc', 'not-a-valid-base')).toBe(null);
    expect(resolveDeleteUrl('', 'https://insight.local:8889/cam1/whip')).toBe(null);
  });

  it('resolveDeleteUrl keeps an absolute Location as given', () => {
    expect(
      resolveDeleteUrl('https://other.host:8889/x/y', 'https://insight.local:8889/cam1/whip'),
    ).toBe('https://other.host:8889/x/y');
  });

  it('only H.264 codecs are selected for the transceiver', () => {
    const capabilities = {
      codecs: [
        { mimeType: 'video/VP8' },
        { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' },
        { mimeType: 'video/h264', sdpFmtpLine: 'profile-level-id=640c1f' },
        { mimeType: 'video/H265' },
        { mimeType: 'video/H264X' },
      ],
    };

    const selected = selectH264Codecs(capabilities);

    expect(selected.map((codec) => codec.mimeType)).toEqual(['video/H264', 'video/h264']);
  });

  it('selectH264Codecs tolerates a browser without getCapabilities', () => {
    expect(selectH264Codecs(undefined)).toEqual([]);
    expect(selectH264Codecs({})).toEqual([]);
  });

  it('publishing is confirmed as soon as MediaMTX reports the path', async () => {
    let calls = 0;
    const slept: number[] = [];

    const result = await confirmWebcamPublishing(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('Webcam is not publishing yet');
        return 'started';
      },
      { intervalMs: 250, sleep: async (ms) => void slept.push(ms), now: () => 0 },
    );

    expect(result).toBe('started');
    expect(calls).toBe(3);
    expect(slept).toEqual([250, 250]); // waited between attempts, not before the first
  });

  it('a webcam that never publishes reports the real error, not a timeout string', async () => {
    let clock = 0;

    const error = (await rejection(
      confirmWebcamPublishing(
        async () => {
          throw new Error('Webcam is not publishing yet');
        },
        {
          timeoutMs: 1000,
          intervalMs: 250,
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
      ),
    )) as Error;

    expect(error.message).toBe('Webcam is not publishing yet');
  });

  it('confirmation stops at the deadline instead of retrying forever', async () => {
    let clock = 0;
    let calls = 0;

    const error = await rejection(
      confirmWebcamPublishing(
        async () => {
          calls += 1;
          throw new Error('nope');
        },
        {
          timeoutMs: 1000,
          intervalMs: 250,
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
      ),
    );

    expect((error as Error).message).toMatch(/nope/);
    // 5 attempts at t=0,250,500,750,1000; the one at the deadline is the last.
    expect(calls).toBe(5);
  });

  it('a first-attempt success never sleeps', async () => {
    let slept = false;

    const result = await confirmWebcamPublishing(async () => 'started', {
      sleep: async () => {
        slept = true;
      },
      now: () => 0,
    });

    expect(result).toBe('started');
    expect(slept).toBe(false);
  });

  it('webcam failures are described in terms the user can act on', () => {
    expect(describeWebcamError({ name: 'NotAllowedError' })).toMatch(/permission was denied/);
    expect(describeWebcamError({ name: 'SecurityError' })).toMatch(/permission was denied/);
    expect(describeWebcamError({ name: 'NotFoundError' })).toMatch(/no longer available/);
    expect(describeWebcamError({ name: 'OverconstrainedError' })).toMatch(/no longer available/);
    expect(describeWebcamError({ name: 'NotReadableError' })).toMatch(
      /in use by another application/,
    );
  });

  it('an unrecognized failure keeps its own message', () => {
    expect(describeWebcamError(new Error('Webcam publish was rejected (HTTP 500).'))).toBe(
      'Webcam publish was rejected (HTTP 500).',
    );
    expect(describeWebcamError(undefined)).toBe('Webcam publishing failed.');
  });

  /** A session whose tracks and peer connection record that they were closed. */
  function fakeSession({ deleteUrl = null }: { deleteUrl?: string | null } = {}) {
    const stopped: string[] = [];
    const peer = {
      closed: false,
      close() {
        this.closed = true;
      },
    };
    const session: ClosableSession = {
      deleteUrl,
      stream: {
        getTracks: () => [{ stop: () => stopped.push('a') }, { stop: () => stopped.push('b') }],
      },
      pc: peer,
    };
    return { session, stopped, peer };
  }

  it('closing a session stops the camera and closes the peer connection', () => {
    const s = fakeSession();
    expect(closeWebcamSession(s.session, async () => ({}))).toBe(true);
    expect(s.stopped).toEqual(['a', 'b']); // every track released, so the OS frees the camera
    expect(s.peer.closed).toBe(true);
  });

  it('closing a session tells MediaMTX to drop the path', () => {
    const calls: [string, string | undefined][] = [];
    const s = fakeSession({ deleteUrl: 'https://insight.local:8889/cam1/whip/session/a' });

    closeWebcamSession(s.session, async (url, opts) => {
      calls.push([url, opts.method]);
      return {};
    });

    expect(calls).toEqual([['https://insight.local:8889/cam1/whip/session/a', 'DELETE']]);
  });

  it('a failing DELETE does not break teardown', () => {
    const s = fakeSession({ deleteUrl: 'https://insight.local:8889/x' });
    expect(() =>
      closeWebcamSession(s.session, () => {
        throw new Error('offline');
      }),
    ).not.toThrow();
    expect(s.peer.closed).toBe(true); // the peer connection still closed, which is what ends the media
  });

  it('closing nothing is harmless', () => {
    expect(closeWebcamSession(null, async () => ({}))).toBe(false);
    expect(closeAllWebcamSessions(null, async () => ({}))).toEqual([]);
  });

  it('a bulk action releases every camera and empties the registry', () => {
    // Stop All / Reset / Auto Assign: Insight cannot end these publishes itself,
    // so anything left here keeps streaming while the UI says stopped.
    const fakes = [fakeSession(), fakeSession(), fakeSession()];
    const sessions = new Map<number, ClosableSession>([
      [1, fakes[0].session],
      [3, fakes[1].session],
      [7, fakes[2].session],
    ]);

    const closed = closeAllWebcamSessions(sessions, async () => ({}));

    expect(closed).toEqual([1, 3, 7]);
    expect(sessions.size).toBe(0); // registry emptied, so nothing is left publishing
    for (const s of fakes) {
      expect(s.stopped).toEqual(['a', 'b']);
      expect(s.peer.closed).toBe(true);
    }
  });

  /** A watcher whose timers the test fires by hand. */
  function watcherHarness(opts = {}) {
    const lost: string[] = [];
    let seq = 0;
    const timers = new Map<number, () => void>();
    const w = createDisconnectWatcher<number>({
      onLost: (reason) => lost.push(reason),
      graceMs: 10000,
      setTimer: (fn) => {
        const id = ++seq;
        timers.set(id, fn);
        return id;
      },
      clearTimer: (id) => timers.delete(id),
      ...opts,
    });
    return {
      w,
      lost,
      timers,
      fire: () => {
        for (const [id, fn] of timers) {
          timers.delete(id);
          fn();
        }
      },
    };
  }

  it('a brief disconnect that recovers does not stop the source', () => {
    const { w, lost, timers } = watcherHarness();

    w.update('disconnected');
    expect(timers.size).toBe(1); // a grace period is pending, not an immediate teardown
    expect(lost).toEqual([]);

    w.update('connected');
    expect(timers.size).toBe(0); // grace period cancelled on recovery
    expect(lost).toEqual([]); // the source survived the blip
  });

  it('a disconnect that never recovers ends the session', () => {
    const { w, lost, fire } = watcherHarness();

    w.update('disconnected');
    fire();

    expect(lost).toEqual(['disconnected']);
  });

  it('failed and closed are acted on immediately', () => {
    const terminal: RTCPeerConnectionState[] = ['failed', 'closed'];
    for (const state of terminal) {
      const { w, lost, timers } = watcherHarness();
      w.update(state);
      expect(lost).toEqual([state]);
      expect(timers.size).toBe(0); // no point waiting out a terminal state
    }
  });

  it('repeated disconnect events do not stack grace periods', () => {
    const { w, timers } = watcherHarness();

    w.update('disconnected');
    w.update('disconnected');
    w.update('disconnected');

    expect(timers.size).toBe(1);
  });

  it('a disconnect followed by failure ends it at once', () => {
    const { w, lost, timers } = watcherHarness();

    w.update('disconnected');
    w.update('failed');

    expect(lost).toEqual(['failed']);
    expect(timers.size).toBe(0); // the pending grace period was cancelled
  });

  it('cancelling the watcher drops a pending grace period', () => {
    const { w, lost, timers, fire } = watcherHarness();

    w.update('disconnected');
    w.cancel();
    fire();

    expect(timers.size).toBe(0);
    expect(lost).toEqual([]); // a teardown already under way must not fire it again
  });

  it('H.264 is pinned on the transceiver when the browser offers it', () => {
    let pinned: { mimeType: string }[] | null = null;
    const transceiver = {
      setCodecPreferences: (c: { mimeType: string }[]) => {
        pinned = c;
      },
    };
    const caps = { codecs: [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264' }] };

    const chosen = pinH264(transceiver, caps);

    expect(pinned!.map((c) => c.mimeType)).toEqual(['video/H264']);
    expect(chosen.map((c) => c.mimeType)).toEqual(['video/H264']);
  });

  it('a browser with no H.264 is rejected rather than publishing VP8 as H.264', () => {
    const transceiver = { setCodecPreferences: () => undefined };

    expect(() => pinH264(transceiver, { codecs: [{ mimeType: 'video/VP8' }] })).toThrow(
      /cannot publish H\.264/,
    );
  });

  it('a browser without setCodecPreferences is rejected', () => {
    const caps = { codecs: [{ mimeType: 'video/H264' }] };

    expect(() => pinH264(undefined, caps)).toThrow(/cannot choose a video codec/);
    expect(() => pinH264({}, caps)).toThrow(/cannot choose a video codec/);
  });

  it('a terminal failure stops the retry loop immediately', async () => {
    // A slot reassigned mid-start will never become what we are waiting for.
    let calls = 0;
    const slept: number[] = [];
    const superseded = { superseded: true };

    const error = await rejection(
      confirmWebcamPublishing(
        async () => {
          calls += 1;
          throw superseded;
        },
        {
          isTerminal: (e) => Boolean((e as { superseded?: boolean } | undefined)?.superseded),
          sleep: async (ms) => void slept.push(ms),
          now: () => 0,
        },
      ),
    );

    expect(error === superseded).toBe(true);
    expect(calls).toBe(1); // no retry after a terminal failure
    expect(slept).toEqual([]); // and no waiting either
  });

  it('an ordinary failure still retries to the deadline', async () => {
    let clock = 0;
    let calls = 0;

    const error = await rejection(
      confirmWebcamPublishing(
        async () => {
          calls += 1;
          throw new Error('not publishing yet');
        },
        {
          isTerminal: (e) => Boolean((e as { superseded?: boolean } | undefined)?.superseded),
          timeoutMs: 500,
          intervalMs: 250,
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
      ),
    );

    expect((error as Error).message).toMatch(/not publishing yet/);
    expect(calls).toBe(3); // retried as before
  });

  it('the session id comes from the Id header, not the Location', async () => {
    // Verified on MediaMTX v1.12.1: Location carries a separate resource
    // secret; Id carries the session id the status API reports.
    const { deleteUrl, sessionId } = await publishWebcamOffer(
      fakePeerConnection(),
      'https://insight.local:8889/cam1/whip',
      async () =>
        response({
          location: '/cam1/whip/5fdd8139-d213-48c1-bef7-f95884810d15',
          id: '52304a1c-28cc-41d7-8234-164aa9ebd9bb',
        }),
    );

    expect(deleteUrl).toBe(
      'https://insight.local:8889/cam1/whip/5fdd8139-d213-48c1-bef7-f95884810d15',
    );
    expect(sessionId).toBe('52304a1c-28cc-41d7-8234-164aa9ebd9bb');
  });

  it('no Id header means no session id, so no release claim can be made', async () => {
    const { sessionId } = await publishWebcamOffer(
      fakePeerConnection(),
      'https://insight.local:8889/cam1/whip',
      async () => response({ location: '/cam1/whip/secret' }),
    );

    expect(sessionId).toBe(null);
    expect(sessionIdFromResponse(undefined)).toBe(null);
    expect(sessionIdFromResponse({ get: () => '  ' })).toBe(null);
  });

  it('a cancelled watcher ignores the close it caused', () => {
    // teardown cancels, then closes the peer, which emits `closed` — that must
    // not be reported as a lost connection.
    const { w, lost, timers } = watcherHarness();

    w.cancel();
    w.update('closed');
    w.update('failed');
    w.update('disconnected');

    expect(lost).toEqual([]);
    expect(timers.size).toBe(0);
  });

  it('recovering keeps the watcher armed for a later loss', () => {
    // Every successful publish reaches `connected`; that must not disarm the
    // watcher, or a network loss minutes later leaves the row Live for good.
    const { w, lost, timers, fire } = watcherHarness();

    w.update('connecting');
    w.update('connected');
    expect(lost).toEqual([]);

    w.update('disconnected');
    expect(timers.size).toBe(1); // still watching after recovery
    fire();
    expect(lost).toEqual(['disconnected']);
  });

  it('a failure after a healthy connection is still reported', () => {
    const { w, lost } = watcherHarness();
    w.update('connected');
    w.update('failed');
    expect(lost).toEqual(['failed']);
  });

  it('recordWebcamStopsOnExit sends a keepalive session-bound stop per owned webcam', () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchRequest = (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve();
    };
    const sessions = new Map<number, { sessionId: string | null }>([
      [1, { sessionId: 'sess-1' }],
      [2, { sessionId: null }], // no id: nothing to record, skipped
      [3, { sessionId: 'sess-3' }],
    ]);

    const stopped = recordWebcamStopsOnExit(sessions, fetchRequest);

    expect(stopped).toEqual([1, 3]); // only sessions this tab can name are stopped
    expect(calls.length).toBe(2);
    for (const { url, init } of calls) {
      expect(url).toBe('/api/mediasrc/stop');
      expect(init.method).toBe('POST');
      expect(init.keepalive).toBe(true); // must survive page unload
      const body = JSON.parse(init.body as string);
      expect(body.publisher_released).toBe(true);
      expect(body.publisher_session).toBe(`sess-${body.index}`);
    }
  });

  it('recordWebcamStopsOnExit swallows a fetch that throws as the page unloads', () => {
    const sessions = new Map([[1, { sessionId: 'sess-1' }]]);
    const fetchRequest = (): Promise<unknown> => {
      throw new Error('page is going away');
    };
    expect(recordWebcamStopsOnExit(sessions, fetchRequest)).toEqual([1]);
  });

  it('camerasFromDevices lists a multi-sensor camera once, under its first name', () => {
    // As Chrome on Linux reported a laptop's RGB + IR camera and a USB webcam.
    const devices: DeviceInfo[] = [
      { kind: 'audioinput', deviceId: 'mic', label: 'Microphone' },
      { kind: 'videoinput', deviceId: 'hp', label: 'HP 5MP Camera: HP 5MP Camera' },
      { kind: 'videoinput', deviceId: 'hp', label: 'HP 5MP Camera: HP IR Camera' },
      { kind: 'videoinput', deviceId: 'rapoo', label: 'Rapoo Camera: Rapoo Camera' },
    ];
    expect(camerasFromDevices(devices)).toEqual([
      { deviceId: 'hp', label: 'HP 5MP Camera: HP 5MP Camera' },
      { deviceId: 'rapoo', label: 'Rapoo Camera: Rapoo Camera' },
    ]);
  });

  it('camerasFromDevices skips entries without an id and numbers unnamed cameras', () => {
    const devices: DeviceInfo[] = [
      { kind: 'videoinput', deviceId: '', label: '' }, // before permission is granted
      { kind: 'videoinput', deviceId: 'a', label: '' },
      { kind: 'videoinput', deviceId: 'b', label: '' },
    ];
    expect(camerasFromDevices(devices)).toEqual([
      { deviceId: 'a', label: 'Camera 1' },
      { deviceId: 'b', label: 'Camera 2' },
    ]);
    expect(camerasFromDevices(undefined)).toEqual([]);
  });
});
