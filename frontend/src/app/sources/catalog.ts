import type { CatalogAsset, CatalogSource } from './api';
import { codecLabel } from './slot-row';

/**
 * The media catalog as the import dialog's Catalog tab shows it (Inv-SM §1.1): labels, order,
 * search and the Resolution & FPS / Codec filter both browsing modes share. Pure functions over
 * the index `GET /api/media-catalog` returns.
 */

/** The profile of a source's preview clip, which is shown, never imported. */
const PREVIEW_PROFILE = 'preview_320p30';

/** The filter both modes share; '' is "Any". */
export interface CatalogFilter {
  readonly profile: string;
  readonly codec: string;
}

/** "720p30 / 30 fps / H.264 / 1280x720", leaving out what the index does not say. */
export function catalogAssetLabel(asset: CatalogAsset): string {
  return [
    asset.profile,
    asset.fps ? `${asset.fps} fps` : '',
    asset.codec ? codecLabel(asset.codec) : '',
    asset.width && asset.height ? `${asset.width}x${asset.height}` : '',
  ]
    .filter(Boolean)
    .join(' / ');
}

/**
 * By source, then height and frame rate, then codec and path. #170 compared one joined string, so
 * 1080 sorted before 480; heights and rates compare as numbers here.
 */
export function sortCatalogAssets(assets: readonly CatalogAsset[]): CatalogAsset[] {
  const title = (asset: CatalogAsset) => asset.source_title || asset.source_id || '';
  const height = (asset: CatalogAsset) => asset.target_height || asset.height || 0;
  return [...assets].sort(
    (a, b) =>
      title(a).localeCompare(title(b)) ||
      height(a) - height(b) ||
      (a.fps || 0) - (b.fps || 0) ||
      a.codec.localeCompare(b.codec) ||
      a.path.localeCompare(b.path),
  );
}

const distinct = (values: readonly string[]): string[] =>
  [...new Set(values.filter(Boolean))].sort();

/** The profiles the filter offers for these assets; the preview clip's is not one to pick. */
export function catalogProfiles(assets: readonly CatalogAsset[]): string[] {
  return distinct(assets.map((asset) => asset.profile)).filter(
    (profile) => profile !== PREVIEW_PROFILE,
  );
}

export function catalogCodecs(assets: readonly CatalogAsset[]): string[] {
  return distinct(assets.map((asset) => asset.codec));
}

/** Whether an importable asset passes the filter; a preview clip never does. */
export function matchesFilter(asset: CatalogAsset, filter: CatalogFilter): boolean {
  return (
    !asset.preview &&
    (!filter.profile || asset.profile === filter.profile) &&
    (!filter.codec || asset.codec === filter.codec)
  );
}

const includes = (values: readonly (string | undefined)[], query: string): boolean => {
  const q = query.trim().toLowerCase();
  return !q || values.some((value) => !!value && value.toLowerCase().includes(q));
};

/** The by-name search: a source's title, description or id. */
export function sourceMatchesSearch(source: CatalogSource, query: string): boolean {
  return includes([source.title, source.description, source.id], query);
}

/** The by-type search: the asset's source as the index lists it, or as the asset names it. */
export function assetMatchesSearch(
  asset: CatalogAsset,
  source: CatalogSource | undefined,
  query: string,
): boolean {
  return includes(
    [source?.title, source?.description, source?.id, asset.source_title, asset.source_id],
    query,
  );
}

/** One source's assets, preview clips included, in order. */
export function assetsOfSource(assets: readonly CatalogAsset[], sourceId: string): CatalogAsset[] {
  return sortCatalogAssets(assets.filter((asset) => asset.source_id === sourceId));
}

/** The clip a source's detail plays: its H.264 preview if it has one, as #170 chose. */
export function previewOf(assets: readonly CatalogAsset[]): CatalogAsset | null {
  return (
    assets.find((asset) => asset.preview && asset.codec === 'h264') ??
    assets.find((asset) => asset.preview) ??
    null
  );
}

export function totalBytes(assets: readonly CatalogAsset[]): number {
  return assets.reduce((total, asset) => total + (asset.bytes || 0), 0);
}
