import { computed, effect, type Signal, untracked } from '@angular/core';
import type { SyncSettings } from './settings/schema';
import type { VfConnection } from './vf/vf-connection';

/** The part of a channel connection that takes the channel's sync settings. */
export type SyncTarget = Pick<VfConnection, 'setSyncBuffer'>;

/**
 * Keeps a held connection in step with its channel's video sync buffer (from
 * `store.general(channel)`): applied when it changes, and when the connection does. Every holder of
 * a channel's connection (its grid tile, the inspector's preview) calls this, because either may be
 * the only one holding it; the same value applied twice changes nothing.
 *
 * Only the buffer is followed: the connection re-applies its jitter buffer target on every call,
 * which a change to another setting (the retention, which the tile applies) has no reason to cause.
 * Call it in an injection context.
 */
export function followSyncSettings(
  connection: Signal<SyncTarget | null>,
  sync: Signal<SyncSettings | null>,
): void {
  const bufferMs = computed(() => sync()?.videoSyncBufferMs ?? null);
  effect(() => {
    const target = connection();
    const value = bufferMs();
    if (target !== null && value !== null) untracked(() => target.setSyncBuffer(value));
  });
}
