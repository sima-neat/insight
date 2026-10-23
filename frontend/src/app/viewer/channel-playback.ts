import { Injectable, signal, type Signal, type WritableSignal } from '@angular/core';

/**
 * Whether each channel's grid tile is playing video, for the inspector's ROI backdrop: drawing
 * needs a picture, and only a playing tile has one. Only grid tiles publish, as with
 * `ChannelLateness`; a channel without a grid tile on screen counts as not playing.
 *
 * A flag changes with the tile's state, never per frame. Provided by the Viewer page.
 */
@Injectable()
export class ChannelPlayback {
  // A plain map, as in the settings store: `of(n)` may add a channel while a computed reads it.
  private readonly flags = new Map<number, WritableSignal<boolean>>();

  /** Whether the channel's grid tile plays; false while it has none. */
  of(channel: number): Signal<boolean> {
    return this.entry(channel);
  }

  publish(channel: number, playing: boolean): void {
    this.entry(channel).set(playing);
  }

  /** The channel's grid tile is gone, and with it the video it played. */
  clear(channel: number): void {
    this.flags.get(channel)?.set(false);
  }

  private entry(channel: number): WritableSignal<boolean> {
    let playing = this.flags.get(channel);
    if (playing === undefined) {
      playing = signal(false);
      this.flags.set(channel, playing);
    }
    return playing;
  }
}
