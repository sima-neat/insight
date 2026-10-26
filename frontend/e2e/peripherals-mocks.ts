import { Page, Request } from '@playwright/test';
// Types only, erased at run time: the mocks are checked against the shapes the app reads.
import type { BoardState, ShellInfo } from '../src/app/board/api';
import type {
  CameraItem,
  CameraModeChoice,
  DeviceAvailability,
  MicrophoneItem,
  MicTestStatus,
  PeripheralSnapshot,
  PreviewSession,
} from '../src/app/peripherals/api';
import { TOP_BAR_BOARD } from './top-bar';

// The answers of the board, peripherals, preview and microphone-test endpoints for the
// Peripherals and board e2e, in the shapes of Inv-PB §4 (the items are a real DevKit scan's, as
// in the unit tests' fixtures).

/** The SDK-paired DevKit of every test (`TOP_BAR_BOARD`), checked and connected. */
export const CONNECTED_BOARD: BoardState = {
  ...TOP_BAR_BOARD,
  status: { state: 'connected', checked_at: '2026-10-25T10:00:00Z', error: null },
  board: {
    hostname: 'modalix',
    machine: 'aarch64',
    build_version: '2.0.0',
    fingerprint: '3f9a0c2b7d1e4f68',
  },
};

/** The DevKit after it was reflashed: its new host key is refused until it is trusted. */
export const HOST_KEY_CHANGED_BOARD: BoardState = {
  ...CONNECTED_BOARD,
  status: {
    state: 'error',
    checked_at: '2026-10-25T10:00:00Z',
    error: {
      error: '192.168.100.200 presented a different SSH host key than the one Insight trusted.',
      code: 'host_key_changed',
      hint:
        'This is expected after the board is reflashed. If you reflashed it, trust the new key; ' +
        'otherwise check that the address still points to your board.',
      host: '192.168.100.200',
      expected_fingerprint: 'SHA256:Gv7dpXcI1r0pVQ3nJmB4o1x0aT9WcL2yKfHq8sRzE6M',
      presented_fingerprint: 'SHA256:b2Q9nTz4XcLw7Vh1Ry0uJ5kP8eMfA3sGdK6oIqWtYxU',
    },
  },
  board: null,
};

/** The DevKit before anything checked it: what Insight starts from on a fresh selection. */
export const UNCHECKED_BOARD: BoardState = {
  ...TOP_BAR_BOARD,
  status: { state: 'unknown', checked_at: null, error: null },
  board: null,
};

/** A scan's refusal when the board does not answer (502 `unreachable`, Inv-PB §4.1). */
export const BOARD_UNREACHABLE = {
  status: 502,
  body: {
    error: 'Could not connect to 192.168.100.200:22: [Errno 113] No route to host',
    code: 'unreachable',
    hint:
      'Check that the board is powered on and on the network, and that ' +
      '`ssh -p 22 sima@192.168.100.200` works from this machine.',
  },
};

const LABEL = TOP_BAR_BOARD.target!.label;
const available: DeviceAvailability = { state: 'available', users: [], reason: null };
// SiMa Sentinel never opens a camera, so a camera's availability is always unknown.
const unknown: DeviceAvailability = { state: 'unknown', users: [], reason: null };

export const IMX477: CameraItem = {
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
  availability: unknown,
  support: { tier: 'available', reason: '' },
  modes_source: 'live',
  formats: [
    {
      format: 'NV12',
      label: 'NV12 (YUV 4:2:0)',
      exportable: true,
      support: { tier: 'available', reason: '' },
      range: null,
      sizes: [
        {
          width: 1920,
          height: 1080,
          fps: [{ value: 30, framerate_num: 30, framerate_den: 1, tier: 'available' }],
        },
        {
          width: 1280,
          height: 720,
          fps: [{ value: 60, framerate_num: 60, framerate_den: 1, tier: 'available' }],
        },
      ],
    },
  ],
  default_selection: { format: 'NV12', width: 1920, height: 1080, fps: 30 },
  notes: [],
  errors: [],
};

const USB_REASON = 'USB cameras have no camera overlay on this board.';

export const C270: CameraItem = {
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
  availability: unknown,
  support: { tier: 'unsupported', reason: USB_REASON },
  modes_source: 'live',
  formats: [
    {
      format: 'MJPG',
      label: 'Motion-JPEG',
      exportable: false,
      support: { tier: 'unsupported', reason: USB_REASON },
      range: null,
      sizes: [
        {
          width: 1280,
          height: 720,
          fps: [
            {
              value: 30,
              framerate_num: 30,
              framerate_den: 1,
              tier: 'unsupported',
              reason: USB_REASON,
            },
          ],
        },
      ],
    },
  ],
  default_selection: null,
  notes: [],
  errors: [],
};

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
    by_id: '/dev/snd/by-id/usb-Blue_Microphones_Yeti_Nano_2127SG00CBA8_888-000441040606-00',
    usb: {
      vendor_id: 'b58e',
      product_id: '0005',
      manufacturer: 'Blue Microphones',
      product: 'Yeti Nano',
      serial: '2127SG00CBA8_888-000441040606',
      bus_path: '1-3.1',
    },
  },
  availability: available,
  capture: [
    {
      format: 'S24_3LE',
      channels: 2,
      bits: 24,
      rates: [32000, 44100, 48000],
      rate_range: null,
      channel_map: ['FL', 'FR'],
    },
  ],
  record: '1f0c6e2a9b3d4c5e',
  notes: [],
  errors: [],
};

/** The DevKit before any scan: what `GET /api/peripherals` answers until the first refresh. */
const UNSCANNED: PeripheralSnapshot = {
  board: {
    label: LABEL,
    source: 'sdk-env',
    hostname: null,
    machine: null,
    build_version: null,
    fingerprint: null,
  },
  generation: TOP_BAR_BOARD.generation,
  scan_id: null,
  scanned_at: null,
  items: [],
  issues: [],
  changes: null,
  camera_setup: null,
};

/** A scan of the DevKit, made `at` (now): two cameras (MIPI and USB), one microphone, no LiDAR. */
function scanned(at = new Date()): PeripheralSnapshot {
  const scannedAt = at.toISOString();
  return {
    ...UNSCANNED,
    board: { ...UNSCANNED.board, ...CONNECTED_BOARD.board! },
    scan_id: `118:${scannedAt}`,
    scanned_at: scannedAt,
    scan_ms: 3400,
    items: [IMX477, C270, YETI],
    camera_setup: {
      model: 'SiMa.ai Modalix SoM 16Gig Board',
      overlays: ['modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo'],
    },
  };
}

/** A preview session as a start answers it (`GET /api/peripherals/preview` adds `viewer`). */
function previewSession(id: string, camera: CameraItem, mode: CameraModeChoice): PreviewSession {
  return {
    id,
    camera_id: camera.id,
    mode,
    stream_url: `/api/peripherals/cameras/preview/${id}/stream`,
    generation: TOP_BAR_BOARD.generation,
    started_at: new Date().toISOString(),
    state: 'live',
    // A USB camera runs at its mode's rate; a MIPI camera's arrives later from SiMa Sentinel.
    camera_fps: camera.connection === 'usb' ? mode.fps : null,
  };
}

/** A recording of the Yeti, `elapsedMs` in, as `mictest.py`'s `status()` reports it. */
function recordingTest(token: string, elapsedMs: number): MicTestStatus {
  return {
    token,
    id: YETI.id,
    state: 'recording',
    device: 'plughw:CARD=Nano,DEV=0',
    format: { rate: 48000, channels: 2, bits: 16, seconds: 30 },
    elapsed_ms: elapsedMs,
    level_dbfs: -18,
  };
}

/** The same test once stopped: its levels, and the recording to play. */
function readyTest(token: string, elapsedMs: number): MicTestStatus {
  return {
    ...recordingTest(token, elapsedMs),
    state: 'ready',
    level_dbfs: null,
    level: { peak_dbfs: -9, rms_dbfs: -24.5, silent: false },
    audio_url: `/api/peripherals/microphones/test/${token}.wav`,
  };
}

/**
 * A 0.2 s silent WAV (8 kHz, mono, 16-bit PCM): short, so that a playback ends within the test,
 * and decodable, so that the browser plays it through to `ended`.
 */
const SILENT_WAV: Buffer = (() => {
  const rate = 8000;
  const data = Buffer.alloc(rate * 0.2 * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // the fmt chunk's size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per frame
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
})();

/** The browser shell of the SDK-paired DevKit, webssh installed: Open shell signs in by itself. */
const SHELL: ShellInfo = {
  configured: true,
  devkit_ip: '192.168.100.200',
  button_label: 'DevKit: 192.168.100.200',
  available: true,
  running: false,
  webssh_port: 8022,
  webssh_host_port: 8022,
  default_username: 'sima',
  credentials_prefilled: true,
  launch_supported: true,
  launch_url: null,
};

/** A 1×1 PNG: the preview stream's stand-in, which an `<img>` loads as it would the MJPEG. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** A POST the page sent: its path and JSON body. */
interface Posted {
  path: string;
  body: unknown;
}

/**
 * Insight's backend for the board and Peripherals, held in memory: it answers as Flask would and
 * records what the page posts. A test sets the fields before (or while) the page asks.
 */
export class FakePeripheralsBackend {
  /** What `GET /api/board` answers; a 500 while `boardFails` is set. */
  board: BoardState = CONNECTED_BOARD;
  boardFails = false;
  /** The connection check (`POST /api/board/test`) fails: the board's state records the error. */
  checkFails = false;
  /** A refresh answers this board error (with its status) instead of a scan. */
  scanFailure: { status: number; body: object } | null = null;
  /** The preview's stream answers 409 `preview_active`: another tab claimed it first. */
  streamTaken = false;
  /** Set while a refresh is held open (`holdScans`): the refresh answers once it resolves. */
  private held: Promise<void> | null = null;

  /** Every POST, in order. */
  private readonly posts: Posted[] = [];
  /** What `GET /api/peripherals` answers: no scan until a refresh succeeds. */
  private snapshot: PeripheralSnapshot = UNSCANNED;
  private preview: PreviewSession | null = null;
  private viewer = false;
  private previews = 0;
  private test: MicTestStatus | null = null;
  private tests = 0;

  /** The bodies posted to `path`. */
  posted(path: string): unknown[] {
    return this.posts.filter((post) => post.path === path).map((post) => post.body);
  }

  /** The paths posted, in order: what the page asked the board to do. */
  postedPaths(): string[] {
    return this.posts.map((post) => post.path);
  }

  /** Holds every refresh open until the returned function is called. */
  holdScans(): () => void {
    let release!: () => void;
    this.held = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.held = null;
      release();
    };
  }

  /**
   * A preview started by someone else after the page read the preview: another tab, or a client
   * of the API (which may preview a USB camera's MJPG, as the backend allows). `viewing`: that tab
   * shows its stream.
   */
  startElsewhere(camera: CameraItem, mode: CameraModeChoice, viewing: boolean): void {
    this.preview = previewSession(`p${++this.previews}`, camera, mode);
    this.viewer = viewing;
  }

  /**
   * Answers every endpoint of the board, the scan, the preview and the microphone test, and the
   * Streaming page's slots (empty), where the flows leave Peripherals to.
   */
  async install(page: Page): Promise<void> {
    const record = (request: Request) => {
      const url = new URL(request.url());
      this.posts.push({ path: url.pathname, body: request.postDataJSON() });
    };

    await page.route(
      (url) => url.pathname === '/api/board',
      (route) =>
        this.boardFails
          ? route.fulfill({ status: 500, contentType: 'text/html', body: 'Internal Server Error' })
          : route.fulfill({ json: this.board }),
    );
    // A board change starts a new generation with the connection not checked (Inv-PB §4.1).
    const changed = (next: Partial<BoardState>): BoardState => ({
      ...this.board,
      generation: this.board.generation + 1,
      status: { state: 'unknown', checked_at: null, error: null },
      board: null,
      ...next,
    });
    await page.route(
      (url) => url.pathname === '/api/board/select',
      (route) => {
        record(route.request());
        const { host, port, user } = route.request().postDataJSON();
        this.board = changed({
          target: {
            mode: 'ssh',
            source: 'manual',
            host,
            port,
            user,
            label: `${user}@${host}${port === 22 ? '' : `:${port}`}`,
          },
          saved: { host, port, user },
        });
        return route.fulfill({ json: this.board });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/board/test',
      (route) => {
        record(route.request());
        if (this.checkFails) {
          // The backend records the failure, so the next read says it.
          this.board = {
            ...this.board,
            status: { state: 'error', checked_at: new Date().toISOString(), error: null },
          };
          return route.fulfill({ status: BOARD_UNREACHABLE.status, json: BOARD_UNREACHABLE.body });
        }
        this.board = {
          ...this.board,
          status: CONNECTED_BOARD.status,
          board: CONNECTED_BOARD.board,
        };
        return route.fulfill({ json: this.board });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/board/trust-host-key',
      (route) => {
        record(route.request());
        this.board = changed({});
        return route.fulfill({ json: this.board });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/devkit-shell',
      (route) => route.fulfill({ json: SHELL }),
    );
    await page.route(
      (url) => url.pathname === '/api/peripherals',
      (route) => route.fulfill({ json: this.snapshot }),
    );
    await page.route(
      (url) => url.pathname === '/api/peripherals/refresh',
      async (route) => {
        record(route.request());
        await this.held;
        if (this.scanFailure) {
          return route.fulfill({ status: this.scanFailure.status, json: this.scanFailure.body });
        }
        this.snapshot = scanned();
        return route.fulfill({ json: this.snapshot });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/peripherals/preview',
      (route) =>
        route.fulfill({
          json: { session: this.preview && { ...this.preview, viewer: this.viewer } },
        }),
    );
    await page.route(
      (url) => url.pathname === '/api/peripherals/cameras/preview',
      (route) => {
        record(route.request());
        // One preview per Insight: a start while one runs is refused (`PreviewManager.start`).
        if (this.preview) {
          const running = this.preview.camera_id;
          return route.fulfill({
            status: 409,
            json: {
              error: `A preview of ${running} is already starting or running.`,
              code: 'preview_active',
              hint: 'Stop that preview before starting another one.',
              camera_id: running,
            },
          });
        }
        const { id, format, width, height, fps } = route.request().postDataJSON();
        const camera = [IMX477, C270].find((item) => item.id === id)!;
        this.preview = previewSession(`p${++this.previews}`, camera, {
          format,
          width,
          height,
          fps,
        });
        this.viewer = false;
        return route.fulfill({ json: { session: this.preview } });
      },
    );
    await page.route(
      (url) => /^\/api\/peripherals\/cameras\/preview\/[^/]+\/stream$/.test(url.pathname),
      (route) => {
        if (this.streamTaken) {
          this.viewer = true;
          return route.fulfill({
            status: 409,
            json: {
              error: 'This preview is already shown in another tab or window.',
              code: 'preview_active',
              hint: 'Close the other view, or stop the preview and start it again here.',
              camera_id: this.preview?.camera_id,
            },
          });
        }
        this.viewer = true;
        return route.fulfill({ contentType: 'image/png', body: PIXEL });
      },
    );
    await page.route(
      (url) => /^\/api\/peripherals\/cameras\/preview\/[^/]+\/stop$/.test(url.pathname),
      (route) => {
        record(route.request());
        const stopped = this.preview && { ...this.preview, state: 'stopped' };
        this.preview = null;
        this.viewer = false;
        return route.fulfill({ json: { session: stopped } });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/peripherals/microphones/test',
      (route) => {
        if (route.request().method() === 'POST') {
          record(route.request());
          this.test = recordingTest(`t${++this.tests}`, 0);
          return route.fulfill({ status: 202, json: { test: this.test } });
        }
        // Each read finds the recording a little further on, as arecord's would be.
        if (this.test?.state === 'recording') {
          this.test = recordingTest(this.test.token, this.test.elapsed_ms + 300);
        }
        return route.fulfill({ json: { test: this.test } });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/peripherals/microphones/test/stop',
      (route) => {
        record(route.request());
        if (this.test?.state === 'recording') {
          this.test = readyTest(this.test.token, this.test.elapsed_ms);
        }
        return route.fulfill({ json: { test: this.test } });
      },
    );
    await page.route(
      (url) => /^\/api\/peripherals\/microphones\/test\/[^/]+\.wav$/.test(url.pathname),
      (route) => route.fulfill({ contentType: 'audio/wav', body: SILENT_WAV }),
    );
    await page.route(
      (url) => url.pathname === '/api/mediasrc',
      (route) => route.fulfill({ json: [] }),
    );
  }
}
