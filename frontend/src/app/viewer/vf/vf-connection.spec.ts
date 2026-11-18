import { computed, effect, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { NeatFrameStats } from '@sima/neat-ui/video';
import { VfConnection } from './vf-connection';

/** What the connection did, in order, across the fakes: proves when the offer is posted. */
let calls: string[];

/** Frame stats as a playing tile emits them. */
const SAMPLE_FRAME_STATS: NeatFrameStats = {
  timestampMatches: 120,
  arrivalFallbacks: 3,
  frameMisses: 2,
  expired: 1,
  evicted: 0,
  untimestampedReceived: 4,
  late: 5,
  timestampedPending: 6,
  arrivalPending: 7,
  recentLatenessMedianMs: 41.5,
  recentLatenessMaxMs: 88.25,
  metadataMessagesPerSecond: 30,
  video: {
    readyState: 4,
    paused: false,
    currentTime: 12.345,
    videoWidth: 1920,
    videoHeight: 1080,
    lastFrameAgeMs: 16,
    active: true,
  },
};

class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: string[] = [];

  constructor(
    readonly label: string,
    readonly init: RTCDataChannelInit,
  ) {}

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.readyState = 'closed';
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  /** The server's side: one text frame. */
  receive(text: string): void {
    this.onmessage?.(new MessageEvent('message', { data: text }));
  }
}

/** A receiver of a browser with `jitterBufferTarget`, unless a test replaces it. */
let createReceiver: () => object;

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  signalingState: RTCSignalingState = 'stable';
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  readonly transceivers: { kind: string; init: RTCRtpTransceiverInit }[] = [];
  readonly channels: FakeDataChannel[] = [];
  readonly receiver = createReceiver();
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;
  /** The inbound-rtp video report getStats returns, if any; a function of the fake clock. */
  inbound: (() => Record<string, unknown>) | null = null;
  /** While set, getStats waits for it, as a slow browser would. */
  statsDelay: Promise<void> | null = null;

  constructor(readonly config?: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }

  static get last(): FakePeerConnection {
    return FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
  }

  get channel(): FakeDataChannel {
    return this.channels[0];
  }

  addTransceiver(kind: string, init: RTCRtpTransceiverInit) {
    this.transceivers.push({ kind, init });
    return { receiver: this.receiver };
  }

  createDataChannel(label: string, init: RTCDataChannelInit): FakeDataChannel {
    const channel = new FakeDataChannel(label, init);
    this.channels.push(channel);
    return channel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    calls.push('createOffer');
    return { type: 'offer', sdp: 'v=0\r\n' };
  }

  async setLocalDescription(): Promise<void> {
    calls.push('setLocalDescription');
    this.iceGatheringState = 'gathering';
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    calls.push('setRemoteDescription');
    this.remoteDescription = description;
  }

  async getStats(): Promise<Map<string, unknown>> {
    if (this.statsDelay) await this.statsDelay;
    const stats = new Map<string, unknown>([
      ['A1', { id: 'A1', type: 'inbound-rtp', kind: 'audio', bytesReceived: 10 }],
      ['C1', { id: 'C1', type: 'codec', mimeType: 'video/H264' }],
    ]);
    if (this.inbound) {
      stats.set('V1', {
        id: 'V1',
        type: 'inbound-rtp',
        kind: 'video',
        codecId: 'C1',
        ...this.inbound(),
      });
    }
    return stats;
  }

  close(): void {
    this.closed = true;
  }

  // Test controls.

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  setIceGatheringState(state: RTCIceGatheringState): void {
    this.iceGatheringState = state;
    this.onicegatheringstatechange?.();
  }

  setIceConnectionState(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }

  /** Connected, the data channel open and video arriving at 30 fps and 4 Mb/s. */
  connect(): void {
    this.setIceConnectionState('connected');
    this.setConnectionState('connected');
    this.channel.open();
    this.inbound = () => {
      const seconds = Date.now() / 1000;
      return {
        timestamp: Date.now(),
        bytesReceived: Math.round(seconds * 500_000),
        packetsReceived: Math.round(seconds * 400),
        framesReceived: Math.round(seconds * 30),
        framesDecoded: Math.round(seconds * 30),
        framesPerSecond: 30,
        frameWidth: 1280,
        frameHeight: 720,
        jitterBufferDelay: 1.5,
        jitterBufferEmittedCount: 30,
      };
    };
  }
}

class FakeMediaStream {
  constructor(readonly tracks: MediaStreamTrack[]) {}
}

type Respond = (url: string, init: RequestInit) => Promise<Partial<Response>>;
let respond: Respond;
let fetchMock: ReturnType<typeof vi.fn<Respond>>;

const ANSWER: RTCSessionDescriptionInit = { type: 'answer', sdp: 'v=0\r\n' };
const answered: Respond = async () => ({ ok: true, status: 200, json: async () => ANSWER });
const rejectedWith =
  (status: number): Respond =>
  async () => ({ ok: false, status, json: async () => null });

/** Lets the promise chain of the offer settle without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('VfConnection', () => {
  let connection: VfConnection | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    calls = [];
    createReceiver = () => ({ jitterBufferTarget: null });
    FakePeerConnection.instances = [];
    respond = answered;
    fetchMock = vi.fn<Respond>((url, init) => {
      calls.push(`fetch ${url}`);
      return respond(url, init);
    });
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    vi.stubGlobal('MediaStream', FakeMediaStream);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    connection?.close();
    connection = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function open(channel = 4): Promise<FakePeerConnection> {
    connection = new VfConnection(channel);
    await settle();
    return FakePeerConnection.last;
  }

  it('posts the offer to /api/channels/N/offer right after setLocalDescription', async () => {
    const pc = await open(4);

    // No ICE server: the host and peer-reflexive candidates connect (see signaling.ts).
    expect(pc.config?.iceServers ?? []).toStrictEqual([]);
    expect(pc.transceivers).toStrictEqual([{ kind: 'video', init: { direction: 'recvonly' } }]);
    expect(pc.channels.map(({ label, init }) => ({ label, init }))).toStrictEqual([
      { label: 'metadata', init: { ordered: true, maxRetransmits: 0 } },
    ]);
    expect(calls).toStrictEqual([
      'createOffer',
      'setLocalDescription',
      'fetch /api/channels/4/offer',
      'setRemoteDescription',
    ]);
    // Not held back until gathering completes (see signaling.ts).
    expect(pc.iceGatheringState).toBe('gathering');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toStrictEqual({ type: 'offer', sdp: 'v=0\r\n' });
    expect(pc.remoteDescription).toStrictEqual(ANSWER);
    expect(connection?.status().phase).toBe('connecting');
  });

  it('503 → phase waiting, retries after 2000 ms; 415 → phase failed "Codec not supported by this browser", no retry', async () => {
    respond = rejectedWith(503);
    const first = await open();

    expect(connection?.status().phase).toBe('waiting');
    expect(first.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakePeerConnection.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Still waiting while the retry is under way: no flicker back to an empty status.
    expect(connection?.status().phase).toBe('waiting');

    respond = rejectedWith(415);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakePeerConnection.instances).toHaveLength(3);
    expect(connection?.status()).toMatchObject({
      phase: 'failed',
      failure: 'Codec not supported by this browser',
    });
    expect(FakePeerConnection.last.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakePeerConnection.instances).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a network error retries after 2000 ms', async () => {
    respond = async () => {
      throw new TypeError('Failed to fetch');
    };
    await open();
    expect(connection?.status().phase).toBe('waiting');

    respond = answered;
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(FakePeerConnection.last.remoteDescription).toStrictEqual(ANSWER);
    // Answered: no longer waiting for the server, though the first stats are a second away.
    expect(connection?.status().phase).toBe('connecting');
  });

  it('another 4xx fails with its HTTP status and gives up', async () => {
    respond = rejectedWith(404);
    await open();

    expect(connection?.status()).toMatchObject({
      phase: 'failed',
      failure: 'Connection failed: HTTP 404',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakePeerConnection.instances).toHaveLength(1);
  });

  it('connectionState failed → reconnect after 2000 ms; ICE disconnected for 5000 ms → reconnect', async () => {
    const pc = await open();
    pc.connect();
    pc.setConnectionState('failed');
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakePeerConnection.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(pc.closed).toBe(true);

    const second = FakePeerConnection.last;
    second.connect();
    second.setConnectionState('closed');
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakePeerConnection.instances).toHaveLength(3);

    // A short ICE outage that recovers is left alone.
    const third = FakePeerConnection.last;
    third.connect();
    third.setIceConnectionState('disconnected');
    await vi.advanceTimersByTimeAsync(4000);
    third.setIceConnectionState('connected');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakePeerConnection.instances).toHaveLength(3);

    // One that lasts 5 s schedules the reconnect, which follows 2 s later.
    third.setIceConnectionState('disconnected');
    await vi.advanceTimersByTimeAsync(5000 + 1999);
    expect(FakePeerConnection.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakePeerConnection.instances).toHaveLength(4);
  });

  it('a 5000 ms decoder stall reconnects', async () => {
    const pc = await open();
    pc.connect();
    const decodedUntil = Date.now() + 1000;
    const playing = pc.inbound!;
    // Packets keep arriving but the decoder stops producing frames after the first second.
    pc.inbound = () => ({
      ...playing(),
      framesDecoded: Math.round((Math.min(Date.now(), decodedUntil) / 1000) * 30),
    });

    // Ticks at 1 s (first sample) and 2 s (stall starts); stalled at the 7 s tick, +2 s retry.
    await vi.advanceTimersByTimeAsync(8999);
    expect(FakePeerConnection.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakePeerConnection.instances).toHaveLength(2);
  });

  it('schedules one reconnect however many triggers fire while it is pending', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    connection = new VfConnection(4, { debug: true });
    await settle();
    const pc = FakePeerConnection.last;
    pc.connect();

    pc.setIceConnectionState('disconnected');
    await vi.advanceTimersByTimeAsync(4000);
    pc.setConnectionState('failed');
    pc.setConnectionState('closed');
    // The ICE timer fires at 5 s, while the reconnect from `failed` is due at 6 s.
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakePeerConnection.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakePeerConnection.instances).toHaveLength(2);

    const scheduled = log.mock.calls.filter(([, event]) => event === 'reconnecting in 2000 ms');
    expect(scheduled.map(([, , reason]) => reason)).toEqual(['connection failed']);
  });

  it('ignores stats that arrive after their session was replaced', async () => {
    const pc = await open();
    pc.connect();
    let release!: () => void;
    pc.statsDelay = new Promise((resolve) => (release = resolve));

    await vi.advanceTimersByTimeAsync(1000);
    pc.setConnectionState('failed');
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakePeerConnection.instances).toHaveLength(2);

    release();
    await settle();
    expect(pc.channel.sent).toEqual([]);
    expect(connection?.status().phase).toBe('connecting');
  });

  it('samples nothing before it is connected, and never sends on the data channel', async () => {
    const pc = await open(4);
    pc.channel.readyState = 'open';
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection?.status().phase).toBe('connecting');

    pc.connect();
    connection!.reportFrameStats(SAMPLE_FRAME_STATS);
    await vi.advanceTimersByTimeAsync(3000);

    expect(connection?.status()).toMatchObject({ phase: 'connected', fps: 30, width: 1280 });
    // The server reads nothing the browser sends on the metadata channel.
    expect(pc.channel.sent).toEqual([]);
  });

  it('applies jitterBufferTarget on connect and on setSyncBuffer and reports supported=false when the receiver lacks it', async () => {
    const pc = await open();
    const receiver = pc.receiver as { jitterBufferTarget: number | null };
    // The default video sync buffer until the page sets the channel's own.
    expect(receiver.jitterBufferTarget).toBe(300);
    expect(connection?.syncBuffer()).toStrictEqual({
      supported: true,
      applied: true,
      targetMs: 300,
    });

    connection!.setSyncBuffer(650);
    expect(receiver.jitterBufferTarget).toBe(650);
    expect(connection?.syncBuffer()).toStrictEqual({
      supported: true,
      applied: true,
      targetMs: 650,
    });

    // A reconnect applies the current value to its new receiver.
    pc.setConnectionState('failed');
    await vi.advanceTimersByTimeAsync(2000);
    const next = FakePeerConnection.last.receiver as { jitterBufferTarget: number | null };
    expect(next.jitterBufferTarget).toBe(650);

    createReceiver = () => ({});
    connection!.close();
    connection = new VfConnection(5);
    expect(connection.syncBuffer()).toStrictEqual({
      supported: false,
      applied: false,
      targetMs: 0,
    });

    createReceiver = () => ({
      get jitterBufferTarget() {
        return 0;
      },
      set jitterBufferTarget(_ms: number) {
        throw new RangeError('out of range');
      },
    });
    connection.close();
    connection = new VfConnection(6);
    expect(connection.syncBuffer()).toStrictEqual({ supported: true, applied: false, targetMs: 0 });
  });

  it('close() stops timers, closes the data channel and the peer connection, and stops retrying', async () => {
    const pc = await open();
    pc.connect();
    pc.ontrack?.({ track: { kind: 'video' } } as RTCTrackEvent);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection?.stream()).not.toBeNull();

    connection!.close();
    expect(pc.channel.readyState).toBe('closed');
    expect(pc.closed).toBe(true);
    expect(connection?.stream()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    // A connection closed while waiting for the server does not come back.
    respond = rejectedWith(503);
    connection = new VfConnection(4);
    await settle();
    connection.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakePeerConnection.instances).toHaveLength(2);

    // Nor does an offer that settles after close.
    let answer!: (response: Partial<Response>) => void;
    respond = () => new Promise((resolve) => (answer = resolve));
    connection = new VfConnection(4);
    await settle();
    connection.close();
    answer({ ok: false, status: 503 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakePeerConnection.instances).toHaveLength(3);
    expect(connection.status().phase).toBe('connecting');
  });

  it('status updates at most once per second while frames and messages stream', async () => {
    const pc = await open();
    pc.connect();
    pc.ontrack?.({ track: { kind: 'video' } } as RTCTrackEvent);
    const seen = new Set([connection!.status()]);

    // 3 s of 30 messages a second, with the tile's stats each second, sampled every 10 ms.
    for (let step = 1; step <= 300; step += 1) {
      if (step % 3 === 0) pc.channel.receive('{"type":"classification","data":{}}');
      if (step % 100 === 50) connection!.reportFrameStats(SAMPLE_FRAME_STATS);
      await vi.advanceTimersByTimeAsync(10);
      seen.add(connection!.status());
    }

    // The initial status plus one per stats tick.
    expect(seen.size).toBe(4);
    expect(connection!.status()).toStrictEqual({
      phase: 'connected',
      codec: 'H.264',
      width: 1280,
      height: 720,
      fps: 30,
      kbps: 4000,
      messagesPerSecond: SAMPLE_FRAME_STATS.metadataMessagesPerSecond,
    });
  });

  it('shows 0 msg/s until the tile reports its first frame stats', async () => {
    const pc = await open();
    pc.connect();
    await vi.advanceTimersByTimeAsync(1000);

    expect(connection?.status()).toMatchObject({ phase: 'connected', messagesPerSecond: 0 });
  });

  it('hands the tile the video track as a stream and the metadata text as it arrives', async () => {
    const pc = await open();
    const track = { kind: 'video' } as MediaStreamTrack;
    expect(connection?.stream()).toBeNull();

    pc.ontrack?.({ track: { kind: 'audio' } } as RTCTrackEvent);
    expect(connection?.stream()).toBeNull();
    pc.ontrack?.({ track } as RTCTrackEvent);
    expect((connection?.stream() as unknown as FakeMediaStream).tracks).toStrictEqual([track]);

    const received: [string, number][] = [];
    const unsubscribe = connection!.onMetadata((text, at) => received.push([text, at]));
    vi.spyOn(performance, 'now').mockReturnValue(1234.5);
    pc.channel.receive('{"type":"tracking"}');
    unsubscribe();
    pc.channel.receive('{"type":"tracking"}');
    expect(received).toStrictEqual([['{"type":"tracking"}', 1234.5]]);

    // A reconnect drops the old stream until the new session's track arrives.
    pc.setConnectionState('failed');
    await vi.advanceTimersByTimeAsync(2000);
    expect(connection?.stream()).toBeNull();
  });

  it('logs its events prefixed with the channel when debug is on', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    connection = new VfConnection(4, { debug: true });
    await settle();
    const pc = FakePeerConnection.last;
    pc.setIceGatheringState('gathering');
    pc.connect();
    pc.ontrack?.({ track: { kind: 'video', id: 'T1', readyState: 'live' } } as RTCTrackEvent);
    await vi.advanceTimersByTimeAsync(1000);
    pc.setConnectionState('failed');

    expect(log.mock.calls.every(([prefix]) => prefix === '[viewer][ch4]')).toBe(true);
    expect(log.mock.calls.map(([, event]) => event)).toEqual([
      'connect start',
      'pc created',
      'offer answered',
      'iceGatheringState',
      'iceConnectionState',
      'connectionState',
      'data channel open',
      'ontrack',
      'stats',
      'connectionState',
      'reconnecting in 2000 ms',
    ]);
    expect(log).toHaveBeenCalledWith(
      '[viewer][ch4]',
      'reconnecting in 2000 ms',
      'connection failed',
    );

    // After the reconnect the old session's handlers are detached: its events log nothing.
    await vi.advanceTimersByTimeAsync(2000);
    log.mockClear();
    pc.setConnectionState('closed');
    pc.setIceConnectionState('disconnected');
    pc.setIceGatheringState('complete');
    pc.channel.open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).not.toHaveBeenCalled();
  });

  it('logs nothing when debug is off', async () => {
    const log = vi.spyOn(console, 'log');
    respond = rejectedWith(503);
    const pc = await open();
    respond = answered;
    await vi.advanceTimersByTimeAsync(2000);
    FakePeerConnection.last.connect();
    await vi.advanceTimersByTimeAsync(3000);
    pc.setConnectionState('failed');

    expect(log).not.toHaveBeenCalled();
  });

  it('can be created inside a computed or an effect without tracking or writing its signals there', async () => {
    respond = rejectedWith(503);
    const created = computed(() => new VfConnection(1));
    const fromComputed = created();
    await settle();
    expect(fromComputed.status().phase).toBe('waiting');
    expect(created(), 'the computed did not come to depend on the status').toBe(fromComputed);

    let runs = 0;
    let fromEffect: VfConnection | undefined;
    const watcher = effect(
      () => {
        runs += 1;
        fromEffect = new VfConnection(2);
      },
      { injector: TestBed.inject(Injector) },
    );
    TestBed.tick();
    // Status and stream change while the server keeps answering 503; the effect must not run again.
    await vi.advanceTimersByTimeAsync(6000);
    TestBed.tick();
    expect(runs).toBe(1);
    expect(fromEffect?.status().phase).toBe('waiting');

    watcher.destroy();
    fromComputed.close();
    fromEffect?.close();
  });
});
