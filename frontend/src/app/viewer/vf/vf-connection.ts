import { signal, untracked } from '@angular/core';
import type { NeatFrameStats, NeatTileSource } from '@sima/neat-ui/video';
import { resolveCodecLabel, offerFailureText, type VfStatus } from './channel-status';
import { INITIAL_DECODER_HEALTH, updateDecoderHealth, type DecoderHealth } from './decoder-health';
import { isRetryable, OfferRejectedError, requestAnswer } from './signaling';

/** Fixed and unlimited, without backoff, as vf's own viewer retries. */
const RECONNECT_DELAY_MS = 2000;
/**
 * Deliberately longer than the retry delay: a decoder can legitimately produce nothing for a moment
 * while it waits for a keyframe, and reconnecting is the more expensive response.
 */
const DECODER_STALL_MS = 5000;
/**
 * ICE often recovers from a brief `disconnected` on its own. One that lasts this long gets a
 * reconnect instead of a frozen frame until ICE gives up with `failed`.
 */
const ICE_DISCONNECTED_MS = 5000;
const STATS_INTERVAL_MS = 1000;
/** The viewer's default video sync buffer, until the page sets the channel's own. */
const DEFAULT_SYNC_BUFFER_MS = 300;

type MetadataListener = (text: string, receivedAt: number) => void;
type DebugLog = (event: string, details?: unknown) => void;

const NO_LOG: DebugLog = () => undefined;

/** The inbound-rtp video fields the tick reads, for the status line, the stall check and the log. */
type InboundVideoReport = Pick<
  RTCInboundRtpStreamStats,
  | 'bytesReceived'
  | 'packetsReceived'
  | 'packetsLost'
  | 'framesReceived'
  | 'framesDecoded'
  | 'framesDropped'
  | 'framesPerSecond'
  | 'frameWidth'
  | 'frameHeight'
>;

/** A stats report as the tick reads it: any type, with the inbound-rtp fields when it is one. */
type InboundRtpReport = RTCStats & InboundVideoReport & { kind?: string; codecId?: string };

/** Whether the receiver took the video sync buffer as its jitter buffer target. */
export interface VfSyncBuffer {
  supported: boolean;
  applied: boolean;
  /** The target the receiver reports, in ms; 0 unless applied. */
  targetMs: number;
}

/** One peer connection and everything that belongs to it; replaced on every reconnect. */
interface Session {
  readonly pc: RTCPeerConnection;
  readonly receiver: RTCRtpReceiver;
  readonly channel: RTCDataChannel;
  readonly statsTimer: ReturnType<typeof setInterval>;
  iceDisconnectedTimer: ReturnType<typeof setTimeout> | null;
  /** The previous inbound-rtp sample, for the bitrate. */
  lastBytes: number | null;
  lastTimestamp: number | null;
  /** Kept across samples so a report that omits the codec does not blank it. */
  codec: string | null;
  decoderHealth: DecoderHealth;
}

const CONNECTING: VfStatus = {
  phase: 'connecting',
  codec: null,
  width: null,
  height: null,
  fps: null,
  kbps: 0,
  messagesPerSecond: 0,
};

/**
 * Receives one channel over WebRTC: its video as `stream` and its metadata data channel through
 * `onMetadata`, for a `neat-video-tile`. It signals to Insight's server
 * (`/api/channels/<n>/offer`) and reconnects as vf's viewer did. The data channel only receives:
 * the server reads nothing the browser sends on it.
 *
 * All of it runs outside Angular change detection on WebRTC callbacks and timers. Metadata goes to
 * the listeners without touching a signal; `status` changes on connection events and at most once
 * per stats tick.
 */
export class VfConnection implements NeatTileSource {
  private readonly streamState = signal<MediaStream | null>(null);
  private readonly statusState = signal<VfStatus>(CONNECTING);
  private readonly syncBufferState = signal<VfSyncBuffer>({
    supported: false,
    applied: false,
    targetMs: 0,
  });

  readonly stream = this.streamState.asReadonly();
  readonly status = this.statusState.asReadonly();
  /** How the receiver took the video sync buffer; the inspector says when it cannot. */
  readonly syncBuffer = this.syncBufferState.asReadonly();

  private readonly listeners = new Set<MetadataListener>();
  private session: Session | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private syncBufferMs = DEFAULT_SYNC_BUFFER_MS;
  /** The tile's latest frame stats for the current stream; null until it reports. */
  private frameStats: NeatFrameStats | null = null;
  private log: DebugLog = NO_LOG;

  /**
   * Connects at once. The first session is set up untracked: a connection created inside an
   * `effect` or `computed` must neither make it depend on the connection's own signals nor write
   * signals in a reactive context that forbids it.
   */
  constructor(
    readonly channel: number,
    options: { debug?: boolean } = {},
  ) {
    this.setDebug(options.debug ?? false);
    untracked(() => this.connect());
  }

  /** Logs the connection's events to the console as `[viewer][chN]` (the viewer's `debug=1`). */
  setDebug(enabled: boolean): void {
    const prefix = `[viewer][ch${this.channel}]`;
    this.log = enabled
      ? (event, details) =>
          details === undefined ? console.log(prefix, event) : console.log(prefix, event, details)
      : NO_LOG;
  }

  onMetadata(listener: MetadataListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sets the receiver's jitter buffer target, now and on every reconnect. */
  setSyncBuffer(ms: number): void {
    this.syncBufferMs = ms;
    if (this.session) this.applySyncBuffer(this.session.receiver);
  }

  /** Takes the tile's `frameStats` output, whose message rate the status line shows. */
  reportFrameStats(stats: NeatFrameStats): void {
    this.frameStats = stats;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.endSession();
    this.listeners.clear();
  }

  private connect(): void {
    this.endSession();
    // A retry while the server has nothing to send keeps saying so instead of flickering to
    // "connecting".
    if (this.statusState().phase !== 'waiting') this.statusState.set(CONNECTING);
    this.frameStats = null;
    this.log('connect start', { videoSyncBufferMs: this.syncBufferMs });

    // No ICE servers: the server and the browser reach each other without them (signaling.ts).
    const pc = new RTCPeerConnection();
    const { receiver } = pc.addTransceiver('video', { direction: 'recvonly' });
    const channel = pc.createDataChannel('metadata', { ordered: true, maxRetransmits: 0 });
    const session: Session = {
      pc,
      receiver,
      channel,
      statsTimer: setInterval(() => void this.sample(session), STATS_INTERVAL_MS),
      iceDisconnectedTimer: null,
      lastBytes: null,
      lastTimestamp: null,
      codec: null,
      decoderHealth: INITIAL_DECODER_HEALTH,
    };
    this.session = session;
    this.applySyncBuffer(receiver);
    this.log('pc created', this.syncBufferState());

    channel.onopen = () => this.log('data channel open');
    channel.onclose = () => this.log('data channel closed');
    channel.onmessage = (event: MessageEvent) => {
      // The server sends text frames only; the tile parses and validates them.
      if (typeof event.data !== 'string') return;
      const receivedAt = performance.now();
      for (const listener of this.listeners) listener(event.data, receivedAt);
    };
    pc.ontrack = (event) => {
      if (this.session !== session || event.track.kind !== 'video') return;
      const { kind, id, readyState } = event.track;
      this.log('ontrack', { kind, id, readyState });
      this.streamState.set(new MediaStream([event.track]));
    };
    pc.onconnectionstatechange = () => {
      if (this.session !== session) return;
      this.log('connectionState', pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.scheduleReconnect(`connection ${pc.connectionState}`);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (this.session !== session) return;
      this.log('iceConnectionState', pc.iceConnectionState);
      if (session.iceDisconnectedTimer !== null) clearTimeout(session.iceDisconnectedTimer);
      session.iceDisconnectedTimer = null;
      if (pc.iceConnectionState === 'disconnected') {
        session.iceDisconnectedTimer = setTimeout(
          () => this.scheduleReconnect(`ICE disconnected for ${ICE_DISCONNECTED_MS} ms`),
          ICE_DISCONNECTED_MS,
        );
      }
    };
    pc.onicegatheringstatechange = () => {
      if (this.session === session) this.log('iceGatheringState', pc.iceGatheringState);
    };

    requestAnswer(pc, `/api/channels/${this.channel}/offer`)
      .then(async (answer) => {
        if (this.session !== session) return;
        await pc.setRemoteDescription(answer);
        if (this.session !== session) return;
        this.log('offer answered');
        // A retry that got through is no longer waiting for the server, though no stats show it
        // yet.
        if (this.statusState().phase === 'waiting') this.statusState.set(CONNECTING);
      })
      .catch((error: unknown) => {
        if (this.session !== session) return;
        const reason = error instanceof Error ? error.message : String(error);
        this.log('offer failed', reason);
        this.endSession();
        if (isRetryable(error)) {
          this.statusState.set({ ...CONNECTING, phase: 'waiting' });
          this.scheduleReconnect(`offer failed: ${reason}`);
        } else {
          const failure =
            error instanceof OfferRejectedError
              ? offerFailureText(error.status)
              : `Connection failed: ${reason}`;
          this.statusState.set({ ...CONNECTING, phase: 'failed', failure });
        }
      });
  }

  /** One pending reconnect at a time; the next session starts from scratch. */
  private scheduleReconnect(reason: string): void {
    if (this.closed || this.reconnectTimer !== null) return;
    this.log(`reconnecting in ${RECONNECT_DELAY_MS} ms`, reason);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private endSession(): void {
    const session = this.session;
    if (session === null) return;
    this.session = null;
    clearInterval(session.statsTimer);
    if (session.iceDisconnectedTimer !== null) clearTimeout(session.iceDisconnectedTimer);
    // Detached first, so a deliberate close cannot report `closed` and schedule a reconnect, and an
    // old session's events stay out of the log.
    session.channel.onopen = null;
    session.channel.onclose = null;
    session.channel.onmessage = null;
    session.channel.close();
    session.pc.ontrack = null;
    session.pc.onconnectionstatechange = null;
    session.pc.oniceconnectionstatechange = null;
    session.pc.onicegatheringstatechange = null;
    session.pc.close();
    // Not read first: an effect that releases the connection would come to depend on it.
    this.streamState.set(null);
  }

  private applySyncBuffer(receiver: RTCRtpReceiver): void {
    this.syncBufferState.set(applyJitterBufferTarget(receiver, this.syncBufferMs));
  }

  /**
   * The 1 s stats tick: status line and decoder stall check, from the inbound-rtp video report.
   * Only a connected session has stats worth showing.
   */
  private async sample(session: Session): Promise<void> {
    const { pc } = session;
    if (pc.connectionState !== 'connected') return;
    let stats: RTCStatsReport;
    try {
      stats = await pc.getStats();
    } catch {
      // getStats rejects while the connection is closing; the next tick samples again.
      return;
    }
    if (this.session !== session) return;

    let status: VfStatus | null = null;
    let stalled = false;
    for (const report of stats.values() as Iterable<InboundRtpReport>) {
      if (report.type !== 'inbound-rtp' || report.kind !== 'video') continue;
      const now = Date.now();
      session.codec = resolveCodecLabel(stats, report) ?? session.codec;
      const health = updateDecoderHealth(session.decoderHealth, report, now, DECODER_STALL_MS);
      session.decoderHealth = health;
      stalled ||= health.stalled;
      this.log('stats', {
        framesReceived: report.framesReceived,
        framesDecoded: report.framesDecoded,
        framesDropped: report.framesDropped,
        packetsReceived: report.packetsReceived,
        packetsLost: report.packetsLost,
        bytesReceived: report.bytesReceived,
        fps: report.framesPerSecond,
        video: this.frameStats?.video,
      });

      const bytes = report.bytesReceived ?? null;
      const seconds =
        session.lastTimestamp === null ? 0 : (report.timestamp - session.lastTimestamp) / 1000;
      const bitrateBps =
        seconds > 0 && bytes !== null && session.lastBytes !== null
          ? ((bytes - session.lastBytes) * 8) / seconds
          : 0;
      session.lastBytes = bytes;
      session.lastTimestamp = report.timestamp;

      status = {
        phase: 'connected',
        codec: session.codec,
        width: report.frameWidth ?? null,
        height: report.frameHeight ?? null,
        fps: report.framesPerSecond ?? null,
        kbps: bitrateBps / 1000,
        // The tile counts the valid messages; counting the data channel too would disagree.
        messagesPerSecond: this.frameStats?.metadataMessagesPerSecond ?? 0,
      };
    }

    if (status !== null) this.statusState.set(status);
    if (stalled) this.scheduleReconnect(`decoder stalled for ${DECODER_STALL_MS} ms`);
  }
}

/**
 * Asks the receiver to hold video for the sync buffer, so frames wait for metadata that lags them.
 * Browsers without `jitterBufferTarget` (or that reject the value) play as soon as they can.
 */
function applyJitterBufferTarget(receiver: RTCRtpReceiver, targetMs: number): VfSyncBuffer {
  if (!('jitterBufferTarget' in receiver)) return { supported: false, applied: false, targetMs: 0 };
  try {
    receiver.jitterBufferTarget = targetMs;
    return { supported: true, applied: true, targetMs: Number(receiver.jitterBufferTarget) };
  } catch {
    return { supported: true, applied: false, targetMs: 0 };
  }
}
