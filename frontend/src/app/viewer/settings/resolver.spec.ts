import { NEAT_OVERLAY_DEFAULTS, NEAT_OVERLAY_STYLE_FALLBACK_COLOR } from '@sima/neat-ui';
import {
  EMPTY_OVERRIDES,
  holdsSomething,
  resolveOverlaySettings,
  resolveValue,
  settingsOverrides,
  withOwnValue,
  withoutOwnValue,
} from './resolver';
import {
  AUXILIARY_DEFAULTS,
  GENERAL_DEFAULTS,
  SCALAR_SETTINGS,
  SETTINGS_VERSION,
  TYPE_DEFAULTS,
} from './schema';

// Ported from viewerSettings.test.js (829ec7c). There the resolver's normalizeSettings filled in
// every default; here a scope is only ever read as its own values (settingsOverrides) and the
// defaults come in at resolution, so assertions on a normalized scope read its own values.
describe('viewer settings resolver', () => {
  it('viewer synchronization settings default to a 300 ms video buffer and unlimited retention', () => {
    expect({ ...GENERAL_DEFAULTS }).toStrictEqual({
      videoSyncBufferMs: 300,
      metadataRetentionMs: 0,
      showRoi: true,
      applyRoiFiltering: true,
      lineWidth: 3,
    });
  });

  it('the global line width is a whole number of pixels from 1 to 10', () => {
    // Owner review (O4): one width for every overlay line, defaulting to 3 px.
    const widthOf = (lineWidth: unknown) =>
      settingsOverrides({ version: 4, general: { lineWidth } }).general.lineWidth;

    expect(widthOf(5)).toBe(5);
    expect(widthOf(2.6)).toBe(3);
    expect(widthOf(0)).toBe(1);
    expect(widthOf(50)).toBe(10);
    expect(widthOf('thick')).toBe(3);
  });

  it('viewer synchronization settings preserve configured values', () => {
    const own = settingsOverrides({
      version: 4,
      general: { videoSyncBufferMs: 700, metadataRetentionMs: 2500 },
    });

    expect(own.general.videoSyncBufferMs).toBe(700);
    expect(own.general.metadataRetentionMs).toBe(2500);
  });

  it('BlazePose 3D settings normalize values and drop unknown keys', () => {
    const own = settingsOverrides({
      version: 6,
      auxiliary: {
        'blazepose-3d': {
          panelMode: 'floating',
          backgroundTransparency: 3,
          unknownKey: true,
          yawDegrees: 999,
          pitchDegrees: -999,
        },
      },
      types: {
        'pose-estimation': {
          poseStrokeColor: '#123456',
          poseFillColor: '#654321',
          poseFont: '12px sans-serif',
        },
      },
    });
    const pose3D = own.auxiliary['blazepose-3d'];

    expect({ ...AUXILIARY_DEFAULTS['blazepose-3d'] }).toStrictEqual({
      enabled: true,
      panelMode: 'compact',
      backgroundTransparency: 0,
      yawDegrees: -45,
      pitchDegrees: 20,
      showReferenceBox: true,
    });
    expect({
      panelMode: pose3D?.panelMode,
      backgroundTransparency: pose3D?.backgroundTransparency,
      yawDegrees: pose3D?.yawDegrees,
      pitchDegrees: pose3D?.pitchDegrees,
    }).toStrictEqual({
      panelMode: 'compact',
      backgroundTransparency: 1,
      yawDegrees: 180,
      pitchDegrees: -60,
    });
    expect(pose3D !== undefined && 'unknownKey' in pose3D).toBe(false);
    // Deliberate change: the original kept these style keys of an old pose renderer (copied by
    // Object.assign) although nothing read them. A scope holds only the known settings now.
    expect(own.types['pose-estimation']).toBeUndefined();
  });

  it('settings version is 10 and object lists default to empty', () => {
    expect(SETTINGS_VERSION).toBe(10);
    expect(TYPE_DEFAULTS['object-detection'].objects).toStrictEqual([]);
    expect(TYPE_DEFAULTS.segmentation.objects).toStrictEqual([]);
  });

  it('scope overrides are read without defaults', () => {
    expect(
      settingsOverrides({ version: 4, general: { videoSyncBufferMs: 600 }, types: {} }).general,
    ).toStrictEqual({
      videoSyncBufferMs: 600,
    });
    expect(settingsOverrides(null)).toStrictEqual({ general: {}, types: {}, auxiliary: {} });
  });

  it('the scalar settings list has every switchable id, each with its tab and metadata type', () => {
    expect(
      SCALAR_SETTINGS.map(({ id, tab, metadataType }) => ({ id, tab, metadataType })),
    ).toStrictEqual([
      { id: 'general.videoSyncBufferMs', tab: 'General', metadataType: null },
      { id: 'general.metadataRetentionMs', tab: 'General', metadataType: null },
      { id: 'general.lineWidth', tab: 'General', metadataType: null },
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
      { id: 'auxiliary.blazepose-3d.enabled', tab: '3D Pose', metadataType: null },
      { id: 'auxiliary.blazepose-3d.panelMode', tab: '3D Pose', metadataType: null },
      { id: 'auxiliary.blazepose-3d.backgroundTransparency', tab: '3D Pose', metadataType: null },
      { id: 'auxiliary.blazepose-3d.yawDegrees', tab: '3D Pose', metadataType: null },
      { id: 'auxiliary.blazepose-3d.pitchDegrees', tab: '3D Pose', metadataType: null },
      { id: 'auxiliary.blazepose-3d.showReferenceBox', tab: '3D Pose', metadataType: null },
    ]);
  });

  // New tests for this port.

  it('resolving with nothing stored gives the kit overlay defaults with no ROI', () => {
    expect(resolveOverlaySettings(EMPTY_OVERRIDES, EMPTY_OVERRIDES)).toStrictEqual(
      NEAT_OVERLAY_DEFAULTS,
    );
  });

  it('a legacy flat scope maps its keys and copies only known pose and classification keys', () => {
    // Deliberate change: the old migration copied the whole flat object into both types.
    const own = settingsOverrides({
      showRoi: false,
      confidenceThreshold: 0.4,
      objects: [
        { label: 'default', color: '#00FF00' },
        { label: 'car', color: '#ff0000', style: 'dashed', width: 3 },
      ],
      trackingConfidenceThreshold: 0.2,
      showTrackHistory: false,
      trailLength: 500,
      lostTrackTtlMs: 4000,
      visible: false,
      showKeypointLabels: true,
      poseStrokeColor: '#123456',
    });

    expect(own).toStrictEqual({
      general: { showRoi: false },
      types: {
        'object-detection': {
          confidenceThreshold: 0.4,
          objects: [{ label: 'car', color: '#ff0000', style: 'dashed', width: 3 }],
        },
        tracking: {
          confidenceThreshold: 0.2,
          history: { enabled: false, trailLength: 120, lostTrackTtlMs: 4000 },
        },
        'pose-estimation': { visible: false, showKeypointLabels: true },
        classification: { visible: false },
      },
      auxiliary: {},
    });
  });

  it('a tracking scope of a supported version still accepts the flat history keys, which win', () => {
    const own = settingsOverrides({
      version: 7,
      types: { tracking: { history: { enabled: true, trailLength: 30 }, showTrackHistory: false } },
    });

    expect(own.types.tracking).toStrictEqual({ history: { enabled: false, trailLength: 30 } });
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
      { version: 10, general: null, types: 'x', auxiliary: [] },
      { version: 10, types: { tracking: { history: 5 } }, auxiliary: { 'blazepose-3d': null } },
    ]) {
      expect(settingsOverrides(raw)).toStrictEqual({ general: {}, types: {}, auxiliary: {} });
    }
  });

  it('a scope gives a value back without leaving empty containers behind', () => {
    let own = withOwnValue(EMPTY_OVERRIDES, 'types.tracking.history.trailLength', 25);
    own = withOwnValue(own, 'auxiliary.blazepose-3d.yawDegrees', 30);
    expect(holdsSomething(own)).toBe(true);
    expect(resolveValue(EMPTY_OVERRIDES, own, 'types.tracking.history.trailLength')).toBe(25);

    own = withoutOwnValue(own, 'types.tracking.history.trailLength');
    own = withoutOwnValue(own, 'auxiliary.blazepose-3d.yawDegrees');
    expect(own).toStrictEqual({ general: {}, types: {}, auxiliary: {} });
    expect(holdsSomething(own)).toBe(false);
    // The original object is never changed.
    expect(EMPTY_OVERRIDES).toStrictEqual({ general: {}, types: {}, auxiliary: {} });
  });
});
