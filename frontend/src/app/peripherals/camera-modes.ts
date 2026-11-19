/**
 * A camera's modes as the camera panel offers them, and whether its preview can start: pure
 * functions of the scanned camera.
 *
 * A mode is a format, a size and a frame rate, each with SiMa Sentinel's verdict on it
 * (`SupportTier`). The menus name the format and the size; the rate is chosen for the user (the
 * best one of the size) and carried in the selection, since a MIPI mode's real rate is not known
 * until the camera runs in it.
 */

import type { NeatSelectOption } from '@sima/neat-ui/select';
import type { BoardTarget } from '../board/api';
import type {
  CameraFormat,
  CameraFormatRange,
  CameraItem,
  CameraMode,
  PreviewMode,
  CameraSize,
  PreviewSession,
  SupportTier,
} from './api';
import { countLabel, tierInfo } from './devices';

/** An entry of a mode menu, with the tier its label names when the menu mixes tiers. */
export interface ModeOption extends NeatSelectOption<string> {
  tier: SupportTier;
}

/** A Pixel format entry. One without a size and rate is disabled, and `reason` says why. */
export interface FormatOption extends ModeOption {
  disabled: boolean;
  /** Why the format cannot be chosen; '' when it can. */
  reason: string;
}

/** A Resolution entry; its value is `sizeKey(width, height)`. */
export interface SizeOption extends ModeOption {
  width: number;
  height: number;
}

/** Whether Start preview is blocked, and the reason shown under it. */
export interface PreviewBlock {
  blocked: boolean;
  reason: string;
}

const TIER_RANK: Record<SupportTier, number> = { available: 0, unsupported: 1 };

/** A Resolution entry's value. */
export function sizeKey(width: number, height: number): string {
  return `${width}x${height}`;
}

export function sizeLabel(width: number, height: number): string {
  return `${width}×${height}`;
}

/**
 * A rate the camera runs at, for display: a whole number when within 1% of one (66.18 reads
 * "66 fps"), else to two decimals. Empty when the rate is unknown.
 */
export function rateLabel(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return '';
  const whole = Math.round(value);
  return `${whole > 0 && Math.abs(value - whole) <= value * 0.01 ? whole : fpsLabel(value)} fps`;
}

/**
 * Format and size only, for every camera: a MIPI mode's rate is not known until the camera runs
 * in it, so no camera's rate is named before it runs.
 */
export function modeLabel(selection: PreviewMode | null): string {
  if (!selection) return '';
  return `${selection.format} ${sizeLabel(selection.width, selection.height)}`;
}

/** A stepwise or continuous size range: "16–1920×16–1080 in 16×8 steps". */
export function formatRangeLabel(range: CameraFormatRange | null): string {
  if (!range) return '';
  const width = `${range.min_width}–${range.max_width}`;
  const height = `${range.min_height}–${range.max_height}`;
  const step =
    range.step_width || range.step_height
      ? ` in ${range.step_width || 1}×${range.step_height || 1} steps`
      : '';
  return `${width}×${height}${step}`;
}

/**
 * The Pixel format menu. Unsupported formats stay in it, labelled; only a format without a size
 * and rate cannot be chosen, and its `reason` says why.
 */
export function formatOptions(camera: CameraItem): FormatOption[] {
  return withTiers(
    camera.formats.map((f) => {
      const selectable = isSelectable(f);
      const range = formatRangeLabel(f.range);
      return {
        value: f.format,
        label: f.label || f.format,
        tier: selectable ? f.support.tier : 'unsupported',
        disabled: !selectable,
        reason: selectable
          ? ''
          : `no sizes with a frame rate were reported for it.${range ? ` Reported range: ${range}.` : ''}`,
      };
    }),
  );
}

/** The Resolution menu for a format: its sizes that have a rate, each named by its size only. */
export function sizeOptions(camera: CameraItem, format: string): SizeOption[] {
  return withTiers(
    usableSizes(findFormat(camera, format)).map((s) => ({
      value: sizeKey(s.width, s.height),
      label: sizeLabel(s.width, s.height),
      width: s.width,
      height: s.height,
      tier: sizeTier(s),
    })),
  );
}

/**
 * One visible explanation line per camera state, chosen by priority, so the panel never stacks
 * near-identical sentences: why a MIPI camera is not Available; nothing otherwise.
 */
export function cameraSummaryLine(camera: CameraItem): string {
  // A USB camera is always Unsupported (no camera overlay), so a sentence saying so adds nothing.
  if (camera.connection === 'usb') return '';
  if (camera.support.tier !== 'available') return camera.support.reason || 'Unsupported.';
  // An Available camera's menus already label every entry, and whether another program holds the
  // camera is found out, and said, when a preview tries to start.
  return '';
}

/** "2 formats cannot be used (A, B)": the disabled formats, for the No usable modes callout. */
export function blockedFormatSummary(
  options: readonly Pick<FormatOption, 'value' | 'disabled'>[],
): string {
  const blocked = options.filter((option) => option.disabled);
  if (!blocked.length) return '';
  return `${countLabel(blocked.length, 'format')} cannot be used (${blocked.map((option) => option.value).join(', ')})`;
}

/** The tier Sentinel gave the selected mode; '' when the camera does not list it. */
export function selectionTier(
  camera: CameraItem,
  selection: PreviewMode | null,
): SupportTier | '' {
  return selectedMode(camera, selection)?.tier ?? '';
}

/** The selected mode as the camera lists it; null when it does not. */
function selectedMode(camera: CameraItem, selection: PreviewMode | null): CameraMode | null {
  if (!selection) return null;
  const size = findSize(findFormat(camera, selection.format), selection.width, selection.height);
  return findFps(size, selection.fps);
}

/**
 * The mode the menus show: what the user wanted where the camera still offers it, level by level
 * (a format change keeps the size when the new format has it), else the camera's default, else
 * its best mode. Null when the camera has no usable mode. A wanted mode that vanished after a
 * refresh falls back instead of clearing.
 */
export function resolveSelection(
  camera: CameraItem,
  wanted: Partial<PreviewMode> | null,
): PreviewMode | null {
  const formats = camera.formats.filter(isSelectable);
  if (!formats.length) return null;
  const def = camera.default_selection;
  const format =
    formats.find((f) => f.format === wanted?.format) ??
    formats.find((f) => f.format === def?.format) ??
    best(formats, (f) => f.support.tier);
  const defHere = def?.format === format.format ? def : null;
  const size =
    findSize(format, wanted?.width, wanted?.height) ??
    (defHere && findSize(format, defHere.width, defHere.height)) ??
    best(usableSizes(format), sizeTier);
  const defSize =
    defHere !== null && defHere.width === size.width && defHere.height === size.height;
  const fps =
    findFps(size, wanted?.fps) ??
    (defSize ? findFps(size, defHere.fps) : null) ??
    best(size.fps, (f) => f.tier);
  return { format: format.format, width: size.width, height: size.height, fps: fps.value };
}

/** The same mode: format, size and rate. */
export function sameSelection(a: PreviewMode | null, b: PreviewMode | null): boolean {
  if (!a || !b) return a === b;
  return a.format === b.format && a.width === b.width && a.height === b.height && a.fps === b.fps;
}

/**
 * Why Start preview cannot start, the first that applies. A mode starts when the server says the
 * preview takes it (`CameraMode.previewable`): a USB camera's in a format the preview reads (the
 * only reason it refuses a rate the camera lists), a MIPI camera's in NV12 that Sentinel does not
 * refuse. A busy camera is reported by the start.
 */
export function previewBlock({
  camera,
  selection,
  stale = false,
  session = null,
  target,
}: {
  camera: CameraItem | null;
  selection: PreviewMode | null;
  /** The snapshot was scanned for another board. */
  stale?: boolean;
  /** The preview this page holds, of any camera. */
  session?: PreviewSession | null;
  target: BoardTarget | null;
}): PreviewBlock {
  const blocked = (reason: string): PreviewBlock => ({ blocked: true, reason });
  if (!target) return blocked('No board is selected. Open board settings and choose one.');
  if (!camera) return blocked('Select a camera first.');
  if (stale)
    return blocked('The board changed after this scan. Refresh before starting a preview.');
  if (camera.modes_source === 'previous-scan') {
    return blocked(
      'This camera is listed from the last successful scan. Refresh before starting a preview.',
    );
  }
  if (!selection) return blocked('This camera reports no mode Insight can start.');
  const mode = selectedMode(camera, selection);
  if (!mode?.previewable) {
    if (camera.connection === 'usb') {
      return blocked(
        `Preview decodes MJPG and converts raw formats such as YUYV, not ${selection.format}. Choose another format.`,
      );
    }
    return blocked(
      mode?.reason
        ? `${modeLabel(selection)} cannot be previewed: ${mode.reason} Choose an Available mode.`
        : `${modeLabel(selection)} cannot be previewed. Choose an Available mode.`,
    );
  }
  if (session && session.camera !== camera.id) {
    return blocked(
      `A preview is already running on ${session.camera}. Stop it before starting this one.`,
    );
  }
  return { blocked: false, reason: '' };
}

/** A rate as reported, to at most two decimals: 7.5, 12.35. */
function fpsLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/**
 * A menu's entries in tier order (Available, then Unsupported; the board's order within each).
 * `neat-select` has no option groups, so when the menu mixes tiers, each entry that is not
 * Available names its tier: "1332×990 · Unsupported".
 */
function withTiers<T extends ModeOption>(options: T[]): T[] {
  const mixed = new Set(options.map((option) => option.tier)).size > 1;
  // `sort` is stable, so entries of one tier keep the board's order.
  return [...options]
    .sort((a, b) => rank(a.tier) - rank(b.tier))
    .map((option) =>
      mixed && option.tier !== 'available'
        ? { ...option, label: `${option.label} · ${tierInfo(option.tier).label}` }
        : option,
    );
}

/** A tier's rank; anything but the two tiers ranks as Unsupported. */
function rank(tier: SupportTier | ''): number {
  return TIER_RANK[tier as SupportTier] ?? TIER_RANK.unsupported;
}

/** The entry with the best tier, the first of equals; the list must not be empty. */
function best<T>(list: readonly T[], tierOf: (item: T) => SupportTier | ''): T {
  return list.reduce((top, item) => (rank(tierOf(item)) < rank(tierOf(top)) ? item : top));
}

function usableSizes(format: CameraFormat | null): CameraSize[] {
  return format?.sizes.filter((size) => size.fps.length > 0) ?? [];
}

function isSelectable(format: CameraFormat): boolean {
  return usableSizes(format).length > 0;
}

/** A size's tier: its best rate's. */
function sizeTier(size: CameraSize): SupportTier {
  return best(size.fps, (f) => f.tier).tier;
}

function findFormat(camera: CameraItem, format: string): CameraFormat | null {
  return camera.formats.find((f) => f.format === format) ?? null;
}

function findSize(
  format: CameraFormat | null,
  width: number | undefined,
  height: number | undefined,
): CameraSize | null {
  return usableSizes(format).find((s) => s.width === width && s.height === height) ?? null;
}

function findFps(size: CameraSize | null, value: number | undefined): CameraMode | null {
  if (value === undefined) return null;
  return size?.fps.find((f) => f.value === value) ?? null;
}
