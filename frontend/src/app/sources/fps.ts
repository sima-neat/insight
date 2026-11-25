/**
 * The rules for a slot's output frame rate (sima-neat/insight#111). A file streams at its
 * own rate unless the slot sets another, which the server serves from a rendition: a copy of the
 * file re-encoded at that rate, made on start (the slot is `preparing` meanwhile).
 *
 * The minimum is the server's. There is no maximum: the server refuses a rate that no codec level
 * covers, with a message that names the highest it can do.
 */

import type { Slot } from '../api.generated';

export const FPS_MIN = 1;
export const FPS_STEP = 5;

/**
 * The rate a slot streams at when it is not the file's own: its override when it differs from the
 * native rate, else null. The app's one rule for "a custom rate" (the row's "· rendition", the
 * panel's pending rendition). A native rate the server has not probed yet is unknown, so an
 * override then counts as custom: the server encodes for it.
 */
export function customRate(slot: Pick<Slot, 'fps' | 'native_fps'>): number | null {
  return slot.fps !== undefined && slot.fps !== slot.native_fps ? slot.fps : null;
}

/** How a frame-rate commit ended: the server took the rate, or refused it (already reported). */
export interface CommitResult {
  readonly ok: boolean;
}

/** A start awaits every pending rate commit; it must not post if any was refused. */
export function allCommitsSucceeded(results: readonly CommitResult[]): boolean {
  return results.every((result) => result.ok);
}
