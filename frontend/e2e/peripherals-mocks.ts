import { Page, Request } from '@playwright/test';
import type { BoardList, MicTest, Peripherals } from '../src/app/api.generated';
import { boardUrl } from '../src/app/board/api';
import type { CameraItem, PreviewMode } from '../src/app/peripherals/api';
import { C270, IMX477, scanAnswer, YETI } from '../src/app/peripherals/scans.testing';
import { TOP_BAR_BOARD, TOP_BAR_BOARD_ID } from './top-bar';

// The answers of the boards, peripherals, preview and microphone-test routes for the Peripherals
// e2e: the server's shapes, with the devices of a DevKit's scan as the server answers them
// (`scans.testing.ts`, which the page's unit spec shares).

/** The path of a route of the DevKit's, as the page asks for it. */
export const devkitPath = (path: string): string => boardUrl(TOP_BAR_BOARD_ID, path);

/** The SDK-paired DevKit of every test (`TOP_BAR_BOARD`), checked and connected. */
const CONNECTED_BOARD: BoardList = {
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

const DEVICES = [IMX477, C270, YETI];

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

/** A POST the page sent: its path with query, and its JSON body. */
interface Sent {
  path: string;
  body: unknown;
}

/**
 * Insight's server for the boards and Peripherals, held in memory: it answers as the server would
 * and records what the page sends. A test sets the fields before (or while) the page asks.
 */
export class FakePeripheralsBackend {
  /** What `GET /api/boards` answers. */
  board: BoardList = CONNECTED_BOARD;
  /** Set while a refresh is held open (`holdScans`): the refresh answers once it resolves. */
  private held: Promise<void> | null = null;

  /** Every POST, in order. */
  private readonly sent: Sent[] = [];
  /** What `GET .../peripherals` answers: no scan until a refresh. */
  private scan: Peripherals = { scan: null };
  private preview: Preview | null = null;
  private viewer = false;
  private previews = 0;
  private test: MicTest | null = null;
  private tests = 0;

  /** The bodies POSTed to `path` (with its query, if any). */
  posted(path: string): unknown[] {
    return this.sent.filter((request) => request.path === path).map((request) => request.body);
  }

  /** The paths POSTed, in order: what the page asked the board to do. */
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
   * Answers the boards, and the scan, the preview and the microphone test of the selected board,
   * and the Streaming page's slots (empty), where the flows leave Peripherals to.
   */
  async install(page: Page): Promise<void> {
    const record = (request: Request) => {
      const url = new URL(request.url());
      this.sent.push({
        path: url.pathname + url.search,
        body: request.postDataJSON(),
      });
    };
    /** The route's path after `/api/boards/<id>`, when it names the selected board. */
    const routeOf = (url: URL): string | null => {
      const prefix = `/api/boards/${encodeURIComponent(this.board.selected?.id ?? '')}`;
      return url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : null;
    };
    const on = (path: string | RegExp) => (url: URL) => {
      const rest = routeOf(url);
      return rest !== null && (typeof path === 'string' ? rest === path : path.test(rest));
    };

    await page.route(
      (url) => url.pathname === '/api/boards',
      (route) => route.fulfill({ json: this.board }),
    );
    await page.route(on('/peripherals'), (route) => route.fulfill({ json: this.scan }));
    await page.route(on('/peripherals/refresh'), async (route) => {
      record(route.request());
      await this.held;
      this.scan = scanAnswer(DEVICES, { scanned_at: new Date().toISOString() });
      return route.fulfill({ json: this.scan });
    });
    await page.route(on('/cameras/preview'), (route) =>
      route.fulfill({
        json: { preview: this.preview && { ...this.preview, viewer: this.viewer } },
      }),
    );
    await page.route(on(/^\/cameras\/[^/]+\/preview$/), (route) => {
      record(route.request());
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!);
      const camera = [IMX477, C270].find((item) => item.id === id)!;
      this.preview = this.newPreview(camera, route.request().postDataJSON());
      this.viewer = false;
      return route.fulfill({ json: { preview: { ...this.preview, viewer: false } } });
    });
    await page.route(on(/^\/cameras\/[^/]+\/preview\.mjpg$/), (route) => {
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
