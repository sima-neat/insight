import { computed, inject, Injectable, signal } from '@angular/core';
import { NEAT_MIN_TILE_WIDTH, type NeatTileAspect } from '@sima/neat-ui';
import { ViewerStorage } from './storage';

const LAYOUT = 'layout';

interface Layout {
  readonly aspect: NeatTileAspect;
  readonly bars: boolean;
  readonly hideEmpty: boolean;
  readonly inspector: boolean;
  /** The tile width chosen with the size slider, per displayed channel count. */
  readonly tileWidths: ReadonlyMap<number, number>;
}

const ASPECTS: readonly NeatTileAspect[] = ['16:9', '1:1'];

function isTileWidth(width: unknown): width is number {
  return typeof width === 'number' && Number.isFinite(width) && width >= NEAT_MIN_TILE_WIDTH;
}

function isChannelCount(count: number): boolean {
  return Number.isInteger(count) && count > 0;
}

/** The stored layout, with anything malformed or out of range replaced by its default. */
function parseLayout(raw: string | null): Layout {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) stored = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: every choice starts from its default.
  }
  const flag = (value: unknown, fallback: boolean) =>
    typeof value === 'boolean' ? value : fallback;
  const tileWidths = new Map<number, number>();
  const widths = stored['tileWidths'];
  if (typeof widths === 'object' && widths !== null) {
    for (const [count, width] of Object.entries(widths)) {
      if (isChannelCount(Number(count)) && isTileWidth(width)) tileWidths.set(Number(count), width);
    }
  }
  return {
    aspect: ASPECTS.includes(stored['aspect'] as NeatTileAspect)
      ? (stored['aspect'] as NeatTileAspect)
      : '16:9',
    bars: flag(stored['bars'], true),
    hideEmpty: flag(stored['hideEmpty'], false),
    inspector: flag(stored['inspector'], false),
    tileWidths,
  };
}

/**
 * The Viewer's layout choices, stored under one key as they change: tile shape, tile bars, "Hide
 * empty", the inspector, and the tile size per displayed channel count (the spec's "remembered per
 * displayed channel count"). Provided by the Viewer page like the settings store; the choices
 * outlive the page through storage.
 */
@Injectable()
export class LayoutPrefs {
  private readonly storage = inject(ViewerStorage);
  private readonly layout = signal(parseLayout(this.storage.get(LAYOUT)));
  private readonly tileWidths = computed(() => this.layout().tileWidths);

  readonly aspect = computed(() => this.layout().aspect);
  readonly bars = computed(() => this.layout().bars);
  readonly hideEmpty = computed(() => this.layout().hideEmpty);
  readonly inspector = computed(() => this.layout().inspector);

  setAspect(aspect: NeatTileAspect): void {
    this.choose('aspect', aspect);
  }

  setBars(bars: boolean): void {
    this.choose('bars', bars);
  }

  setHideEmpty(hideEmpty: boolean): void {
    this.choose('hideEmpty', hideEmpty);
  }

  setInspector(inspector: boolean): void {
    this.choose('inspector', inspector);
  }

  /** The width remembered for `count` displayed channels, or null when the user never chose one. */
  tileWidthFor(count: number): number | null {
    return this.tileWidths().get(count) ?? null;
  }

  /** Remembers `width` for `count` displayed channels; a width the grid cannot use is ignored. */
  rememberTileWidth(count: number, width: number): void {
    if (!isChannelCount(count) || !isTileWidth(width)) return;
    if (this.tileWidths().get(count) === width) return;
    this.update((latest) => ({
      ...latest,
      tileWidths: new Map(latest.tileWidths).set(count, width),
    }));
  }

  /** Stores one choice; choosing what is already chosen writes nothing. */
  private choose<K extends 'aspect' | 'bars' | 'hideEmpty' | 'inspector'>(
    key: K,
    value: Layout[K],
  ): void {
    if (this.layout()[key] === value) return;
    this.update((latest) => ({ ...latest, [key]: value }));
  }

  /**
   * Applies `edit` to the layout as stored now rather than as read at open: another Viewer tab may
   * have stored other choices since, and toggling bars here must not wipe its tile widths.
   */
  private update(edit: (latest: Layout) => Layout): void {
    const next = edit(parseLayout(this.storage.get(LAYOUT)));
    this.layout.set(next);
    this.storage.set(
      LAYOUT,
      JSON.stringify({
        aspect: next.aspect,
        bars: next.bars,
        hideEmpty: next.hideEmpty,
        inspector: next.inspector,
        tileWidths: Object.fromEntries(next.tileWidths),
      }),
    );
  }
}
