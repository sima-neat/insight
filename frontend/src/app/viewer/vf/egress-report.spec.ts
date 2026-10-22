import { buildEgressReport, type EgressInput } from './egress-report';
import { SAMPLE_FRAME_STATS, schemaViolations } from './egress-schema.testing';

/** A Chrome-like sample: every field present, and the counters fractional to prove rounding. */
function fullInput(): EgressInput {
  return {
    channel: 3,
    time: new Date('2026-10-22T12:00:00.000Z'),
    peer: {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      iceGatheringState: 'complete',
      signalingState: 'stable',
    },
    inbound: {
      bytesReceived: 1_000_000.6,
      packetsReceived: 900.2,
      packetsLost: -1.4,
      framesReceived: 300.5,
      framesDecoded: 299,
      framesDropped: 1,
      framesPerSecond: 29.97,
      decoderImplementation: 'ExternalDecoder (D3D11VideoDecoder)',
      powerEfficientDecoder: true,
      frameWidth: 1920,
      frameHeight: 1080,
      freezeCount: 0,
      pauseCount: 0,
      jitterBufferDelay: 9.876,
      jitterBufferEmittedCount: 299,
    },
    bitrateBps: 4_200_123.456,
    dataChannelState: 'open',
    frameStats: SAMPLE_FRAME_STATS,
    videoSyncBufferMs: 300,
    metadataRetentionMs: 0,
    syncBuffer: { supported: true, applied: true, targetMs: 300 },
  };
}

describe('buildEgressReport', () => {
  it('sends every field of vf’s report with the JSON type vf parses it as', () => {
    const report = buildEgressReport(fullInput());

    expect(schemaViolations(report, true)).toEqual([]);
    expect(report).toMatchObject({
      type: 'browser_egress_stats',
      channel: 3,
      time: '2026-10-22T12:00:00.000Z',
    });
  });

  it('rounds the counters to whole numbers and the two rates to one decimal place', () => {
    const report = buildEgressReport(fullInput());

    expect(report.inbound_rtp).toMatchObject({
      bytes_received: 1_000_001,
      packets_received: 900,
      packets_lost: -1,
      frames_received: 301,
      frames_per_second: 29.97,
      bitrate_bps: 4_200_123.5,
      // 9.876 s over 299 frames is 33.03 ms per frame.
      average_jitter_buffer_delay_ms: 33,
    });
    expect(report.video.current_time).toBe(12.345);
  });

  it('copies the tile’s frame stats into the video, data channel and synchronization groups', () => {
    const report = buildEgressReport(fullInput());

    expect(report.video).toStrictEqual({
      ready_state: 4,
      paused: false,
      current_time: 12.345,
      video_width: 1920,
      video_height: 1080,
      last_frame_age_ms: 16,
      active: true,
    });
    expect(report.data_channel).toStrictEqual({ state: 'open', metadata_messages_per_sec: 30 });
    expect(report.synchronization).toStrictEqual({
      video_sync_buffer_ms: 300,
      metadata_retention_ms: 0,
      jitter_buffer_target_supported: true,
      jitter_buffer_target_applied: true,
      jitter_buffer_target_ms: 300,
      timestamp_matches: 120,
      arrival_fallbacks: 3,
      frame_misses: 2,
      metadata_expired: 1,
      metadata_evicted: 0,
      metadata_late: 5,
      metadata_lateness_recent_median_ms: 41.5,
      metadata_lateness_recent_max_ms: 88.25,
      untimestamped_metadata_received: 4,
      timestamped_metadata_pending: 6,
      arrival_metadata_pending: 7,
    });
  });

  it('omits what the browser has not reported yet instead of sending null', () => {
    const report = buildEgressReport({
      ...fullInput(),
      inbound: { bytesReceived: 512, framesPerSecond: Number.NaN, jitterBufferEmittedCount: 0 },
      bitrateBps: 0,
      frameStats: null,
      syncBuffer: { supported: false, applied: false, targetMs: 0 },
    });

    expect(schemaViolations(report, false)).toEqual([]);
    expect(report.inbound_rtp).toStrictEqual({
      bytes_received: 512,
      bitrate_bps: 0,
      average_jitter_buffer_delay_ms: 0,
    });
    // Before the tile's first stats the video reads as an element without a stream.
    expect(report.video).toStrictEqual({
      ready_state: 0,
      paused: true,
      current_time: 0,
      active: false,
    });
    expect(report.data_channel.metadata_messages_per_sec).toBe(0);
    expect(report.synchronization).not.toHaveProperty('metadata_lateness_recent_median_ms');
    expect(report.synchronization).toMatchObject({
      jitter_buffer_target_supported: false,
      jitter_buffer_target_ms: 0,
      timestamp_matches: 0,
    });
    expect(JSON.parse(JSON.stringify(report))).toStrictEqual(report);
  });

  it('omits a last frame age and lateness values the tile reports as null', () => {
    const report = buildEgressReport({
      ...fullInput(),
      frameStats: {
        ...SAMPLE_FRAME_STATS,
        recentLatenessMedianMs: null,
        recentLatenessMaxMs: null,
        video: { ...SAMPLE_FRAME_STATS.video, lastFrameAgeMs: null },
      },
    });

    expect(schemaViolations(report, false)).toEqual([]);
    expect(report.video).not.toHaveProperty('last_frame_age_ms');
    expect(report.synchronization).not.toHaveProperty('metadata_lateness_recent_median_ms');
    expect(report.synchronization).not.toHaveProperty('metadata_lateness_recent_max_ms');
  });
});
