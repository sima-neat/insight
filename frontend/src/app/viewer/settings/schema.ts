import { NEAT_OVERLAY_DEFAULTS, type NeatOverlaySettings } from '@sima/neat-ui/video';

/**
 * The viewer settings model, ported from viewer-settings-resolver.js (sima-neat/insight@829ec7c):
 * every setting a scope can own, with its default and the range its value is held to. A stored
 * scope is `{ version, general, types }`, and a setting's id is its path in that object.
 */

/** The version every scope is stored at; a scope stored at any other version is not read. */
export const SETTINGS_VERSION = 10;

export type MetadataType = keyof NeatOverlaySettings['types'];

/** The metadata types whose class rows (`objects`) restyle overlays by label. */
export const CLASS_STYLE_TYPES = [
  'object-detection',
  'segmentation',
  'pose-estimation',
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

// The overlay defaults are the kit's, so a tile with nothing stored draws exactly as the kit's own
// default settings would; the resolver spec pins the values.
export const GENERAL_DEFAULTS: GeneralSettings = {
  videoSyncBufferMs: 300,
  metadataRetentionMs: 0,
  ...NEAT_OVERLAY_DEFAULTS.general,
};

export const TYPE_DEFAULTS: TypeSettings = NEAT_OVERLAY_DEFAULTS.types;

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
  'types.pose-estimation.showBoxes': boolean;
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
 * 0..30000 against 0..10000); a control picks its own range within them.
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
};

export type SettingTab = 'General' | 'ROI' | 'Metadata';

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
  scalar('types.pose-estimation.showBoxes', 'Metadata', 'pose-estimation'),
];

/** The defaults in the stored shape, so a setting's default is found by its path like any value. */
export const DEFAULTS_ROOT = {
  general: GENERAL_DEFAULTS,
  types: TYPE_DEFAULTS,
};
