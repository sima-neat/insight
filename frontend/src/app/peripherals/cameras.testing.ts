import type {
  CameraFormat,
  CameraFormatRange,
  CameraItem,
  CameraMode,
  CameraModeChoice,
  CameraSize,
  DeviceAvailability,
  DeviceSupport,
  PreviewSession,
  SupportTier,
} from './api';

// #170's camera fixtures (model.test.js), typed: the cameras a real DevKit scan returned, for the
// camera modes and the preview.

export const ISP_SIZE = 'The ISP cannot output this size.';
export const NOT_IN_OVERLAYS = "IMX568 is not in this board's camera overlays.";
export const USB_REASON = 'USB cameras have no camera overlay on this board.';
export const NO_BOARD =
  "This board's SiMa Sentinel does not report camera overlays; update Sentinel.";

export const support = (tier: SupportTier, reason = ''): DeviceSupport => ({ tier, reason });

/** Frame rates with their tiers. A tier of '' is a rate the board did not judge. */
export const rates = (...pairs: [number, SupportTier | ''][]): CameraMode[] =>
  pairs.map(([value, tier]) => ({
    value,
    framerate_num: value,
    framerate_den: 1,
    tier: tier as SupportTier,
  }));

export const size = (
  width: number,
  height: number,
  ...pairs: [number, SupportTier | ''][]
): CameraSize => ({ width, height, fps: rates(...pairs) });

export const format = (
  name: string,
  label: string,
  exportable: boolean,
  formatSupport: DeviceSupport,
  sizes: CameraSize[],
  range: CameraFormatRange | null = null,
): CameraFormat => ({ format: name, label, exportable, support: formatSupport, range, sizes });

export const sel = (
  format: string,
  width: number,
  height: number,
  fps: number,
): CameraModeChoice => ({
  format,
  width,
  height,
  fps,
});

export const available: DeviceAvailability = { state: 'available', users: [], reason: null };

export const imx477: CameraItem = {
  id: 'mipi:/base/axi/pcie@120000/rp1/i2c@80000/imx477@1a',
  kind: 'camera',
  connection: 'mipi',
  name: '/base/axi/pcie@120000/rp1/i2c@80000/imx477@1a',
  model: 'imx477',
  device: {
    camera_name: '/base/axi/pcie@120000/rp1/i2c@80000/imx477@1a',
    camera_name_source: 'libcamera',
    media_device: '/dev/media0',
    bus_info: 'platform:csi2video@1',
    csi: 'csidev-40c3000.csi',
    video_node: '/dev/video3',
  },
  availability: available,
  support: support('available'),
  modes_source: 'live',
  formats: [
    format('NV12', 'NV12 (YUV 4:2:0)', true, support('available'), [
      size(1920, 1080, [30, 'available'], [60, 'available']),
      size(1280, 720, [60, 'unsupported']),
    ]),
  ],
  default_selection: { format: 'NV12', width: 1920, height: 1080, fps: 30 },
  notes: [],
  errors: [],
};

export const imx568: CameraItem = {
  id: 'mipi:econ-imx568-fpga 5-0042',
  kind: 'camera',
  connection: 'mipi',
  name: 'econ-imx568-fpga 5-0042',
  model: 'imx568',
  device: {
    camera_name: 'econ-imx568-fpga 5-0042',
    camera_name_source: 'media-graph',
    media_device: '/dev/media0',
  },
  availability: { state: 'unknown', users: [], reason: 'fuser is not installed on the board.' },
  support: support('unsupported', NOT_IN_OVERLAYS),
  modes_source: 'live',
  formats: [
    format(
      'NV12',
      'NV12 (YUV 4:2:0)',
      false,
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
    format('RGB888', 'RGB888', false, support('unsupported', NOT_IN_OVERLAYS), [size(1920, 1080)]),
  ],
  default_selection: null,
  notes: ['Sensor crop rectangle could not be read; defaults were used.'],
  errors: [],
};

export const inUse: CameraItem = {
  ...imx477,
  id: 'mipi:/base/axi/i2c@88000/imx477@1a',
  name: '/base/axi/i2c@88000/imx477@1a',
  device: { camera_name: '/base/axi/i2c@88000/imx477@1a', camera_name_source: 'libcamera' },
  availability: { state: 'in_use', users: [{ pid: 812, command: 'gst-launch-1.0' }], reason: null },
  modes_source: 'previous-scan',
};

export const usb: CameraItem = {
  id: 'usb:046d:0825:1-1.2',
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
  availability: available,
  support: support('unsupported', USB_REASON),
  modes_source: 'live',
  formats: [
    format('MJPG', 'Motion-JPEG', false, support('unsupported', USB_REASON), [
      size(1280, 720, [30, 'unsupported']),
      size(640, 480, [30, 'unsupported']),
    ]),
    format('YUYV', 'YUYV 4:2:2', false, support('unsupported', USB_REASON), [
      size(640, 480, [30, 'unsupported'], [15, 'unsupported']),
    ]),
  ],
  default_selection: null,
  notes: [],
  errors: [],
};

/** #170's live preview of the imx477 on board generation 3, with what a test overrides. */
export function previewSession(overrides: Partial<PreviewSession> = {}): PreviewSession {
  return {
    id: '8f1c',
    camera_id: imx477.id,
    mode: sel('NV12', 1920, 1080, 30),
    stream_url: '/api/peripherals/cameras/preview/8f1c/stream',
    generation: 3,
    started_at: '2026-10-25T10:00:00Z',
    state: 'live',
    camera_fps: null,
    ...overrides,
  };
}
