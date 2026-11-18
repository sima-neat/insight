import { HttpClient } from '@angular/common/http';
import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LatestOnly, visiblePoller } from '../polling';

const CHANNELS_URL = '/api/channels';
const POLL_INTERVAL_MS = 2000;

/**
 * The channels a `/api/channels` answer says receive video. It lists every channel the server
 * serves, live or not; a channel is live while its `video.active` is true (video arrived in the
 * last 3 s). Anything malformed is skipped, since this is JSON from over the network.
 */
export function liveChannels(answer: unknown): ReadonlySet<number> {
  const channels = (answer as { channels?: unknown } | null)?.channels;
  const live = new Set<number>();
  if (!Array.isArray(channels)) return live;
  for (const entry of channels as unknown[]) {
    const { channel, video } = (entry ?? {}) as { channel?: unknown; video?: unknown };
    const active = (video as { active?: unknown } | null | undefined)?.active;
    if (active === true && typeof channel === 'number' && Number.isInteger(channel)) {
      live.add(channel);
    }
  }
  return live;
}

/**
 * Which channels Insight's server receives video on, for the Viewer's "Hide empty". It polls
 * `/api/channels` every 2 s, but only while enabled and while the page is visible: a hidden tab
 * shows nothing, so it asks again the moment it shows. A slow answer that arrives after a newer
 * one is dropped, so the newest answer always wins. When the newest request failed (the server
 * unreachable or answering with an error) `unavailable` says so until a request succeeds again,
 * and `live` keeps the last good answer: one lost poll must not swing the grid to every channel and
 * back, opening and closing connections each time.
 *
 * Provided by the Viewer page, so polling ends with it.
 */
@Injectable()
export class ChannelLiveness {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  private readonly liveState = signal<ReadonlySet<number> | null>(null);
  private readonly unavailableState = signal(false);
  /** The last good answer's live channels; null while disabled or before any good answer. */
  readonly live = this.liveState.asReadonly();
  /** The newest request failed, so `live` may be out of date (or, before any answer, absent). */
  readonly unavailable = this.unavailableState.asReadonly();

  private readonly latest = new LatestOnly();
  private readonly poller = visiblePoller(POLL_INTERVAL_MS, () => this.poll());

  setEnabled(enabled: boolean): void {
    if (!enabled) {
      // Answers to requests sent so far describe a moment before this; never show them.
      this.latest.discard();
      this.liveState.set(null);
      this.unavailableState.set(false);
    }
    this.poller.setActive(enabled);
  }

  private poll(): void {
    const request = this.latest.next();
    this.http
      .get<unknown>(CHANNELS_URL)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (answer) => this.settle(request, liveChannels(answer)),
        // The server unreachable or too slow; the next poll tries again.
        error: () => this.settle(request, null),
      });
  }

  /**
   * Takes the outcome of `request`, unless a newer one has settled: a good answer replaces the live
   * set, a failure (null) only marks it unavailable.
   */
  private settle(request: number, live: ReadonlySet<number> | null): void {
    if (!this.latest.accept(request)) return;
    this.unavailableState.set(live === null);
    if (live !== null) this.liveState.set(live);
  }
}
