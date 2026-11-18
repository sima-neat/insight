import { Page } from '@playwright/test';
// Types only, erased at run time: the answers are checked against the shapes the app reads.
import type { MediaEntry, Slot, SlotList } from '../src/app/api.generated';
import type { BoardState } from '../src/app/board/api';
import type { HostMetrics } from '../src/app/system-info/api';

/**
 * What `GET /api/board` answers in every test: the SDK-paired DevKit, already checked. A board
 * whose state is unknown is checked as the app loads (`BoardService`), so a test that wants no
 * `POST /api/board/test` starts from a checked one.
 */
export const TOP_BAR_BOARD: BoardState = {
  target: {
    mode: 'ssh',
    source: 'sdk-env',
    host: '192.168.100.200',
    port: 22,
    user: 'sima',
    label: 'sima@192.168.100.200',
  },
  saved: null,
  defaults: {
    on_board: false,
    sdk_env: { host: '192.168.100.200', port: 22, user: 'sima' },
  },
  generation: 1,
  status: { state: 'connected', checked_at: '2026-10-25T10:00:00Z', error: null },
  board: null,
};

/** A board whose host name is far longer than the rail can show: entered by hand. */
export const LONG_HOST = 'devkit-lab-bench-07.vision.corp.example.com';
export const LONG_BOARD: BoardState = {
  ...TOP_BAR_BOARD,
  target: {
    mode: 'ssh',
    source: 'manual',
    host: LONG_HOST,
    port: 22,
    user: 'sima',
    label: `sima@${LONG_HOST}`,
  },
  saved: { host: LONG_HOST, port: 22, user: 'sima' },
};

/**
 * What `GET /api/sysinfo` answers without the `neat` command (`_missing_neat_sysinfo_payload`,
 * enriched from the SDK's port map), so that no test depends on the machine running it.
 */
const SYSINFO = {
  schema: 'sima.neat.status.v1',
  components: {},
  environment: {
    label: null,
    mode: null,
    sdkVersion: null,
    devkitBuildVersion: null,
    sysroot: null,
  },
  exposedPorts: [{ name: 'mainUI', protocol: 'tcp', hostPortStart: 9900, hostPortEnd: 9900 }],
  insight: { serviceState: null, venv: null, webUiUrl: 'https://127.0.0.1:9900' },
  updateCheck: { offline: null, status: null },
  missing: ['neat'],
};

/** What `GET /api/metrics` answers, for System Info's "This computer": a local machine, with no temperature. */
const HOST_METRICS: HostMetrics = {
  cpu_load: 34,
  memory: { total: 16 * 1024 ** 3, used: 8 * 1024 ** 3, percent: 52 },
  disk: { mount: '/home/sima', total: 200 * 1024 ** 3, used: 120 * 1024 ** 3, percent: 61 },
  temperature_celsius_avg: null,
  REMOTE: false,
};

/**
 * Answers the top bar's own requests, made on every page: the board for the rail's board block, and the System
 * Info (its `neat` data and the readings of "This computer"). Whatever serves the app (the dev
 * server has no API) then cannot change what the top bar shows, nor leave a failed request in a
 * test that is about something else. Call it before the page loads; a test's own route for the
 * same URL, added later, takes precedence.
 */
export async function answerTopBar(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/board',
    (route) => route.fulfill({ json: TOP_BAR_BOARD }),
  );
  await page.route(
    (url) => url.pathname === '/api/sysinfo',
    (route) => route.fulfill({ json: SYSINFO }),
  );
  await page.route(
    (url) => url.pathname === '/api/metrics',
    (route) => route.fulfill({ json: HOST_METRICS }),
  );
}

/** The Streaming and Media pages' slots (`GET /api/slots`): `count` idle slots, none in use. */
export function slotRows(count: number): Slot[] {
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
  count,
  channels: Array.from({ length: count }, (_, channel) => ({
    channel,
    viewers: 0,
    errors: [],
    video: {
      port: 9000 + channel,
      active: false,
      payload_type: 0,
      unsupported_packets: 0,
      packets: 0,
      bits_per_second: 0,
      frames_per_second: 0,
      keyframes: 0,
    },
    metadata: {
      port: 9100 + channel,
      active: false,
      received: 0,
      messages_per_second: 0,
      matched: 0,
      unmatched: 0,
      invalid: 0,
      no_viewer: 0,
    },
  })),
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
