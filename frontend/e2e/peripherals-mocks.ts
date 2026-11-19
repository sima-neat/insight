import { Page, Request } from '@playwright/test';
import type { BoardList, BoardTarget, MicTest, Peripherals } from '../src/app/api.generated';
import { boardUrl } from '../src/app/board/api';
import type { CameraItem, MicrophoneItem, PreviewMode } from '../src/app/peripherals/api';
import { snapshotOf } from '../src/app/peripherals/catalog';
import { sentinelScan, type SentinelDevice } from '../src/app/peripherals/catalog.testing';
import { TOP_BAR_BOARD, TOP_BAR_BOARD_ID } from './top-bar';

// The answers of the boards, peripherals, preview and microphone-test routes for the Peripherals
// and board e2e: the server's shapes, with SiMa Sentinel's catalog as a DevKit scan reports it.

const DEVKIT: BoardTarget = TOP_BAR_BOARD.boards[0];

/** The path of a route of the DevKit's, as the page asks for it. */
export const devkitPath = (path: string): string => boardUrl(TOP_BAR_BOARD_ID, path);

/** The SDK-paired DevKit of every test (`TOP_BAR_BOARD`), checked and connected. */
export const CONNECTED_BOARD: BoardList = {
  ...TOP_BAR_BOARD,
  selected: {
    ...TOP_BAR_BOARD.selected!,
    status: { state: 'connected', checked_at: '2026-10-25T10:00:00Z' },
    identity: {
      hostname: 'modalix',
      machine: 'modalix',
      build: '2.0.0',
      host_key: 'SHA256:Gv7dpXcI1r0pVQ3nJmB4o1x0aT9WcL2yKfHq8sRzE6M',
    },
  },
};

/** The DevKit after it was reflashed: its new host key is refused until it is trusted. */
export const HOST_KEY_CHANGED_BOARD: BoardList = {
  ...TOP_BAR_BOARD,
  selected: {
    ...TOP_BAR_BOARD.selected!,
    status: {
      state: 'error',
      checked_at: '2026-10-25T10:00:00Z',
      error: {
        code: 'host_key_changed',
        message: '192.168.100.200 presented a different SSH host key than the one Insight trusts.',
        hint:
          'This is expected after the board is reflashed. If you reflashed it, trust the new key; ' +
          'otherwise check that the address still points to your board.',
      },
      host_key: {
        host: '192.168.100.200',
        expected: 'SHA256:Gv7dpXcI1r0pVQ3nJmB4o1x0aT9WcL2yKfHq8sRzE6M',
        presented: 'SHA256:b2Q9nTz4XcLw7Vh1Ry0uJ5kP8eMfA3sGdK6oIqWtYxU',
      },
    },
    identity: null,
  },
};

/** The DevKit before anything checked it: what Insight starts from on a fresh selection. */
export const UNCHECKED_BOARD: BoardList = {
  ...TOP_BAR_BOARD,
  selected: { ...TOP_BAR_BOARD.selected!, status: { state: 'unknown' }, identity: null },
};

/** A refusal when the board does not answer (502 `unreachable`). */
export const BOARD_UNREACHABLE = {
  status: 502,
  body: {
    error: {
      code: 'unreachable',
      message: 'Could not connect to sima@192.168.100.200: no route to host.',
      hint:
        'Check that the board is powered on and on the network, and that ' +
        '`ssh sima@192.168.100.200` works from this machine.',
    },
  },
};

/** Discrete frame intervals of one size, one per rate. */
const intervals = (width: number, height: number, fps: number) => [
  { width, height, intervals: [{ type: 'discrete', numerator: 1, denominator: fps }] },
];

const USB_REASON = 'USB cameras have no camera overlay on this board.';

/** The DevKit's IMX477, as Sentinel lists it: NV12 1920×1080 at 30 fps and 1280×720 at 60. */
const SENTINEL_IMX477: SentinelDevice = {
  id: 'camera:imx477 5-001a',
  type: 'camera',
  backend: 'mipi',
  camera_name: 'imx477 5-001a',
  model: 'imx477',
  media_device: '/dev/media0',
  max_fps: 66.18,
  // SiMa Sentinel never opens a camera, so a camera's availability is always unknown.
  availability: { state: 'unknown' },
  modes: [
    {
      format: 'NV12',
      width: 1920,
      height: 1080,
      available: true,
      frame_intervals: intervals(1920, 1080, 30),
    },
    {
      format: 'NV12',
      width: 1280,
      height: 720,
      available: true,
      frame_intervals: intervals(1280, 720, 60),
    },
  ],
};

/** A Logitech C270 on USB: MJPG 1280×720 at 30 fps, Unsupported by Sentinel yet previewable. */
const SENTINEL_C270: SentinelDevice = {
  id: 'camera:v4l2:5a1c0e2f9b7d4c31',
  type: 'camera',
  backend: 'v4l2',
  model: 'HD Webcam C270',
  device_path: '/dev/video0',
  by_id_path: '/dev/v4l/by-id/usb-046d_0825_2F6D4A10-video-index0',
  identity: { vendor_id: '046d', product_id: '0825', speed: '480', topology: 'usb1/1-1/1-1.2' },
  availability: { state: 'unknown' },
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
  ],
};

/** A Blue Yeti Nano on its own USB port. */
const SENTINEL_YETI: SentinelDevice = {
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
    usb: { vendor_id: 'b58e', product_id: '0005', product: 'Yeti Nano', bus_path: '1-3.1' },
  },
  modes: [{ format: 'S24_3LE', channels: 2, sample_bits: 24, rates_hz: [32000, 44100, 48000] }],
};

const DEVICES = [SENTINEL_IMX477, SENTINEL_C270, SENTINEL_YETI];

/** The scanned devices, as the page builds them from the catalog. */
export const [IMX477, C270, YETI] = snapshotOf(
  { id: DEVKIT.id, label: DEVKIT.label },
  sentinelScan(DEVICES),
).items as [CameraItem, CameraItem, MicrophoneItem];

/** A preview as the server answers it. */
interface Preview {
  id: string;
  camera: string;
  mode: PreviewMode;
  started_at: string;
  camera_fps: number | null;
}

/** A recording of the Yeti, `elapsedMs` in. */
function recordingTest(id: string, elapsedMs: number): MicTest {
  return {
    id,
    microphone: YETI.id,
    state: 'recording',
    device: 'plughw:CARD=Nano,DEV=0',
    format: { rate: 48000, channels: 2, bits: 16, seconds: 30 },
    elapsed_ms: elapsedMs,
    level_dbfs: -18,
  };
}

/** The same test once stopped: its levels, and no live level. */
function readyTest(id: string, elapsedMs: number): MicTest {
  const { microphone, device, format } = recordingTest(id, elapsedMs);
  return {
    id,
    microphone,
    state: 'ready',
    device,
    format,
    elapsed_ms: elapsedMs,
    level: { peak_dbfs: -9, rms_dbfs: -24.5, silent: false },
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

/** A 1×1 PNG: the preview stream's stand-in, which an `<img>` loads as it would the MJPEG. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** A request the page sent that changes something: its method, path with query, and JSON body. */
interface Sent {
  method: string;
  path: string;
  body: unknown;
}

/** The error shape the server answers with. */
const failure = (code: string, message: string, hint: string) => ({
  error: { code, message, hint },
});

/**
 * Insight's server for the boards and Peripherals, held in memory: it answers as the server would
 * and records what the page sends. A test sets the fields before (or while) the page asks.
 */
export class FakePeripheralsBackend {
  /** What `GET /api/boards` answers; a 500 while `boardFails` is set. */
  board: BoardList = CONNECTED_BOARD;
  boardFails = false;
  /** The connection check (`POST .../check`) fails: the board's status records the error. */
  checkFails = false;
  /** A refresh answers this board error (with its status) instead of a scan. */
  scanFailure: { status: number; body: object } | null = null;
  /** The preview's stream answers 409 `preview_active`: another tab claimed it first. */
  streamTaken = false;
  /** Set while a refresh is held open (`holdScans`): the refresh answers once it resolves. */
  private held: Promise<void> | null = null;

  /** Every POST and DELETE, in order. */
  private readonly sent: Sent[] = [];
  /** What `GET .../peripherals` answers: no scan until a refresh succeeds. */
  private scan: Peripherals = { scan: null };
  private preview: Preview | null = null;
  private viewer = false;
  private previews = 0;
  private test: MicTest | null = null;
  private tests = 0;

  /** The bodies POSTed to `path` (with its query, if any). */
  posted(path: string): unknown[] {
    return this.sent
      .filter((request) => request.method === 'POST' && request.path === path)
      .map((request) => request.body);
  }

  /** The paths POSTed or DELETEd, in order: what the page asked the board to do. */
  postedPaths(): string[] {
    return this.sent.map((request) => request.path);
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
   * of the API (which may preview a USB camera's MJPG, as the server allows). `viewing`: that tab
   * shows its stream.
   */
  startElsewhere(camera: CameraItem, mode: PreviewMode, viewing: boolean): void {
    this.preview = this.newPreview(camera, mode);
    this.viewer = viewing;
  }

  /**
   * Answers every route of the boards, the scan, the preview and the microphone test, and the
   * Streaming page's slots (empty), where the flows leave Peripherals to.
   */
  async install(page: Page): Promise<void> {
    const record = (request: Request) => {
      const url = new URL(request.url());
      this.sent.push({
        method: request.method(),
        path: url.pathname + url.search,
        body: request.postDataJSON(),
      });
    };
    const selectedId = () => this.board.selected?.id ?? '';
    /** The board id a board route names; null for another route. */
    const boardOf = (url: URL): string | null => {
      const match = /^\/api\/boards\/([^/]+)(\/.*)?$/.exec(url.pathname);
      return match ? decodeURIComponent(match[1]) : null;
    };
    /** The route's path after `/api/boards/<id>`, when it names the selected board. */
    const routeOf = (url: URL): string | null =>
      boardOf(url) === selectedId()
        ? url.pathname.slice(`/api/boards/${encodeURIComponent(selectedId())}`.length)
        : null;

    await page.route(
      (url) => url.pathname === '/api/boards',
      (route) => {
        const request = route.request();
        if (request.method() === 'POST') {
          record(request);
          const { host, port, user } = request.postDataJSON();
          const target: BoardTarget = {
            id: `ssh:${user}@${host}:${port}`,
            mode: 'ssh',
            source: 'manual',
            host,
            port,
            user,
            label: `${user}@${host}${port === 22 ? '' : `:${port}`}`,
          };
          this.board = this.select(target, [target, DEVKIT]);
          return route.fulfill({ json: this.board });
        }
        return this.boardFails
          ? route.fulfill({ status: 500, contentType: 'text/html', body: 'Internal Server Error' })
          : route.fulfill({ json: this.board });
      },
    );
    // A board route naming another board than the selected one is 404, as the server answers it.
    await page.route(
      (url) => boardOf(url) !== null && routeOf(url) === null,
      (route) => {
        if (route.request().method() === 'DELETE') {
          record(route.request());
          this.board = this.select(DEVKIT, [DEVKIT]);
          return route.fulfill({ json: this.board });
        }
        return route.fulfill({
          status: 404,
          json: failure('not_found', 'This is not the selected board.', 'Read the boards again.'),
        });
      },
    );
    const on = (path: string | RegExp) => (url: URL) => {
      const rest = routeOf(url);
      return rest !== null && (typeof path === 'string' ? rest === path : path.test(rest));
    };

    await page.route(on(''), (route) => {
      // Only an entered board can be forgotten; the DevKit is selected again.
      record(route.request());
      this.board = this.select(DEVKIT, [DEVKIT]);
      return route.fulfill({ json: this.board });
    });
    await page.route(on('/check'), (route) => {
      record(route.request());
      const selected = this.board.selected!;
      if (this.checkFails) {
        // The server records the failure, so the next read says it.
        this.board = {
          ...this.board,
          selected: {
            ...selected,
            status: {
              state: 'error',
              checked_at: new Date().toISOString(),
              error: BOARD_UNREACHABLE.body.error,
            },
          },
        };
        return route.fulfill({ status: BOARD_UNREACHABLE.status, json: BOARD_UNREACHABLE.body });
      }
      this.board = {
        ...this.board,
        selected: {
          ...selected,
          status: CONNECTED_BOARD.selected!.status,
          identity: CONNECTED_BOARD.selected!.identity,
        },
      };
      return route.fulfill({ json: this.board });
    });
    await page.route(on('/trust-host-key'), (route) => {
      record(route.request());
      // The board is replaced, its key trusted: check it again.
      this.board = {
        ...this.board,
        selected: { ...this.board.selected!, status: { state: 'unknown' }, identity: null },
      };
      return route.fulfill({ json: this.board });
    });
    await page.route(on('/peripherals'), (route) => route.fulfill({ json: this.scan }));
    await page.route(on('/peripherals/refresh'), async (route) => {
      record(route.request());
      await this.held;
      if (this.scanFailure) {
        return route.fulfill({ status: this.scanFailure.status, json: this.scanFailure.body });
      }
      this.scan = sentinelScan(DEVICES, { scannedAt: new Date().toISOString() });
      return route.fulfill({ json: this.scan });
    });
    await page.route(on('/cameras/preview'), (route) =>
      route.fulfill({
        json: { preview: this.preview && { ...this.preview, viewer: this.viewer } },
      }),
    );
    await page.route(on(/^\/cameras\/[^/]+\/preview$/), (route) => {
      record(route.request());
      // One preview per board: a start while one runs is refused.
      if (this.preview) {
        return route.fulfill({
          status: 409,
          json: failure(
            'preview_active',
            `A preview of ${this.preview.camera} is already running.`,
            'Stop that preview before starting another.',
          ),
        });
      }
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!);
      const camera = [IMX477, C270].find((item) => item.id === id)!;
      this.preview = this.newPreview(camera, route.request().postDataJSON());
      this.viewer = false;
      return route.fulfill({ json: { preview: { ...this.preview, viewer: false } } });
    });
    await page.route(on(/^\/cameras\/[^/]+\/preview\.mjpg$/), (route) => {
      if (this.streamTaken) {
        this.viewer = true;
        return route.fulfill({
          status: 409,
          json: failure(
            'preview_active',
            'This preview is shown in another tab or window.',
            'Close the other view, or stop the preview and start it again here.',
          ),
        });
      }
      this.viewer = true;
      return route.fulfill({ contentType: 'image/png', body: PIXEL });
    });
    await page.route(on(/^\/cameras\/[^/]+\/preview\/stop$/), (route) => {
      record(route.request());
      this.preview = null;
      this.viewer = false;
      return route.fulfill({ json: { preview: null } });
    });
    await page.route(on('/microphones/test'), (route) => {
      // Each read finds the recording a little further on, as arecord's would be.
      if (this.test?.state === 'recording') {
        this.test = recordingTest(this.test.id, this.test.elapsed_ms + 300);
      }
      return route.fulfill({ json: { test: this.test } });
    });
    await page.route(on(/^\/microphones\/[^/]+\/test$/), (route) => {
      record(route.request());
      this.test = recordingTest(`t${++this.tests}`, 0);
      return route.fulfill({ status: 202, json: { test: this.test } });
    });
    await page.route(on(/^\/microphones\/[^/]+\/test\/stop$/), (route) => {
      record(route.request());
      if (this.test?.state === 'recording') {
        this.test = readyTest(this.test.id, this.test.elapsed_ms);
      }
      return route.fulfill({ json: { test: this.test } });
    });
    await page.route(on(/^\/microphones\/[^/]+\/test\.wav$/), (route) =>
      route.fulfill({ contentType: 'audio/wav', body: SILENT_WAV }),
    );
    await page.route(
      (url) => url.pathname === '/api/slots',
      (route) => route.fulfill({ json: { count: 48, slots: [] } }),
    );
  }

  /** `target` selected among `boards`, not checked yet, as a new selection is. */
  private select(target: BoardTarget, boards: BoardTarget[]): BoardList {
    return {
      boards,
      selected: {
        id: target.id,
        label: target.label,
        status: { state: 'unknown' },
        identity: null,
        ssh: `ssh ${target.port === 22 ? '' : `-p ${target.port} `}${target.user}@${target.host}`,
      },
    };
  }

  private newPreview(camera: CameraItem, mode: PreviewMode): Preview {
    return {
      id: `p${++this.previews}`,
      camera: camera.id,
      mode,
      started_at: new Date().toISOString(),
      // A USB camera runs at its mode's rate; a MIPI camera's arrives later from SiMa Sentinel.
      camera_fps: camera.connection === 'usb' ? mode.fps : null,
    };
  }
}
