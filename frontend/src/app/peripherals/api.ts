/**
 * Request and response shapes of Flask's `/api/peripherals*` endpoints (Inv-PB §4.2 and §4.3;
 * `neat_insight/peripherals/cameras.py`, `microphones.py`, `mictest.py` and
 * `neat_insight/preview/manager.py`). Types only: `PeripheralsService` and the pages' preview and
 * microphone-test units call the endpoints.
 *
 * A failed request answers a board error body (`BoardErrorBody` in `board/api.ts`), which
 * `problemOf` reads. Besides the board's codes, these endpoints add `stale_snapshot`, `not_found`,
 * `preview_active`, `camera_in_use`, `mode_adjusted`, `tool_missing`, `command_failed`,
 * `test_running`, `microphone_in_use` and the `peripheral_*` codes of SiMa Sentinel.
 */

import type { BoardErrorBody, BoardSummary, CameraSetup } from '../board/api';

// ---------------------------------------------------------------------------------------------
// The scan (`GET /api/peripherals`, `POST /api/peripherals/refresh`)
// ---------------------------------------------------------------------------------------------

/**
 * The last scan of the selected board, or an empty one before any. It counts as scanned when
 * `scan_id` is not null (`isScanned` in `devices.ts`); `scan_id`, `scanned_at` and `scan_ms` are
 * set together by a scan.
 */
export interface PeripheralSnapshot {
  board: BoardSummary;
  /** The board generation the scan was made for (`BoardState.generation`). */
  generation: number;
  /** `<Sentinel revision>:<observed at>`; null before a scan. */
  scan_id: string | null;
  /** ISO time of the scan; null before a scan. */
  scanned_at: string | null;
  /** How long SiMa Sentinel's refresh took; absent before a scan. */
  scan_ms?: number;
  items: PeripheralItem[];
  issues: PeripheralIssue[];
  /** What changed since the previous scan; null on the first scan of a board. */
  changes: DeviceChanges | null;
  /** Null before a scan and from a Sentinel that does not read the board's camera setup. */
  camera_setup: CameraSetup | null;
}

/**
 * One device. `kind` is `camera` or `microphone` today; a kind the backend adds later arrives as
 * an `OtherItem`, which Insight lists but has no view for. Narrow with `isCamera` and
 * `isMicrophone` (`devices.ts`): `OtherItem.kind` is any string, so `kind` alone cannot.
 */
export type PeripheralItem = CameraItem | MicrophoneItem | OtherItem;

/** Fields every item carries. */
interface ItemBase {
  /** Stable across scans of one board; selections and changes name items by it. */
  id: string;
  kind: string;
  /**
   * How the device is attached: `mipi` or `usb` for cameras, `usb` or `onboard` for microphones,
   * otherwise the backend's own name for it.
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
  users: { pid: number; command: string }[];
  reason: string | null;
}

/** A problem with one device, such as a camera without modes (`no_modes`). */
export interface DeviceError {
  code: string;
  message: string;
  hint: string | null;
}

/**
 * Whether a camera, format or mode can be previewed and exported: Available (the board's camera
 * overlays support the sensor, the ISP outputs the size and the format is NV12), Unverified (a
 * Platform 3.0 sensor size SiMa Sentinel cannot confirm; it can be previewed to check) or
 * Unsupported. USB cameras are always Unsupported, yet previewable.
 */
export type SupportTier = 'available' | 'unverified' | 'unsupported';

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
  camera_name_source?: string;
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
  /** Some mode of this format is Available. */
  exportable: boolean;
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
 * One mode: a frame rate of its size and format, with that mode's tier. `value` is the rate for
 * display and requests; the fraction is the exact rate.
 */
export interface CameraMode {
  value: number;
  framerate_num: number;
  framerate_den: number;
  tier: SupportTier;
  /** Why the mode is not Available; absent when it is. */
  reason?: string;
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
  pcm_device: number;
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
   * A short fingerprint of SiMa Sentinel's record a test binds to: a microphone listed again
   * under the same id with another `record` is another device, and a test of the old one is over.
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
  added: DeviceRef[];
  removed: DeviceRef[];
}

// ---------------------------------------------------------------------------------------------
// The camera preview (`/api/peripherals/preview`, `/api/peripherals/cameras/preview*`)
// ---------------------------------------------------------------------------------------------

/**
 * `POST /api/peripherals/cameras/preview`: a scanned camera, in a mode of its last scan; without
 * a mode the camera's `default_selection`.
 */
export interface PreviewStartRequest {
  id: string;
  format?: string;
  width?: number;
  height?: number;
  fps?: number;
}

/**
 * The one camera preview Insight runs. Its MJPEG stream (`stream_url`) has a single reader and
 * stops when that reader goes.
 */
export interface PreviewSession {
  id: string;
  camera_id: string;
  mode: CameraModeChoice;
  /** `/api/peripherals/cameras/preview/<id>/stream`. */
  stream_url: string;
  generation: number;
  started_at: string;
  /** `stopped` only in the answer of a stop. */
  state: 'live' | 'stopped';
  /** The rate the camera runs at: the mode's for USB; for MIPI null until SiMa Sentinel read it. */
  camera_fps: number | null;
  /** `GET /api/peripherals/preview` only: whether a stream reader has claimed it. */
  viewer?: boolean;
}

/**
 * `GET /api/peripherals/preview`, the answer of a start and of
 * `POST /api/peripherals/cameras/preview/<id>/stop`; null when no preview runs (or a stop found
 * it ended already).
 */
export interface PreviewResponse {
  session: PreviewSession | null;
}

// ---------------------------------------------------------------------------------------------
// The microphone test (`/api/peripherals/microphones/test*`)
// ---------------------------------------------------------------------------------------------

/** `POST /api/peripherals/microphones/test`: record from a scanned microphone. */
export interface MicTestRequest {
  id: string;
  /** 1 to 30, default 30. */
  seconds?: number;
}

/** `POST /api/peripherals/microphones/test/stop`: a test is stopped by its token only. */
export interface MicTestStopRequest {
  token: string;
}

/** The levels of a finished recording; null dBFS for a recording with no samples. */
export interface MicTestLevel {
  peak_dbfs: number | null;
  rms_dbfs: number | null;
  /** The median slice peak is below −60 dBFS. */
  silent: boolean;
}

/** The test Insight runs or ran last (one per Insight process). */
export interface MicTestStatus {
  token: string;
  /** The microphone's item id. */
  id: string;
  state: 'recording' | 'ready' | 'failed';
  /** The ALSA selector it records from, `plughw:CARD=<id>,DEV=<n>`. */
  device: string;
  format: { rate: number; channels: number; bits: 16; seconds: number };
  elapsed_ms: number;
  /** The live level while recording; null otherwise. */
  level_dbfs: number | null;
  /** Once `ready`. */
  level?: MicTestLevel;
  /** Once `ready`: `/api/peripherals/microphones/test/<token>.wav`. */
  audio_url?: string;
  /** Once `failed`, such as `stopped_early`, `tool_missing` or `microphone_in_use`. */
  error?: BoardErrorBody;
}

/** The answer of a start (202), a stop and `GET /api/peripherals/microphones/test`. */
export interface MicTestResponse {
  test: MicTestStatus | null;
}
