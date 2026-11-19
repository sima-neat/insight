/**
 * The device model built from SiMa Sentinel's peripheral catalog, as the server passes it on
 * (`PeripheralScan.catalog`): its cameras with their modes, formats, sizes and rates, its
 * microphones with their capture formats, the notes and errors of each, and the scan's issues.
 * Pure functions over plain data.
 *
 * Sentinel decides whether a camera mode can be used (each mode's `available` and `reason`);
 * Insight keeps that verdict as it is. Whether Insight's preview takes a mode is the server's rule
 * (`previewable` in `server/internal/peripherals/pipeline.go`), mirrored here so the page does not
 * offer what the server refuses.
 */

import type { CameraSetup } from '../board/api';
import type {
  CameraDevice,
  CameraFormat,
  CameraFormatRange,
  CameraItem,
  CameraMode,
  CameraModeChoice,
  CameraSize,
  DeviceAvailability,
  DeviceError,
  DeviceSupport,
  MicrophoneCapture,
  MicrophoneDevice,
  MicrophoneItem,
  OtherItem,
  PeripheralIssue,
  Peripherals,
  PeripheralSnapshot,
  SnapshotBoard,
  UsbFacts,
} from './api';

/** A JSON object of Sentinel's, read field by field. */
type Json = Readonly<Record<string, unknown>>;

/** The format a MIPI camera's preview, and Neat's CameraInput, take. */
const MIPI_FORMAT = 'NV12';

/**
 * The V4L2 formats a USB camera's preview reads: MJPG, and the raw formats it converts
 * (`rawFormats` in the server's `pipeline.go`).
 */
export const USB_PREVIEW_FORMATS: readonly string[] = Object.freeze([
  'MJPG',
  'YUYV',
  'UYVY',
  'YVYU',
  'NV12',
  'NV21',
  'YU12',
  'YV12',
  'GREY',
  'RGB3',
  'BGR3',
]);

/** The rates offered for a size whose range of intervals names no rate of its own. */
const STANDARD_FPS = [60, 30, 25, 20, 15, 10, 5];

/**
 * The rate offered for a MIPI mode that advertises none: CameraInput's default, at most the rate
 * the camera reports (`max_fps`), which the server accepts for such a mode.
 */
const MIPI_DEFAULT_FPS = 30;

/** The size a default selection prefers: 1920 wide, else the widest below, else the smallest. */
const DEFAULT_WIDTH = 1920;

/** V4L2 FourCCs, named as the kernel describes them. */
const FORMAT_LABELS: Readonly<Record<string, string>> = {
  NV12: 'NV12 (YUV 4:2:0)',
  YUYV: 'YUYV (YUV 4:2:2)',
  MJPG: 'MJPG (Motion-JPEG)',
  RGB3: 'RGB3 (packed 24-bit)',
  AR24: 'AR24 (packed 32-bit)',
};

const NO_MODES_REASON = 'SiMa Sentinel reported no modes for this camera.';
const NO_VERDICT_REASON =
  "This board's SiMa Sentinel does not say whether this mode can be used; update Sentinel.";
const REFUSED_REASON = 'SiMa Sentinel marks this mode unavailable.';
const NO_BY_ID_NOTE =
  'No /dev/v4l/by-id link was found; /dev/videoN numbering can change across reboots and replugs.';
const NO_CAPABILITIES_NOTE = 'Capture formats cannot be read without opening the device.';
/** Sentinel's issue for a microphone without read-only formats; `NO_CAPABILITIES_NOTE` says it. */
const CAPABILITIES_ISSUE = 'peripherals.capabilities_unavailable';
const STATUS_HINT =
  'Check `systemctl status simaai-sentinel` and `journalctl -u simaai-sentinel` on the board, then Refresh.';

/** The snapshot of `board` from its peripherals answer: the empty one before a scan. */
export function snapshotOf(board: SnapshotBoard, answer: Peripherals): PeripheralSnapshot {
  const scan = answer.scan;
  if (!scan) {
    return {
      board,
      scan_id: null,
      scanned_at: null,
      items: [],
      issues: [],
      changes: null,
      camera_setup: null,
    };
  }
  const catalog: Json = scan.catalog;
  const devices = records(catalog['devices']);
  const errors = records(catalog['errors']);
  // A failed provider's devices are those of its last successful scan.
  const retained = new Set(errors.map((error) => text(error['provider'])));
  const cameras = devices
    .filter((device) => device['type'] === 'camera')
    .map((device) =>
      cameraItem(device, retained.has(providerOf(device)), number(device['max_fps'])),
    );
  const microphones = devices
    .filter((device) => device['type'] === 'microphone')
    .map((device) => microphoneItem(device, cameras, retained.has(providerOf(device))));
  const others = devices
    .filter((device) => device['type'] !== 'camera' && device['type'] !== 'microphone')
    .map(otherItem);
  return {
    board,
    scan_id: `${String(catalog['revision'] ?? '')}:${text(catalog['observed_at'])}`,
    scanned_at: scan.scanned_at,
    scan_ms: scan.scan_ms,
    items: [...cameras, ...microphones, ...others],
    issues: issuesOf(errors, devices),
    changes: scan.changes,
    camera_setup: cameraSetupOf(catalog['board']),
  };
}

/**
 * The board's camera setup from Sentinel's `board` block; null when it sends none. Sentinel lists
 * every overlay the boot loader applies (PCIe, secure boot, ...); those that configure a camera
 * sensor are the ones shown.
 */
export function cameraSetupOf(block: unknown): CameraSetup | null {
  if (!isRecord(block)) return null;
  const sensors = records(block['supported_sensors']);
  const cameraOverlays = new Set(sensors.flatMap((sensor) => strings(sensor['overlays'])));
  return {
    model: text(block['model']) || null,
    overlays: strings(block['overlays']).filter((overlay) => cameraOverlays.has(overlay)),
  };
}

// ---------------------------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------------------------

/** A camera mode with Sentinel's verdict read. */
interface Mode {
  raw: Json;
  format: string;
  width: number | null;
  height: number | null;
  available: boolean;
  /** Sentinel's verdict as it gave it; null when it gave none. */
  verdict: boolean | null;
  reason: string;
}

/** A camera's item from Sentinel's device; `retained` when its provider failed in this scan. */
export function cameraItem(device: Json, retained: boolean, maxFps: number | null): CameraItem {
  const connection = cameraConnection(device);
  const usb = connection === 'usb';
  const modes = records(device['modes']).map(modeOf);
  const formats = formatsOf(modes, connection, maxFps);
  const notes: string[] = [];
  const errors: DeviceError[] = [];
  let info: CameraDevice;
  let name: string;
  if (usb) {
    const identity = record(device['identity']);
    info = {
      ...(text(device['device_path']) ? { video_node: text(device['device_path']) } : {}),
      ...(text(device['by_id_path']) ? { by_id: text(device['by_id_path']) } : {}),
      usb: usbFacts({
        vendor_id: text(identity['vendor_id']),
        product_id: text(identity['product_id']),
        manufacturer: text(identity['manufacturer']),
        serial: text(identity['serial']),
        product: text(device['model']),
        bus_path: text(identity['topology']),
        speed_mbps: speedOf(identity['speed']),
      }),
    };
    if (!text(device['by_id_path'])) notes.push(NO_BY_ID_NOTE);
    name = text(device['model']) || text(device['device_path']) || text(device['id']);
  } else {
    info = {
      camera_name: text(device['camera_name']) || null,
      ...(text(device['media_device']) ? { media_device: text(device['media_device']) } : {}),
      ...(text(device['bus_info']) ? { bus_info: text(device['bus_info']) } : {}),
      ...(text(device['csi_receiver']) ? { csi: text(device['csi_receiver']) } : {}),
    };
    name = text(device['camera_name']) || text(device['id']);
  }
  if (!modes.length) {
    const isp = record(device['isp']);
    errors.push({
      code: 'no_modes',
      message:
        isp['state'] === 'unavailable'
          ? `The ISP output node could not be read, so this camera's modes are unknown: ${text(isp['reason'])}`
          : NO_MODES_REASON,
      hint: STATUS_HINT,
    });
  } else if (retained) {
    notes.push(retainedNote('Modes', providerOf(device)));
  }
  return {
    id: text(device['id']),
    kind: 'camera',
    connection,
    name,
    model: text(device['model']) || null,
    device: info,
    availability: availabilityOf(device['availability']),
    support: verdictOf(modes),
    modes_source: !modes.length ? 'unavailable' : retained ? 'previous-scan' : 'live',
    formats,
    default_selection: defaultSelection(formats),
    notes,
    errors,
  };
}

/** Sentinel's V4L2 provider reports USB cameras only. */
function cameraConnection(device: Json): string {
  const backend = text(device['backend']);
  if (backend === 'mipi') return 'mipi';
  if (backend === 'v4l2') return 'usb';
  return backend || 'unknown';
}

function modeOf(raw: Json): Mode {
  const verdict = typeof raw['available'] === 'boolean' ? raw['available'] : null;
  const available = verdict === true;
  return {
    raw,
    format: text(raw['format']),
    width: integer(raw['width']),
    height: integer(raw['height']),
    available,
    verdict,
    reason: available
      ? ''
      : text(raw['reason']) || (verdict === false ? REFUSED_REASON : NO_VERDICT_REASON),
  };
}

/**
 * A camera's or format's verdict: Available when any of its modes is; otherwise the reason
 * Sentinel gave most often for its NV12 modes (CameraInput's format), else for all of them.
 */
function verdictOf(modes: readonly Mode[]): DeviceSupport {
  if (modes.some((mode) => mode.available)) return { tier: 'available', reason: '' };
  if (!modes.length) return { tier: 'unsupported', reason: NO_MODES_REASON };
  const nv12 = modes.filter((mode) => mode.format === MIPI_FORMAT);
  return {
    tier: 'unsupported',
    reason: mostCommon((nv12.length ? nv12 : modes).map((m) => m.reason)),
  };
}

function mostCommon(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let top = '';
  let most = 0;
  for (const [value, count] of counts) {
    if (count > most) [top, most] = [value, count];
  }
  return top;
}

/** The camera's formats in Sentinel's order, each with its sizes in Sentinel's order. */
function formatsOf(
  modes: readonly Mode[],
  connection: string,
  maxFps: number | null,
): CameraFormat[] {
  const byFormat = new Map<string, Mode[]>();
  for (const mode of modes) byFormat.set(mode.format, [...(byFormat.get(mode.format) ?? []), mode]);
  return [...byFormat].map(([format, entries]) => {
    const bySize = new Map<string, Mode[]>();
    for (const mode of entries) {
      if (mode.width === null || mode.height === null) continue;
      const key = `${mode.width}x${mode.height}`;
      bySize.set(key, [...(bySize.get(key) ?? []), mode]);
    }
    const description = entries.map((mode) => text(mode.raw['format_description'])).find(Boolean);
    const ranged = entries
      .map((mode) => record(mode.raw['size_range']))
      .find((r) => 'min_width' in r);
    const sizes: CameraSize[] = [...bySize.values()].map((group) => ({
      width: group[0].width as number,
      height: group[0].height as number,
      fps: ratesOf(group, connection, maxFps),
    }));
    return {
      format,
      // A USB driver names its own formats.
      label:
        connection === 'usb' && description
          ? `${format} (${description})`
          : (FORMAT_LABELS[format] ?? format),
      support: verdictOf(entries),
      range: ranged ? rangeOf(ranged) : null,
      sizes,
    };
  });
}

function rangeOf(range: Json): CameraFormatRange {
  return {
    min_width: integer(range['min_width']) ?? 0,
    min_height: integer(range['min_height']) ?? 0,
    max_width: integer(range['max_width']) ?? 0,
    max_height: integer(range['max_height']) ?? 0,
    step_width: integer(range['step_width']) ?? 0,
    step_height: integer(range['step_height']) ?? 0,
  };
}

/**
 * The frame rates of one format and size, fastest first, each with its mode's verdict: the rates
 * the camera advertises for the size; for a MIPI mode that advertises none, CameraInput's default
 * rate up to the camera's own. A USB mode without an advertised rate offers none.
 */
function ratesOf(modes: readonly Mode[], connection: string, maxFps: number | null): CameraMode[] {
  const rates = new Map<number, CameraMode>();
  for (const mode of modes) {
    let values = records(mode.raw['frame_intervals'])
      .filter((entry) => entry['width'] === mode.width && entry['height'] === mode.height)
      .flatMap(intervalRates);
    if (!values.length && connection === 'mipi') {
      values = [
        maxFps !== null && maxFps > 0
          ? fpsValue(Math.min(MIPI_DEFAULT_FPS, maxFps))
          : MIPI_DEFAULT_FPS,
      ];
    }
    const choice = {
      tier: mode.available ? ('available' as const) : ('unsupported' as const),
      ...(mode.available ? {} : { reason: mode.reason }),
      previewable: previewable(mode, connection),
    };
    for (const value of values) {
      if (!rates.has(value) || mode.available) rates.set(value, { value, ...choice });
    }
  }
  return [...rates.values()].sort((a, b) => b.value - a.value);
}

/**
 * Whether the server's preview takes the mode: for a MIPI camera an NV12 mode Sentinel does not
 * refuse (one without a verdict may be tried), for a USB camera MJPG or a raw format it converts.
 */
function previewable(mode: Mode, connection: string): boolean {
  if (connection === 'mipi') return mode.format === MIPI_FORMAT && mode.verdict !== false;
  if (connection === 'usb') return USB_PREVIEW_FORMATS.includes(mode.format);
  return false;
}

/** The rates of one `frame_intervals` entry, which lists periods as V4L2 reports them. */
function intervalRates(entry: Json): number[] {
  const rates: number[] = [];
  for (const interval of records(entry['intervals'])) {
    if (interval['type'] === 'discrete') {
      const num = integer(interval['numerator']);
      const den = integer(interval['denominator']);
      if (num !== null && den !== null && num > 0 && den > 0) rates.push(fpsValue(den / num));
      continue;
    }
    // The longest period is the slowest rate.
    const slowest = rateOfPeriod(interval['maximum']);
    const fastest = rateOfPeriod(interval['minimum']);
    if (slowest === null || fastest === null) continue;
    const step = interval['type'] === 'stepwise' ? periodOf(interval['step']) : null;
    const sampled = STANDARD_FPS.filter(
      (fps) =>
        fps >= slowest - 1e-3 &&
        fps <= fastest + 1e-3 &&
        (step === null || onStep(1 / fps, 1 / fastest, step)),
    );
    // No standard rate in the range (one fixed at 24 fps, say): its fastest rate, which every
    // range includes.
    rates.push(...(sampled.length ? sampled : [fpsValue(fastest)]));
  }
  return rates;
}

/** Whether `period` is `first` plus a whole number of steps, allowing for the driver's rounding. */
function onStep(period: number, first: number, step: number): boolean {
  const k = Math.round((period - first) / step);
  return Math.abs(first + k * step - period) <= period * 1e-3;
}

function periodOf(value: unknown): number | null {
  const fraction = record(value);
  const num = number(fraction['numerator']);
  const den = number(fraction['denominator']);
  return num !== null && den !== null && den > 0 && num > 0 ? num / den : null;
}

function rateOfPeriod(value: unknown): number | null {
  const period = periodOf(value);
  return period === null ? null : 1 / period;
}

/**
 * A rate as requests and menus name it: whole when it is, else to a thousandth (the server reads
 * a rate to a thousandth). A rate too slow for that keeps six significant digits, never 0.
 */
export function fpsValue(fps: number): number {
  const whole = Math.round(fps);
  if (Math.abs(fps - whole) < 1e-9) return whole;
  const rounded = Math.round(fps * 1000) / 1000;
  return rounded > 0 ? rounded : Number(fps.toPrecision(6));
}

/**
 * The mode to preselect: 1920 wide when a size that wide is Available, else the widest Available
 * size narrower than that, else the smallest Available one, at its fastest Available rate; null
 * when no mode is Available.
 */
function defaultSelection(formats: readonly CameraFormat[]): CameraModeChoice | null {
  const candidates: CameraModeChoice[] = [];
  for (const format of formats) {
    for (const size of format.sizes) {
      const rate = size.fps.find((fps) => fps.tier === 'available');
      if (rate) {
        candidates.push({
          format: format.format,
          width: size.width,
          height: size.height,
          fps: rate.value,
        });
      }
    }
  }
  if (!candidates.length) return null;
  const bySize = (a: CameraModeChoice, b: CameraModeChoice) =>
    a.width - b.width || a.height - b.height;
  const preferred = candidates.filter((c) => c.width <= DEFAULT_WIDTH);
  return preferred.length
    ? preferred.reduce((top, c) => (bySize(c, top) > 0 ? c : top))
    : candidates.reduce((low, c) => (bySize(c, low) < 0 ? c : low));
}

// ---------------------------------------------------------------------------------------------
// Microphones and other devices
// ---------------------------------------------------------------------------------------------

/**
 * A microphone's item from Sentinel's device. A USB microphone that belongs to a USB camera of
 * the same scan (a webcam's) names it in `part_of`.
 */
export function microphoneItem(
  device: Json,
  cameras: readonly CameraItem[],
  retained: boolean,
): MicrophoneItem {
  const identity = record(device['identity']);
  const target = record(device['capture_target']);
  const usbIdentity = isRecord(identity['usb']) ? identity['usb'] : null;
  const cardId = text(identity['card_id']) || text(target['card_id']) || null;
  const pcm = integer(target['device']);
  const info: MicrophoneDevice = {
    card_index: integer(identity['card_index']),
    card_id: cardId,
    card_name: text(identity['card_name']) || null,
    card_driver: text(identity['card_driver']) || null,
    pcm_device: pcm,
    pcm_node: text(identity['pcm_node']) || null,
    ...(cardId && pcm !== null ? { alsa_name: `hw:CARD=${cardId},DEV=${pcm}` } : {}),
    ...(text(identity['by_path']) ? { by_path: text(identity['by_path']) } : {}),
    ...(text(identity['by_id']) ? { by_id: text(identity['by_id']) } : {}),
  };
  if (usbIdentity) {
    const usb = usbFacts({
      vendor_id: text(usbIdentity['vendor_id']),
      product_id: text(usbIdentity['product_id']),
      manufacturer: text(usbIdentity['manufacturer']),
      product: text(usbIdentity['product']),
      serial: text(usbIdentity['serial']),
      bus_path: text(usbIdentity['bus_path']),
      interface: text(usbIdentity['interface']),
    });
    info.usb = usb;
    const camera = usb.bus_path ? usbCameraAt(cameras, usb.bus_path) : null;
    if (camera) info.part_of = { id: camera.id, name: camera.name };
  }
  const modes = records(device['modes']);
  const notes = modes.length ? [] : [NO_CAPABILITIES_NOTE];
  notes.push(...issueNotes(device, CAPABILITIES_ISSUE));
  if (retained) notes.push(retainedNote('Details', providerOf(device)));
  return {
    id: text(device['id']),
    kind: 'microphone',
    connection: device['connection'] === 'usb' ? 'usb' : 'onboard',
    name: text(usbIdentity?.['product']) || text(device['name']) || text(device['id']),
    device: info,
    availability: availabilityOf(device['availability']),
    capture: modes.length ? modes.map(captureOf) : null,
    record: JSON.stringify([device['capture_target'] ?? null, device['identity'] ?? null]),
    notes,
    errors: [],
  };
}

/**
 * The USB camera at a microphone's place on the bus. A camera's place is its USB device's sysfs
 * path, whose last part is the name ALSA gives the device.
 */
function usbCameraAt(cameras: readonly CameraItem[], busPath: string): CameraItem | null {
  return (
    cameras.find(
      (camera) =>
        camera.connection === 'usb' && camera.device.usb?.bus_path?.split('/').at(-1) === busPath,
    ) ?? null
  );
}

function captureOf(mode: Json): MicrophoneCapture {
  const span = record(mode['rate_range_hz']);
  const min = number(span['min']);
  const max = number(span['max']);
  return {
    format: text(mode['format']) || null,
    channels: integer(mode['channels']),
    bits: integer(mode['sample_bits']),
    rates: Array.isArray(mode['rates_hz'])
      ? mode['rates_hz'].filter((rate): rate is number => typeof rate === 'number')
      : [],
    rate_range: min !== null && max !== null ? { min, max } : null,
    channel_map: Array.isArray(mode['channel_map']) ? strings(mode['channel_map']) : null,
  };
}

/** A device of a kind Insight has no view for: listed with its name and Sentinel's notes. */
function otherItem(device: Json): OtherItem {
  return {
    id: text(device['id']),
    kind: text(device['type']),
    connection: text(device['backend']) || 'unknown',
    name: text(device['name']) || text(device['model']) || text(device['id']),
    device: {},
    availability: availabilityOf(device['availability']),
    notes: issueNotes(device),
    errors: [],
  };
}

/** What Sentinel says about a device (its `issues`), but the issue `except`, as notes. */
function issueNotes(device: Json, except = ''): string[] {
  return records(device['issues'])
    .filter((issue) => issue['code'] !== except)
    .map((issue) => text(issue['reason']))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// The scan's issues and the shared readers
// ---------------------------------------------------------------------------------------------

/** Sentinel's failed providers as the page's warnings. */
function issuesOf(errors: readonly Json[], devices: readonly Json[]): PeripheralIssue[] {
  const listed = new Set(devices.map(providerOf));
  return errors.map((error) => {
    const provider = text(error['provider']);
    const reason = text(error['reason']);
    const code = text(error['code']);
    // Sentinel names a board-block error's provider after the field it could not read.
    const boardField = provider === 'board' || provider.startsWith('board.');
    let message =
      boardField && code === 'platform.unsupported'
        ? `SiMa Sentinel: ${reason}`
        : boardField
          ? `SiMa Sentinel could not read part of the board's camera setup: ${reason}`
          : `SiMa Sentinel's ${provider} provider failed: ${reason}`;
    if (listed.has(provider)) message += ' The devices it found last time are still listed.';
    return { severity: 'warning', code, message, hint: STATUS_HINT };
  });
}

/** Sentinel names its providers `<type>.<backend>`. */
function providerOf(device: Json): string {
  return `${text(device['type'])}.${text(device['backend'])}`;
}

function retainedNote(what: string, provider: string): string {
  return `${what} are from SiMa Sentinel's last successful scan; its ${provider} provider failed during this refresh.`;
}

/** Sentinel's availability fact; a state it does not name reads as unknown. */
function availabilityOf(value: unknown): DeviceAvailability {
  const reported = record(value);
  const state = reported['state'];
  return {
    state: state === 'available' || state === 'in_use' ? state : 'unknown',
    reason: text(reported['reason']) || null,
  };
}

/** The USB facts with a value. */
function usbFacts(facts: Partial<Record<keyof UsbFacts, string | number>>): UsbFacts {
  return Object.fromEntries(
    Object.entries(facts).filter(
      ([, value]) => value !== '' && value !== null && value !== undefined,
    ),
  ) as UsbFacts;
}

/** The USB link speed sysfs reports in Mb/s ("1.5", "480", "5000"); undefined when unreadable. */
function speedOf(value: unknown): number | undefined {
  const speed = typeof value === 'number' ? value : Number.parseFloat(text(value));
  return Number.isFinite(speed) && speed > 0 ? speed : undefined;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Json {
  return isRecord(value) ? value : {};
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integer(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}
