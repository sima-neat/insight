import { Injectable, signal, type Signal, type WritableSignal } from '@angular/core';
import type { NeatLatenessSnapshot } from '@sima/neat-ui/video';

/** What a channel's grid tile last measured of how late its metadata arrives. */
export interface LatenessReading {
  /** Whether the tile's "Metadata late" warning is on (Inv §4g): judged late, and playing. */
  readonly active: boolean;
  /** The tile's lateness window at its last stats tick; null before the first one. */
  readonly snapshot: NeatLatenessSnapshot | null;
}

/**
 * The lateness each grid tile measures, for the inspector's status and late notice. Only grid
 * tiles publish: they are the ones whose stats reach the connection and whose window is reset
 * when the sync buffer changes, so the inspector's preview of the same channel measures nothing
 * that counts. A channel without a grid tile on screen has no reading.
 *
 * A reading changes at most once per stats tick. Provided by the Viewer page.
 */
@Injectable()
export class ChannelLateness {
  // A plain map, as in the settings store: `of(n)` may add a channel while a template reads it.
  private readonly readings = new Map<number, WritableSignal<LatenessReading | null>>();

  /** The channel's reading, null while no grid tile of it publishes one. */
  of(channel: number): Signal<LatenessReading | null> {
    return this.entry(channel);
  }

  publish(channel: number, reading: LatenessReading): void {
    this.entry(channel).set(reading);
  }

  /** The channel's grid tile is gone: what it measured no longer describes anything on screen. */
  clear(channel: number): void {
    this.readings.get(channel)?.set(null);
  }

  private entry(channel: number): WritableSignal<LatenessReading | null> {
    let reading = this.readings.get(channel);
    if (reading === undefined) {
      reading = signal(null);
      this.readings.set(channel, reading);
    }
    return reading;
  }
}
