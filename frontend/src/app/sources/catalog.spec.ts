import {
  type CatalogAsset,
  type CatalogSource,
  assetMatchesSearch,
  assetsOfSource,
  catalogAssetLabel,
  catalogCodecs,
  catalogProfiles,
  matchesFilter,
  previewOf,
  sortCatalogAssets,
  sourceMatchesSearch,
  totalBytes,
} from './catalog';

const asset = (overrides: Partial<CatalogAsset>): CatalogAsset => ({
  source_id: 'street',
  source_title: 'Street',
  profile: '720p30',
  preview: false,
  codec: 'h264',
  container: 'mp4',
  fps: 30,
  target_height: 720,
  path: 'street/street_720p30_30fps_h264.mp4',
  bytes: 1024,
  sha256: '',
  width: 1280,
  height: 720,
  url: 'https://artifacts.neat.sima.ai/media-assets/street/street_720p30_30fps_h264.mp4',
  ...overrides,
});

const source = (id: string, title: string, description = ''): CatalogSource => ({
  id,
  title,
  description,
  file: '',
  url: '',
});

describe('catalogAssetLabel', () => {
  it('joins profile, rate, codec and size', () => {
    expect(catalogAssetLabel(asset({ codec: 'hevc' }))).toBe('720p30 / 30 fps / H.265 / 1280x720');
    expect(catalogAssetLabel(asset({ width: null, height: null, fps: 0 }))).toBe('720p30 / H.264');
  });
});

describe('sortCatalogAssets', () => {
  it('orders by source, then height and rate as numbers, then codec and path', () => {
    const sorted = sortCatalogAssets([
      asset({ path: 'c', target_height: 1080 }),
      asset({ path: 'b', target_height: 480, codec: 'mjpeg' }),
      asset({ path: 'a', target_height: 480, codec: 'h264' }),
      asset({ path: 'z', source_title: 'Alley', target_height: 2160 }),
    ]);
    expect(sorted.map((one) => one.path)).toEqual(['z', 'a', 'b', 'c']);
  });
});

describe('filters', () => {
  const assets = [
    asset({ profile: '720p30', codec: 'h264' }),
    asset({ profile: '1080p30', codec: 'hevc' }),
    asset({ profile: 'preview_320p30', codec: 'h264', preview: true }),
  ];

  it('offer the profiles and codecs there are, without the preview clip’s profile', () => {
    expect(catalogProfiles(assets)).toEqual(['1080p30', '720p30']);
    expect(catalogCodecs(assets)).toEqual(['h264', 'hevc']);
  });

  it('match any value while unset, and never the preview clip', () => {
    const any = { profile: '', codec: '' };
    expect(assets.map((one) => matchesFilter(one, any))).toEqual([true, true, false]);
    expect(assets.map((one) => matchesFilter(one, { profile: '', codec: 'hevc' }))).toEqual([
      false,
      true,
      false,
    ]);
    expect(assets.map((one) => matchesFilter(one, { profile: '720p30', codec: 'hevc' }))).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe('search', () => {
  it('finds a source by title, description or id, ignoring case', () => {
    const street = source('street', 'Street', 'Cars at a crossing');
    expect(['street', 'CROSSING', 'str', ''].map((q) => sourceMatchesSearch(street, q))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(sourceMatchesSearch(street, 'forest')).toBe(false);
  });

  it('finds an asset by its source, or by the title the asset carries', () => {
    const street = source('street', 'Street', 'Cars');
    expect(assetMatchesSearch(asset({}), street, 'cars')).toBe(true);
    expect(assetMatchesSearch(asset({}), undefined, 'street')).toBe(true);
    expect(assetMatchesSearch(asset({}), street, 'forest')).toBe(false);
  });
});

describe('a source’s assets', () => {
  const assets = [
    asset({ path: 'b', target_height: 1080 }),
    asset({ path: 'x', source_id: 'forest' }),
    asset({ path: 'p2', preview: true, codec: 'hevc' }),
    asset({ path: 'p1', preview: true, codec: 'h264' }),
    asset({ path: 'a', target_height: 480 }),
  ];

  it('lists the assets of one source in order', () => {
    expect(assetsOfSource(assets, 'street').map((one) => one.path)).toEqual(['a', 'p1', 'p2', 'b']);
  });

  it('previews with the H.264 preview clip first, else any preview clip', () => {
    expect(previewOf(assets)?.path).toBe('p1');
    expect(previewOf(assets.filter((one) => one.path !== 'p1'))?.path).toBe('p2');
    expect(previewOf([asset({})])).toBeNull();
  });

  it('adds up their sizes', () => {
    expect(totalBytes([asset({ bytes: 1000 }), asset({ bytes: 24 })])).toBe(1024);
    expect(totalBytes([])).toBe(0);
  });
});
