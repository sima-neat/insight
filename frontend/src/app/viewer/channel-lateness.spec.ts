import { ChannelLateness } from './channel-lateness';

const LATE = { recentLateShare: 0.8, recentLatenessMedianMs: 90, recentLatenessP90Ms: 140 };

describe('ChannelLateness', () => {
  it('has no reading for a channel until its tile publishes one', () => {
    const lateness = new ChannelLateness();

    expect(lateness.of(4)()).toBeNull();
  });

  it('keeps one reading per channel, replaced by each publish and dropped by clear', () => {
    const lateness = new ChannelLateness();
    const four = lateness.of(4);

    lateness.publish(4, { active: true, snapshot: LATE });
    lateness.publish(5, { active: false, snapshot: null });

    expect(four()).toEqual({ active: true, snapshot: LATE });
    expect(lateness.of(5)()).toEqual({ active: false, snapshot: null });

    lateness.publish(4, { active: false, snapshot: LATE });
    expect(four()).toEqual({ active: false, snapshot: LATE });

    lateness.clear(4);
    expect(four()).toBeNull();
    expect(lateness.of(5)()).toEqual({ active: false, snapshot: null });
  });
});
