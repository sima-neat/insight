/**
 * The rules for a slot's output frame rate (#170's `fps.js`, issue #111). A file streams at its
 * own rate unless the slot sets another, which the server serves from a rendition: a copy of the
 * file re-encoded at that rate, made on start.
 *
 * The minimum is the backend's (`neat_insight/renditions.py`). There is no maximum: the backend
 * refuses a rate that no codec level covers, with a message that names the highest it can do.
 */

import type { Slot } from './api';

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

/** True when a slot streams at its source's own rate: no override, or one equal to the native rate. */
export function isNativeRate(fps: number | null | undefined, nativeFps: number | null | undefined) {
  return fps == null || (nativeFps != null && fps === nativeFps);
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mmss = `${minutes}:${String(secs).padStart(2, '0')}`;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : mmss;
}

/** How far an encode has got, as `m:ss / m:ss` (or `m:ss` alone while the length is unknown). */
export function formatFpsProgress({
  seconds,
  total,
}: {
  seconds: number;
  total: number | null;
}): string {
  const done = clock(Number(seconds) || 0);
  return total != null && Number.isFinite(total) && total > 0 ? `${done} / ${clock(total)}` : done;
}

/** True when starting the slot needs a rendition: an override that differs from the native rate. */
export function needsRendition(slot: Pick<Slot, 'fps' | 'native_fps'> | null | undefined): boolean {
  return slot != null && slot.fps != null && slot.fps !== slot.native_fps;
}

/**
 * True when a slot in `next` plays at a custom rate it did not play at in `previous`: a start that
 * may have encoded a rendition, from this page, another tab or the API.
 */
export function renditionMayHaveChanged(
  previous: readonly Pick<Slot, 'index' | 'file' | 'fps' | 'state'>[],
  next: readonly Pick<Slot, 'index' | 'file' | 'fps' | 'state'>[],
): boolean {
  const playing = (slot: Pick<Slot, 'file' | 'fps' | 'state'>) =>
    slot.state === 'playing' && slot.fps != null ? `${slot.file}@${slot.fps}` : null;
  const before = new Map(previous.map((slot) => [slot.index, playing(slot)]));
  return next.some((slot) => playing(slot) != null && playing(slot) !== before.get(slot.index));
}

/** How a frame-rate commit ended: the rate the server took, or a refusal (already reported). */
export type CommitResult = { ok: true; fps: number | null } | { ok: false };

/**
 * The slot a start should act on once a pending rate commit has settled: `result` is undefined
 * when nothing was pending, a landed commit applies its rate, and a failed one gives null (the
 * start then does nothing; the commit has reported its error).
 */
export function withCommittedFps<T extends { fps?: number | null }>(
  slot: T | null | undefined,
  result: CommitResult | undefined,
): T | null {
  if (!slot) return null;
  if (result === undefined) return slot;
  if (!result.ok) return null;
  return { ...slot, fps: result.fps };
}

/** A bulk start awaits every pending rate commit; it must not post if any was refused. */
export function allCommitsSucceeded(results: readonly CommitResult[]): boolean {
  return results.every((result) => result && result.ok);
}
