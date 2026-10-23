import { ChannelPlayback } from './channel-playback';

describe('ChannelPlayback', () => {
  it('a channel is not playing until its tile publishes that it is', () => {
    const playback = new ChannelPlayback();

    expect(playback.of(4)()).toBe(false);
  });

  it('keeps one flag per channel, replaced by each publish and dropped by clear', () => {
    const playback = new ChannelPlayback();
    const four = playback.of(4);

    playback.publish(4, true);
    playback.publish(5, true);
    expect(four()).toBe(true);
    expect(playback.of(5)()).toBe(true);

    playback.publish(4, false);
    expect(four()).toBe(false);

    playback.publish(4, true);
    playback.clear(4);
    expect(four()).toBe(false);
    expect(playback.of(5)()).toBe(true);
  });
});
