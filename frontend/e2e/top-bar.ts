import { Page } from '@playwright/test';

/**
 * What `GET /api/board` answers in every test: the SDK-paired DevKit, not checked yet. "Not
 * checked" is the widest chip a board with a target shows, so the layout checks see the pill at
 * its usual widest.
 */
export const TOP_BAR_BOARD = {
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

/**
 * Answers the top bar's own requests, made on every page: the board for the pill, and the System
 * Info. Whatever serves the app (the dev server has no API) then cannot change what the top bar
 * shows, nor leave a failed request in a test that is about something else. Call it before the
 * page loads; a test's own route for the same URL, added later, takes precedence.
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
}
