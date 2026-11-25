import type { CameraItem, MicrophoneItem, PeripheralItem, Peripherals } from './api';

// A DevKit's devices as the server answers its scan, for tests that answer the peripherals routes
// (the Peripherals page's spec, the end-to-end mocks): an IMX477 on MIPI, a C270 webcam on USB and
// a Yeti Nano microphone on the same USB port. Plain data with no Angular, so the end-to-end tests
// can import it too. The server's own tests hold its answers to real Sentinel catalogs.

const USB_REASON = 'Update SiMa Sentinel on the board to check USB cameras.';

/** The IMX477: NV12 1920×1080 at 60 and 30 fps and 1280×720 at 60, all Available. */
export const IMX477: CameraItem = {
  id: 'camera:imx477 5-001a',
  kind: 'camera',
  connection: 'mipi',
  name: 'imx477 5-001a',
  model: 'imx477',
  device: {
    camera_name: 'imx477 5-001a',
    media_device: '/dev/media0',
    bus_info: 'platform:csi2video@1',
    csi: 'csidev-40c3000.csi',
  },
  support: { tier: 'available', reason: '' },
  modes_source: 'live',
  formats: [
    {
      format: 'NV12',
      label: 'NV12 (YUV 4:2:0)',
      support: { tier: 'available', reason: '' },
      range: null,
      sizes: [
        {
          width: 1920,
          height: 1080,
          fps: [
            { value: 60, tier: 'available', previewable: true },
            { value: 30, tier: 'available', previewable: true },
          ],
        },
        {
          width: 1280,
          height: 720,
          fps: [{ value: 60, tier: 'available', previewable: true }],
        },
      ],
    },
  ],
  default_selection: { format: 'NV12', width: 1920, height: 1080, fps: 60 },
  notes: [],
  errors: [],
};

/** A rate of a C270 mode: Unsupported by Sentinel, yet previewable. */
const c270Rate = (value: number) => ({
  value,
  tier: 'unsupported' as const,
  reason: USB_REASON,
  previewable: true,
});

/** A Logitech C270: MJPG and YUYV modes, Unsupported by Sentinel yet previewable. */
export const C270: CameraItem = {
  id: 'camera:v4l2:5a1c0e2f9b7d4c31',
  kind: 'camera',
  connection: 'usb',
  name: 'HD Webcam C270',
  model: 'HD Webcam C270',
  device: {
    video_node: '/dev/video0',
    by_id: '/dev/v4l/by-id/usb-046d_0825_2F6D4A10-video-index0',
    usb: {
      vendor_id: '046d',
      product_id: '0825',
      product: 'HD Webcam C270',
      serial: '2F6D4A10',
      bus_path: 'devices/platform/usb1/1-1/1-1.2',
      speed_mbps: 480,
    },
  },
  support: { tier: 'unsupported', reason: USB_REASON },
  modes_source: 'live',
  formats: [
    {
      format: 'MJPG',
      label: 'MJPG (Motion-JPEG)',
      support: { tier: 'unsupported', reason: USB_REASON },
      range: null,
      sizes: [
        { width: 1280, height: 720, fps: [c270Rate(30)] },
        { width: 640, height: 480, fps: [c270Rate(30)] },
      ],
    },
    {
      format: 'YUYV',
      label: 'YUYV (YUYV 4:2:2)',
      support: { tier: 'unsupported', reason: USB_REASON },
      range: null,
      sizes: [{ width: 640, height: 480, fps: [c270Rate(30), c270Rate(15)] }],
    },
  ],
  default_selection: null,
  notes: [],
  errors: [],
};

/** A Blue Yeti Nano plugged into the C270's USB port: named as its part. */
export const YETI: MicrophoneItem = {
  id: 'microphone:alsa:3ff3d77bf791d455',
  kind: 'microphone',
  connection: 'usb',
  name: 'Yeti Nano',
  device: {
    card_index: 0,
    card_id: 'Nano',
    card_name: 'Yeti Nano',
    card_driver: 'USB-Audio',
    pcm_device: 0,
    pcm_node: '/dev/snd/pcmC0D0c',
    alsa_name: 'hw:CARD=Nano,DEV=0',
    usb: {
      vendor_id: 'b58e',
      product_id: '0005',
      manufacturer: 'Blue Microphones',
      product: 'Yeti Nano',
      serial: '2127SG00CBA8_888-000441040606',
      bus_path: '1-1.2',
    },
    part_of: { id: C270.id, name: C270.name },
  },
  capture: [
    {
      format: 'S24_3LE',
      channels: 2,
      bits: 24,
      rates: [32000, 44100, 48000],
      channel_map: ['FL', 'FR'],
    },
  ],
  record: 'dd0788aea9c636c5',
  notes: [],
  errors: [],
};

/** The parts of a scan a test sets beside its devices. */
export type ScanOptions = Partial<Omit<NonNullable<Peripherals['scan']>, 'items'>>;

/** The peripherals answer of a scan that found `items`. */
export function scanAnswer(
  items: readonly PeripheralItem[],
  options: ScanOptions = {},
): Peripherals {
  return {
    scan: {
      scanned_at: '2026-10-25T10:00:00Z',
      scan_ms: 3400,
      items,
      issues: [],
      camera_setup: { model: 'SiMa.ai Modalix SoM 16Gig Board', overlays: [] },
      changes: null,
      ...options,
    },
  };
}

/** The peripherals answer before the board's first scan. */
export const NO_SCAN: Peripherals = { scan: null };
