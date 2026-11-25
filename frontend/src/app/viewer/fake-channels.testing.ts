import { computed, signal } from '@angular/core';
import type { NeatInsightVideoStats } from '@sima/neat-ui/insight';
import type { NeatEncodedFrames } from '@sima/neat-ui/video';
import type { ViewerChannel, ViewerChannels } from './viewer-channels';

/** A channel's connection without WebRTC: its signals are set by the test. */
export class FakeSource {
  readonly stream = signal<MediaStream | null>(null);
  readonly failure = signal<string | null>(null);
  readonly waiting = signal<string | null>(null);
  readonly notice = computed(() => this.failure() ?? this.waiting());
  readonly videoDelayMs = signal<number | null>(null);
  readonly stats = signal<NeatInsightVideoStats | null>(null);
  readonly frames = signal<NeatEncodedFrames | null>(null);
  /** A browser that holds video, until a test says otherwise. */
  readonly videoBufferSupported = signal(true);
  closed = false;

  onMetadata(): () => void {
    return () => undefined;
  }

  close(): void {
    this.closed = true;
  }
}

/** A channel as the Viewer holds it, its source a `FakeSource`. */
export interface FakeChannel extends Omit<ViewerChannel, 'source'> {
  readonly source: FakeSource;
}

/**
 * Stands in for the page's `ViewerChannels`: one fake channel per channel number, with the holders
 * counted as the real one counts them, and every release recorded.
 */
export class FakeChannels {
  readonly channels = new Map<number, FakeChannel>();
  readonly holders = new Map<number, number>();
  readonly released: number[] = [];
  debug: boolean | null = null;

  /** Provide with `{ provide: ViewerChannels, useValue: fake.asViewerChannels() }`. */
  asViewerChannels(): ViewerChannels {
    return this as unknown as ViewerChannels;
  }

  get(channel: number): ViewerChannel {
    let held = this.channels.get(channel);
    if (held === undefined) {
      held = { source: new FakeSource(), messagesPerSecond: signal(0) };
      this.channels.set(channel, held);
    }
    this.holders.set(channel, (this.holders.get(channel) ?? 0) + 1);
    return held as unknown as ViewerChannel;
  }

  release(channel: number): void {
    this.released.push(channel);
    const holders = (this.holders.get(channel) ?? 0) - 1;
    if (holders > 0) this.holders.set(channel, holders);
    else this.holders.delete(channel);
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled;
  }

  /** The channels something holds now, ascending. */
  held(): number[] {
    return [...this.holders.keys()].sort((a, b) => a - b);
  }
}
