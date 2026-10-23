import { HttpClient } from '@angular/common/http';
import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LatestOnly, visiblePoller } from '../polling';

const STATS_URL = '/api/ingest/stats';
const POLL_INTERVAL_MS = 2000;

/**
 * The channels an ingest stats answer reports active. Without `all=1` vf lists only channels that
 * received video in the last few seconds (`active_ttl_ms`), each with `active: true`; the flag is
 * still checked, and anything malformed is skipped, since this is another process's JSON.
 */
export function liveChannels(stats: unknown): ReadonlySet<number> {
  const channels = (stats as { channels?: unknown } | null)?.channels;
  const live = new Set<number>();
  if (!Array.isArray(channels)) return live;
  for (const entry of channels as unknown[]) {
    const { channel, active } = (entry ?? {}) as { channel?: unknown; active?: unknown };
    if (active === true && typeof channel === 'number' && Number.isInteger(channel)) {
      live.add(channel);
    }
  }
  return live;
}

/**
 * Which channels vf receives video on, for the Viewer's "Hide empty". It polls Insight's
 * `/api/ingest/stats` proxy every 2 s, but only while enabled and while the page is visible: a
 * hidden tab shows nothing, so it asks again the moment it shows. A slow answer that arrives after
 * a newer one is dropped, so the newest answer always wins. When the newest request failed (vf down,
 * the proxy answering 502) `unavailable` says so until a request succeeds again, and `live` keeps
 * the last good answer: one lost poll must not swing the grid to every channel and back, opening
 * and closing connections each time.
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
      .get<unknown>(STATS_URL)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (stats) => this.settle(request, liveChannels(stats)),
        // vf down or too slow; the next poll tries again.
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
