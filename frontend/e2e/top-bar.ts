import { Page } from '@playwright/test';
// Types only, erased at run time: the answers are checked against the shapes the app reads.
import type {
  BoardList,
  BoardTarget,
  HostReadings,
  MediaEntry,
  Slot,
  SlotList,
  SystemInfo,
} from '../src/app/api.generated';

/** The SDK-paired DevKit every test's top bar shows. */
const DEVKIT: BoardTarget = {
  id: 'ssh:sima@192.168.100.200:22',
  mode: 'ssh',
  source: 'sdk-env',
  host: '192.168.100.200',
  port: 22,
  user: 'sima',
  label: 'sima@192.168.100.200',
};

/**
 * What `GET /api/boards` answers in every test: the SDK-paired DevKit, already checked. A board
 * whose state is unknown is checked as the app loads (`BoardService`), so a test that wants no
 * `POST /api/boards/<id>/check` starts from a checked one.
 */
export const TOP_BAR_BOARD: BoardList = {
  boards: [DEVKIT],
  selected: {
    id: DEVKIT.id,
    label: DEVKIT.label,
    status: { state: 'connected', checked_at: '2026-10-25T10:00:00Z' },
    identity: null,
    ssh: 'ssh sima@192.168.100.200',
  },
};

/** The selected board's id in `TOP_BAR_BOARD`, which every board route takes. */
export const TOP_BAR_BOARD_ID = DEVKIT.id;

/** A board whose host name is far longer than the rail can show: entered by hand. */
const LONG_HOST = 'devkit-lab-bench-07.vision.corp.example.com';
const LONG_TARGET: BoardTarget = {
  id: `ssh:sima@${LONG_HOST}:22`,
  mode: 'ssh',
  source: 'manual',
  host: LONG_HOST,
  port: 22,
  user: 'sima',
  label: `sima@${LONG_HOST}`,
};
export const LONG_BOARD: BoardList = {
  boards: [LONG_TARGET, DEVKIT],
  selected: {
    ...TOP_BAR_BOARD.selected!,
    id: LONG_TARGET.id,
    label: LONG_TARGET.label,
    ssh: `ssh sima@${LONG_HOST}`,
  },
};

/**
 * What `GET /api/system` answers without the `neat` command, so that no test depends on the
 * machine running it.
 */
export const SYSTEM_INFO: SystemInfo = {
  insight: {
    version: '0.0.0-dev',
    build: { go_version: 'go1.26.0', platform: 'linux/amd64' },
    place: 'sdk',
    data_dir: '/home/sima/.local/share/neat-insight',
    port: 9900,
    web_ui_url: 'https://127.0.0.1:9900',
    network: { certificate_host: '127.0.0.1', browser_ice_address_source: 'default' },
    ports: {
      channels: 16,
      channels_source: 'default',
      webrtc_start: 9200,
      webrtc_end: 9215,
      rtsp: 8554,
      whip: 8889,
      whip_ice: 8189,
    },
  },
  neat: {
    state: 'missing',
    exposed_ports: [{ name: 'mainUI', protocol: 'tcp', hostPortStart: 9900, hostPortEnd: 9900 }],
  },
};

/** What `GET /api/system/host` answers, for System Info's "This computer". */
const HOST_READINGS: HostReadings = {
  cpu_percent: 34,
  memory: { total: 16 * 1024 ** 3, used: 8 * 1024 ** 3, percent: 52 },
  disk: { path: '/home/sima', total: 200 * 1024 ** 3, used: 120 * 1024 ** 3, percent: 61 },
};

/**
 * Answers the top bar's own requests, made on every page: the boards for the rail's board block,
 * and System Info (Insight's and `neat`'s facts and the readings of "This computer"). Whatever
 * serves the app (the dev server has no API) then cannot change what the top bar shows, nor leave
 * a failed request in a test that is about something else. Call it before the page loads; a
 * test's own route for the same URL, added later, takes precedence.
 */
export async function answerTopBar(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/boards',
    (route) => route.fulfill({ json: TOP_BAR_BOARD }),
  );
  await page.route(
    (url) => url.pathname === '/api/system',
    (route) => route.fulfill({ json: SYSTEM_INFO }),
  );
  await page.route(
    (url) => url.pathname === '/api/system/host',
    (route) => route.fulfill({ json: HOST_READINGS }),
  );
}

/** The Streaming and Media pages' slots (`GET /api/slots`): `count` idle slots, none in use. */
function slotRows(count: number): Slot[] {
  return Array.from({ length: count }, (_, i) => ({
    n: i + 1,
    kind: 'none',
    run: false,
    state: 'idle',
    readers: [],
    urls: { rtsp: `rtsp://127.0.0.1:8554/src${i + 1}` },
  }));
}

/** Answers the slots with `count` idle ones; call it before the page loads. */
export const answerSlots = (page: Page, count: number) =>
  page.route(
    (url) => url.pathname === '/api/slots',
    (route) => route.fulfill({ json: { count: 48, slots: slotRows(count) } satisfies SlotList }),
  );

/** Answers the media library (`GET /api/media`) as empty: its root folder holds nothing. */
export const answerEmptyLibrary = (page: Page) =>
  page.route(
    (url) => url.pathname === '/api/media',
    (route) =>
      route.fulfill({
        json: {
          name: '',
          path: '',
          folder: true,
          streamable: false,
          probe: null,
        } satisfies MediaEntry,
      }),
  );

/**
 * What Insight's server answers on `GET /api/channels` while nothing arrives: every one of its
 * `count` channels listed (server/api/openapi.yaml), none of them active.
 */
export const idleChannels = (count: number) => ({
  channels: Array.from({ length: count }, (_, channel) => ({ channel, video: { active: false } })),
});

/** The channel a `POST /api/channels/<n>/offer` names, or null for any other path. */
export function offeredChannel(url: URL): number | null {
  const match = /^\/api\/channels\/(\d+)\/offer$/.exec(url.pathname);
  return match === null ? null : Number(match[1]);
}

/** The server's answer to an offer while its channel has no video yet, which the Viewer retries. */
export const NO_VIDEO_YET = {
  status: 503,
  json: { error: { code: 'no_video', message: 'No video has reached this channel yet.' } },
};

/**
 * Answers what the Viewer asks for on load: a 16-channel limit, no live video, and no stream to
 * connect to (its tiles show their no-stream state). Call it before the page loads.
 */
export async function answerViewer(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/viewer-url',
    (route) =>
      route.fulfill({
        json: {
          url: 'https://127.0.0.1:9900/viewer?max_channels=16',
          max_video_channels: 16,
          channel_limit_source: 'sdk-port-map',
          sdk_channel_limited: true,
        },
      }),
  );
  await page.route(
    (url) => url.pathname === '/api/channels',
    (route) => route.fulfill({ json: idleChannels(16) }),
  );
  await page.route(
    (url) => offeredChannel(url) !== null,
    (route) => route.fulfill(NO_VIDEO_YET),
  );
}
