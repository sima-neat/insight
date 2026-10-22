import { HttpClient } from '@angular/common/http';
import { DestroyRef, DOCUMENT, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

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
 * the proxy answering 502) nothing is known: `live` is null and `unavailable` says why, until a
 * request succeeds again.
 *
 * Provided by the Viewer page, so polling ends with it.
 */
@Injectable()
export class ChannelLiveness {
  private readonly http = inject(HttpClient);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  private readonly liveState = signal<ReadonlySet<number> | null>(null);
  private readonly unavailableState = signal(false);
  /** The live channels; null while disabled, before the first answer and while unavailable. */
  readonly live = this.liveState.asReadonly();
  /** The newest request failed, so which channels are live is unknown. */
  readonly unavailable = this.unavailableState.asReadonly();

  private enabled = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The number of the last request sent, and of the newest one that has settled. */
  private sent = 0;
  private shown = 0;

  constructor() {
    const onVisibilityChange = () => this.schedule();
    this.document.addEventListener('visibilitychange', onVisibilityChange);
    this.destroyRef.onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisibilityChange);
      this.stopTimer();
    });
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      // Answers to requests sent so far describe a moment before this; never show them.
      this.shown = this.sent;
      this.liveState.set(null);
      this.unavailableState.set(false);
    }
    this.schedule();
  }

  private schedule(): void {
    const run = this.enabled && this.document.visibilityState === 'visible';
    if (run && this.timer === null) {
      this.poll();
      this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    } else if (!run) {
      this.stopTimer();
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private poll(): void {
    const request = ++this.sent;
    this.http
      .get<unknown>(STATS_URL)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (stats) => this.settle(request, liveChannels(stats)),
        // vf down or too slow; the next poll tries again.
        error: () => this.settle(request, null),
      });
  }

  /** Takes the outcome of `request` (the live set, or null for a failure) unless a newer one came. */
  private settle(request: number, live: ReadonlySet<number> | null): void {
    if (request <= this.shown) return;
    this.shown = request;
    this.liveState.set(live);
    this.unavailableState.set(live === null);
  }
}
