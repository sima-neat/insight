import { DEVKIT } from '../board/board.testing';
import type {
  CameraFormat,
  CameraFormatRange,
  CameraItem,
  CameraMode,
  PreviewMode,
  CameraSize,
  DeviceSupport,
  PreviewSession,
  SupportTier,
} from './api';

// Camera items as the server answers them for a real DevKit scan, for the camera modes and the
// preview.

export const NOT_IN_OVERLAYS = "IMX568 is not in this board's camera overlays.";
export const USB_REASON = 'Update SiMa Sentinel on the board to check USB cameras.';

export const support = (tier: SupportTier, reason = ''): DeviceSupport => ({ tier, reason });

/**
 * Frame rates with Sentinel's verdicts. A rate is previewable when Available unless the third
 * element says otherwise (a USB camera previews its Unsupported modes).
 */
export const rates = (...modes: [number, SupportTier, boolean?][]): CameraMode[] =>
  modes.map(([value, tier, previewable = tier === 'available']) => ({ value, tier, previewable }));

export const size = (
  width: number,
  height: number,
  ...modes: [number, SupportTier, boolean?][]
): CameraSize => ({ width, height, fps: rates(...modes) });

export const format = (
  name: string,
  label: string,
  formatSupport: DeviceSupport,
  sizes: CameraSize[],
  range: CameraFormatRange | null = null,
): CameraFormat => ({ format: name, label, support: formatSupport, range, sizes });

export const sel = (format: string, width: number, height: number, fps: number): PreviewMode => ({
  format,
  width,
  height,
  fps,
});

export const imx477: CameraItem = {
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
  support: support('available'),
  modes_source: 'live',
  formats: [
    format('NV12', 'NV12 (YUV 4:2:0)', support('available'), [
      size(1920, 1080, [30, 'available'], [60, 'available']),
      size(1280, 720, [60, 'unsupported']),
    ]),
  ],
  default_selection: { format: 'NV12', width: 1920, height: 1080, fps: 30 },
  notes: [],
  errors: [],
};

export const imx568: CameraItem = {
  id: 'camera:econ-imx568-fpga 5-0042',
  kind: 'camera',
  connection: 'mipi',
  name: 'econ-imx568-fpga 5-0042',
  model: 'imx568',
  device: {
    camera_name: 'econ-imx568-fpga 5-0042',
    media_device: '/dev/media0',
  },
  support: support('unsupported', NOT_IN_OVERLAYS),
  modes_source: 'live',
  formats: [
    format(
      'NV12',
      'NV12 (YUV 4:2:0)',
      support('unsupported', NOT_IN_OVERLAYS),
      [
        size(2432, 2048, [30, 'unsupported']),
        size(1920, 1080, [30, 'unsupported'], [59.94, 'unsupported']),
      ],
      {
        min_width: 64,
        min_height: 64,
        max_width: 2432,
        max_height: 2048,
        step_width: 2,
        step_height: 2,
      },
    ),
    format('RGB888', 'RGB888', support('unsupported', NOT_IN_OVERLAYS), [size(1920, 1080)]),
  ],
  default_selection: null,
  notes: ['Sensor crop rectangle could not be read; defaults were used.'],
  errors: [],
};

export const inUse: CameraItem = {
  ...imx477,
  id: 'camera:imx477 6-001a',
  name: 'imx477 6-001a',
  device: { camera_name: 'imx477 6-001a' },
  modes_source: 'previous-scan',
};

export const usb: CameraItem = {
  id: 'camera:v4l2:421bbe426738013b',
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
      manufacturer: 'Logitech',
      product: 'HD Webcam C270',
      bus_path: '1-1.2',
      speed_mbps: 480,
    },
  },
  support: support('unsupported', USB_REASON),
  modes_source: 'live',
  formats: [
    format('MJPG', 'Motion-JPEG', support('unsupported', USB_REASON), [
      size(1280, 720, [30, 'unsupported', true]),
      size(640, 480, [30, 'unsupported', true]),
    ]),
    format('YUYV', 'YUYV 4:2:2', support('unsupported', USB_REASON), [
      size(640, 480, [30, 'unsupported', true], [15, 'unsupported', true]),
    ]),
  ],
  default_selection: null,
  notes: [],
  errors: [],
};

/** The DevKit's live preview of the imx477, with what a test overrides. */
export function previewSession(overrides: Partial<PreviewSession> = {}): PreviewSession {
  return {
    id: '8f1c',
    camera: imx477.id,
    mode: sel('NV12', 1920, 1080, 30),
    board: DEVKIT.id,
    started_at: '2026-10-25T10:00:00Z',
    camera_fps: null,
    viewer: false,
    ...overrides,
  };
}
