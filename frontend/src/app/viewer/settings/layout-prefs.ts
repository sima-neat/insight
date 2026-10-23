import { computed, inject, Injectable, signal } from '@angular/core';
import { NEAT_MIN_TILE_WIDTH } from '@sima/neat-ui';
import { ViewerStorage } from './storage';

const LAYOUT = 'layout';

interface Layout {
  readonly bars: boolean;
  readonly hideEmpty: boolean;
  readonly inspector: boolean;
  /** The tile width chosen with the size slider, per displayed channel count. */
  readonly tileWidths: ReadonlyMap<number, number>;
  /**
   * The tiles per page chosen with "Fit", per displayed channel count. A count has a width or a
   * fit, never both: choosing one forgets the other.
   */
  readonly fits: ReadonlyMap<number, number>;
}

function isTileWidth(width: unknown): width is number {
  return typeof width === 'number' && Number.isFinite(width) && width >= NEAT_MIN_TILE_WIDTH;
}

/** A channel count, or a count of tiles per page: a positive whole number. */
function isCount(count: unknown): count is number {
  return Number.isInteger(count) && (count as number) > 0;
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
      if (isCount(Number(count)) && isTileWidth(width)) tileWidths.set(Number(count), width);
    }
  }
  // A count stored with both (only by hand) keeps its width, the more specific choice.
  const fits = new Map<number, number>();
  const storedFits = stored['fits'];
  if (typeof storedFits === 'object' && storedFits !== null) {
    for (const [count, tiles] of Object.entries(storedFits)) {
      const key = Number(count);
      if (isCount(key) && isCount(tiles) && !tileWidths.has(key)) {
        fits.set(key, tiles);
      }
    }
  }
  return {
    bars: flag(stored['bars'], true),
    hideEmpty: flag(stored['hideEmpty'], false),
    inspector: flag(stored['inspector'], false),
    tileWidths,
    fits,
  };
}

/**
 * The Viewer's layout choices, stored under one key as they change: tile bars, "Hide empty", the
 * inspector, and the tile size per displayed channel count (the spec's "remembered per displayed
 * channel count"), either a width from the slider or a tiles-per-page fit from "Fit". Provided
 * by the Viewer page like the settings store; the choices outlive the page through storage. Tiles
 * are always 16:9, so an `aspect` that plan 2a stored is not read and the next write leaves it
 * out.
 */
@Injectable()
export class LayoutPrefs {
  private readonly storage = inject(ViewerStorage);
  private readonly layout = signal(parseLayout(this.storage.get(LAYOUT)));
  private readonly tileWidths = computed(() => this.layout().tileWidths);
  private readonly fits = computed(() => this.layout().fits);

  readonly bars = computed(() => this.layout().bars);
  readonly hideEmpty = computed(() => this.layout().hideEmpty);
  readonly inspector = computed(() => this.layout().inspector);

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

  /**
   * Remembers `width` for `count` displayed channels, in place of a fit; a width the grid cannot
   * use is ignored.
   */
  rememberTileWidth(count: number, width: number): void {
    if (!isCount(count) || !isTileWidth(width)) return;
    if (this.tileWidths().get(count) === width) return;
    this.update((latest) => {
      const fits = new Map(latest.fits);
      fits.delete(count);
      return { ...latest, tileWidths: new Map(latest.tileWidths).set(count, width), fits };
    });
  }

  /** The tiles per page remembered for `count` displayed channels, or null when none was chosen. */
  fitFor(count: number): number | null {
    return this.fits().get(count) ?? null;
  }

  /**
   * Remembers a fit of `tiles` per page for `count` displayed channels, in place of a width; a
   * count of tiles that is not a positive whole number is ignored.
   */
  rememberFit(count: number, tiles: number): void {
    if (!isCount(count) || !isCount(tiles)) return;
    if (this.fits().get(count) === tiles) return;
    this.update((latest) => {
      const tileWidths = new Map(latest.tileWidths);
      tileWidths.delete(count);
      return { ...latest, tileWidths, fits: new Map(latest.fits).set(count, tiles) };
    });
  }

  /**
   * Forgets the width or fit chosen for `count` displayed channels, so they fit all on one page
   * again ("Fit all"). Forgetting a size that is not stored writes nothing.
   */
  forgetSize(count: number): void {
    if (!this.tileWidths().has(count) && !this.fits().has(count)) return;
    this.update((latest) => {
      const tileWidths = new Map(latest.tileWidths);
      const fits = new Map(latest.fits);
      tileWidths.delete(count);
      fits.delete(count);
      return { ...latest, tileWidths, fits };
    });
  }

  /** Stores one choice; choosing what is already chosen writes nothing. */
  private choose<K extends 'bars' | 'hideEmpty' | 'inspector'>(key: K, value: Layout[K]): void {
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
        bars: next.bars,
        hideEmpty: next.hideEmpty,
        inspector: next.inspector,
        tileWidths: Object.fromEntries(next.tileWidths),
        fits: Object.fromEntries(next.fits),
      }),
    );
  }
}
