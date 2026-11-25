import { NEAT_OVERLAY_DEFAULTS, NEAT_OVERLAY_STYLE_FALLBACK_COLOR } from '@sima/neat-ui/video';
import {
  EMPTY_OVERRIDES,
  holdsSomething,
  normalizeSettingValue,
  resolveOrientation,
  resolveOverlaySettings,
  resolveValue,
  settingsOverrides,
  withOwnValue,
  withoutOwnValue,
} from './resolver';
import { GENERAL_DEFAULTS, SCALAR_SETTINGS, SETTINGS_VERSION, TYPE_DEFAULTS } from './schema';

// Ported from viewerSettings.test.js (sima-neat/insight@829ec7c). There the resolver's
// normalizeSettings filled in every default; here a scope is only ever read as its own values
// (settingsOverrides) and the defaults come in at resolution, so assertions on a normalized scope
// read its own values.
describe('viewer settings resolver', () => {
  it('viewer synchronization settings default to a 300 ms video buffer and unlimited retention', () => {
    expect({ ...GENERAL_DEFAULTS }).toStrictEqual({
      videoSyncBufferMs: 300,
      metadataRetentionMs: 0,
      showRoi: true,
      applyRoiFiltering: true,
      lineWidth: 3,
      orientation: 'none',
    });
  });

  it('the global line width is a whole number of pixels from 1 to 10', () => {
    // One width for every overlay line, defaulting to 3 px.
    const widthOf = (lineWidth: unknown) =>
      settingsOverrides({ version: 10, general: { lineWidth } }).general.lineWidth;

    expect(widthOf(5)).toBe(5);
    expect(widthOf(2.6)).toBe(3);
    expect(widthOf(0)).toBe(1);
    expect(widthOf(50)).toBe(10);
    expect(widthOf('thick')).toBe(3);
  });

  it('viewer synchronization settings preserve configured values', () => {
    const own = settingsOverrides({
      version: 10,
      general: { videoSyncBufferMs: 700, metadataRetentionMs: 2500 },
    });

    expect(own.general.videoSyncBufferMs).toBe(700);
    expect(own.general.metadataRetentionMs).toBe(2500);
  });

  it('a scope holds only the known settings; style keys of an old pose renderer are dropped', () => {
    // Deliberate change: the original kept these style keys (copied by Object.assign) although
    // nothing read them.
    const own = settingsOverrides({
      version: 10,
      types: {
        'pose-estimation': {
          poseStrokeColor: '#123456',
          poseFillColor: '#654321',
          poseFont: '12px sans-serif',
        },
      },
    });

    expect(own.types['pose-estimation']).toBeUndefined();
  });

  it('pins the metadata type defaults', () => {
    // TYPE_DEFAULTS comes from the kit; this pins the values the viewer has always used.
    expect(TYPE_DEFAULTS).toStrictEqual({
      'object-detection': { visible: true, confidenceThreshold: 0, objects: [] },
      segmentation: { visible: true, confidenceThreshold: 0, maskOpacity: 0.4, objects: [] },
      tracking: {
        visible: true,
        confidenceThreshold: 0,
        history: { enabled: true, trailLength: 10, lostTrackTtlMs: 2000 },
      },
      'pose-estimation': {
        visible: true,
        showKeypoints: true,
        showKeypointLabels: false,
        showBoxes: true,
        objects: [],
      },
      classification: { visible: true },
    });
  });

  it('settings version is 10 and object lists default to empty', () => {
    expect(SETTINGS_VERSION).toBe(10);
    expect(TYPE_DEFAULTS['object-detection'].objects).toStrictEqual([]);
    expect(TYPE_DEFAULTS.segmentation.objects).toStrictEqual([]);
  });

  it('scope overrides are read without defaults', () => {
    expect(
      settingsOverrides({ version: 10, general: { videoSyncBufferMs: 600 }, types: {} }).general,
    ).toStrictEqual({
      videoSyncBufferMs: 600,
    });
    expect(settingsOverrides(null)).toStrictEqual({ general: {}, types: {} });
  });

  it('the scalar settings list has every switchable id, each with its tab and metadata type', () => {
    expect(
      SCALAR_SETTINGS.map(({ id, tab, metadataType }) => ({ id, tab, metadataType })),
    ).toStrictEqual([
      { id: 'general.videoSyncBufferMs', tab: 'General', metadataType: null },
      { id: 'general.metadataRetentionMs', tab: 'General', metadataType: null },
      { id: 'general.lineWidth', tab: 'General', metadataType: null },
      { id: 'general.orientation', tab: 'General', metadataType: null },
      { id: 'general.showRoi', tab: 'ROI', metadataType: null },
      { id: 'general.applyRoiFiltering', tab: 'ROI', metadataType: null },
      {
        id: 'types.object-detection.confidenceThreshold',
        tab: 'Metadata',
        metadataType: 'object-detection',
      },
      {
        id: 'types.segmentation.confidenceThreshold',
        tab: 'Metadata',
        metadataType: 'segmentation',
      },
      { id: 'types.segmentation.maskOpacity', tab: 'Metadata', metadataType: 'segmentation' },
      { id: 'types.tracking.confidenceThreshold', tab: 'Metadata', metadataType: 'tracking' },
      { id: 'types.tracking.history.enabled', tab: 'Metadata', metadataType: 'tracking' },
      { id: 'types.tracking.history.trailLength', tab: 'Metadata', metadataType: 'tracking' },
      { id: 'types.tracking.history.lostTrackTtlMs', tab: 'Metadata', metadataType: 'tracking' },
      { id: 'types.object-detection.visible', tab: 'Metadata', metadataType: 'object-detection' },
      { id: 'types.segmentation.visible', tab: 'Metadata', metadataType: 'segmentation' },
      { id: 'types.tracking.visible', tab: 'Metadata', metadataType: 'tracking' },
      { id: 'types.pose-estimation.visible', tab: 'Metadata', metadataType: 'pose-estimation' },
      { id: 'types.classification.visible', tab: 'Metadata', metadataType: 'classification' },
      {
        id: 'types.pose-estimation.showKeypoints',
        tab: 'Metadata',
        metadataType: 'pose-estimation',
      },
      {
        id: 'types.pose-estimation.showKeypointLabels',
        tab: 'Metadata',
        metadataType: 'pose-estimation',
      },
      { id: 'types.pose-estimation.showBoxes', tab: 'Metadata', metadataType: 'pose-estimation' },
    ]);
  });

  // New tests for this port.

  it('resolving with nothing stored gives the kit overlay defaults with no ROI', () => {
    expect(resolveOverlaySettings(EMPTY_OVERRIDES, EMPTY_OVERRIDES, [])).toStrictEqual(
      NEAT_OVERLAY_DEFAULTS,
    );
  });

  it('pose boxes resolve on with no class rows by default, and take a channel row and its own switch', () => {
    const defaults = resolveOverlaySettings(EMPTY_OVERRIDES, EMPTY_OVERRIDES, []);
    expect(defaults.types['pose-estimation'].showBoxes).toBe(true);
    expect(defaults.types['pose-estimation'].objects).toStrictEqual([]);

    const row = { label: 'person', color: '#ff0000', style: 'dashed' as const, width: 3 };
    const channel = withOwnValue(
      settingsOverrides({ version: 10, types: { 'pose-estimation': { objects: [row] } } }),
      'types.pose-estimation.showBoxes',
      false,
    );
    const resolved = resolveOverlaySettings(EMPTY_OVERRIDES, channel, []).types['pose-estimation'];
    expect(resolved.showBoxes).toBe(false);
    expect(resolved.objects).toStrictEqual([row]);
  });

  it('resolving takes the regions as given, whatever the scopes hold', () => {
    const roi = [
      {
        type: 'inclusion' as const,
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.5, y: 0.9 },
        ],
      },
    ];
    const own = withOwnValue(EMPTY_OVERRIDES, 'general.lineWidth', 5);

    const resolved = resolveOverlaySettings(own, EMPTY_OVERRIDES, roi);

    expect(resolved.roi).toBe(roi);
    expect(resolved.general.lineWidth).toBe(5);
  });

  it('resolves orientation channel over global, none by default', () => {
    const global = settingsOverrides({ version: 10, general: { orientation: 'mirror' } });
    const channel = settingsOverrides({ version: 10, general: { orientation: 'rotate-180' } });

    expect(resolveOrientation(EMPTY_OVERRIDES, EMPTY_OVERRIDES)).toBe('none');
    expect(resolveOrientation(global, EMPTY_OVERRIDES)).toBe('mirror');
    expect(resolveOrientation(global, channel)).toBe('rotate-180');
    expect(resolveOrientation(EMPTY_OVERRIDES, channel)).toBe('rotate-180');
  });

  it('keeps a stored orientation only when it is one of the four', () => {
    const orientationOf = (orientation: unknown) =>
      settingsOverrides({ version: 10, general: { orientation } }).general.orientation;

    for (const orientation of ['none', 'mirror', 'flip-vertical', 'rotate-180']) {
      expect(orientationOf(orientation)).toBe(orientation);
    }
    // 'toString' is found on every object's prototype: membership is in the list, not a lookup.
    for (const junk of ['sideways', 7, 'toString', null, true, ['mirror']]) {
      expect(orientationOf(junk), String(junk)).toBe('none');
      expect(normalizeSettingValue('general.orientation', junk)).toBe('none');
    }
  });

  it('a scope stored at another version, or at none, holds nothing', () => {
    for (const version of [9, 11, '10', undefined]) {
      expect(
        settingsOverrides({ version, general: { lineWidth: 5, videoSyncBufferMs: 600 } }),
      ).toStrictEqual(EMPTY_OVERRIDES);
    }
    // The first viewer's flat shape, with no version.
    expect(settingsOverrides({ showRoi: false, confidenceThreshold: 0.4 })).toStrictEqual(
      EMPTY_OVERRIDES,
    );
  });

  it('class rows normalize their fields and drop rows without a label', () => {
    const own = settingsOverrides({
      version: 10,
      types: {
        segmentation: {
          objects: [
            { label: '  person ', color: 7, style: 'wavy', width: '3' },
            { label: '   ' },
            'car',
            { label: 'bus', color: '#0000ff', style: 'dotted', width: 2 },
          ],
        },
      },
    });

    expect(own.types.segmentation?.objects).toStrictEqual([
      { label: 'person', color: NEAT_OVERLAY_STYLE_FALLBACK_COLOR, style: 'solid', width: 3 },
      { label: 'bus', color: '#0000ff', style: 'dotted', width: 1 },
    ]);
  });

  it('corrupt scopes read as holding nothing and never throw', () => {
    for (const raw of [
      undefined,
      'text',
      42,
      [],
      null,
      { version: 10, general: null, types: 'x' },
      { version: 10, types: { tracking: { history: 5 } } },
      { version: 10, general: [1, 2], types: [3] },
    ]) {
      expect(settingsOverrides(raw)).toStrictEqual({ general: {}, types: {} });
    }
  });

  it('a scope gives a value back without leaving empty containers behind', () => {
    let own = withOwnValue(EMPTY_OVERRIDES, 'types.tracking.history.trailLength', 25);
    own = withOwnValue(own, 'general.lineWidth', 6);
    expect(holdsSomething(own)).toBe(true);
    expect(resolveValue(EMPTY_OVERRIDES, own, 'types.tracking.history.trailLength')).toBe(25);

    own = withoutOwnValue(own, 'types.tracking.history.trailLength');
    own = withoutOwnValue(own, 'general.lineWidth');
    expect(own).toStrictEqual({ general: {}, types: {} });
    expect(holdsSomething(own)).toBe(false);
    // The original object is never changed.
    expect(EMPTY_OVERRIDES).toStrictEqual({ general: {}, types: {} });
  });
});
