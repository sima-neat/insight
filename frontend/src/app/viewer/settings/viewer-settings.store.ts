import {
  computed,
  inject,
  Injectable,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import type { NeatOverlaySettings } from '@sima/neat-ui/video';
import {
  EMPTY_OVERRIDES,
  followedValue,
  holdsSomething,
  normalizeSettingValue,
  ownValue,
  resolveOverlaySettings,
  resolveSyncSettings,
  resolveValue,
  type ScopeOverrides,
  settingsOverrides,
  withOwnValue,
  withoutOwnValue,
} from './resolver';
import { RoiStore } from './roi-store';
import {
  type SettingId,
  type SettingValues,
  SCALAR_SETTINGS,
  SETTINGS_VERSION,
  type SyncSettings,
} from './schema';
import { ViewerStorage } from './storage';

/** The global settings, or a channel's own values over them. */
export type SettingsScope = 'global' | number;

const GLOBAL_SCOPE = 'settings:global';
// No leading zeros: `settings:channel:007` is not channel 7's name, and must not shadow it.
const CHANNEL_SCOPE = /^settings:channel:(0|[1-9]\d*)$/;

function scopeName(scope: SettingsScope): string {
  return scope === 'global' ? GLOBAL_SCOPE : `settings:channel:${scope}`;
}

/** How many settings the scope holds its own value for. */
function ownValueCount(own: ScopeOverrides): number {
  return SCALAR_SETTINGS.filter(({ id }) => ownValue(own, id) !== undefined).length;
}

/**
 * The viewer's overlay settings: a global scope plus per-channel overrides, one setting at a time.
 * A change applies at once and is stored at once; there is no Save step.
 *
 * Every stored scope is read and parsed when the store opens, and a scope again just before this
 * store writes it. From then on the scopes live in signals, and each channel's resolved settings
 * are a computed signal built on first use and reused, so reading them is free (tiles read them
 * every frame) and a change re-resolves only the channels it reaches: a channel's change its own,
 * a global change every channel. Changes other tabs make show up here only through a write.
 *
 * The regions of interest are not settings: `RoiStore` keeps them under their own names, and each
 * channel's resolved settings carry the regions in effect for it.
 *
 * Provided by the Viewer page, so it ends with the page and the next visit reads storage afresh.
 */
@Injectable()
export class ViewerSettingsStore {
  private readonly storage = inject(ViewerStorage);
  private readonly roi = inject(RoiStore);
  private readonly global = signal(this.read(GLOBAL_SCOPE));
  // A plain map rather than a signal: `resolved(n)` may add a channel while a template or computed
  // reads it, where writing a signal is not allowed. A channel added that way holds nothing yet.
  private readonly channels = new Map<number, WritableSignal<ScopeOverrides>>();
  /** The channels that have held a value of their own, for overridesOf. */
  private readonly ownerChannels = signal<readonly number[]>([]);
  /**
   * Counts the changes this store made to channel scopes, so that `channelOverrides`, which reads
   * storage, is read again by whatever computed it.
   */
  private readonly channelChanges = signal(0);
  private readonly resolvedCache = new Map<number, Signal<NeatOverlaySettings>>();
  private readonly syncCache = new Map<number, Signal<SyncSettings>>();

  constructor() {
    const owners: number[] = [];
    for (const name of this.storage.names()) {
      const match = CHANNEL_SCOPE.exec(name);
      if (match === null) continue;
      const channel = Number(match[1]);
      this.channels.set(channel, signal(this.read(name)));
      owners.push(channel);
    }
    this.ownerChannels.set(owners.sort((a, b) => a - b));
  }

  /** The channel's overlay settings, a new object for each change that reaches the channel. */
  resolved(channel: number): Signal<NeatOverlaySettings> {
    let resolved = this.resolvedCache.get(channel);
    if (resolved === undefined) {
      const own = this.channelSignal(channel);
      const roi = this.roi.effective(channel);
      resolved = computed(() => resolveOverlaySettings(this.global(), own(), roi()));
      this.resolvedCache.set(channel, resolved);
    }
    return resolved;
  }

  /** The channel's video sync buffer and metadata retention; a new object only when one changes. */
  general(channel: number): Signal<SyncSettings> {
    let sync = this.syncCache.get(channel);
    if (sync === undefined) {
      const own = this.channelSignal(channel);
      // The connection re-applies its jitter buffer target on every new value, so an overlay
      // change on the channel must not produce one.
      sync = computed(() => resolveSyncSettings(this.global(), own()), {
        equal: (a, b) =>
          a.videoSyncBufferMs === b.videoSyncBufferMs &&
          a.metadataRetentionMs === b.metadataRetentionMs,
      });
      this.syncCache.set(channel, sync);
    }
    return sync;
  }

  /**
   * The value in effect at the scope: globally its own value or the default, on a channel what the
   * channel resolves to.
   */
  value<Id extends SettingId>(scope: SettingsScope, id: Id): SettingValues[Id] {
    return scope === 'global'
      ? followedValue(this.global(), id)
      : resolveValue(this.global(), this.channelSignal(scope)(), id);
  }

  /** Whether the channel holds its own value for `id`, even one equal to the global value. */
  isOverride(channel: number, id: SettingId): boolean {
    return ownValue(this.channelSignal(channel)(), id) !== undefined;
  }

  /**
   * Stores `value`, normalized to the setting's range, as the scope's own: on a channel an
   * override, globally a change of only that setting for every channel that does not override it.
   */
  set<Id extends SettingId>(scope: SettingsScope, id: Id, value: SettingValues[Id]): void {
    const normalized = normalizeSettingValue(id, value);
    const own = scope === 'global' ? this.global : this.channelSignal(scope);
    if (ownValue(own(), id) === normalized) return;
    this.write(scope, (latest) => withOwnValue(latest, id, normalized));
  }

  /** Gives back the channel's own value for `id`, so the channel follows global again. */
  resetOverride(channel: number, id: SettingId): void {
    if (!this.isOverride(channel, id)) return;
    this.write(channel, (latest) => withoutOwnValue(latest, id));
  }

  /** The channels that override `id`, in ascending order. */
  overridesOf(id: SettingId): number[] {
    return this.ownerChannels().filter((channel) => this.isOverride(channel, id));
  }

  /**
   * How many own values the channel scopes hold in all, and on how many channels, as stored now
   * rather than as this store last read them (see `write`). It is read again after each change
   * this store makes to a channel scope; one another tab makes shows up with the next such change.
   */
  channelOverrides(): { settings: number; channels: number } {
    this.channelChanges();
    let settings = 0;
    let channels = 0;
    for (const name of this.channelScopeNames()) {
      const count = ownValueCount(this.read(name));
      settings += count;
      if (count > 0) channels += 1;
    }
    return { settings, channels };
  }

  /**
   * Every channel gives up every own value, so all channels follow global, and no channel scope
   * stays in storage. The channels are those stored now, which may include ones another tab
   * wrote, and the global scope is untouched.
   */
  resetAllChannels(): void {
    for (const name of this.channelScopeNames()) this.storage.remove(name);
    for (const own of this.channels.values()) own.set(EMPTY_OVERRIDES);
    this.ownerChannels.set([]);
    this.channelChanges.update((changes) => changes + 1);
  }

  /**
   * The late notice's global action: the channel gives up its own
   * value and follows global, which is raised to `value` when below it and never lowered. Both
   * scopes change before anything reads them again, so no one sees half of it.
   */
  raiseGlobal(
    channel: number,
    id: 'general.videoSyncBufferMs',
    value: number,
  ): { raised: boolean } {
    const target = normalizeSettingValue(id, value);
    // Judged on the stored global value, so a higher one another tab stored is never lowered.
    const raised = followedValue(this.read(GLOBAL_SCOPE), id) < target;
    if (raised) this.write('global', (latest) => withOwnValue(latest, id, target));
    this.resetOverride(channel, id);
    return { raised };
  }

  private channelScopeNames(): string[] {
    return this.storage.names().filter((name) => CHANNEL_SCOPE.test(name));
  }

  private channelSignal(channel: number): WritableSignal<ScopeOverrides> {
    let own = this.channels.get(channel);
    if (own === undefined) {
      own = signal(EMPTY_OVERRIDES);
      this.channels.set(channel, own);
    }
    return own;
  }

  private read(name: string): ScopeOverrides {
    const raw = this.storage.get(name);
    if (raw === null) return EMPTY_OVERRIDES;
    try {
      return settingsOverrides(JSON.parse(raw));
    } catch {
      // Not JSON: the scope holds nothing until its next write replaces it.
      return EMPTY_OVERRIDES;
    }
  }

  /**
   * Applies `edit` to the scope as stored now rather than as this store read it: another Viewer
   * tab may have written the scope since, and its keys must survive this change. The result
   * becomes this store's view of the scope too.
   */
  private write(scope: SettingsScope, edit: (latest: ScopeOverrides) => ScopeOverrides): void {
    const name = scopeName(scope);
    const own = edit(this.read(name));
    if (scope === 'global') {
      this.global.set(own);
    } else {
      this.channelSignal(scope).set(own);
      if (!this.ownerChannels().includes(scope)) {
        this.ownerChannels.update((owners) => [...owners, scope].sort((a, b) => a - b));
      }
      this.channelChanges.update((changes) => changes + 1);
    }
    // A scope left holding nothing is removed rather than stored as an empty stub.
    if (holdsSomething(own)) {
      this.storage.set(name, JSON.stringify({ version: SETTINGS_VERSION, ...own }));
    } else {
      this.storage.remove(name);
    }
  }
}
