import { DestroyRef, DOCUMENT, inject } from '@angular/core';

/**
 * A timer that polls only while it is active and the page is visible: a hidden tab shows nothing,
 * so it asks again the moment the page shows. Activating it, and the page becoming visible while
 * it is active, call `poll` at once; then it calls it every `intervalMs`. Call it where an
 * injection context exists: it stops when that context is destroyed.
 */
export function visiblePoller(
  intervalMs: number,
  poll: () => void,
): { setActive(active: boolean): void } {
  const document = inject(DOCUMENT);
  let active = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const schedule = () => {
    const run = active && document.visibilityState === 'visible';
    if (run && timer === null) {
      poll();
      timer = setInterval(poll, intervalMs);
    } else if (!run) {
      stop();
    }
  };

  document.addEventListener('visibilitychange', schedule);
  inject(DestroyRef).onDestroy(() => {
    document.removeEventListener('visibilitychange', schedule);
    stop();
  });

  return {
    setActive(next: boolean) {
      if (next === active) return;
      active = next;
      schedule();
    },
  };
}

/**
 * Numbers requests so that the newest answer wins: a slow answer that arrives after a newer one
 * must never overwrite it. `next()` when sending, then `accept(request)` when the answer is in;
 * apply the answer only if it returns true. An answer that arrives before a newer one is
 * accepted, which suits a list that the newer answer replaces a moment later; an answer that is
 * only of use as the last one asked for (the info of the file now selected) checks `isNewest`.
 */
export class LatestOnly {
  /** The number of the last request sent, and of the newest one whose answer was taken. */
  private sent = 0;
  private taken = 0;

  next(): number {
    return ++this.sent;
  }

  accept(request: number): boolean {
    if (request <= this.taken) return false;
    this.taken = request;
    return true;
  }

  /** Whether no request has been sent since `request`. */
  isNewest(request: number): boolean {
    return request === this.sent;
  }

  /** Refuses the answers of every request sent so far: they describe a moment that is past. */
  discard(): void {
    this.taken = this.sent;
  }
}
