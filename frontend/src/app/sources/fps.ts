/**
 * The rules for a slot's output frame rate (#170's `fps.js`, issue #111). A file streams at its
 * own rate unless the slot sets another, which the server serves from a rendition: a copy of the
 * file re-encoded at that rate, made on start (the slot is `preparing` meanwhile).
 *
 * The minimum is the server's. There is no maximum: the server refuses a rate that no codec level
 * covers, with a message that names the highest it can do.
 */

import type { Slot } from '../api.generated';

export const FPS_MIN = 1;
export const FPS_STEP = 5;

/** The rate one step of the stepper's − (`direction < 0`) or + gives, never below the minimum. */
export function stepFps(value: number, direction: number): number {
  const next = Number(value) + (direction < 0 ? -FPS_STEP : FPS_STEP);
  return Math.max(FPS_MIN, next);
}

/** A typed rate: whole digits, at least the minimum; null for anything else. */
export function parseFps(text: string | null | undefined): number | null {
  if (text == null) return null;
  const trimmed = String(text).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (value < FPS_MIN || !Number.isSafeInteger(value)) return null;
  return value;
}

/**
 * The rate a slot streams at when it is not the file's own: its override when it differs from the
 * native rate, else null. The app's one rule for "a custom rate" (the row's "· rendition", the
 * panel's pending rendition). A native rate the server has not probed yet is unknown, so an
 * override then counts as custom: the server encodes for it.
 */
export function customRate(slot: Pick<Slot, 'fps' | 'native_fps'>): number | null {
  return slot.fps !== undefined && slot.fps !== slot.native_fps ? slot.fps : null;
}

/**
 * A time as `m:ss`, or `h:mm:ss` from an hour on, cut to whole seconds: the app's one clock (a
 * file's duration, a recording's length).
 */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mmss = `${minutes}:${String(secs).padStart(2, '0')}`;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : mmss;
}

/** How a frame-rate commit ended: the server took the rate, or refused it (already reported). */
export interface CommitResult {
  readonly ok: boolean;
}

/** A start awaits every pending rate commit; it must not post if any was refused. */
export function allCommitsSucceeded(results: readonly CommitResult[]): boolean {
  return results.every((result) => result.ok);
}
