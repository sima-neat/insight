import type { NeatFrameStats } from '@sima/neat-ui';

/** The inbound-rtp video fields the report reads; Chrome adds `powerEfficientDecoder`. */
export type InboundVideoReport = Pick<
  RTCInboundRtpStreamStats,
  | 'bytesReceived'
  | 'packetsReceived'
  | 'packetsLost'
  | 'framesReceived'
  | 'framesDecoded'
  | 'framesDropped'
  | 'framesPerSecond'
  | 'decoderImplementation'
  | 'frameWidth'
  | 'frameHeight'
  | 'freezeCount'
  | 'pauseCount'
  | 'jitterBufferDelay'
  | 'jitterBufferEmittedCount'
> & { powerEfficientDecoder?: boolean };

/** Whether the receiver took the video sync buffer as its jitter buffer target. */
export interface VfSyncBuffer {
  supported: boolean;
  applied: boolean;
  /** The target the receiver reports, in ms; 0 unless applied, which is also what vf records. */
  targetMs: number;
}

export interface EgressInput {
  channel: number;
  time: Date;
  peer: Pick<
    RTCPeerConnection,
    'connectionState' | 'iceConnectionState' | 'iceGatheringState' | 'signalingState'
  >;
  inbound: InboundVideoReport;
  /** Measured between this sample and the previous one; 0 on the first. */
  bitrateBps: number;
  dataChannelState: RTCDataChannelState;
  /** The tile's latest frame stats; null before it reported any for this stream. */
  frameStats: NeatFrameStats | null;
  videoSyncBufferMs: number;
  metadataRetentionMs: number;
  syncBuffer: VfSyncBuffer;
}

/**
 * vf's `BrowserEgressReport` (webrtc/egress_stats.go). Optional fields are Go pointers or
 * `omitempty` values the browser may not report; they are left out rather than sent as null.
 */
export interface BrowserEgressReport {
  type: 'browser_egress_stats';
  channel: number;
  time: string;
  connection: {
    connection_state: string;
    ice_connection_state: string;
    ice_gathering_state: string;
    signaling_state: string;
  };
  inbound_rtp: {
    bytes_received?: number;
    packets_received?: number;
    packets_lost?: number;
    frames_received?: number;
    frames_decoded?: number;
    frames_dropped?: number;
    frames_per_second?: number;
    decoder_implementation?: string;
    power_efficient_decoder?: boolean;
    frame_width?: number;
    frame_height?: number;
    freeze_count?: number;
    pause_count?: number;
    bitrate_bps: number;
    average_jitter_buffer_delay_ms: number;
  };
  video: {
    ready_state: number;
    paused: boolean;
    current_time: number;
    video_width?: number;
    video_height?: number;
    last_frame_age_ms?: number;
    active: boolean;
  };
  data_channel: { state: string; metadata_messages_per_sec: number };
  synchronization: {
    video_sync_buffer_ms: number;
    metadata_retention_ms: number;
    jitter_buffer_target_supported: boolean;
    jitter_buffer_target_applied: boolean;
    jitter_buffer_target_ms: number;
    timestamp_matches: number;
    arrival_fallbacks: number;
    frame_misses: number;
    metadata_expired: number;
    metadata_evicted: number;
    metadata_late: number;
    metadata_lateness_recent_median_ms?: number;
    metadata_lateness_recent_max_ms?: number;
    untimestamped_metadata_received: number;
    timestamped_metadata_pending: number;
    arrival_metadata_pending: number;
  };
}

/*
 * vf unmarshals the report in one go, and a single field of the wrong JSON type (a fraction sent
 * into a Go integer, a negative into an unsigned one) drops the whole report without a trace. So
 * every integer field goes through `unsigned` or `signed`, and a value the browser did not report,
 * or reported as NaN, becomes undefined and is left out (`present`).
 */
function finite(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function unsigned(value: number | null | undefined): number | undefined {
  const number = finite(value);
  return number === undefined ? undefined : Math.max(0, Math.round(number));
}

function signed(value: number | null | undefined): number | undefined {
  const number = finite(value);
  return number === undefined ? undefined : Math.round(number);
}

function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Drops the fields set to undefined, so the report holds exactly the fields that are sent. */
function present<T extends object>(group: T): T {
  return Object.fromEntries(Object.entries(group).filter(([, value]) => value !== undefined)) as T;
}

/** The video group before the tile has reported: an element without a stream. */
const NO_VIDEO: BrowserEgressReport['video'] = {
  ready_state: 0,
  paused: true,
  current_time: 0,
  active: false,
};

function videoGroup(video: NeatFrameStats['video'] | undefined): BrowserEgressReport['video'] {
  if (video === undefined) return NO_VIDEO;
  return present({
    ready_state: unsigned(video.readyState) ?? 0,
    paused: video.paused,
    current_time: finite(video.currentTime) ?? 0,
    video_width: unsigned(video.videoWidth),
    video_height: unsigned(video.videoHeight),
    last_frame_age_ms: signed(video.lastFrameAgeMs),
    active: video.active,
  });
}

/** The `browser_egress_stats` message vf expects on the data channel for one inbound video report. */
export function buildEgressReport(input: EgressInput): BrowserEgressReport {
  const { inbound, frameStats, peer, syncBuffer } = input;
  const emitted = inbound.jitterBufferEmittedCount ?? 0;
  const jitterBufferDelayMs = emitted > 0 ? ((inbound.jitterBufferDelay ?? 0) / emitted) * 1000 : 0;

  return {
    type: 'browser_egress_stats',
    channel: input.channel,
    time: input.time.toISOString(),
    connection: {
      connection_state: peer.connectionState,
      ice_connection_state: peer.iceConnectionState,
      ice_gathering_state: peer.iceGatheringState,
      signaling_state: peer.signalingState,
    },
    inbound_rtp: present({
      bytes_received: unsigned(inbound.bytesReceived),
      packets_received: unsigned(inbound.packetsReceived),
      packets_lost: signed(inbound.packetsLost),
      frames_received: unsigned(inbound.framesReceived),
      frames_decoded: unsigned(inbound.framesDecoded),
      frames_dropped: unsigned(inbound.framesDropped),
      frames_per_second: finite(inbound.framesPerSecond),
      decoder_implementation: inbound.decoderImplementation,
      power_efficient_decoder: inbound.powerEfficientDecoder,
      frame_width: unsigned(inbound.frameWidth),
      frame_height: unsigned(inbound.frameHeight),
      freeze_count: unsigned(inbound.freezeCount),
      pause_count: unsigned(inbound.pauseCount),
      bitrate_bps: oneDecimal(input.bitrateBps),
      average_jitter_buffer_delay_ms: oneDecimal(jitterBufferDelayMs),
    }),
    video: videoGroup(frameStats?.video),
    data_channel: {
      state: input.dataChannelState,
      metadata_messages_per_sec: unsigned(frameStats?.metadataMessagesPerSecond) ?? 0,
    },
    synchronization: present({
      video_sync_buffer_ms: unsigned(input.videoSyncBufferMs) ?? 0,
      metadata_retention_ms: unsigned(input.metadataRetentionMs) ?? 0,
      jitter_buffer_target_supported: syncBuffer.supported,
      jitter_buffer_target_applied: syncBuffer.applied,
      jitter_buffer_target_ms: finite(syncBuffer.targetMs) ?? 0,
      timestamp_matches: unsigned(frameStats?.timestampMatches) ?? 0,
      arrival_fallbacks: unsigned(frameStats?.arrivalFallbacks) ?? 0,
      frame_misses: unsigned(frameStats?.frameMisses) ?? 0,
      metadata_expired: unsigned(frameStats?.expired) ?? 0,
      metadata_evicted: unsigned(frameStats?.evicted) ?? 0,
      metadata_late: unsigned(frameStats?.late) ?? 0,
      metadata_lateness_recent_median_ms: finite(frameStats?.recentLatenessMedianMs),
      metadata_lateness_recent_max_ms: finite(frameStats?.recentLatenessMaxMs),
      untimestamped_metadata_received: unsigned(frameStats?.untimestampedReceived) ?? 0,
      timestamped_metadata_pending: unsigned(frameStats?.timestampedPending) ?? 0,
      arrival_metadata_pending: unsigned(frameStats?.arrivalPending) ?? 0,
    }),
  };
}
