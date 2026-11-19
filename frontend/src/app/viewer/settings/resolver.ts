import {
  NEAT_OVERLAY_STYLE_FALLBACK_COLOR,
  type NeatOverlayClassStyle,
  type NeatOverlayLineStyle,
  type NeatOverlaySettings,
  type NeatRoiPolygon,
} from '@sima/neat-ui/video';
import {
  AUTO_COLORS_VERSION,
  CLASS_STYLE_TYPES,
  DEFAULTS_ROOT,
  GENERAL_DEFAULTS,
  type GeneralSettings,
  NUMBER_RANGES,
  type NumericSettingId,
  PREVIOUS_VIDEO_SYNC_DEFAULT_MS,
  SCALAR_SETTINGS,
  type SettingId,
  type SettingValues,
  settingPath,
  SETTINGS_VERSION,
  SUPPORTED_SETTINGS_VERSIONS,
  type SyncSettings,
  TYPE_DEFAULTS,
  type TypeSettings,
  VIDEO_SYNC_DEFAULT_CHANGED_VERSION,
} from './schema';

/**
 * The settings resolver, ported from viewer-settings-resolver.js (sima-neat/insight@829ec7c) as
 * pure functions over parsed scopes; the store does the storage and the caching. A scope is read
 * once into its own values (`settingsOverrides`), and a channel resolves as default, then the
 * global scope's own value, then the channel's own value. "Own" means present in the scope, even
 * when equal to what the scope would otherwise follow.
 */

/** Optional all the way down, except class row lists, which a scope owns whole. */
type Own<T> = {
  readonly [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? Own<T[K]>
      : T[K];
};

/** A scope's own values in the stored shape: only what the scope holds, normalized. */
export interface ScopeOverrides {
  readonly general: Own<GeneralSettings>;
  readonly types: Own<TypeSettings>;
}

export const EMPTY_OVERRIDES: ScopeOverrides = { general: {}, types: {} };

type Tree = Readonly<Record<string, unknown>>;

/** A scope under construction: both sections, nothing owned yet. */
function emptyTree(): Tree {
  return { general: {}, types: {} };
}

// Arrays count as objects, as they did in the original; they simply hold none of the keys read.
function isTree(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null;
}

/** The value at `path`, or undefined when any part of the path is missing. */
function valueAt(root: unknown, path: readonly string[]): unknown {
  let node = root;
  for (const key of path) {
    if (!isTree(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/** A copy of `node` with `value` at `path`, creating the objects on the way as needed. */
function withValueAt(node: Tree, path: readonly string[], value: unknown): Tree {
  const [key, ...rest] = path;
  if (rest.length === 0) return { ...node, [key]: value };
  const child = node[key];
  return { ...node, [key]: withValueAt(isTree(child) ? child : {}, rest, value) };
}

/**
 * A copy of `node` without the value at `path`. An object left empty below a section (general,
 * types) goes too, so no empty `history: {}` stays behind.
 */
function withoutValueAt(node: Tree, path: readonly string[], depth = 0): Tree {
  const [key, ...rest] = path;
  const { [key]: child, ...others } = node;
  if (rest.length === 0) return others;
  if (!isTree(child)) return node;
  const next = withoutValueAt(child, rest, depth + 1);
  return depth > 0 && Object.keys(next).length === 0 ? others : { ...others, [key]: next };
}

function parseNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultValue<Id extends SettingId>(id: Id): SettingValues[Id] {
  return valueAt(DEFAULTS_ROOT, settingPath(id)) as SettingValues[Id];
}

/**
 * Normalizes one raw value the way the original's per-section normalizers did. Anything not of
 * the setting's kind falls back to its default: a boolean keeps only a boolean, a number is parsed,
 * clamped to its range and rounded where whole.
 * `sourceVersion` is the version the value was stored at, for the 350 ms migration.
 */
export function normalizeSettingValue<Id extends SettingId>(
  id: Id,
  raw: unknown,
  sourceVersion = SETTINGS_VERSION,
): SettingValues[Id] {
  const fallback: unknown = defaultValue(id);
  if (typeof fallback === 'boolean') {
    return (typeof raw === 'boolean' ? raw : fallback) as SettingValues[Id];
  }
  // Every setting that is not a boolean is a number with a range.
  const { min, max, integer } = NUMBER_RANGES[id as NumericSettingId];
  const clamped = Math.max(min, Math.min(max, parseNumber(raw, fallback as number)));
  const value = integer ? Math.round(clamped) : clamped;
  const isOldDefault =
    id === 'general.videoSyncBufferMs' &&
    sourceVersion < VIDEO_SYNC_DEFAULT_CHANGED_VERSION &&
    value === PREVIOUS_VIDEO_SYNC_DEFAULT_MS;
  return (isOldDefault ? GENERAL_DEFAULTS.videoSyncBufferMs : value) as SettingValues[Id];
}

const LINE_STYLES: readonly NeatOverlayLineStyle[] = ['solid', 'dashed', 'dotted'];

// Before version 10 every class row list carried an injected `default` row in this stock green,
// the same colour a row falls back to.
const LEGACY_DEFAULT_COLOR = NEAT_OVERLAY_STYLE_FALLBACK_COLOR;

function normalizeClassStyle(entry: unknown): NeatOverlayClassStyle | null {
  if (!isTree(entry)) return null;
  const label = typeof entry['label'] === 'string' ? entry['label'].trim() : '';
  if (!label) return null;
  const style = entry['style'] as NeatOverlayLineStyle;
  return {
    label,
    color: typeof entry['color'] === 'string' ? entry['color'] : NEAT_OVERLAY_STYLE_FALLBACK_COLOR,
    style: LINE_STYLES.includes(style) ? style : 'solid',
    width: Number(entry['width']) === 3 ? 3 : 1,
  };
}

/**
 * Normalizes a class row list. For a scope stored before version 10 (`legacy`) the injected stock
 * default row is dropped, so the automatic colours take over; a recoloured default is a deliberate
 * user override and stays.
 */
function normalizeClassStyles(raw: unknown, legacy: boolean): readonly NeatOverlayClassStyle[] {
  if (!Array.isArray(raw)) return [];
  const rows = raw.map(normalizeClassStyle).filter((row) => row !== null);
  if (!legacy) return rows;
  return rows.filter(
    (row) => !(row.label === 'default' && row.color.toLowerCase() === LEGACY_DEFAULT_COLOR),
  );
}

/** Tracking scopes may still hold the history keys flat at type level; these win over `history`. */
const TRACKING_FLAT_KEYS: readonly (readonly [string, SettingId])[] = [
  ['showTrackHistory', 'types.tracking.history.enabled'],
  ['trailLength', 'types.tracking.history.trailLength'],
  ['lostTrackTtlMs', 'types.tracking.history.lostTrackTtlMs'],
];

/**
 * Where the unversioned flat shape kept each setting. Pose and classification get nothing from it:
 * the original's resolution never read them from a flat scope (only its dialog's load
 * copied the whole flat object into both types), so tiles keep drawing what they drew before.
 */
const LEGACY_FLAT_KEYS: readonly (readonly [string, SettingId])[] = [
  ['showRoi', 'general.showRoi'],
  ['applyRoiFiltering', 'general.applyRoiFiltering'],
  ['confidenceThreshold', 'types.object-detection.confidenceThreshold'],
  ['trackingConfidenceThreshold', 'types.tracking.confidenceThreshold'],
  ...TRACKING_FLAT_KEYS,
];

function withRawValue(own: Tree, id: SettingId, raw: unknown, sourceVersion: number): Tree {
  return raw === undefined
    ? own
    : withValueAt(own, settingPath(id), normalizeSettingValue(id, raw, sourceVersion));
}

function versionedOverrides(raw: Tree, version: number): Tree {
  let own = emptyTree();
  for (const { id } of SCALAR_SETTINGS)
    own = withRawValue(own, id, valueAt(raw, settingPath(id)), version);
  for (const [key, id] of TRACKING_FLAT_KEYS) {
    own = withRawValue(own, id, valueAt(raw, ['types', 'tracking', key]), version);
  }
  for (const type of CLASS_STYLE_TYPES) {
    const rows = valueAt(raw, ['types', type, 'objects']);
    if (rows === undefined) continue;
    own = withValueAt(
      own,
      ['types', type, 'objects'],
      normalizeClassStyles(rows, version < AUTO_COLORS_VERSION),
    );
  }
  return own;
}

function flatOverrides(raw: Tree): Tree {
  let own = emptyTree();
  for (const [key, id] of LEGACY_FLAT_KEYS)
    own = withRawValue(own, id, valueAt(raw, [key]), SETTINGS_VERSION);
  const rows = valueAt(raw, ['objects']);
  if (rows !== undefined) {
    own = withValueAt(
      own,
      ['types', 'object-detection', 'objects'],
      normalizeClassStyles(rows, true),
    );
  }
  return own;
}

/**
 * A stored scope's own values, migrated from any older version and normalized. Anything that is
 * not a scope (null, text, a number, a list) holds nothing.
 */
export function settingsOverrides(raw: unknown): ScopeOverrides {
  if (!isTree(raw)) return EMPTY_OVERRIDES;
  const version = raw['version'];
  const own = SUPPORTED_SETTINGS_VERSIONS.has(version)
    ? versionedOverrides(raw, version as number)
    : flatOverrides(raw);
  // Every leaf was written by normalizeSettingValue or normalizeClassStyles at its setting's path.
  return own as unknown as ScopeOverrides;
}

/** The scope's own value for `id`, or undefined when it follows. */
export function ownValue<Id extends SettingId>(
  own: ScopeOverrides,
  id: Id,
): SettingValues[Id] | undefined {
  return valueAt(own, settingPath(id)) as SettingValues[Id] | undefined;
}

/** A copy of the scope owning `value` (already normalized) for `id`. */
export function withOwnValue<Id extends SettingId>(
  own: ScopeOverrides,
  id: Id,
  value: SettingValues[Id],
): ScopeOverrides {
  return withValueAt(own as unknown as Tree, settingPath(id), value) as unknown as ScopeOverrides;
}

/** A copy of the scope following again for `id`. */
export function withoutOwnValue(own: ScopeOverrides, id: SettingId): ScopeOverrides {
  return withoutValueAt(own as unknown as Tree, settingPath(id)) as unknown as ScopeOverrides;
}

/**
 * Whether a scope is worth keeping stored: it owns a value or a class row. A scope reduced to
 * empty objects or empty row lists holds nothing and is removed rather than stored.
 */
export function holdsSomething(own: ScopeOverrides): boolean {
  return (
    SCALAR_SETTINGS.some(({ id }) => ownValue(own, id) !== undefined) ||
    CLASS_STYLE_TYPES.some((type) => (own.types[type]?.objects?.length ?? 0) > 0)
  );
}

/** What a channel without its own value for `id` gets: global's own value, else the default. */
export function followedValue<Id extends SettingId>(
  global: ScopeOverrides,
  id: Id,
): SettingValues[Id] {
  return ownValue(global, id) ?? defaultValue(id);
}

/** The channel's value for `id`: its own, else the followed one. */
export function resolveValue<Id extends SettingId>(
  global: ScopeOverrides,
  channel: ScopeOverrides,
  id: Id,
): SettingValues[Id] {
  return ownValue(channel, id) ?? followedValue(global, id);
}

/** Class rows merge by label: a channel's row replaces global's row for the same label. */
function resolveClassStyles(
  global: ScopeOverrides,
  channel: ScopeOverrides,
  type: (typeof CLASS_STYLE_TYPES)[number],
): readonly NeatOverlayClassStyle[] {
  const byLabel = new Map<string, NeatOverlayClassStyle>();
  for (const row of [
    ...TYPE_DEFAULTS[type].objects,
    ...(global.types[type]?.objects ?? []),
    ...(channel.types[type]?.objects ?? []),
  ]) {
    byLabel.set(row.label, row);
  }
  return [...byLabel.values()];
}

/**
 * The settings a channel's overlays are drawn with. The regions of interest are stored apart from
 * the other settings (they replace as a whole, not value by value), so the caller resolves them
 * and passes them in.
 */
export function resolveOverlaySettings(
  global: ScopeOverrides,
  channel: ScopeOverrides,
  roi: readonly NeatRoiPolygon[],
): NeatOverlaySettings {
  const value = <Id extends SettingId>(id: Id) => resolveValue(global, channel, id);
  return {
    general: {
      lineWidth: value('general.lineWidth'),
      showRoi: value('general.showRoi'),
      applyRoiFiltering: value('general.applyRoiFiltering'),
    },
    types: {
      'object-detection': {
        visible: value('types.object-detection.visible'),
        confidenceThreshold: value('types.object-detection.confidenceThreshold'),
        objects: resolveClassStyles(global, channel, 'object-detection'),
      },
      segmentation: {
        visible: value('types.segmentation.visible'),
        confidenceThreshold: value('types.segmentation.confidenceThreshold'),
        maskOpacity: value('types.segmentation.maskOpacity'),
        objects: resolveClassStyles(global, channel, 'segmentation'),
      },
      tracking: {
        visible: value('types.tracking.visible'),
        confidenceThreshold: value('types.tracking.confidenceThreshold'),
        history: {
          enabled: value('types.tracking.history.enabled'),
          trailLength: value('types.tracking.history.trailLength'),
          lostTrackTtlMs: value('types.tracking.history.lostTrackTtlMs'),
        },
      },
      'pose-estimation': {
        visible: value('types.pose-estimation.visible'),
        showKeypoints: value('types.pose-estimation.showKeypoints'),
        showKeypointLabels: value('types.pose-estimation.showKeypointLabels'),
        showBoxes: value('types.pose-estimation.showBoxes'),
        objects: resolveClassStyles(global, channel, 'pose-estimation'),
      },
      classification: {
        visible: value('types.classification.visible'),
      },
    },
    roi,
  };
}

/** The channel's video sync buffer and metadata retention. */
export function resolveSyncSettings(global: ScopeOverrides, channel: ScopeOverrides): SyncSettings {
  return {
    videoSyncBufferMs: resolveValue(global, channel, 'general.videoSyncBufferMs'),
    metadataRetentionMs: resolveValue(global, channel, 'general.metadataRetentionMs'),
  };
}
