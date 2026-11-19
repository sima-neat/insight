import type { PeripheralChanges, Peripherals } from '../api.generated';

// Devices of SiMa Sentinel's peripheral catalog as the server passes them on, for tests that
// answer the peripherals routes (the Peripherals page's spec, the end-to-end mocks). Plain data
// with no Angular, so the end-to-end tests can import it too.

/** A Sentinel device: its fields are Sentinel's. */
export type SentinelDevice = Record<string, unknown>;

const USB_REASON = 'USB cameras have no camera overlay on this board.';

/** Discrete frame intervals of one size, one per rate. */
function intervals(width: number, height: number, ...fps: number[]) {
  return [
    {
      width,
      height,
      intervals: fps.map((rate) => ({ type: 'discrete', numerator: 1, denominator: rate })),
    },
  ];
}

/**
 * The DevKit's IMX477 on MIPI CSI: NV12 1920×1080 at 60 and 30 fps, which Sentinel marks
 * Available, and NV12 1280×720, which it does not.
 */
export const SENTINEL_IMX477: SentinelDevice = {
  id: 'camera:imx477 5-001a',
  type: 'camera',
  backend: 'mipi',
  camera_name: 'imx477 5-001a',
  model: 'imx477',
  media_device: '/dev/media0',
  bus_info: 'platform:csi2video@1',
  csi_receiver: 'csidev-40c3000.csi',
  max_fps: 66.18,
  availability: { state: 'unknown', reason: 'Discovery does not open the camera.' },
  modes: [
    {
      format: 'NV12',
      width: 1920,
      height: 1080,
      available: true,
      frame_intervals: intervals(1920, 1080, 60, 30),
    },
    {
      format: 'NV12',
      width: 1280,
      height: 720,
      available: false,
      reason: 'The ISP cannot output this size.',
      frame_intervals: intervals(1280, 720, 60),
    },
  ],
};

/** A Logitech C270 on USB: MJPG and YUYV modes, Unsupported by Sentinel yet previewable. */
export const SENTINEL_C270: SentinelDevice = {
  id: 'camera:v4l2:5a1c0e2f9b7d4c31',
  type: 'camera',
  backend: 'v4l2',
  model: 'HD Webcam C270',
  device_path: '/dev/video0',
  by_id_path: '/dev/v4l/by-id/usb-046d_0825_2F6D4A10-video-index0',
  identity: {
    vendor_id: '046d',
    product_id: '0825',
    serial: '2F6D4A10',
    speed: '480',
    topology: 'devices/platform/usb1/1-1/1-1.2',
  },
  availability: { state: 'unknown', reason: 'V4L2 does not expose an ownership state.' },
  modes: [
    {
      format: 'MJPG',
      format_description: 'Motion-JPEG',
      width: 1280,
      height: 720,
      available: false,
      reason: USB_REASON,
      frame_intervals: intervals(1280, 720, 30),
    },
    {
      format: 'MJPG',
      format_description: 'Motion-JPEG',
      width: 640,
      height: 480,
      available: false,
      reason: USB_REASON,
      frame_intervals: intervals(640, 480, 30),
    },
    {
      format: 'YUYV',
      format_description: 'YUYV 4:2:2',
      width: 640,
      height: 480,
      available: false,
      reason: USB_REASON,
      frame_intervals: intervals(640, 480, 30, 15),
    },
  ],
};

/** A Blue Yeti Nano plugged into the same USB port as the C270's hub: named as its part. */
export const SENTINEL_YETI: SentinelDevice = {
  id: 'microphone:alsa:3ff3d77bf791d455',
  type: 'microphone',
  backend: 'alsa',
  connection: 'usb',
  name: 'Yeti Nano',
  availability: { state: 'available' },
  capture_target: { card_id: 'Nano', device: 0, selector: 'plughw:CARD=Nano,DEV=0' },
  identity: {
    card_index: 0,
    card_id: 'Nano',
    card_name: 'Yeti Nano',
    card_driver: 'USB-Audio',
    pcm_node: '/dev/snd/pcmC0D0c',
    usb: {
      vendor_id: 'b58e',
      product_id: '0005',
      manufacturer: 'Blue Microphones',
      product: 'Yeti Nano',
      serial: '2127SG00CBA8_888-000441040606',
      bus_path: '1-1.2',
    },
  },
  modes: [
    {
      format: 'S24_3LE',
      channels: 2,
      sample_bits: 24,
      rates_hz: [32000, 44100, 48000],
      channel_map: ['FL', 'FR'],
    },
  ],
};

/** The parts of a scan a test sets. */
export interface ScanOptions {
  /** Sentinel's catalog revision; scans of the same revision have the same `scan_id`. */
  revision?: number;
  scannedAt?: string;
  changes?: PeripheralChanges | null;
  /** Sentinel's failed providers. */
  errors?: { provider: string; code: string; reason: string }[];
}

/** The peripherals answer of a scan that found `devices`. */
export function sentinelScan(
  devices: readonly SentinelDevice[],
  {
    revision = 42,
    scannedAt = '2026-10-25T10:00:00Z',
    changes = null,
    errors = [],
  }: ScanOptions = {},
): Peripherals {
  return {
    scan: {
      scanned_at: scannedAt,
      scan_ms: 3400,
      catalog: {
        revision,
        observed_at: scannedAt,
        devices,
        errors,
        board: { model: 'SiMa.ai Modalix SoM 16Gig Board' },
      },
      changes,
    },
  };
}

/** The peripherals answer before the board's first scan. */
export const NO_SCAN: Peripherals = { scan: null };
