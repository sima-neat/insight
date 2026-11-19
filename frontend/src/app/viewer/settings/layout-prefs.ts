import { computed, Injectable } from '@angular/core';
import { neatStoredSignal } from '@sima/neat-ui';
import { NEAT_MIN_TILE_WIDTH } from '@sima/neat-ui/video';

const LAYOUT_KEY = 'neat-insight:viewer:layout';
/** The inspector's width is kept apart from the layout. */
const INSPECTOR_WIDTH_KEY = 'neat-insight:viewer:aside-width';

/** A size per displayed channel count, keyed by the count as JSON keeps it: as text. */
type SizeByCount = Readonly<Record<string, number>>;

interface Layout {
  readonly bars: boolean;
  readonly hideEmpty: boolean;
  readonly inspector: boolean;
  /** The tile width chosen with the size slider, per displayed channel count. */
  readonly tileWidths: SizeByCount;
  /**
   * The tiles per page chosen with "Fit", per displayed channel count. A count has a width or a
   * fit, never both: choosing one forgets the other.
   */
  readonly fits: SizeByCount;
}

const DEFAULT_LAYOUT: Layout = {
  bars: true,
  hideEmpty: false,
  inspector: false,
  tileWidths: {},
  fits: {},
};

function isTileWidth(width: unknown): width is number {
  return typeof width === 'number' && Number.isFinite(width) && width >= NEAT_MIN_TILE_WIDTH;
}

/** A channel count, or a count of tiles per page: a positive whole number. */
function isCount(count: unknown): count is number {
  return Number.isInteger(count) && (count as number) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The entries of `stored` keyed by a channel count whose size `valid` accepts. */
function sizesIn(stored: unknown, valid: (size: unknown) => size is number): SizeByCount {
  if (!isRecord(stored)) return {};
  const sizes: Record<string, number> = {};
  for (const [count, size] of Object.entries(stored)) {
    if (isCount(Number(count)) && valid(size)) sizes[Number(count)] = size;
  }
  return sizes;
}

function without(sizes: SizeByCount, count: number): SizeByCount {
  return Object.fromEntries(Object.entries(sizes).filter(([key]) => key !== String(count)));
}

/** The stored layout, with anything malformed or out of range replaced by its default. */
function parseLayout(stored: unknown): Layout | undefined {
  if (!isRecord(stored)) return undefined;
  const flag = (value: unknown, fallback: boolean) =>
    typeof value === 'boolean' ? value : fallback;
  const tileWidths = sizesIn(stored['tileWidths'], isTileWidth);
  // A count stored with both (only by hand) keeps its width, the more specific choice.
  const fits = Object.fromEntries(
    Object.entries(sizesIn(stored['fits'], isCount)).filter(
      ([count]) => !Object.hasOwn(tileWidths, count),
    ),
  );
  return {
    bars: flag(stored['bars'], DEFAULT_LAYOUT.bars),
    hideEmpty: flag(stored['hideEmpty'], DEFAULT_LAYOUT.hideEmpty),
    inspector: flag(stored['inspector'], DEFAULT_LAYOUT.inspector),
    tileWidths,
    fits,
  };
}

/**
 * A stored inspector width: a positive number of pixels. Anything else is the kit's default; the
 * kit clamps any width it is given, so only what cannot be a width is refused here.
 */
function parseWidth(stored: unknown): number | undefined {
  return typeof stored === 'number' && Number.isFinite(stored) && stored > 0 ? stored : undefined;
}

/**
 * The Viewer's layout choices, stored under one key as they change: tile bars, "Hide empty", the
 * inspector, and the tile size per displayed channel count, either a width from the slider or a
 * tiles-per-page fit from "Fit". The width the inspector was dragged to is stored under a key of
 * its own. Provided by the Viewer page like the settings store, and read from storage on each
 * visit, so a choice made in another Viewer tab shows on the next visit (the tab that writes last
 * keeps its layout). A choice storage refuses to keep lasts for the visit.
 */
@Injectable()
export class LayoutPrefs {
  private readonly layout = neatStoredSignal(LAYOUT_KEY, DEFAULT_LAYOUT, parseLayout);
  private readonly width = neatStoredSignal<number | null>(INSPECTOR_WIDTH_KEY, null, parseWidth);

  readonly bars = computed(() => this.layout().bars);
  readonly hideEmpty = computed(() => this.layout().hideEmpty);
  readonly inspector = computed(() => this.layout().inspector);

  /** The width the inspector was dragged to, in pixels, or null for the kit's default. */
  readonly inspectorWidth = this.width.asReadonly();

  setBars(bars: boolean): void {
    this.choose('bars', bars);
  }

  setHideEmpty(hideEmpty: boolean): void {
    this.choose('hideEmpty', hideEmpty);
  }

  setInspector(inspector: boolean): void {
    this.choose('inspector', inspector);
  }

  /** Remembers the inspector's width; null, the default, forgets it. */
  setInspectorWidth(width: number | null): void {
    if (this.width() !== width) this.width.set(width);
  }

  /** The width remembered for `count` displayed channels, or null when the user never chose one. */
  tileWidthFor(count: number): number | null {
    return this.layout().tileWidths[count] ?? null;
  }

  /**
   * Remembers `width` for `count` displayed channels, in place of a fit; a width the grid cannot
   * use is ignored.
   */
  rememberTileWidth(count: number, width: number): void {
    if (!isCount(count) || !isTileWidth(width) || this.tileWidthFor(count) === width) return;
    this.layout.update((layout) => ({
      ...layout,
      tileWidths: { ...layout.tileWidths, [count]: width },
      fits: without(layout.fits, count),
    }));
  }

  /** The tiles per page remembered for `count` displayed channels, or null when none was chosen. */
  fitFor(count: number): number | null {
    return this.layout().fits[count] ?? null;
  }

  /**
   * Remembers a fit of `tiles` per page for `count` displayed channels, in place of a width; a
   * count of tiles that is not a positive whole number is ignored.
   */
  rememberFit(count: number, tiles: number): void {
    if (!isCount(count) || !isCount(tiles) || this.fitFor(count) === tiles) return;
    this.layout.update((layout) => ({
      ...layout,
      tileWidths: without(layout.tileWidths, count),
      fits: { ...layout.fits, [count]: tiles },
    }));
  }

  /**
   * Forgets the width or fit chosen for `count` displayed channels, so they fit all on one page
   * again ("Fit all"). Forgetting a size that is not stored writes nothing.
   */
  forgetSize(count: number): void {
    if (this.tileWidthFor(count) === null && this.fitFor(count) === null) return;
    this.layout.update((layout) => ({
      ...layout,
      tileWidths: without(layout.tileWidths, count),
      fits: without(layout.fits, count),
    }));
  }

  /** Stores one choice; choosing what is already chosen writes nothing. */
  private choose<K extends 'bars' | 'hideEmpty' | 'inspector'>(key: K, value: Layout[K]): void {
    if (this.layout()[key] !== value) this.layout.update((layout) => ({ ...layout, [key]: value }));
  }
}
