import { bufferSettleMs } from '@sima/neat-ui';
import { LateChip, type LatenessSource } from './late-chip';

/** A tile's lateness window as the chip sees it: a share the test sets, and a reset counter. */
class FakeTile implements LatenessSource {
  share: number | null = null;
  resets = 0;
  snapshot() {
    return { recentLateShare: this.share };
  }
  resetLatenessWindow(): void {
    this.resets += 1;
  }
}

describe('LateChip', () => {
  let tile: FakeTile;
  let chip: LateChip;

  beforeEach(() => {
    tile = new FakeTile();
    chip = new LateChip();
  });

  it('turns on at half the messages late and off below a tenth (Inv §4g hysteresis)', () => {
    tile.share = 0.4;
    expect(chip.tick(tile, 0)).toBe(false);
    tile.share = 0.5;
    expect(chip.tick(tile, 1000)).toBe(true);
    tile.share = 0.2;
    expect(chip.tick(tile, 2000)).toBe(true);
    tile.share = null;
    expect(chip.tick(tile, 3000)).toBe(true);
    tile.share = 0.09;
    expect(chip.tick(tile, 4000)).toBe(false);
  });

  it('a buffer change resets the window, turns the chip off and keeps it off while the buffer settles', () => {
    tile.share = 0.9;
    expect(chip.tick(tile, 0)).toBe(true);

    chip.bufferChanged(tile, 300, 500, 1000);
    expect(tile.resets).toBe(1);
    const settled = 1000 + bufferSettleMs(300, 500);

    // Every tick inside the settle time measures afresh: the window is reset again.
    expect(chip.tick(tile, settled - 1)).toBe(false);
    expect(tile.resets).toBe(2);

    expect(chip.tick(tile, settled)).toBe(true);
    expect(tile.resets).toBe(2);
  });

  it('reset turns the chip off without a settle time', () => {
    tile.share = 0.9;
    chip.tick(tile, 0);

    chip.reset();
    tile.share = 0.3;
    expect(chip.tick(tile, 1000)).toBe(false);
    expect(tile.resets).toBe(0);
  });
});
