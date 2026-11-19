/**
 * Peripherals' routes (`/api/boards/<id>/peripherals...`, `/cameras/...`, `/microphones/...`),
 * typed from `server/api/openapi.yaml` (`api.generated.ts`): the scan's devices as the server
 * builds them from SiMa Sentinel's catalog, the camera preview and the microphone test. Types
 * only: `PeripheralsService` and the page's preview and microphone-test units call the routes.
 *
 * A failed request answers the error shape (`problemOf` in `board-error.ts` reads it). Besides
 * the board's codes, these routes add `not_found`, `no_scan`, `stale_scan`, `preview_active`,
 * `camera_in_use`, `mode_adjusted`, `tool_missing`, `command_failed`, `test_running`,
 * `microphone_in_use` and `stopped_early`.
 */

import type { CameraPreview, DeviceSupport, MicTest, PeripheralScan } from '../api.generated';

export type {
  CameraDevice,
  CameraFormat,
  CameraFormatRange,
  CameraItem,
  CameraMode,
  CameraPreview,
  CameraSize,
  DeviceError,
  DeviceSupport,
  MicLevel,
  MicrophoneCapture,
  MicrophoneDevice,
  MicrophoneItem,
  MicTest,
  MicTestAnswer,
  MicTestRequest,
  OtherItem,
  PeripheralChanges,
  PeripheralIssue,
  PeripheralItem,
  PeripheralScan,
  Peripherals,
  PreviewAnswer,
  PreviewMode,
  UsbFacts,
} from '../api.generated';

/**
 * SiMa Sentinel's verdict on a camera, format or mode: Available when Neat's CameraInput can use
 * it, Unsupported otherwise. USB cameras are Unsupported, yet previewable.
 */
export type SupportTier = DeviceSupport['tier'];

/** The board a snapshot is of: the id it was read with, and its label then. */
export interface SnapshotBoard {
  id: string;
  label: string;
}

/**
 * The last scan of a board as the page holds it, with the board it was read from; before a scan
 * of the board, `scanned_at` is null and the rest empty (`isScanned` in `devices.ts`).
 */
export interface PeripheralSnapshot extends Omit<PeripheralScan, 'scanned_at' | 'scan_ms'> {
  board: SnapshotBoard;
  scanned_at: string | null;
  /** Absent before a scan. */
  scan_ms?: number;
}

/**
 * The board's camera preview (one per board) as the page holds it: the server's answer and the
 * id of the board it was read from, which its stream and stop paths name.
 */
export type PreviewSession = CameraPreview & { board: string };

/** The board's microphone test (one per board), and the board it was read from. */
export type MicTestStatus = MicTest & { board: string };
