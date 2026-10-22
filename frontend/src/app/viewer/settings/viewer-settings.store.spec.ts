import { TestBed } from '@angular/core/testing';
import { NEAT_OVERLAY_DEFAULTS, NEAT_OVERLAY_STYLE_FALLBACK_COLOR } from '@sima/neat-ui';
import { FakeLocalStorage } from './fake-storage.testing';
import type { ScopeOverrides } from './resolver';
import { SCALAR_SETTINGS, TYPE_DEFAULTS, type SettingId } from './schema';
import { ViewerSettingsStore } from './viewer-settings.store';

type StoredScope = ScopeOverrides & { readonly version: number };
type Failures = Partial<Pick<FakeLocalStorage, 'failWrites' | 'failWritesFor' | 'unavailable'>>;

let fake: FakeLocalStorage;

/** A store for the Viewer opened again in the same browser session. */
function openStore(): ViewerSettingsStore {
  return TestBed.runInInjectionContext(() => new ViewerSettingsStore());
}

/**
 * Opens the store on fresh storage holding `stored` (names without the viewer prefix), as the
 * original loadSettingsApi(stored) did. Each call starts a new browser session.
 */
function load(stored: Record<string, unknown> = {}, failures: Failures = {}): ViewerSettingsStore {
  fake = new FakeLocalStorage();
  fake.seed(stored);
  Object.assign(fake, failures);
  vi.stubGlobal('localStorage', fake);
  TestBed.resetTestingModule();
  return openStore();
}

/** A new browser session on the same storage: what a page reload sees. */
function reload(): ViewerSettingsStore {
  TestBed.resetTestingModule();
  return openStore();
}

function stored(name: string): StoredScope | null {
  return fake.readStored(name) as StoredScope | null;
}

function writesTo(name: string) {
  return fake.writes.filter(({ key }) => key === `neat-insight:viewer:${name}`);
}

/** A channel's own values by id, as the original readScopeOwnValues reported them. */
function ownValues(store: ViewerSettingsStore, channel: number): Record<string, unknown> {
  return Object.fromEntries(
    SCALAR_SETTINGS.filter(({ id }) => store.isOverride(channel, id)).map(({ id }) => [
      id,
      store.value(channel, id),
    ]),
  );
}

/** The channels with their own value for `id`, as the original listChannelOverrides listed them. */
function listOverrides(store: ViewerSettingsStore, id: SettingId) {
  return store.overridesOf(id).map((channel) => ({ channel, value: store.value(channel, id) }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Ported from viewerSettings.test.js (829ec7c). Storage names map viewerSettings_global to
// settings:global and viewerSettings_channel_<N> to settings:channel:<N>; the old API's calls map
// onto the store (resolveTypeSettings → resolved/general, followedValue → value('global'),
// writeScopeGeneralOverride and writeScopeOwnSettings → set, clearScope* → resetOverride,
// listChannel*Overrides → overridesOf, applyGlobalGeneral → raiseGlobal). The report lists the
// tests and assertions that were dropped and why.
describe('ViewerSettingsStore (ported resolver tests)', () => {
  it('the previous 350 ms default migrates to the measured 300 ms floor', () => {
    const store = load({
      'settings:global': JSON.stringify({ version: 8, general: { videoSyncBufferMs: 350 } }),
    });

    expect(store.general(0)().videoSyncBufferMs).toBe(300);
    expect(store.value('global', 'general.videoSyncBufferMs')).toBe(300);
  });

  it('auxiliary mutations migrate legacy settings without creating channel overrides', () => {
    const store = load({
      'settings:global': JSON.stringify({
        version: 9,
        general: { metadataRetentionMs: 2500 },
        types: { 'pose-estimation': { visible: false } },
      }),
      'settings:channel:0': JSON.stringify({
        version: 3,
        general: { videoSyncBufferMs: 350 },
        auxiliary: { 'blazepose-3d': { panelMode: 'expanded' } },
      }),
      'settings:channel:1': JSON.stringify({
        version: 3,
        general: { videoSyncBufferMs: 350 },
        auxiliary: { 'blazepose-3d': { panelMode: 'expanded' } },
      }),
    });

    store.set(0, 'auxiliary.blazepose-3d.panelMode', 'collapsed');
    store.resetOverride(1, 'auxiliary.blazepose-3d.panelMode');

    for (const channel of [0, 1]) {
      expect(store.general(channel)().videoSyncBufferMs).toBe(300);
      expect(store.general(channel)().metadataRetentionMs).toBe(2500);
      expect(store.resolved(channel)().types['pose-estimation'].visible).toBe(false);
    }
    expect(store.value(0, 'auxiliary.blazepose-3d.panelMode')).toBe('collapsed');
    expect(stored('settings:channel:1')?.auxiliary['blazepose-3d']).toBeUndefined();
  });

  it('version two settings migrate without retaining overlay delay', () => {
    const store = load({
      'settings:global': JSON.stringify({
        version: 2,
        general: { metadataDelay: 900, showRoi: false },
        types: { 'object-detection': { confidenceThreshold: 0.5 } },
      }),
    });

    expect(store.value('global', 'general.videoSyncBufferMs')).toBe(300);
    expect(store.value('global', 'general.metadataRetentionMs')).toBe(0);
    expect(store.value('global', 'general.showRoi')).toBe(false);
    expect(store.value('global', 'types.object-detection.confidenceThreshold')).toBe(0.5);
    // The next write stores the migrated scope.
    store.set('global', 'general.lineWidth', 3);
    const settings = stored('settings:global');
    expect(settings?.version).toBe(10);
    expect(settings !== null && 'metadataDelay' in settings.general).toBe(false);
  });

  it('viewer settings resolve and clear independent channel overrides', () => {
    const store = load({
      'settings:global': JSON.stringify({
        version: 9,
        types: {
          'object-detection': { visible: false, confidenceThreshold: 0.8 },
          'pose-estimation': { showKeypoints: false, showKeypointLabels: true },
        },
        auxiliary: {
          'blazepose-3d': {
            yawDegrees: -20,
            backgroundTransparency: 0.35,
            showReferenceBox: false,
          },
        },
      }),
      'settings:channel:2': JSON.stringify({
        version: 9,
        types: {
          'object-detection': { visible: true },
          'pose-estimation': { showKeypoints: true, showKeypointLabels: false },
        },
        auxiliary: {
          'blazepose-3d': {
            enabled: false,
            yawDegrees: 75,
            panelMode: 'expanded',
            backgroundTransparency: 0.8,
          },
        },
      }),
    });

    expect(store.value(1, 'auxiliary.blazepose-3d.backgroundTransparency')).toBe(0.35);
    expect(store.value(2, 'auxiliary.blazepose-3d.backgroundTransparency')).toBe(0.8);
    expect(store.resolved(1)().types['object-detection'].visible).toBe(false);
    expect(store.resolved(2)().types['object-detection'].visible).toBe(true);
    expect(store.resolved(2)().types['pose-estimation'].showKeypoints).toBe(true);
    expect(store.resolved(2)().types['pose-estimation'].showKeypointLabels).toBe(false);
    store.set(3, 'auxiliary.blazepose-3d.enabled', true);
    store.set(3, 'auxiliary.blazepose-3d.panelMode', 'expanded');
    expect(store.resolved(3)().types['object-detection'].confidenceThreshold).toBe(0.8);
    expect(store.value(3, 'auxiliary.blazepose-3d.panelMode')).toBe('expanded');
    // The original changed the global value through the dialog's full save (dropped).
    store.set('global', 'auxiliary.blazepose-3d.backgroundTransparency', 0.6);
    expect(store.value(3, 'auxiliary.blazepose-3d.backgroundTransparency')).toBe(0.6);
    expect(store.value(3, 'auxiliary.blazepose-3d.panelMode')).toBe('expanded');
    expect(TYPE_DEFAULTS['pose-estimation'].showKeypointLabels).toBe(false);
    expect(stored('settings:channel:2')?.auxiliary['blazepose-3d']).toBeDefined();
    for (const key of ['enabled', 'yawDegrees', 'panelMode', 'backgroundTransparency'] as const) {
      store.resetOverride(2, `auxiliary.blazepose-3d.${key}`);
    }
    expect(stored('settings:channel:2')?.auxiliary['blazepose-3d']).toBeUndefined();
    expect(store.value(2, 'auxiliary.blazepose-3d.showReferenceBox')).toBe(false);
  });

  it('resolved object styles contain only user entries, no injected default', () => {
    const store = load({
      'settings:global': JSON.stringify({
        version: 10,
        types: { 'object-detection': { objects: [{ label: 'person', color: '#112233' }] } },
      }),
    });

    expect(store.resolved(0)().types['object-detection'].objects).toStrictEqual([
      { label: 'person', color: '#112233', style: 'solid', width: 1 },
    ]);
    expect(store.resolved(0)().types.segmentation.objects).toStrictEqual([]);
  });

  it('migrating from version 9 drops a stock green default entry', () => {
    // The drop recognises the stock row by the kit's fallback colour; a kit change must fail here
    // rather than silently stop the drop.
    expect(NEAT_OVERLAY_STYLE_FALLBACK_COLOR).toBe('#00ff00');
    const store = load({
      'settings:global': JSON.stringify({
        version: 9,
        types: {
          'object-detection': {
            objects: [
              { label: 'default', color: '#00ff00', style: 'solid', width: 1 },
              { label: 'car', color: '#ff0000', style: 'dashed', width: 3 },
            ],
          },
          segmentation: {
            objects: [{ label: 'default', color: '#00ff00', style: 'solid', width: 1 }],
          },
        },
      }),
    });

    expect(store.resolved(0)().types['object-detection'].objects).toStrictEqual([
      { label: 'car', color: '#ff0000', style: 'dashed', width: 3 },
    ]);
    expect(store.resolved(0)().types.segmentation.objects).toStrictEqual([]);
    // The next write stores the migrated scope.
    store.set('global', 'general.lineWidth', 3);
    const settings = stored('settings:global');
    expect(settings?.version).toBe(10);
    expect(settings?.types['object-detection']?.objects).toStrictEqual([
      { label: 'car', color: '#ff0000', style: 'dashed', width: 3 },
    ]);
    expect(settings?.types.segmentation?.objects).toStrictEqual([]);
  });

  it('migrating from version 9 keeps a recolored default entry as an override', () => {
    const store = load({
      'settings:global': JSON.stringify({
        version: 9,
        types: {
          'object-detection': {
            objects: [{ label: 'default', color: '#ff00ff', style: 'solid', width: 1 }],
          },
        },
      }),
    });

    expect(store.resolved(0)().types['object-detection'].objects).toStrictEqual([
      { label: 'default', color: '#ff00ff', style: 'solid', width: 1 },
    ]);
  });

  it('version 10 settings keep an explicit stock green default entry', () => {
    const store = load({
      'settings:global': JSON.stringify({
        version: 10,
        types: {
          'object-detection': {
            objects: [{ label: 'default', color: '#00ff00', style: 'solid', width: 1 }],
          },
        },
      }),
    });

    const objects = store.resolved(0)().types['object-detection'].objects;
    expect(objects.length).toBe(1);
    expect(objects[0].color).toBe('#00ff00');
  });

  it('channel object entries override global entries by label', () => {
    const store = load({
      'settings:global': JSON.stringify({
        version: 10,
        types: {
          'object-detection': {
            objects: [
              { label: 'person', color: '#111111' },
              { label: 'car', color: '#222222' },
            ],
          },
        },
      }),
      'settings:channel:2': JSON.stringify({
        version: 10,
        types: { 'object-detection': { objects: [{ label: 'person', color: '#333333' }] } },
      }),
    });

    const objects = store.resolved(2)().types['object-detection'].objects;
    const byLabel = Object.fromEntries(objects.map((entry) => [entry.label, entry.color]));
    expect(byLabel).toStrictEqual({ person: '#333333', car: '#222222' });
  });

  it("writing one general override leaves the scope's other values inherited", () => {
    const store = load({
      'settings:global': {
        version: 4,
        general: { videoSyncBufferMs: 500, showRoi: false },
        types: {},
      },
    });

    store.set(1, 'general.videoSyncBufferMs', 600);

    expect(stored('settings:channel:1')?.general).toStrictEqual({ videoSyncBufferMs: 600 });
    expect(store.general(1)().videoSyncBufferMs).toBe(600);
    expect(store.resolved(1)().general.showRoi).toBe(false);
  });

  it('writing one general override leaves other scopes untouched', () => {
    const global = { version: 4, general: { videoSyncBufferMs: 500 }, types: {} };
    const store = load({ 'settings:global': global });

    store.set(1, 'general.videoSyncBufferMs', 600);

    expect(stored('settings:global')).toStrictEqual(global);
    expect(stored('settings:channel:2')).toBeNull();
    expect(store.general(2)().videoSyncBufferMs).toBe(500);
  });

  it("writing one general override keeps the scope's existing overrides", () => {
    const store = load({
      'settings:channel:1': {
        version: 4,
        general: { metadataRetentionMs: 2500 },
        types: { segmentation: { maskOpacity: 0.7 } },
      },
    });

    store.set(1, 'general.videoSyncBufferMs', 600);

    const scope = stored('settings:channel:1');
    expect(scope?.general).toStrictEqual({ metadataRetentionMs: 2500, videoSyncBufferMs: 600 });
    expect(scope?.types.segmentation?.maskOpacity).toBe(0.7);
    expect(scope?.version).toBe(10);
  });

  it('writing one general override clamps the value like the settings dialog', () => {
    const store = load();

    store.set(1, 'general.videoSyncBufferMs', 9000);

    expect(stored('settings:channel:1')?.general.videoSyncBufferMs).toBe(4000);
  });

  it('clearing one own general value keeps the others and the types', () => {
    const store = load({
      'settings:channel:1': {
        version: 4,
        general: { videoSyncBufferMs: 600, metadataRetentionMs: 2500 },
        types: { segmentation: { maskOpacity: 0.7 } },
      },
    });

    store.resetOverride(1, 'general.videoSyncBufferMs');

    const scope = stored('settings:channel:1');
    expect(scope?.general).toStrictEqual({ metadataRetentionMs: 2500 });
    expect(scope?.types.segmentation?.maskOpacity).toBe(0.7);
    expect(store.general(1)().videoSyncBufferMs).toBe(300);
  });

  it('clearing a value the scope does not have succeeds and changes nothing else', () => {
    const store = load({
      'settings:channel:1': { version: 4, general: { metadataRetentionMs: 2500 }, types: {} },
    });

    store.resetOverride(1, 'general.videoSyncBufferMs');

    expect(ownValues(store, 1)).toStrictEqual({ 'general.metadataRetentionMs': 2500 });
    expect(stored('settings:channel:1')?.general).toStrictEqual({ metadataRetentionMs: 2500 });
  });

  it('clearing a general value removes the entry when nothing is left', () => {
    const store = load({
      'settings:channel:1': { version: 4, general: { videoSyncBufferMs: 600 }, types: {} },
    });

    store.resetOverride(1, 'general.videoSyncBufferMs');

    expect(stored('settings:channel:1')).toBeNull();
    expect(ownValues(store, 1)).toStrictEqual({});
  });

  it('a clear that storage refuses still holds for the session and leaves the stored entry alone', () => {
    // The original returned null here; the store keeps its state in memory and ViewerStorage
    // keeps the refused write for the session instead (Review Focus 5).
    const channel1 = { version: 4, general: { videoSyncBufferMs: 600 }, types: {} };
    const store = load(
      { 'settings:channel:1': channel1 },
      { failWritesFor: ['settings:channel:1'] },
    );

    expect(() => store.resetOverride(1, 'general.videoSyncBufferMs')).not.toThrow();

    expect(stored('settings:channel:1')).toStrictEqual(channel1);
    expect(store.isOverride(1, 'general.videoSyncBufferMs')).toBe(false);
    expect(openStore().isOverride(1, 'general.videoSyncBufferMs')).toBe(false);
  });

  it('listing finds channels with their own value, sorted by channel number', () => {
    const store = load({
      'settings:channel:10': { version: 4, general: { videoSyncBufferMs: 900 }, types: {} },
      'settings:channel:2': { version: 4, general: { videoSyncBufferMs: 500 }, types: {} },
      'settings:channel:7': { version: 4, general: { videoSyncBufferMs: 700 }, types: {} },
      'settings:channel:3': { version: 4, general: { metadataRetentionMs: 2500 }, types: {} },
    });

    expect(listOverrides(store, 'general.videoSyncBufferMs')).toStrictEqual([
      { channel: 2, value: 500 },
      { channel: 7, value: 700 },
      { channel: 10, value: 900 },
    ]);
  });

  it('listing ignores the global scope, malformed entries and foreign keys', () => {
    const store = load({
      'settings:global': { version: 4, general: { videoSyncBufferMs: 500 }, types: {} },
      'settings:channel:abc': { version: 4, general: { videoSyncBufferMs: 500 }, types: {} },
      'settings:channel:4': 'not json',
      layout: 3,
    });
    fake.values.set(
      'viewerSettings_channel_5',
      JSON.stringify({ version: 4, general: { videoSyncBufferMs: 500 } }),
    );

    expect(listOverrides(store, 'general.videoSyncBufferMs')).toStrictEqual([]);
  });

  it('listing reports a channel whose own value equals the global value', () => {
    const store = load({
      'settings:global': { version: 4, general: { videoSyncBufferMs: 500 }, types: {} },
      'settings:channel:1': { version: 4, general: { videoSyncBufferMs: 500 }, types: {} },
    });

    expect(listOverrides(store, 'general.videoSyncBufferMs')).toStrictEqual([
      { channel: 1, value: 500 },
    ]);
  });

  it("the followed value is the global scope's own value, else the default", () => {
    const withGlobal = load({
      'settings:global': {
        version: 4,
        general: { videoSyncBufferMs: 1000, metadataRetentionMs: 0 },
        types: {},
      },
      'settings:channel:1': { version: 4, general: { videoSyncBufferMs: 350 }, types: {} },
    });
    expect(withGlobal.value('global', 'general.videoSyncBufferMs')).toBe(1000);
    expect(withGlobal.value('global', 'general.metadataRetentionMs')).toBe(0);
    expect(withGlobal.value('global', 'general.showRoi')).toBe(true);

    const withoutGlobal = load({
      'settings:channel:1': { version: 4, general: { videoSyncBufferMs: 600 }, types: {} },
    });
    expect(withoutGlobal.value('global', 'general.videoSyncBufferMs')).toBe(300);
  });

  it('raising for a channel and then applying globally leaves no entry for the channel', () => {
    const store = load();

    store.set(1, 'general.videoSyncBufferMs', 600);
    const result = store.raiseGlobal(1, 'general.videoSyncBufferMs', 800);

    expect(result).toStrictEqual({ raised: true });
    expect(store.value('global', 'general.videoSyncBufferMs')).toBe(800);
    expect(stored('settings:channel:1')).toBeNull();
    expect(stored('settings:global')?.general.videoSyncBufferMs).toBe(800);
  });

  it("applying globally raises the global value and removes the channel's own value", () => {
    for (const seeded of [
      { 'settings:global': { version: 4, general: { videoSyncBufferMs: 350 }, types: {} } },
      {},
    ]) {
      const store = load({
        ...seeded,
        'settings:channel:1': { version: 4, general: { videoSyncBufferMs: 350 }, types: {} },
      });

      const result = store.raiseGlobal(1, 'general.videoSyncBufferMs', 600);

      expect(result).toStrictEqual({ raised: true });
      expect(store.value('global', 'general.videoSyncBufferMs')).toBe(600);
      expect(stored('settings:global')?.general.videoSyncBufferMs).toBe(600);
      // Nothing was left of the channel's own values, so its entry is gone rather
      // than an empty stub.
      expect(stored('settings:channel:1')).toBeNull();
      expect(store.general(1)().videoSyncBufferMs).toBe(600);
    }
  });

  it('applying globally never lowers the global value', () => {
    const store = load({
      'settings:global': { version: 4, general: { videoSyncBufferMs: 1000 }, types: {} },
      'settings:channel:1': { version: 4, general: { videoSyncBufferMs: 350 }, types: {} },
    });

    const result = store.raiseGlobal(1, 'general.videoSyncBufferMs', 600);

    expect(result).toStrictEqual({ raised: false });
    expect(store.value('global', 'general.videoSyncBufferMs')).toBe(1000);
    expect(stored('settings:global')?.general.videoSyncBufferMs).toBe(1000);
    // Nothing was left of the channel's own values, so its entry is gone rather
    // than an empty stub.
    expect(stored('settings:channel:1')).toBeNull();
    expect(store.general(1)().videoSyncBufferMs).toBe(1000);
  });

  it('applying globally with a global value equal to the target does not write the global scope', () => {
    const global = { version: 4, general: { videoSyncBufferMs: 600 }, types: {} };
    // 600.4 and "600" normalize to 600, so they count as equal too. The text one is what a
    // control's raw value would be; the type says number, but normalization still parses it.
    for (const value of [600, 600.4, '600' as unknown as number]) {
      const store = load({
        'settings:global': global,
        'settings:channel:1': { version: 4, general: { videoSyncBufferMs: 350 }, types: {} },
      });

      const result = store.raiseGlobal(1, 'general.videoSyncBufferMs', value);

      expect(result).toStrictEqual({ raised: false });
      expect(store.value('global', 'general.videoSyncBufferMs')).toBe(600);
      expect(writesTo('settings:global')).toStrictEqual([]);
      expect(stored('settings:global')).toStrictEqual(global);
      // Nothing was left of the channel's own values, so its entry is gone rather
      // than an empty stub.
      expect(stored('settings:channel:1')).toBeNull();
    }
  });

  it("applying globally keeps the channel's other own values and types", () => {
    const store = load({
      'settings:channel:1': {
        version: 4,
        general: { videoSyncBufferMs: 350, metadataRetentionMs: 2500, showRoi: false },
        types: { segmentation: { maskOpacity: 0.7 } },
      },
    });

    store.raiseGlobal(1, 'general.videoSyncBufferMs', 600);

    const scope = stored('settings:channel:1');
    expect(scope?.general).toStrictEqual({ metadataRetentionMs: 2500, showRoi: false });
    expect(scope?.types.segmentation?.maskOpacity).toBe(0.7);
  });

  it("applying globally does not touch other channels' own values", () => {
    const channel2 = { version: 4, general: { videoSyncBufferMs: 450 }, types: {} };
    const store = load({
      'settings:channel:1': { version: 4, general: { videoSyncBufferMs: 350 }, types: {} },
      'settings:channel:2': channel2,
    });

    store.raiseGlobal(1, 'general.videoSyncBufferMs', 600);

    expect(stored('settings:channel:2')).toStrictEqual(channel2);
    expect(store.general(2)().videoSyncBufferMs).toBe(450);
  });

  it('clearing a value the scope does not have writes nothing', () => {
    const store = load();

    store.resetOverride(1, 'general.videoSyncBufferMs');

    expect(stored('settings:channel:1')).toBeNull();
    expect(fake.writes).toStrictEqual([]);
    expect(ownValues(store, 1)).toStrictEqual({});
  });

  it("the followed value is the global scope's own value, else the default, for general, type and nested ids", () => {
    const store = load({
      'settings:global': {
        version: 4,
        general: { videoSyncBufferMs: 900 },
        types: { tracking: { history: { trailLength: 40 } } },
      },
    });

    expect(store.value('global', 'general.videoSyncBufferMs')).toBe(900);
    expect(store.value('global', 'general.metadataRetentionMs')).toBe(0);
    expect(store.value('global', 'types.tracking.confidenceThreshold')).toBe(0);
    expect(store.value('global', 'types.tracking.history.trailLength')).toBe(40);
    expect(store.value('global', 'types.tracking.history.lostTrackTtlMs')).toBe(2000);
  });

  it('own values are read by id, nested ones included, empty for an empty scope', () => {
    const store = load({
      'settings:channel:1': {
        version: 4,
        general: { videoSyncBufferMs: 600 },
        types: { tracking: { history: { trailLength: 25 } } },
      },
    });

    expect(ownValues(store, 1)).toStrictEqual({
      'general.videoSyncBufferMs': 600,
      'types.tracking.history.trailLength': 25,
    });
    expect(ownValues(store, 2)).toStrictEqual({});
  });

  it('own values of a scope stored by the old dialog are all reported', () => {
    const store = load({
      'settings:channel:1': {
        version: 4,
        general: {
          videoSyncBufferMs: 700,
          metadataRetentionMs: 3000,
          showRoi: false,
          applyRoiFiltering: false,
        },
        types: {
          'object-detection': { confidenceThreshold: 0.4 },
          segmentation: { confidenceThreshold: 0.5, maskOpacity: 0.6 },
          tracking: {
            confidenceThreshold: 0.3,
            history: { enabled: false, trailLength: 30, lostTrackTtlMs: 6000 },
          },
        },
      },
    });

    expect(ownValues(store, 1)).toStrictEqual({
      'general.videoSyncBufferMs': 700,
      'general.metadataRetentionMs': 3000,
      'general.showRoi': false,
      'general.applyRoiFiltering': false,
      'types.object-detection.confidenceThreshold': 0.4,
      'types.segmentation.confidenceThreshold': 0.5,
      'types.segmentation.maskOpacity': 0.6,
      'types.tracking.confidenceThreshold': 0.3,
      'types.tracking.history.enabled': false,
      'types.tracking.history.trailLength': 30,
      'types.tracking.history.lostTrackTtlMs': 6000,
    });
  });

  it('own values of a legacy tracking scope with flat keys are reported under the history ids', () => {
    const store = load({
      'settings:channel:1': {
        version: 4,
        general: {},
        types: { tracking: { showTrackHistory: false, trailLength: 20, lostTrackTtlMs: 5000 } },
      },
    });

    expect(ownValues(store, 1)).toStrictEqual({
      'types.tracking.history.enabled': false,
      'types.tracking.history.trailLength': 20,
      'types.tracking.history.lostTrackTtlMs': 5000,
    });
  });

  it('writing own settings stores exactly what is given', () => {
    // Class rows have no writer until plan 2b, so the channel's row is stored up front.
    const store = load({
      'settings:channel:1': {
        version: 10,
        types: {
          'object-detection': {
            objects: [{ label: 'car', color: '#ff0000', style: 'dashed', width: 3 }],
          },
        },
      },
    });

    store.set(1, 'general.videoSyncBufferMs', 600);
    store.set(1, 'types.tracking.confidenceThreshold', 0.5);

    const scope = stored('settings:channel:1');
    expect(scope?.general).toStrictEqual({ videoSyncBufferMs: 600 });
    expect(scope?.types).toStrictEqual({
      tracking: { confidenceThreshold: 0.5 },
      'object-detection': {
        objects: [{ label: 'car', color: '#ff0000', style: 'dashed', width: 3 }],
      },
    });
    expect(ownValues(store, 1)).toStrictEqual({
      'general.videoSyncBufferMs': 600,
      'types.tracking.confidenceThreshold': 0.5,
    });
  });

  it("written values are normalized like the dialog's controls", () => {
    const store = load();

    store.set(1, 'general.videoSyncBufferMs', 9000);
    store.set(1, 'types.tracking.confidenceThreshold', 1.7);
    store.set(1, 'types.tracking.history.trailLength', 500);

    const scope = stored('settings:channel:1');
    expect(scope?.general.videoSyncBufferMs).toBe(4000);
    expect(scope?.types.tracking?.confidenceThreshold).toBe(1);
    expect(scope?.types.tracking?.history?.trailLength).toBe(120);
  });

  it('a switched-on value equal to the followed value is still an own value', () => {
    const store = load({
      'settings:global': { version: 4, general: { videoSyncBufferMs: 500 }, types: {} },
    });

    store.set(1, 'general.videoSyncBufferMs', 500);

    expect(ownValues(store, 1)).toStrictEqual({ 'general.videoSyncBufferMs': 500 });
    expect(listOverrides(store, 'general.videoSyncBufferMs')).toStrictEqual([
      { channel: 1, value: 500 },
    ]);
  });

  it('resolving a channel agrees with its own values and the followed values for every id', () => {
    const store = load();
    const globalValues = {
      'general.videoSyncBufferMs': 900,
      'general.showRoi': false,
      'types.object-detection.confidenceThreshold': 0.6,
      'types.tracking.history.trailLength': 50,
      'types.pose-estimation.visible': false,
      'auxiliary.blazepose-3d.yawDegrees': 30,
    } as const;
    const channelValues = {
      'types.classification.visible': false,
      'types.pose-estimation.showKeypointLabels': true,
      'auxiliary.blazepose-3d.panelMode': 'expanded',
      'auxiliary.blazepose-3d.backgroundTransparency': 0.4,
      'general.metadataRetentionMs': 5000,
      'general.lineWidth': 6,
      'general.applyRoiFiltering': false,
      'types.segmentation.confidenceThreshold': 0.3,
      'types.segmentation.maskOpacity': 0.9,
      'types.tracking.confidenceThreshold': 0.2,
      'types.tracking.history.enabled': false,
      'types.tracking.history.lostTrackTtlMs': 4000,
    } as const;
    for (const [id, value] of Object.entries(globalValues))
      store.set('global', id as SettingId, value);
    for (const [id, value] of Object.entries(channelValues)) store.set(1, id as SettingId, value);

    const own = ownValues(store, 1);
    for (const { id } of SCALAR_SETTINGS) {
      const expected = Object.hasOwn(own, id) ? own[id] : store.value('global', id);
      expect(resolvedValueForId(store, 1, id), id).toBe(expected);
    }
  });

  it('a channel owns overlay and 3D pose settings like any other, and gives them back', () => {
    const store = load({
      'settings:global': {
        version: 10,
        types: { 'pose-estimation': { visible: false } },
        auxiliary: { 'blazepose-3d': { yawDegrees: -20 } },
      },
    });

    store.set(2, 'types.pose-estimation.visible', true);
    store.set(2, 'auxiliary.blazepose-3d.yawDegrees', 75);
    store.set(2, 'auxiliary.blazepose-3d.backgroundTransparency', 3);

    expect(stored('settings:channel:2')?.auxiliary).toStrictEqual({
      'blazepose-3d': { yawDegrees: 75, backgroundTransparency: 1 },
    });
    expect(ownValues(store, 2)).toStrictEqual({
      'types.pose-estimation.visible': true,
      'auxiliary.blazepose-3d.backgroundTransparency': 1,
      'auxiliary.blazepose-3d.yawDegrees': 75,
    });
    expect(store.resolved(2)().types['pose-estimation'].visible).toBe(true);
    expect(store.value(2, 'auxiliary.blazepose-3d.yawDegrees')).toBe(75);
    expect(store.value('global', 'auxiliary.blazepose-3d.yawDegrees')).toBe(-20);
    expect(store.value('global', 'auxiliary.blazepose-3d.pitchDegrees')).toBe(20);
    expect(listOverrides(store, 'auxiliary.blazepose-3d.yawDegrees')).toStrictEqual([
      { channel: 2, value: 75 },
    ]);

    // Changing a general value of the channel keeps its 3D pose values.
    store.set(2, 'general.videoSyncBufferMs', 600);
    expect(stored('settings:channel:2')?.auxiliary['blazepose-3d']?.yawDegrees).toBe(75);

    // Giving every 3D value back leaves no explicit panel settings for the channel.
    store.resetOverride(2, 'auxiliary.blazepose-3d.yawDegrees');
    store.resetOverride(2, 'auxiliary.blazepose-3d.backgroundTransparency');
    expect(stored('settings:channel:2')?.auxiliary['blazepose-3d']).toBeUndefined();
    expect(store.value(2, 'auxiliary.blazepose-3d.yawDegrees')).toBe(-20);
  });

  it('a channel whose only own values are 3D pose settings still counts and is removed when they go', () => {
    const store = load({
      'settings:channel:4': {
        version: 10,
        auxiliary: { 'blazepose-3d': { panelMode: 'collapsed' } },
      },
    });

    expect(store.overridesOf('auxiliary.blazepose-3d.panelMode')).toStrictEqual([4]);
    store.resetOverride(4, 'auxiliary.blazepose-3d.panelMode');
    expect(stored('settings:channel:4')).toBeNull();
    expect(store.overridesOf('auxiliary.blazepose-3d.panelMode')).toStrictEqual([]);
  });

  it('clearing one own value keeps the others and the class colour entries', () => {
    const store = load({
      'settings:channel:1': {
        version: 4,
        general: { videoSyncBufferMs: 600, metadataRetentionMs: 2500 },
        types: {
          tracking: { history: { enabled: false, trailLength: 20, lostTrackTtlMs: 5000 } },
          segmentation: { objects: [{ label: 'car', color: '#ff0000', style: 'solid', width: 1 }] },
        },
      },
    });

    store.resetOverride(1, 'general.videoSyncBufferMs');
    let scope = stored('settings:channel:1');
    expect(scope?.general).toStrictEqual({ metadataRetentionMs: 2500 });
    expect(scope?.types.segmentation?.objects).toStrictEqual([
      { label: 'car', color: '#ff0000', style: 'solid', width: 1 },
    ]);

    // Clearing a nested id leaves its siblings under the same parent untouched.
    store.resetOverride(1, 'types.tracking.history.enabled');
    scope = stored('settings:channel:1');
    expect(scope?.types.tracking?.history).toStrictEqual({ trailLength: 20, lostTrackTtlMs: 5000 });
  });

  it('clearing a value the scope does not have writes nothing, for a nested id', () => {
    const store = load();

    store.resetOverride(1, 'types.tracking.history.trailLength');

    expect(stored('settings:channel:1')).toBeNull();
    expect(fake.writes).toStrictEqual([]);
    expect(ownValues(store, 1)).toStrictEqual({});
  });

  it("clearing a channel's last own value removes its entry", () => {
    const store = load({
      'settings:channel:1': { version: 4, general: { videoSyncBufferMs: 600 }, types: {} },
    });

    store.resetOverride(1, 'general.videoSyncBufferMs');

    expect(stored('settings:channel:1')).toBeNull();
    expect(ownValues(store, 1)).toStrictEqual({});
  });

  it("clearing a channel's last nested own value removes its entry", () => {
    const store = load({
      'settings:channel:1': {
        version: 4,
        general: {},
        types: { tracking: { history: { trailLength: 30 } } },
      },
    });

    store.resetOverride(1, 'types.tracking.history.trailLength');

    expect(stored('settings:channel:1')).toBeNull();
    expect(ownValues(store, 1)).toStrictEqual({});
  });

  it('clearing a value keeps the entry while class colour entries remain', () => {
    const store = load({
      'settings:channel:1': {
        version: 4,
        general: { videoSyncBufferMs: 600 },
        types: {
          'object-detection': {
            objects: [{ label: 'car', color: '#ff0000', style: 'solid', width: 1 }],
          },
        },
      },
    });

    store.resetOverride(1, 'general.videoSyncBufferMs');

    const scope = stored('settings:channel:1');
    expect(scope).not.toBeNull();
    expect(scope?.types['object-detection']?.objects).toStrictEqual([
      { label: 'car', color: '#ff0000', style: 'solid', width: 1 },
    ]);
  });

  it('listing channel overrides works for a nested id, sorted by channel, ignoring the global scope and malformed entries', () => {
    const store = load({
      'settings:global': {
        version: 4,
        general: {},
        types: { tracking: { history: { trailLength: 99 } } },
      },
      'settings:channel:10': {
        version: 4,
        general: {},
        types: { tracking: { history: { trailLength: 90 } } },
      },
      'settings:channel:2': {
        version: 4,
        general: {},
        types: { tracking: { history: { trailLength: 20 } } },
      },
      'settings:channel:4': 'not json',
      layout: 3,
    });

    expect(listOverrides(store, 'types.tracking.history.trailLength')).toStrictEqual([
      { channel: 2, value: 20 },
      { channel: 10, value: 90 },
    ]);
  });

  it("inherited objects are the global scope's own entries for the type", () => {
    const store = load({
      'settings:global': {
        version: 4,
        general: {},
        types: {
          'object-detection': {
            objects: [{ label: 'car', color: '#ff0000', style: 'solid', width: 1 }],
          },
        },
      },
    });

    expect(store.resolved(0)().types['object-detection'].objects).toStrictEqual([
      { label: 'car', color: '#ff0000', style: 'solid', width: 1 },
    ]);
    expect(store.resolved(0)().types.segmentation.objects).toStrictEqual([]);
  });
});

describe('ViewerSettingsStore', () => {
  it('resolved(channel) is computed once per change: 1000 reads after one set() parse storage once', () => {
    const parse = vi.spyOn(JSON, 'parse');
    const store = load({ 'settings:channel:1': { version: 10, general: { lineWidth: 5 } } });
    // Opening the store reads every scope once: the global one (absent) and channel 1's.
    expect(parse).toHaveBeenCalledOnce();

    const resolved = store.resolved(1);
    const before = resolved();
    expect(before.general.lineWidth).toBe(5);
    store.set(1, 'general.lineWidth', 6);
    // The write re-reads its own scope first, in case another tab changed it: the one parse.
    expect(parse).toHaveBeenCalledTimes(2);
    const readsAfterSet = fake.reads.length;
    const after = resolved();
    expect(after).not.toBe(before);
    expect(after.general.lineWidth).toBe(6);

    let sameObject = 0;
    for (let i = 0; i < 1000; i++) {
      if (store.resolved(1)() === after) sameObject++;
    }
    expect(sameObject).toBe(1000);
    expect(store.resolved(1)).toBe(resolved);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(fake.reads.length).toBe(readsAfterSet);

    // Another channel's change leaves channel 1's settings as they were.
    store.set(2, 'general.lineWidth', 8);
    expect(store.resolved(1)()).toBe(after);
  });

  it("two viewer tabs writing the same scopes keep each other's keys", () => {
    const first = load({ 'settings:channel:1': { version: 10, general: { lineWidth: 5 } } });
    const second = openStore();

    first.set(1, 'general.showRoi', false);
    second.set(1, 'types.tracking.visible', false);
    first.set('global', 'general.lineWidth', 2);
    second.set('global', 'types.segmentation.maskOpacity', 0.1);

    expect(stored('settings:channel:1')).toStrictEqual({
      version: 10,
      general: { lineWidth: 5, showRoi: false },
      types: { tracking: { visible: false } },
      auxiliary: {},
    });
    expect(stored('settings:global')).toStrictEqual({
      version: 10,
      general: { lineWidth: 2 },
      types: { segmentation: { maskOpacity: 0.1 } },
      auxiliary: {},
    });
    // A tab takes up what it found when it wrote.
    expect(second.resolved(1)().general.showRoi).toBe(false);
    expect(second.value('global', 'general.lineWidth')).toBe(2);

    // A reset in one tab keeps the key the other tab added since.
    first.resetOverride(1, 'general.lineWidth');
    expect(stored('settings:channel:1')).toStrictEqual({
      version: 10,
      general: { showRoi: false },
      types: { tracking: { visible: false } },
      auxiliary: {},
    });
  });

  it('a raise whose channel write storage refuses still makes the channel follow it this session', () => {
    const channel1 = { version: 10, general: { videoSyncBufferMs: 400 } };
    const store = load(
      { 'settings:channel:1': channel1 },
      { failWritesFor: ['settings:channel:1'] },
    );

    expect(store.raiseGlobal(1, 'general.videoSyncBufferMs', 900)).toStrictEqual({ raised: true });

    expect(store.value(1, 'general.videoSyncBufferMs')).toBe(900);
    expect(store.general(1)().videoSyncBufferMs).toBe(900);
    expect(openStore().value(1, 'general.videoSyncBufferMs')).toBe(900);
    expect(stored('settings:global')?.general.videoSyncBufferMs).toBe(900);
    expect(stored('settings:channel:1')).toStrictEqual(channel1);
  });

  it('a channel override is marked, survives reload and resetOverride removes only that key', () => {
    let store = load({ 'settings:global': { version: 10, general: { lineWidth: 4 } } });

    store.set(2, 'general.lineWidth', 7);
    store.set(2, 'types.tracking.visible', false);
    expect(store.isOverride(2, 'general.lineWidth')).toBe(true);
    expect(store.isOverride(2, 'general.showRoi')).toBe(false);
    expect(store.isOverride(1, 'general.lineWidth')).toBe(false);

    store = reload();
    expect(store.isOverride(2, 'general.lineWidth')).toBe(true);
    expect(store.resolved(2)().general.lineWidth).toBe(7);
    expect(store.overridesOf('general.lineWidth')).toStrictEqual([2]);

    store.resetOverride(2, 'general.lineWidth');
    expect(store.isOverride(2, 'general.lineWidth')).toBe(false);
    expect(store.resolved(2)().general.lineWidth).toBe(4);
    expect(store.overridesOf('general.lineWidth')).toStrictEqual([]);
    expect(store.isOverride(2, 'types.tracking.visible')).toBe(true);
    expect(store.resolved(2)().types.tracking.visible).toBe(false);
    expect(stored('settings:channel:2')).toStrictEqual({
      version: 10,
      general: {},
      types: { tracking: { visible: false } },
      auxiliary: {},
    });
  });

  it('a global change does not touch channel overrides and is visible in every non-overriding channel', () => {
    const store = load({
      'settings:channel:2': { version: 10, types: { segmentation: { maskOpacity: 0.9 } } },
    });
    const channel2 = fake.readRaw('settings:channel:2');
    // Resolved before the change, so the change has to reach existing signals.
    const channels = [0, 1, 2, 3, 47];
    for (const channel of channels) store.resolved(channel)();

    store.set('global', 'types.segmentation.maskOpacity', 0.2);

    // Deliberate change: the global scope stores only the changed key.
    expect(stored('settings:global')).toStrictEqual({
      version: 10,
      general: {},
      types: { segmentation: { maskOpacity: 0.2 } },
      auxiliary: {},
    });
    for (const channel of channels.filter((channel) => channel !== 2)) {
      expect(store.resolved(channel)().types.segmentation.maskOpacity).toBe(0.2);
    }
    expect(store.resolved(2)().types.segmentation.maskOpacity).toBe(0.9);
    expect(store.isOverride(2, 'types.segmentation.maskOpacity')).toBe(true);
    expect(fake.readRaw('settings:channel:2')).toBe(channel2);
    expect(writesTo('settings:channel:2')).toStrictEqual([]);
  });

  it('throwing or corrupt storage → defaults, set() still works for the session, nothing throws', () => {
    const defaultSync = { videoSyncBufferMs: 300, metadataRetentionMs: 0 };

    // Storage that cannot be reached at all.
    let store = load(
      { 'settings:channel:1': { version: 10, general: { lineWidth: 9 } } },
      { unavailable: true },
    );
    expect(store.resolved(1)()).toStrictEqual(NEAT_OVERLAY_DEFAULTS);
    expect(store.general(1)()).toStrictEqual(defaultSync);
    expect(store.overridesOf('general.lineWidth')).toStrictEqual([]);
    expect(() => store.set(1, 'general.lineWidth', 6)).not.toThrow();
    expect(store.resolved(1)().general.lineWidth).toBe(6);
    expect(store.overridesOf('general.lineWidth')).toStrictEqual([1]);
    expect(() => store.raiseGlobal(1, 'general.videoSyncBufferMs', 900)).not.toThrow();
    expect(store.general(1)().videoSyncBufferMs).toBe(900);
    // The Viewer opened again in the same session keeps the changes.
    expect(openStore().resolved(1)().general.lineWidth).toBe(6);
    expect(openStore().general(1)().videoSyncBufferMs).toBe(900);
    expect(() => store.resetOverride(1, 'general.lineWidth')).not.toThrow();
    expect(store.resolved(1)().general.lineWidth).toBe(3);

    // Storage that refuses every write (a full quota).
    store = load({}, { failWrites: true });
    expect(() => store.set('global', 'types.tracking.visible', false)).not.toThrow();
    expect(store.resolved(5)().types.tracking.visible).toBe(false);
    expect(openStore().resolved(5)().types.tracking.visible).toBe(false);
    expect(stored('settings:global')).toBeNull();

    // Storage holding garbage.
    store = load({
      'settings:global': '{',
      'settings:channel:1': 'null',
      'settings:channel:2': '[1,2]',
      'settings:channel:3': {
        version: 10,
        general: { lineWidth: 'wide', showRoi: 'no' },
        types: { tracking: { history: 'long' }, segmentation: null },
        auxiliary: 5,
      },
    });
    for (const channel of [0, 1, 2, 3]) {
      expect(store.resolved(channel)()).toStrictEqual(NEAT_OVERLAY_DEFAULTS);
      expect(store.general(channel)()).toStrictEqual(defaultSync);
    }
    expect(() => store.set('global', 'general.lineWidth', 2)).not.toThrow();
    expect(store.resolved(1)().general.lineWidth).toBe(2);
    expect(stored('settings:global')?.general).toStrictEqual({ lineWidth: 2 });
  });

  it('general(channel) is cached and changes only when its values do', () => {
    const store = load();
    const general = store.general(1);
    const before = general();

    store.set(1, 'general.lineWidth', 6);
    expect(store.general(1)).toBe(general);
    expect(general()).toBe(before);

    store.set(1, 'general.metadataRetentionMs', 1000);
    expect(general()).toStrictEqual({ videoSyncBufferMs: 300, metadataRetentionMs: 1000 });
  });

  it('setting a value a scope already owns writes nothing', () => {
    const store = load({ 'settings:channel:1': { version: 10, general: { lineWidth: 6 } } });
    const resolved = store.resolved(1)();

    store.set(1, 'general.lineWidth', 6);

    expect(fake.writes).toStrictEqual([]);
    expect(store.resolved(1)()).toBe(resolved);
  });
});

/**
 * The value the resolution gives a channel for `id`. Overlay settings come from resolved(), the
 * timing values from general(). The 3D pose values have no resolved view until the auxiliary panel
 * (plan 2b) needs one, so they are read back through value().
 */
function resolvedValueForId(store: ViewerSettingsStore, channel: number, id: SettingId): unknown {
  if (id === 'general.videoSyncBufferMs') return store.general(channel)().videoSyncBufferMs;
  if (id === 'general.metadataRetentionMs') return store.general(channel)().metadataRetentionMs;
  if (id.startsWith('auxiliary.')) return store.value(channel, id);
  return id
    .split('.')
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown>)[key],
      store.resolved(channel)(),
    );
}
