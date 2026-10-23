import {
  computed,
  inject,
  Injectable,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import type { NeatRoiPolygon } from '@sima/neat-ui/video';
import { ViewerStorage } from './storage';
import type { SettingsScope } from './viewer-settings.store';

const GLOBAL_NAME = 'roi:global';
const CHANNEL_NAME = /^roi:channel:(\d+)$/;
const VERSION = 1;

/** A hand-edited or hostile value must not make the viewer draw or hold an unbounded list. */
const MAX_REGIONS = 64;
const MAX_POINTS = 256;
const MIN_POINTS = 3;

const NO_REGIONS: readonly NeatRoiPolygon[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function regionName(scope: SettingsScope): string {
  return scope === 'global' ? GLOBAL_NAME : `roi:channel:${scope}`;
}

/**
 * The regions in `raw`, cleaned: points with non-finite coordinates are dropped, the rest clamped
 * to 0..1, and a region with an unknown type or fewer than 3 points left is dropped, all within
 * the caps. Anything that is not a list holds no regions.
 */
function cleanRegions(raw: unknown): NeatRoiPolygon[] {
  if (!Array.isArray(raw)) return [];
  const regions: NeatRoiPolygon[] = [];
  for (const region of raw) {
    if (regions.length >= MAX_REGIONS) break;
    if (!isRecord(region)) continue;
    const type = region['type'];
    if (type !== 'inclusion' && type !== 'exclusion') continue;
    const rawPoints = region['points'];
    if (!Array.isArray(rawPoints)) continue;
    const points: { x: number; y: number }[] = [];
    for (const point of rawPoints) {
      if (points.length >= MAX_POINTS) break;
      if (!isRecord(point)) continue;
      const { x, y } = point;
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      points.push({ x: clamp01(x), y: clamp01(y) });
    }
    if (points.length >= MIN_POINTS) regions.push({ type, points });
  }
  return regions;
}

/**
 * The regions stored under `name`, or null when it holds none: nothing stored, not JSON, or not
 * the stored shape (an object at `VERSION` with a `regions` list).
 */
function parseRegions(raw: string | null): NeatRoiPolygon[] | null {
  if (raw === null) return null;
  try {
    const stored: unknown = JSON.parse(raw);
    if (!isRecord(stored) || stored['version'] !== VERSION) return null;
    const regions = stored['regions'];
    return Array.isArray(regions) ? cleanRegions(regions) : null;
  } catch {
    return null;
  }
}

/**
 * The regions of interest, a list of inclusion and exclusion polygons per scope: global, and per
 * channel where a channel has its own. A channel's list replaces the global one as a whole (not
 * region by region), and a channel can own an empty list, which means "no regions here" and is not
 * the same as owning none. Display-only: regions never leave the browser.
 *
 * They are stored apart from the other settings (`roi:global`, `roi:channel:<n>`), so "Reset all
 * channels" leaves them alone. Every stored list is read and cleaned when the store opens; from
 * then on the lists live in signals and each write replaces a whole list. Like the settings store,
 * it does not see what other tabs write until its own next write of that list.
 *
 * Provided by the Viewer page next to `ViewerSettingsStore`, which reads the effective regions
 * into each channel's overlay settings.
 */
@Injectable()
export class RoiStore {
  private readonly storage = inject(ViewerStorage);
  private readonly global = signal(this.read(GLOBAL_NAME));
  // A plain map rather than a signal, as in the settings store: `own(n)` may add a channel while a
  // template or computed reads it, where writing a signal is not allowed.
  private readonly channels = new Map<number, WritableSignal<readonly NeatRoiPolygon[] | null>>();
  private readonly owners = signal<readonly number[]>([]);
  private readonly effectiveCache = new Map<number, Signal<readonly NeatRoiPolygon[]>>();
  private readonly editableGlobal = computed(() => this.global() ?? NO_REGIONS);

  constructor() {
    const owners: number[] = [];
    for (const name of this.storage.names()) {
      const match = CHANNEL_NAME.exec(name);
      if (match === null) continue;
      const regions = this.read(name);
      if (regions === null) continue;
      const channel = Number(match[1]);
      this.channels.set(channel, signal(regions));
      owners.push(channel);
    }
    this.owners.set(owners.sort((a, b) => a - b));
  }

  /** The regions the scope stores itself, or null when it stores none and follows. */
  own(scope: SettingsScope): Signal<readonly NeatRoiPolygon[] | null> {
    return scope === 'global' ? this.global : this.channelSignal(scope);
  }

  /** The regions the channel's overlays use: its own list, else global's, else none. */
  effective(channel: number): Signal<readonly NeatRoiPolygon[]> {
    let effective = this.effectiveCache.get(channel);
    if (effective === undefined) {
      const own = this.channelSignal(channel);
      effective = computed(() => own() ?? this.global() ?? NO_REGIONS);
      this.effectiveCache.set(channel, effective);
    }
    return effective;
  }

  /**
   * The regions an editor starts from: global's own, or what the channel shows, which is global's
   * while the channel inherits them. The first edit of a channel therefore writes a copy of what
   * the user saw, with the change on top, and nothing disappears.
   */
  editable(scope: SettingsScope): Signal<readonly NeatRoiPolygon[]> {
    return scope === 'global' ? this.editableGlobal : this.effective(scope);
  }

  /**
   * Stores `regions` as the scope's whole list, cleaned the way a stored list is read, so what is
   * held is what a reload would read. On a channel it becomes an override, an empty list included.
   */
  set(scope: SettingsScope, regions: readonly NeatRoiPolygon[]): void {
    const cleaned = cleanRegions(regions);
    this.storage.set(regionName(scope), JSON.stringify({ version: VERSION, regions: cleaned }));
    if (scope === 'global') {
      this.global.set(cleaned);
    } else {
      this.channelSignal(scope).set(cleaned);
      this.owners.set(this.storedOwners());
    }
  }

  /** Gives back the channel's own list, so the channel follows the global regions again. */
  useGlobal(channel: number): void {
    const own = this.channelSignal(channel);
    if (own() === null) return;
    this.storage.remove(regionName(channel));
    own.set(null);
    this.owners.set(this.storedOwners());
  }

  /** The channels that store a list of their own, in ascending order, read again after each write. */
  channelsWithOwn(): Signal<readonly number[]> {
    return this.owners;
  }

  private channelSignal(channel: number): WritableSignal<readonly NeatRoiPolygon[] | null> {
    let own = this.channels.get(channel);
    if (own === undefined) {
      own = signal(null);
      this.channels.set(channel, own);
    }
    return own;
  }

  private read(name: string): NeatRoiPolygon[] | null {
    return parseRegions(this.storage.get(name));
  }

  /** The channels with a stored list now, which may include ones another tab wrote. */
  private storedOwners(): number[] {
    const owners: number[] = [];
    for (const name of this.storage.names()) {
      const match = CHANNEL_NAME.exec(name);
      if (match !== null && this.read(name) !== null) owners.push(Number(match[1]));
    }
    return owners.sort((a, b) => a - b);
  }
}
