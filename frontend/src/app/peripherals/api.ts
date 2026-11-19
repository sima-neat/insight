/**
 * Peripherals' routes (`/api/boards/<id>/peripherals...`, `/cameras/...`, `/microphones/...`),
 * typed from `server/api/openapi.yaml` (`api.generated.ts`), and the device model the page shows,
 * which the browser builds from SiMa Sentinel's catalog (`catalog.ts`). Types only:
 * `PeripheralsService` and the page's preview and microphone-test units call the routes.
 *
 * A failed request answers the error shape (`problemOf` in `board-error.ts` reads it). Besides
 * the board's codes, these routes add `not_found`, `no_scan`, `preview_active`, `camera_in_use`,
 * `mode_adjusted`, `tool_missing`, `command_failed`, `test_running`, `microphone_in_use` and
 * `stopped_early`.
 */

import type { CameraPreview, MicTest } from '../api.generated';
import type { CameraSetup } from '../board/api';

export type {
  CameraPreview,
  MicLevel,
  MicTest,
  MicTestAnswer,
  MicTestRequest,
  PeripheralChanges,
  PeripheralScan,
  Peripherals,
  PreviewAnswer,
  PreviewMode,
} from '../api.generated';

// ---------------------------------------------------------------------------------------------
// The scan, as the page shows it
// ---------------------------------------------------------------------------------------------

/** The board a snapshot is of: the id it was read with, and its label then. */
export interface SnapshotBoard {
  id: string;
  label: string;
}

/**
 * The last scan of a board, or an empty one before any. It counts as scanned when `scan_id` is
 * not null (`isScanned` in `devices.ts`); `scan_id`, `scanned_at` and `scan_ms` are set together
 * by a scan.
 */
export interface PeripheralSnapshot {
  board: SnapshotBoard;
  /** `<Sentinel revision>:<observed at>`; null before a scan. */
  scan_id: string | null;
  /** ISO time of the scan; null before a scan. */
  scanned_at: string | null;
  /** How long SiMa Sentinel's scan took; absent before a scan. */
  scan_ms?: number;
  items: PeripheralItem[];
  issues: PeripheralIssue[];
  /** What changed since the previous scan; null on the first scan of a board. */
  changes: DeviceChanges | null;
  /** Null before a scan and from a Sentinel that does not read the board's camera setup. */
  camera_setup: CameraSetup | null;
}

/**
 * One device. `kind` is `camera` or `microphone` today; a kind Sentinel adds later arrives as an
 * `OtherItem`, which Insight lists but has no view for. Narrow with `isCamera` and `isMicrophone`
 * (`devices.ts`): `OtherItem.kind` is any string, so `kind` alone cannot.
 */
export type PeripheralItem = CameraItem | MicrophoneItem | OtherItem;

/** Fields every item carries. */
interface ItemBase {
  /** Sentinel's id, stable across scans of one board; selections and changes name items by it. */
  id: string;
  kind: string;
  /**
   * How the device is attached: `mipi` or `usb` for cameras, `usb` or `onboard` for microphones,
   * otherwise Sentinel's own name for it.
   */
  connection: string;
  name: string;
  availability: DeviceAvailability;
  notes: string[];
  errors: DeviceError[];
}

/**
 * SiMa Sentinel's own availability fact, passed through. It never opens a stream, so for cameras
 * it is always `unknown`.
 */
export interface DeviceAvailability {
  state: 'available' | 'in_use' | 'unknown';
  reason: string | null;
}

/** A problem with one device, such as a camera without modes (`no_modes`). */
export interface DeviceError {
  code: string;
  message: string;
  hint: string | null;
}

/**
 * SiMa Sentinel's verdict on a camera, format or mode: Available when Neat's CameraInput can use
 * it, Unsupported otherwise. USB cameras are Unsupported, yet previewable.
 */
export type SupportTier = 'available' | 'unsupported';

export interface DeviceSupport {
  tier: SupportTier;
  /** Why it is not Available; '' when it is. */
  reason: string;
}

/** The USB facts of a device; a fact the device does not report is absent. */
export interface UsbFacts {
  vendor_id?: string;
  product_id?: string;
  manufacturer?: string;
  product?: string;
  serial?: string;
  /** The device's place on the bus, such as `1-1.2`. */
  bus_path?: string;
  /** Microphones only: the USB interface of the audio function. */
  interface?: string;
  /** The link speed in Mb/s (1.5, 12, 480, 5000…); cameras only, and absent when unreadable. */
  speed_mbps?: number;
}

/**
 * How the camera's device is reached. A MIPI camera (and any camera that is not USB) reports the
 * libcamera fields, a USB camera the V4L2 node and its USB facts; each is absent when unknown.
 */
export interface CameraDevice {
  /** libcamera's name for the camera; the stable way to name a MIPI camera. */
  camera_name?: string | null;
  media_device?: string;
  bus_info?: string;
  /** The CSI receiver the sensor is attached to. */
  csi?: string;
  /** `/dev/videoN`, whose number can change across reboots. */
  video_node?: string;
  /** The `/dev/v4l/by-id/…` link, stable across reboots. */
  by_id?: string;
  usb?: UsbFacts;
}

export interface CameraItem extends ItemBase {
  kind: 'camera';
  model: string | null;
  device: CameraDevice;
  /** The camera's best tier over all its modes. */
  support: DeviceSupport;
  /**
   * `live` from this scan; `previous-scan` kept from a failed provider's last good scan (the
   * camera may have been unplugged since); `unavailable` when no mode could be read.
   */
  modes_source: 'live' | 'previous-scan' | 'unavailable';
  formats: CameraFormat[];
  /** The mode to preselect; null when no mode is Available. */
  default_selection: CameraModeChoice | null;
}

/** One pixel format of a camera, with the sizes it offers. */
export interface CameraFormat {
  /** The V4L2 or libcamera fourcc, such as `NV12` or `MJPG`. */
  format: string;
  label: string;
  support: DeviceSupport;
  /** The bounds of a stepwise or continuous size range; null for discrete sizes. */
  range: CameraFormatRange | null;
  sizes: CameraSize[];
}

export interface CameraFormatRange {
  min_width: number;
  min_height: number;
  max_width: number;
  max_height: number;
  step_width: number;
  step_height: number;
}

/** One size of a format, with the frame rates it runs at, fastest first. */
export interface CameraSize {
  width: number;
  height: number;
  fps: CameraMode[];
}

/**
 * One mode: a frame rate of its size and format, with Sentinel's verdict on that mode, and
 * whether Insight's preview takes it (the server's rule: for MIPI, NV12 that Sentinel does not
 * refuse; for USB, MJPG or a raw format, at a rate the camera advertises). `value` is the rate for
 * display and requests, to a thousandth.
 */
export interface CameraMode {
  value: number;
  tier: SupportTier;
  /** Why the mode is not Available; absent when it is. */
  reason?: string;
  previewable: boolean;
}

/** A mode as a selection and a preview request name it. */
export interface CameraModeChoice {
  format: string;
  width: number;
  height: number;
  fps: number;
}

/** A microphone's ALSA identity; a fact the card does not report is null or absent. */
export interface MicrophoneDevice {
  card_index: number | null;
  card_id: string | null;
  card_name: string | null;
  card_driver: string | null;
  pcm_device: number | null;
  pcm_node: string | null;
  /** `hw:CARD=<id>,DEV=<n>`; absent without a card id. */
  alsa_name?: string;
  by_path?: string;
  by_id?: string;
  usb?: UsbFacts;
  /** The camera item the same USB device produced: a webcam's or headset's microphone. */
  part_of?: { id: string; name: string };
}

/** One capture combination the device reports. */
export interface MicrophoneCapture {
  format: string | null;
  channels: number | null;
  bits: number | null;
  rates: number[];
  /** A continuous rate range, in Hz; null for discrete `rates`. */
  rate_range: { min: number; max: number } | null;
  channel_map: string[] | null;
}

export interface MicrophoneItem extends ItemBase {
  kind: 'microphone';
  device: MicrophoneDevice;
  /** Null when the formats cannot be read without opening the device. */
  capture: MicrophoneCapture[] | null;
  /**
   * What identifies the device behind the id (Sentinel's capture target and identity): a
   * microphone listed again under the same id with another `record` is another device, and a test
   * of the old one is over.
   */
  record: string;
}

/** A device of a kind Insight has no view for; listed with its name and facts only. */
export interface OtherItem extends ItemBase {
  device: Record<string, unknown>;
}

/** One SiMa Sentinel problem with the scan as a whole, such as a provider that failed. */
export interface PeripheralIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  hint: string | null;
}

/** A device named in a change summary. */
export interface DeviceRef {
  id: string;
  name: string;
}

export interface DeviceChanges {
  added: readonly DeviceRef[];
  removed: readonly DeviceRef[];
}

// ---------------------------------------------------------------------------------------------
// The camera preview and the microphone test
// ---------------------------------------------------------------------------------------------

/**
 * The board's camera preview (one per board) as the page holds it: the server's answer and the
 * id of the board it was read from, which its stream and stop paths name.
 */
export type PreviewSession = CameraPreview & { board: string };

/** The board's microphone test (one per board), and the board it was read from. */
export type MicTestStatus = MicTest & { board: string };
