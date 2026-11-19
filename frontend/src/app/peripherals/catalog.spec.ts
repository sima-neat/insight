import devkitCatalog from '../../../../tests/fixtures/sentinel-catalog-devkit-3.0.json';
import exampleCatalog from '../../../../tests/fixtures/sentinel-catalog-example.json';
import type { PeripheralChanges, Peripherals } from '../api.generated';
import type { CameraItem, MicrophoneItem, SnapshotBoard } from './api';
import { resolveSelection } from './camera-modes';
import { cameraSetupOf, fpsValue, snapshotOf } from './catalog';

const BOARD: SnapshotBoard = { id: 'ssh:sima@192.168.1.20:22', label: 'sima@192.168.1.20' };
const NV12_ONLY = "Neat's CameraInput outputs NV12 only.";
const USB_REASON = 'USB cameras have no camera overlay on this board.';

/** The peripherals answer of a scan of `catalog`. */
function scanOf(catalog: object, changes: PeripheralChanges | null = null): Peripherals {
  return {
    scan: { scanned_at: '2026-11-19T01:00:05Z', scan_ms: 1200, catalog: { ...catalog }, changes },
  };
}

const devkit = snapshotOf(BOARD, scanOf(devkitCatalog));
const [imx477, c920] = devkit.items as [CameraItem, CameraItem];
const microphone = devkit.items[2] as MicrophoneItem;

describe('the device model from Sentinel', () => {
  it('a board without a scan has the empty snapshot', () => {
    expect(snapshotOf(BOARD, { scan: null })).toEqual({
      board: BOARD,
      scan_id: null,
      scanned_at: null,
      items: [],
      issues: [],
      changes: null,
      camera_setup: null,
    });
  });

  it('a scan lists its cameras, then its microphones, as of the scan', () => {
    expect(devkit.board).toBe(BOARD);
    expect(devkit.scan_id).toBe(`${devkitCatalog.revision}:${devkitCatalog.observed_at}`);
    expect(devkit.scanned_at).toBe('2026-11-19T01:00:05Z');
    expect(devkit.scan_ms).toBe(1200);
    expect(devkit.items.map((item) => [item.kind, item.id])).toEqual([
      ['camera', 'camera:imx477 5-001a'],
      ['camera', 'camera:v4l2:421bbe426738013b'],
      ['microphone', 'microphone:alsa:329f324bddfdde7b'],
    ]);
    expect(devkit.issues).toEqual([]);
    const changes = { added: [{ id: 'camera:x', name: 'X' }], removed: [] };
    expect(snapshotOf(BOARD, scanOf(devkitCatalog, changes)).changes).toEqual(changes);
  });

  it("a MIPI camera keeps Sentinel's verdict on each mode: NV12 is Available, the rest say why not", () => {
    expect(imx477).toMatchObject({
      connection: 'mipi',
      name: 'imx477 5-001a',
      model: 'imx477',
      support: { tier: 'available', reason: '' },
      modes_source: 'live',
      device: {
        camera_name: 'imx477 5-001a',
        media_device: '/dev/media0',
        bus_info: 'platform:csi2video@1',
        csi: 'csidev-40c3000.csi',
      },
      availability: { state: 'unknown' },
      notes: [],
      errors: [],
    });
    expect(imx477.formats.map((f) => [f.format, f.label, f.support])).toEqual([
      ['AR24', 'AR24 (packed 32-bit)', { tier: 'unsupported', reason: NV12_ONLY }],
      ['NV12', 'NV12 (YUV 4:2:0)', { tier: 'available', reason: '' }],
      ['NV16', 'NV16', { tier: 'unsupported', reason: NV12_ONLY }],
      ['NV24', 'NV24', { tier: 'unsupported', reason: NV12_ONLY }],
      ['RGB3', 'RGB3 (packed 24-bit)', { tier: 'unsupported', reason: NV12_ONLY }],
    ]);
    const nv12 = imx477.formats[1];
    // Every size Sentinel lists, the IMX477's 4056-wide ones included: Insight caps no width.
    expect(nv12.sizes.map((s) => `${s.width}x${s.height}`)).toContain('4056x3040');
    // A MIPI mode advertises no rate: CameraInput's default, which the camera's 125.54 fps covers.
    expect(nv12.sizes[0].fps).toEqual([{ value: 30, tier: 'available', previewable: true }]);
    expect(imx477.formats[0].sizes[0].fps).toEqual([
      { value: 30, tier: 'unsupported', reason: NV12_ONLY, previewable: false },
    ]);
    // 1920 wide is preferred.
    expect(imx477.default_selection).toEqual({
      format: 'NV12',
      width: 1920,
      height: 1080,
      fps: 30,
    });
  });

  it('a slow MIPI camera is offered its own rate, not more than it runs at', () => {
    const slow = snapshotOf(
      BOARD,
      scanOf({
        ...devkitCatalog,
        devices: [{ ...devkitCatalog.devices[0], max_fps: 20.004 }],
      }),
    ).items[0] as CameraItem;
    expect(slow.formats[1].sizes[0].fps[0].value).toBe(20.004);
  });

  it('a MIPI camera from a Sentinel that gives no verdicts can be previewed in NV12, and says it is not checked', () => {
    const camera = snapshotOf(BOARD, scanOf(exampleCatalog)).items[0] as CameraItem;
    const nv12 = camera.formats.find((f) => f.format === 'NV12')!;
    const ar24 = camera.formats.find((f) => f.format === 'AR24')!;
    expect(camera.support.tier).toBe('unsupported');
    expect(camera.support.reason).toMatch(/does not say whether this mode can be used/);
    expect(nv12.sizes[0].fps[0]).toMatchObject({ tier: 'unsupported', previewable: true });
    expect(ar24.sizes[0].fps[0]).toMatchObject({ tier: 'unsupported', previewable: false });
    expect(camera.default_selection).toBeNull();
    // The example's camera runs at 66.18 fps: CameraInput's 30 is within it.
    expect(nv12.sizes[0].fps[0].value).toBe(30);
  });

  it("a USB camera is Unsupported by Sentinel's verdict, yet previews its MJPG and raw modes at the rates it advertises", () => {
    expect(c920).toMatchObject({
      connection: 'usb',
      name: 'HD Pro Webcam C920',
      model: 'HD Pro Webcam C920',
      support: { tier: 'unsupported', reason: USB_REASON },
      device: {
        video_node: '/dev/video1',
        by_id: '/dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920_BE998CAF-video-index0',
        usb: { vendor_id: '046d', product_id: '08e5', serial: 'BE998CAF', speed_mbps: 480 },
      },
      default_selection: null,
      notes: [],
    });
    expect(c920.formats.map((f) => [f.format, f.label])).toEqual([
      ['MJPG', 'MJPG (Motion-JPEG)'],
      // A USB driver names its own formats.
      ['YUYV', 'YUYV (YUYV 4:2:2)'],
    ]);
    const fullHd = c920.formats[0].sizes.find((s) => s.width === 1920)!;
    expect(fullHd.fps.map((f) => f.value)).toEqual([30, 24, 20, 15, 10, 7.5, 5]);
    expect(fullHd.fps.every((f) => f.previewable && f.tier === 'unsupported')).toBe(true);
    expect(fullHd.fps[0].reason).toBe(USB_REASON);
    // The menus fall back to its first mode.
    expect(resolveSelection(c920, null)).toMatchObject({ format: 'MJPG', fps: 30 });
  });

  it('a USB camera without a by-id link says its node may change', () => {
    const device: Record<string, unknown> = { ...devkitCatalog.devices[1] };
    delete device['by_id_path'];
    const camera = snapshotOf(BOARD, scanOf({ ...devkitCatalog, devices: [device] }))
      .items[0] as CameraItem;
    expect(camera.device.by_id).toBeUndefined();
    expect(camera.notes).toEqual([expect.stringMatching(/No \/dev\/v4l\/by-id link was found/)]);
  });

  it('a USB microphone names the webcam it belongs to and keeps its capture formats', () => {
    expect(microphone).toMatchObject({
      connection: 'usb',
      name: 'HD Pro Webcam C920',
      device: {
        card_index: 0,
        card_id: 'C920',
        card_name: 'HD Pro Webcam C920',
        card_driver: 'USB-Audio',
        pcm_device: 0,
        pcm_node: '/dev/snd/pcmC0D0c',
        alsa_name: 'hw:CARD=C920,DEV=0',
        usb: { vendor_id: '046d', product_id: '08e5', bus_path: '1-3.1' },
        part_of: { id: c920.id, name: c920.name },
      },
      availability: { state: 'available', reason: null },
      notes: [],
    });
    expect(microphone.capture).toEqual([
      {
        format: 'S16_LE',
        channels: 2,
        bits: 16,
        rates: [16000],
        rate_range: null,
        channel_map: ['FL', 'FR'],
      },
      {
        format: 'S16_LE',
        channels: 2,
        bits: 16,
        rates: [24000],
        rate_range: null,
        channel_map: ['FL', 'FR'],
      },
      {
        format: 'S16_LE',
        channels: 2,
        bits: 16,
        rates: [32000],
        rate_range: null,
        channel_map: ['FL', 'FR'],
      },
    ]);
  });

  it("a microphone's record changes with its capture target or identity, not with its modes", () => {
    const mic = devkitCatalog.devices[2] as Record<string, unknown>;
    const recordOf = (device: Record<string, unknown>) =>
      (
        snapshotOf(BOARD, scanOf({ ...devkitCatalog, devices: [device] }))
          .items[0] as MicrophoneItem
      ).record;
    expect(recordOf({ ...mic, modes: [] })).toBe(microphone.record);
    expect(recordOf({ ...mic, capture_target: { card_id: 'C920', device: 1 } })).not.toBe(
      microphone.record,
    );
  });

  it("a failed provider's devices are its last scan's: listed, said so, and the issue raised", () => {
    const failed = snapshotOf(
      BOARD,
      scanOf({
        ...devkitCatalog,
        errors: [{ provider: 'camera.v4l2', code: 'provider.failed', reason: 'v4l2 timed out' }],
      }),
    );
    const camera = failed.items[1] as CameraItem;
    expect(camera.modes_source).toBe('previous-scan');
    expect(camera.notes).toContain(
      "Modes are from SiMa Sentinel's last successful scan; its camera.v4l2 provider failed during this refresh.",
    );
    expect(failed.issues).toEqual([
      {
        severity: 'warning',
        code: 'provider.failed',
        message:
          "SiMa Sentinel's camera.v4l2 provider failed: v4l2 timed out The devices it found last time are still listed.",
        hint: expect.stringMatching(/systemctl status simaai-sentinel/),
      },
    ]);
    // The others are this scan's.
    expect((failed.items[0] as CameraItem).modes_source).toBe('live');
  });

  it('a camera without modes says why, and a device of another kind is listed with its name', () => {
    const snapshot = snapshotOf(
      BOARD,
      scanOf({
        ...devkitCatalog,
        devices: [
          { ...devkitCatalog.devices[0], modes: [] },
          { id: 'lidar:1', type: 'lidar', backend: 'i2c', name: 'Front LiDAR' },
        ],
      }),
    );
    const [camera, lidar] = snapshot.items;
    expect(camera).toMatchObject({
      modes_source: 'unavailable',
      support: { tier: 'unsupported', reason: 'SiMa Sentinel reported no modes for this camera.' },
      errors: [{ code: 'no_modes', message: 'SiMa Sentinel reported no modes for this camera.' }],
      default_selection: null,
    });
    expect(lidar).toMatchObject({
      id: 'lidar:1',
      kind: 'lidar',
      connection: 'i2c',
      name: 'Front LiDAR',
    });
  });

  it("the board's camera setup lists the overlays that configure a camera sensor", () => {
    expect(devkit.camera_setup).toEqual({
      model: 'SiMa.ai Modalix SoM 16Gig Board',
      overlays: ['modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo'],
    });
    expect(
      cameraSetupOf({
        model: 'Board',
        overlays: ['pcie.dtbo', 'cam.dtbo'],
        supported_sensors: [{ compatible: 'sony,imx477', overlays: ['cam.dtbo'] }],
      }),
    ).toEqual({ model: 'Board', overlays: ['cam.dtbo'] });
    expect(cameraSetupOf(null)).toBeNull();
  });

  it('rates of a stepwise range are the standard ones on its steps, else its fastest', () => {
    const intervals = (interval: object) => ({
      ...devkitCatalog,
      devices: [
        {
          ...devkitCatalog.devices[1],
          modes: [
            {
              format: 'YUYV',
              width: 640,
              height: 480,
              available: false,
              frame_intervals: [{ width: 640, height: 480, intervals: [interval] }],
            },
          ],
        },
      ],
    });
    const ratesOf = (interval: object) =>
      (
        snapshotOf(BOARD, scanOf(intervals(interval))).items[0] as CameraItem
      ).formats[0].sizes[0].fps.map((f) => f.value);
    // 1/30 s to 1/5 s in steps of 1/30 s: 30, 15 and 10 fit, 25 and 20 do not.
    expect(
      ratesOf({
        type: 'stepwise',
        minimum: { numerator: 1, denominator: 30 },
        maximum: { numerator: 1, denominator: 5 },
        step: { numerator: 1, denominator: 30 },
      }),
    ).toEqual([30, 15, 10, 5]);
    // A continuous range fixed at 24 fps holds no standard rate: its fastest is offered.
    expect(
      ratesOf({
        type: 'continuous',
        minimum: { numerator: 1, denominator: 24 },
        maximum: { numerator: 1, denominator: 24 },
      }),
    ).toEqual([24]);
  });

  it('a rate is whole when it is, else to a thousandth, and never 0', () => {
    expect(fpsValue(30)).toBe(30);
    expect(fpsValue(30000 / 1001)).toBe(29.97);
    expect(fpsValue(7.5)).toBe(7.5);
    expect(fpsValue(1 / 3000)).toBe(0.000333333);
  });
});
