import { bufferSettleMs, type NeatMetadataSnapshot, nextWarningActive } from '@sima/neat-ui/video';

/** The tile's lateness window, as the chip reads and resets it; `NeatVideoTile` is one. */
export interface LatenessSource {
  snapshot(): Pick<NeatMetadataSnapshot, 'recentLateShare'>;
  resetLatenessWindow(): void;
}

/**
 * Whether a tile's "Metadata late" chip is on, judged once per stats tick. It turns on
 * when half the recent messages arrive after their frame and off below a tenth.
 *
 * A change of the video sync buffer makes what was measured meaningless: the window is reset, the
 * chip goes off, and it stays off while the new buffer settles (`bufferSettleMs`), every tick in
 * that time resetting the window again so the next judgement sees only the new buffer.
 */
export class LateChip {
  private active = false;
  private settleUntil = Number.NEGATIVE_INFINITY;

  /** One stats tick at `now` (the `performance.now()` clock); returns whether the chip is on. */
  tick(source: LatenessSource, now: number): boolean {
    if (now < this.settleUntil) {
      source.resetLatenessWindow();
      return false;
    }
    this.active = nextWarningActive(this.active, source.snapshot().recentLateShare);
    return this.active;
  }

  bufferChanged(source: LatenessSource, previousMs: number, nextMs: number, now: number): void {
    source.resetLatenessWindow();
    this.active = false;
    this.settleUntil = now + bufferSettleMs(previousMs, nextMs);
  }

  /** Turns the chip off, as for a new stream whose lateness is still unknown. */
  reset(): void {
    this.active = false;
  }
}
