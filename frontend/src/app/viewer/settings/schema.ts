import { NEAT_OVERLAY_DEFAULTS, type NeatOverlaySettings } from '@sima/neat-ui';

/**
 * The viewer settings model, ported from viewer-settings-resolver.js (829ec7c, Inv §5b): every
 * setting a scope can own, with its default and the range its value is held to. A stored scope is
 * `{ version, general, types, auxiliary }`, and a setting's id is its path in that object.
 */

export const SETTINGS_VERSION = 10;

/**
 * Versions stored in the `{ version, general, types, auxiliary }` shape. An entry with any other
 * version (or none) is read as the flat shape the first viewer stored.
 */
export const SUPPORTED_SETTINGS_VERSIONS: ReadonlySet<unknown> = new Set([
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  SETTINGS_VERSION,
]);

/** Up to version 8 the video sync buffer defaulted to 350 ms; a stored 350 meant "the default". */
export const VIDEO_SYNC_DEFAULT_CHANGED_VERSION = 9;
export const PREVIOUS_VIDEO_SYNC_DEFAULT_MS = 350;

/** From version 10 unlisted classes are coloured automatically, not by a stored default row. */
export const AUTO_COLORS_VERSION = 10;

export type MetadataType = keyof NeatOverlaySettings['types'];

/** The metadata types whose class rows (`objects`) restyle overlays by label. */
export const CLASS_STYLE_TYPES = [
  'object-detection',
  'segmentation',
] as const satisfies readonly MetadataType[];

export interface GeneralSettings extends Readonly<NeatOverlaySettings['general']> {
  /** How far video is held back so metadata can catch up with its frame, in ms. */
  readonly videoSyncBufferMs: number;
  /** How long queued metadata is kept for its frame before it expires, in ms; 0 never expires. */
  readonly metadataRetentionMs: number;
}

/** What a channel's connection and tile need besides its overlay settings. */
export type SyncSettings = Pick<GeneralSettings, 'videoSyncBufferMs' | 'metadataRetentionMs'>;

export type TypeSettings = NeatOverlaySettings['types'];

export type PanelMode = 'compact' | 'collapsed' | 'expanded';

/** The BlazePose 3D panel (plan 2b), whose settings already live in every scope. */
export interface AuxiliarySettings {
  readonly enabled: boolean;
  readonly panelMode: PanelMode;
  /** 0..1 */
  readonly backgroundTransparency: number;
  readonly yawDegrees: number;
  readonly pitchDegrees: number;
  readonly showReferenceBox: boolean;
}

// The overlay defaults are the kit's, so a tile with nothing stored draws exactly as the kit's own
// default settings would; the resolver spec pins the values (Inv §5b).
export const GENERAL_DEFAULTS: GeneralSettings = {
  videoSyncBufferMs: 300,
  metadataRetentionMs: 0,
  ...NEAT_OVERLAY_DEFAULTS.general,
};

export const TYPE_DEFAULTS: TypeSettings = NEAT_OVERLAY_DEFAULTS.types;

// Only the BlazePose 3D renderer has settings in 2a. The original also kept enabled/panelMode for
// any other renderer the auxiliary panel met; nothing in 2a writes those, and plan 2b's panel
// extends this schema for them (R24).
export const AUXILIARY_DEFAULTS: { readonly 'blazepose-3d': AuxiliarySettings } = {
  'blazepose-3d': {
    enabled: true,
    panelMode: 'compact',
    backgroundTransparency: 0,
    yawDegrees: -45,
    pitchDegrees: 20,
    showReferenceBox: true,
  },
};

export const PANEL_MODES: readonly PanelMode[] = ['compact', 'collapsed', 'expanded'];

/** Every setting a scope can own, by id, with the type of its value. */
export interface SettingValues {
  'general.videoSyncBufferMs': number;
  'general.metadataRetentionMs': number;
  'general.lineWidth': number;
  'general.showRoi': boolean;
  'general.applyRoiFiltering': boolean;
  'types.object-detection.confidenceThreshold': number;
  'types.segmentation.confidenceThreshold': number;
  'types.segmentation.maskOpacity': number;
  'types.tracking.confidenceThreshold': number;
  'types.tracking.history.enabled': boolean;
  'types.tracking.history.trailLength': number;
  'types.tracking.history.lostTrackTtlMs': number;
  'types.object-detection.visible': boolean;
  'types.segmentation.visible': boolean;
  'types.tracking.visible': boolean;
  'types.pose-estimation.visible': boolean;
  'types.classification.visible': boolean;
  'types.pose-estimation.showKeypoints': boolean;
  'types.pose-estimation.showKeypointLabels': boolean;
  'auxiliary.blazepose-3d.enabled': boolean;
  'auxiliary.blazepose-3d.panelMode': PanelMode;
  'auxiliary.blazepose-3d.backgroundTransparency': number;
  'auxiliary.blazepose-3d.yawDegrees': number;
  'auxiliary.blazepose-3d.pitchDegrees': number;
  'auxiliary.blazepose-3d.showReferenceBox': boolean;
}

export type SettingId = keyof SettingValues;

export type NumericSettingId = {
  [Id in SettingId]: SettingValues[Id] extends number ? Id : never;
}[SettingId];

export type BooleanSettingId = {
  [Id in SettingId]: SettingValues[Id] extends boolean ? Id : never;
}[SettingId];

export interface NumberRange {
  readonly min: number;
  readonly max: number;
  /** Rounded to a whole number after clamping. */
  readonly integer: boolean;
}

/**
 * The range every stored number is clamped to. These are the normalizer's ranges, which are wider
 * than some of the old dialog's controls (trail length 1..120 against 1..60, lost-track time
 * 0..30000 against 0..10000, Inv §5b); a control picks its own range within them.
 */
export const NUMBER_RANGES: Readonly<Record<NumericSettingId, NumberRange>> = {
  'general.videoSyncBufferMs': { min: 0, max: 4000, integer: true },
  'general.metadataRetentionMs': { min: 0, max: 30000, integer: true },
  'general.lineWidth': { min: 1, max: 10, integer: true },
  'types.object-detection.confidenceThreshold': { min: 0, max: 1, integer: false },
  'types.segmentation.confidenceThreshold': { min: 0, max: 1, integer: false },
  'types.segmentation.maskOpacity': { min: 0, max: 1, integer: false },
  'types.tracking.confidenceThreshold': { min: 0, max: 1, integer: false },
  'types.tracking.history.trailLength': { min: 1, max: 120, integer: true },
  'types.tracking.history.lostTrackTtlMs': { min: 0, max: 30000, integer: true },
  'auxiliary.blazepose-3d.backgroundTransparency': { min: 0, max: 1, integer: false },
  'auxiliary.blazepose-3d.yawDegrees': { min: -180, max: 180, integer: true },
  'auxiliary.blazepose-3d.pitchDegrees': { min: -60, max: 60, integer: true },
};

export type SettingTab = 'General' | 'ROI' | 'Metadata' | '3D Pose';

export interface ScalarSetting {
  readonly id: SettingId;
  /** The settings tab that shows it. */
  readonly tab: SettingTab;
  /** The metadata type it belongs to, for the Metadata tab's sections. */
  readonly metadataType: MetadataType | null;
}

function scalar(
  id: SettingId,
  tab: SettingTab,
  metadataType: MetadataType | null = null,
): ScalarSetting {
  return { id, tab, metadataType };
}

/** A setting's path in a stored scope: its id, split. */
export function settingPath(id: SettingId): readonly string[] {
  return id.split('.');
}

/** The one table that drives every own-value function, in the original's order. */
export const SCALAR_SETTINGS: readonly ScalarSetting[] = [
  scalar('general.videoSyncBufferMs', 'General'),
  scalar('general.metadataRetentionMs', 'General'),
  scalar('general.lineWidth', 'General'),
  scalar('general.showRoi', 'ROI'),
  scalar('general.applyRoiFiltering', 'ROI'),
  scalar('types.object-detection.confidenceThreshold', 'Metadata', 'object-detection'),
  scalar('types.segmentation.confidenceThreshold', 'Metadata', 'segmentation'),
  scalar('types.segmentation.maskOpacity', 'Metadata', 'segmentation'),
  scalar('types.tracking.confidenceThreshold', 'Metadata', 'tracking'),
  scalar('types.tracking.history.enabled', 'Metadata', 'tracking'),
  scalar('types.tracking.history.trailLength', 'Metadata', 'tracking'),
  scalar('types.tracking.history.lostTrackTtlMs', 'Metadata', 'tracking'),
  scalar('types.object-detection.visible', 'Metadata', 'object-detection'),
  scalar('types.segmentation.visible', 'Metadata', 'segmentation'),
  scalar('types.tracking.visible', 'Metadata', 'tracking'),
  scalar('types.pose-estimation.visible', 'Metadata', 'pose-estimation'),
  scalar('types.classification.visible', 'Metadata', 'classification'),
  scalar('types.pose-estimation.showKeypoints', 'Metadata', 'pose-estimation'),
  scalar('types.pose-estimation.showKeypointLabels', 'Metadata', 'pose-estimation'),
  scalar('auxiliary.blazepose-3d.enabled', '3D Pose'),
  scalar('auxiliary.blazepose-3d.panelMode', '3D Pose'),
  scalar('auxiliary.blazepose-3d.backgroundTransparency', '3D Pose'),
  scalar('auxiliary.blazepose-3d.yawDegrees', '3D Pose'),
  scalar('auxiliary.blazepose-3d.pitchDegrees', '3D Pose'),
  scalar('auxiliary.blazepose-3d.showReferenceBox', '3D Pose'),
];

/** The defaults in the stored shape, so a setting's default is found by its path like any value. */
export const DEFAULTS_ROOT = {
  general: GENERAL_DEFAULTS,
  types: TYPE_DEFAULTS,
  auxiliary: AUXILIARY_DEFAULTS,
};
