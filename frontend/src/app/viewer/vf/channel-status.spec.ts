import {
  formatChannelStatus,
  offerFailureText,
  resolveCodecLabel,
  type VfStatus,
} from './channel-status';

function statsWith(codecId: string, codecReport: object): ReadonlyMap<string, unknown> {
  return new Map([[codecId, codecReport]]);
}

const CONNECTED: VfStatus = {
  phase: 'connected',
  codec: 'H.265',
  width: 1280,
  height: 720,
  fps: 30,
  kbps: 4200,
  messagesPerSecond: 30,
};

const FAILED: VfStatus = {
  phase: 'failed',
  codec: null,
  width: null,
  height: null,
  fps: null,
  kbps: 0,
  messagesPerSecond: 0,
};

describe('resolveCodecLabel', () => {
  it("resolves the negotiated codec through the report's codecId", () => {
    const stats = statsWith('C1', { type: 'codec', mimeType: 'video/H265' });
    expect(resolveCodecLabel(stats, { codecId: 'C1' })).toBe('H.265');

    const h264 = statsWith('C2', { type: 'codec', mimeType: 'video/H264' });
    expect(resolveCodecLabel(h264, { codecId: 'C2' })).toBe('H.264');
  });

  it('matches encoding names case-insensitively', () => {
    const stats = statsWith('C1', { mimeType: 'video/h265' });
    expect(resolveCodecLabel(stats, { codecId: 'C1' })).toBe('H.265');
  });

  it('shows an unrecognized encoding as reported rather than hiding it', () => {
    const stats = statsWith('C1', { mimeType: 'video/VP8' });
    expect(resolveCodecLabel(stats, { codecId: 'C1' })).toBe('VP8');
  });

  it('keeps the codec unknown when it cannot be resolved', () => {
    const stats = statsWith('C1', { mimeType: 'video/H265' });
    expect(resolveCodecLabel(stats, {}), 'no codecId on the report').toBeNull();
    expect(resolveCodecLabel(stats, { codecId: 'missing' }), 'codecId not in stats').toBeNull();
    expect(resolveCodecLabel(statsWith('C1', {}), { codecId: 'C1' }), 'no mimeType').toBeNull();
    expect(resolveCodecLabel(undefined, { codecId: 'C1' }), 'no stats').toBeNull();
  });
});

describe('formatChannelStatus', () => {
  it('shows the codec first, then size, frame rate, bitrate and message rate', () => {
    expect(formatChannelStatus(CONNECTED)).toBe(
      'H.265 · 1280×720 · 30.0 fps · 4200.0 kb/s · 30 msg/s',
    );
  });

  it('omits the codec segment while the codec is unknown', () => {
    expect(formatChannelStatus({ ...CONNECTED, codec: null })).toBe(
      '1280×720 · 30.0 fps · 4200.0 kb/s · 30 msg/s',
    );
  });

  it('carries the codec in the unsupported-decoder warning when known', () => {
    const unsupported = offerFailureText(415);
    expect(formatChannelStatus({ ...FAILED, codec: 'H.265', failure: unsupported })).toBe(
      'H.265 · Codec not supported by this browser',
    );
    expect(formatChannelStatus({ ...FAILED, failure: unsupported })).toBe(
      'Codec not supported by this browser',
    );
  });

  it('marks a size and frame rate the browser has not reported yet', () => {
    expect(
      formatChannelStatus({ ...CONNECTED, width: null, height: null, fps: null, kbps: 0 }),
    ).toBe('H.265 · ?×? · N/A fps · 0.0 kb/s · 30 msg/s');
  });

  it('says "Waiting for stream" while the server has nothing to send, and nothing while connecting', () => {
    expect(formatChannelStatus({ ...FAILED, phase: 'waiting' })).toBe('Waiting for stream');
    // The tile's label already names the channel, which is all the original showed then.
    expect(formatChannelStatus({ ...FAILED, phase: 'connecting' })).toBe('');
  });

  it('reports any other rejected offer as a connection failure with its HTTP status', () => {
    expect(formatChannelStatus({ ...FAILED, failure: offerFailureText(404) })).toBe(
      'Connection failed: HTTP 404',
    );
  });
});
