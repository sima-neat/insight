import { DestroyRef, inject, signal, type Signal } from '@angular/core';

/**
 * The current time (`Date.now()`), refreshed every `intervalMs`: what a text that ages while it
 * is shown ("Checked 5 s ago") reads, so that it changes without anything else happening. Call it
 * in an injection context; the timer stops when that context is destroyed.
 */
export function ticking(intervalMs: number): Signal<number> {
  const now = signal(Date.now());
  const timer = setInterval(() => now.set(Date.now()), intervalMs);
  inject(DestroyRef).onDestroy(() => clearInterval(timer));
  return now.asReadonly();
}
