import { Page } from '@playwright/test';
// Types only, erased at run time: the answers are checked against the shapes the app reads.
import type { BoardState } from '../src/app/board/api';
import type { HostMetrics } from '../src/app/system-info/api';

/**
 * What `GET /api/board` answers in every test: the SDK-paired DevKit, not checked yet. "Not
 * checked" is the widest chip a board with a target shows, so the layout checks see the pill at
 * its usual widest.
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
  status: { state: 'unknown', checked_at: null, error: null },
  board: null,
};

/** A board whose name runs far past the pill's label cap: a long host name, entered by hand. */
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
 * Answers the top bar's own requests, made on every page: the board for the pill, and the System
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

/** The Streaming and Media pages' slots (`GET /api/mediasrc`): `count` stopped slots, none in use. */
export function slotRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    file: '',
    state: 'stopped',
    transport: '',
    codec: 'unknown',
    type: 'file',
    allowed_transports: [],
    urls: {},
    readers: [],
  }));
}

/** Answers the slots with `count` stopped ones; call it before the page loads. */
export const answerSlots = (page: Page, count: number) =>
  page.route(
    (url) => url.pathname === '/api/mediasrc',
    (route) => route.fulfill({ json: slotRows(count) }),
  );

/**
 * Answers what the Viewer asks for on load: a 16-channel limit, no live ingest, and no stream to
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
    (url) => url.pathname === '/api/ingest/stats',
    (route) =>
      route.fulfill({
        json: { time: '2026-10-22T12:00:00Z', active_ttl_ms: 3000, channels: [] },
      }),
  );
  await page.route(
    (url) => url.pathname === '/api/vf/offer',
    (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'No stream' }),
  );
}
