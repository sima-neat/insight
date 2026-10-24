import { DEVKIT } from '../board/board.testing';
import type { CameraItem } from './api';
import {
  blockedFormatSummary,
  cameraSummaryLine,
  formatOptions,
  formatRangeLabel,
  modeLabel,
  previewBlock,
  rateLabel,
  resolveSelection,
  sameSelection,
  selectionTier,
  sizeOptions,
  USB_PREVIEW_FORMATS,
} from './camera-modes';
import {
  format,
  imx477,
  imx568,
  inUse,
  ISP_SIZE,
  NO_BOARD,
  NOT_IN_OVERLAYS,
  previewSession,
  sel,
  size,
  support,
  usb,
  USB_REASON,
} from './cameras.testing';
import { tierInfo } from './devices';

// #170's mode and preview-block tests (model.test.js), ported with their values. The menus' tier
// groups became a suffix on the option's label (neat-select has no option groups), so the
// assertions on labels name it where more than one tier is offered.

describe('camera modes', () => {
  it('unsupported formats stay selectable; only a format without a size and rate is disabled', () => {
    const [nv12, rgb] = formatOptions(imx568);
    expect(nv12.disabled).toBe(false);
    expect(nv12.label).toBe('NV12 (YUV 4:2:0)');
    expect(nv12.tier).toBe('unsupported');
    expect(rgb.disabled).toBe(true);
    expect(rgb.label).toBe('RGB888');
    expect(rgb.tier).toBe('unsupported');
    expect(rgb.reason).toBe('no sizes with a frame rate were reported for it.');
    expect(formatOptions(usb).map((o) => [o.value, o.disabled, o.tier])).toEqual([
      ['MJPG', false, 'unsupported'],
      ['YUYV', false, 'unsupported'],
    ]);
    expect(formatOptions(imx477)[0].tier).toBe('available');
  });

  it('size options carry their best state', () => {
    expect(sizeOptions(imx477, 'NV12').map((o) => [o.label, o.tier])).toEqual([
      ['1920×1080', 'available'],
      ['1280×720 · Unsupported', 'unsupported'],
    ]);
    expect(sizeOptions(imx477, 'RGB888')).toEqual([]);
  });

  it('a resolution names its size only, for USB and MIPI cameras alike', () => {
    expect(sizeOptions(usb, 'MJPG').map((o) => o.label)).toEqual(['1280×720', '640×480']);
    // The rate is still chosen (highest Available, else highest) and carried in the selection, just not shown.
    const webcam: CameraItem = {
      ...usb,
      formats: [
        format('YUYV', 'YUYV 4:2:2', true, support('available'), [
          size(640, 480, [60, 'unsupported'], [30, 'available']),
          size(320, 240, [29.97, 'unsupported'], [15, 'unsupported']),
          size(160, 120, [7.5, 'unsupported']),
        ]),
      ],
    };
    expect(sizeOptions(webcam, 'YUYV').map((o) => [o.value, o.label])).toEqual([
      ['640x480', '640×480'],
      ['320x240', '320×240 · Unsupported'],
      ['160x120', '160×120 · Unsupported'],
    ]);
    expect(resolveSelection(webcam, { format: 'YUYV', width: 640, height: 480 })?.fps).toBe(30);
    for (const camera of [imx477, imx568]) {
      for (const option of sizeOptions(camera, 'NV12')) expect(option.label).not.toMatch(/fps/);
    }
  });

  it('a rate reads as a whole number within 1% of one, else as reported', () => {
    for (const [rate, label] of [
      [30, '30 fps'],
      [66.18, '66 fps'],
      [29.97, '30 fps'],
      [59.94, '60 fps'],
      [7.5, '7.5 fps'],
      [12.345, '12.35 fps'],
    ] as const) {
      expect(rateLabel(rate)).toBe(label);
    }
    for (const unknown of [null, undefined, 0, -5, NaN, Infinity])
      expect(rateLabel(unknown)).toBe('');
  });

  it('the default selection is preselected; without one an Available mode is preferred', () => {
    expect(resolveSelection(imx477, null)).toEqual(sel('NV12', 1920, 1080, 30));
    // A USB camera has no Available mode and no default; its first reported mode is shown.
    expect(resolveSelection(usb, null)).toEqual(sel('MJPG', 1280, 720, 30));
    const mixed: CameraItem = {
      ...imx477,
      default_selection: null,
      formats: [
        format('AR24', 'AR24', false, support('unsupported', ISP_SIZE), [
          size(4056, 3040, [30, 'unsupported']),
        ]),
        format('NV12', 'NV12', true, support('available'), [
          size(4056, 3040, [30, 'unsupported']),
          size(1920, 1080, [15, 'unsupported'], [30, 'available']),
        ]),
      ],
    };
    expect(resolveSelection(mixed, null)).toEqual(sel('NV12', 1920, 1080, 30));
  });

  it('a missing or non-exportable default falls back to the best exportable mode', () => {
    expect(resolveSelection(imx568, null)).toEqual(sel('NV12', 2432, 2048, 30));
    const rgbDefault = { ...imx568, default_selection: sel('RGB888', 1920, 1080, 30) };
    expect(resolveSelection(rgbDefault, null)?.format).toBe('NV12');
    expect(resolveSelection({ ...imx568, formats: [imx568.formats[1]] }, null)).toBeNull();
  });

  it('changing one level keeps the rest of the selection when it is still offered', () => {
    expect(resolveSelection(usb, { format: 'YUYV' })).toEqual(sel('YUYV', 640, 480, 30));
    expect(resolveSelection(usb, sel('YUYV', 640, 480, 30))).toEqual(sel('YUYV', 640, 480, 30));
    expect(resolveSelection(usb, sel('YUYV', 1280, 720, 30))).toEqual(sel('YUYV', 640, 480, 30));
    expect(resolveSelection(usb, { format: 'MJPG' })).toEqual(sel('MJPG', 1280, 720, 30));
    expect(resolveSelection(imx477, sel('NV12', 1280, 720, 30))).toEqual(
      sel('NV12', 1280, 720, 60),
    );
    expect(resolveSelection(imx568, sel('NV12', 1920, 1080, 59.94))).toEqual(
      sel('NV12', 1920, 1080, 59.94),
    );
  });

  it('a selection that disappears after refresh falls back instead of clearing', () => {
    const refreshed = {
      ...imx477,
      formats: [{ ...imx477.formats[0], sizes: [imx477.formats[0].sizes[0]] }],
    };
    expect(resolveSelection(refreshed, sel('NV12', 1280, 720, 60))).toEqual(
      sel('NV12', 1920, 1080, 60),
    );
    expect(resolveSelection(refreshed, sel('NV12', 1280, 720, 15))).toEqual(
      sel('NV12', 1920, 1080, 30),
    );
    expect(resolveSelection(usb, sel('H264', 1920, 1080, 30))?.format).toBe('MJPG');
  });

  it('mode labels and selection equality drive the fallback notice', () => {
    const mode = sel('NV12', 1920, 1080, 30);
    // No camera's rate is named before it runs, USB included.
    expect(modeLabel(mode)).toBe('NV12 1920×1080');
    expect(modeLabel({ ...mode, fps: 59.94 })).toBe('NV12 1920×1080');
    expect(modeLabel(null)).toBe('');
    expect(sameSelection(mode, { ...mode })).toBe(true);
    expect(sameSelection(mode, { ...mode, width: 1280, height: 720 })).toBe(false);
    expect(sameSelection(mode, { ...mode, format: 'YUYV' })).toBe(false);
    expect(sameSelection(mode, { ...mode, fps: 15 })).toBe(false);
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection(null, mode)).toBe(false);
  });

  it('blocked export formats collapse into one line', () => {
    expect(blockedFormatSummary(formatOptions(imx477))).toBe('');
    expect(blockedFormatSummary(formatOptions(imx568))).toBe('1 format cannot be used (RGB888)');
    expect(
      blockedFormatSummary([
        { value: 'A', disabled: true },
        { value: 'B', disabled: true },
        { value: 'C', disabled: false },
      ]),
    ).toBe('2 formats cannot be used (A, B)');
  });

  it('stepwise and continuous format ranges keep their bounds and steps visible', () => {
    expect(
      formatRangeLabel({
        min_width: 16,
        min_height: 16,
        max_width: 1920,
        max_height: 1080,
        step_width: 16,
        step_height: 8,
      }),
    ).toBe('16–1920×16–1080 in 16×8 steps');
    const camera = {
      ...usb,
      formats: [
        format('YUYV', 'YUYV', false, support('unsupported', USB_REASON), [], {
          min_width: 16,
          min_height: 16,
          max_width: 1920,
          max_height: 1080,
          step_width: 16,
          step_height: 16,
        }),
      ],
    };
    expect(formatOptions(camera)[0].reason).toMatch(
      /Reported range: 16–1920×16–1080 in 16×16 steps\./,
    );
  });

  it('the selected mode keeps the tier the board reported for it', () => {
    expect(selectionTier(imx477, sel('NV12', 1920, 1080, 30))).toBe('available');
    expect(selectionTier(imx477, sel('NV12', 1280, 720, 60))).toBe('unsupported');
    expect(selectionTier(usb, sel('MJPG', 1280, 720, 30))).toBe('unsupported');
    expect(selectionTier(imx477, sel('NV12', 640, 480, 30))).toBe('');
    expect(selectionTier(imx477, null)).toBe('');
  });

  it('the detail pane shows one explanation line, chosen by priority', () => {
    expect(cameraSummaryLine(imx568)).toBe(NOT_IN_OVERLAYS);
    expect(cameraSummaryLine({ ...imx477, support: support('unsupported', NO_BOARD) })).toBe(
      NO_BOARD,
    );
    // An Available camera says nothing: the mode menus carry the Available/Unsupported labels.
    expect(cameraSummaryLine(imx477)).toBe('');
    // Whether another program holds the camera is not a scan fact: Sentinel's availability is passed
    // through untouched and never becomes a sentence; a preview that cannot open the camera says so.
    expect(cameraSummaryLine(inUse)).toBe('');
    expect(cameraSummaryLine({ ...imx477, availability: imx568.availability })).toBe('');
    // A USB camera is always Unsupported, so it gets no sentence.
    expect(cameraSummaryLine(usb)).toBe('');
    expect(cameraSummaryLine({ ...imx477, support: support('unsupported') })).toBe('Unsupported.');
  });

  it('Start preview is blocked with the reason for every state that forbids it', () => {
    const block = (
      camera: CameraItem | null,
      selection: ReturnType<typeof sel> | null,
      extra: Partial<Parameters<typeof previewBlock>[0]> = {},
    ) => previewBlock({ camera, selection, target: DEVKIT, ...extra });
    const open = { blocked: false, reason: '' };
    const mipiMode = sel('NV12', 1920, 1080, 30);
    expect(block(imx477, mipiMode)).toEqual(open);

    expect(block(imx477, mipiMode, { target: null }).reason).toMatch(/No board is selected/);
    expect(block(null, null).reason).toMatch(/Select a camera/);
    expect(block(imx477, mipiMode, { stale: true }).reason).toMatch(/board changed/);
    // Codex 4264144158: a camera kept from a failed provider's last scan may be another device now.
    expect(block({ ...imx477, modes_source: 'previous-scan' }, mipiMode).reason).toMatch(
      /last successful scan/,
    );

    // A USB camera has no camera overlay, so its modes are Unsupported, and it previews any listed mode.
    expect(block(usb, sel('MJPG', 1280, 720, 30))).toEqual(open);
    expect(block(usb, null).reason).toMatch(/no mode Insight can start/);
    // A camera the scan says is in use is not blocked up front: the start reports a busy camera itself.
    expect(block({ ...usb, availability: inUse.availability }, sel('YUYV', 640, 480, 15))).toEqual(
      open,
    );

    // Only the formats the backend previews: MJPG and the raw FourCCs GStreamer converts.
    for (const fmt of ['MJPG', 'YUYV', 'GREY']) {
      expect(block(usb, sel(fmt, 640, 480, 30)).blocked, fmt).toBe(false);
    }
    const h264 = block(usb, sel('H264', 1280, 720, 30));
    expect(h264.blocked).toBe(true);
    expect(h264.reason).toMatch(/not H264\. Choose another format\.$/);
    expect(Object.isFrozen(USB_PREVIEW_FORMATS)).toBe(true);

    expect(block(imx477, null).reason).toMatch(/no mode Insight can start/);

    const unsupported = {
      ...imx477,
      formats: [
        format('NV12', 'NV12', false, support('unsupported', ISP_SIZE), [
          size(1920, 1080, [30, 'unsupported']),
        ]),
      ],
    };
    expect(block(unsupported, mipiMode).reason).toMatch(/is Unsupported on this board/);
    // The backend previews Available modes only: an Unsupported rate, or one with no state, must not leave Start enabled.
    for (const tier of ['', 'unsupported'] as const) {
      const unjudged = block(
        {
          ...imx477,
          formats: [
            format('NV12', 'NV12', true, support('available'), [size(1920, 1080, [30, tier])]),
          ],
        },
        mipiMode,
      );
      expect(unjudged.blocked, `tier ${JSON.stringify(tier)}`).toBe(true);
      expect(unjudged.reason).toMatch(/is Unsupported on this board\. Choose an Available mode\.$/);
    }

    // The scan's availability never blocks Start; a busy camera is reported by the start itself.
    expect(block({ ...inUse, modes_source: 'live' }, mipiMode)).toEqual(open);

    expect(
      block(imx477, mipiMode, { session: previewSession({ camera_id: imx568.id }) }).reason,
    ).toMatch(/already running on mipi:econ-imx568-fpga 5-0042/);
    expect(block(imx477, mipiMode, { session: previewSession() }).blocked).toBe(false);
  });

  it('an Unverified 3.0 sensor size is listed between Available and Unsupported and can be previewed', () => {
    const UNVERIFIED =
      'SiMa Sentinel cannot confirm libcamera streams this exact size; start a preview to check.';
    const camera: CameraItem = {
      ...imx477,
      formats: [
        format('NV12', 'NV12 (YUV 4:2:0)', true, support('available'), [
          size(1332, 990, [30, 'unverified']),
          size(1920, 1080, [30, 'available']),
          size(4056, 3040, [30, 'unsupported']),
        ]),
      ],
    };
    expect(sizeOptions(camera, 'NV12').map((o) => o.label)).toEqual([
      '1920×1080',
      '1332×990 · Unverified',
      '4056×3040 · Unsupported',
    ]);
    // An Available size is preferred over an Unverified one.
    expect(resolveSelection({ ...camera, default_selection: null }, null)).toEqual(
      sel('NV12', 1920, 1080, 30),
    );
    const target = DEVKIT;
    expect(previewBlock({ camera, selection: sel('NV12', 1332, 990, 30), target }).blocked).toBe(
      false,
    );
    expect(previewBlock({ camera, selection: sel('NV12', 4056, 3040, 30), target }).blocked).toBe(
      true,
    );

    const onlyUnverified: CameraItem = {
      ...camera,
      support: support('unverified', UNVERIFIED),
      default_selection: null,
      formats: [
        format('NV12', 'NV12', false, support('unverified', UNVERIFIED), [
          size(1332, 990, [30, 'unverified']),
        ]),
      ],
    };
    expect(tierInfo(onlyUnverified.support.tier)).toEqual({ label: 'Unverified', tone: 'warning' });
    expect(cameraSummaryLine(onlyUnverified)).toBe(UNVERIFIED);
    expect(
      previewBlock({ camera: onlyUnverified, selection: sel('NV12', 1332, 990, 30), target })
        .blocked,
    ).toBe(false);
  });

  it('mode options name their tier when more than one tier is offered', () => {
    // One tier: the labels are the format and the size alone, in the board's order.
    expect(formatOptions(usb).map((o) => o.label)).toEqual(['Motion-JPEG', 'YUYV 4:2:2']);
    expect(sizeOptions(imx568, 'NV12').map((o) => o.label)).toEqual(['2432×2048', '1920×1080']);

    // Several: grouped in tier order (Available, Unverified, Unsupported), the board's order within
    // each, and every label but an Available one names its tier.
    const camera: CameraItem = {
      ...imx477,
      formats: [
        format('AR24', 'AR24', false, support('unsupported', ISP_SIZE), [
          size(4056, 3040, [30, 'unsupported']),
        ]),
        format('RGB888', 'RGB888', false, support('unsupported'), []),
        format('NV12', 'NV12 (YUV 4:2:0)', true, support('available'), [
          size(4056, 3040, [30, 'unsupported']),
          size(1332, 990, [30, 'unverified']),
          size(1920, 1080, [30, 'available']),
          size(2028, 1520, [30, 'unverified']),
        ]),
      ],
    };
    expect(formatOptions(camera).map((o) => [o.value, o.label, o.disabled])).toEqual([
      ['NV12', 'NV12 (YUV 4:2:0)', false],
      ['AR24', 'AR24 · Unsupported', false],
      ['RGB888', 'RGB888 · Unsupported', true],
    ]);
    expect(sizeOptions(camera, 'NV12').map((o) => [o.value, o.label])).toEqual([
      ['1920x1080', '1920×1080'],
      ['1332x990', '1332×990 · Unverified'],
      ['2028x1520', '2028×1520 · Unverified'],
      ['4056x3040', '4056×3040 · Unsupported'],
    ]);
    // A size option carries its size, so the menu's value leads back to the mode.
    expect(sizeOptions(camera, 'NV12')[1]).toMatchObject({ width: 1332, height: 990 });
  });
});
