import { formatChannelStats } from './channel-status';

describe('formatChannelStats', () => {
  it('says what arrives on a connected channel, the codec as people write it', () => {
    expect(
      formatChannelStats(
        {
          codec: 'H265',
          width: 1920,
          height: 1080,
          framesPerSecond: 29.97,
          bitsPerSecond: 4_200_000,
        },
        30,
      ),
    ).toBe('H.265 · 1920×1080 · 30.0 fps · 4.2 Mbit/s · 30 msg/s');
  });

  it('says JPEG as it is', () => {
    expect(
      formatChannelStats(
        {
          codec: 'JPEG',
          width: 640,
          height: 480,
          framesPerSecond: 15,
          bitsPerSecond: 812_400,
        },
        15,
      ),
    ).toBe('JPEG · 640×480 · 15.0 fps · 812 kbit/s · 15 msg/s');
  });

  it('leaves out what the browser has not reported, and keeps a codec it has no label for', () => {
    expect(
      formatChannelStats(
        { codec: 'VP8', width: null, height: null, framesPerSecond: null, bitsPerSecond: 0 },
        0,
      ),
    ).toBe('VP8 · 0 kbit/s · 0 msg/s');
  });

  it('is empty while the channel is not connected', () => {
    expect(formatChannelStats(null, 12)).toBe('');
  });
});
