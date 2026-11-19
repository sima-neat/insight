import { defineConfig, devices } from '@playwright/test';

/**
 * A deployed build (the server with the app built in, e.g. in the SDK container) is tested when
 * `INSIGHT_BASE_URL` is set; otherwise the tests start the dev server and run against it.
 */
const deployedUrl = process.env['INSIGHT_BASE_URL'];
const devServerUrl = 'http://localhost:4200';

// Even with screenshots and traces off, Playwright writes an `error-context.md` with a textual
// snapshot of the page into the artifacts of a failed test. Against a deployed build that is
// still a capture of someone's running UI. This switch stops the snapshots Playwright takes on its
// own, and `discard-artifacts.ts` removes the one a failed web-first assertion attaches to itself,
// which no setting turns off (Playwright 1.64).
if (deployedUrl) {
  process.env['PLAYWRIGHT_NO_COPY_PROMPT'] = '1';
}

export default defineConfig({
  testDir: '.',
  globalTeardown: deployedUrl ? './discard-artifacts.ts' : undefined,
  // Playwright's artifacts (traces, failure context) stay under a git-ignored path.
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: deployedUrl ?? devServerUrl,
    // A deployed build serves a certificate the test browser may not trust.
    ignoreHTTPSErrors: true,
    // A deployed build is someone's running Insight, and capturing its UI needs the owner's
    // explicit permission: record nothing there. Against the throwaway dev server a trace of a
    // failed test is what makes the failure diagnosable.
    screenshot: 'off',
    video: 'off',
    trace: deployedUrl ? 'off' : 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: deployedUrl
    ? undefined
    : {
        // The config lives in e2e/, the npm scripts in its parent.
        cwd: '..',
        command: 'npm start',
        url: devServerUrl,
        // A cold `ng serve` on a CI runner builds the whole app before it answers; the default
        // 60 s is too tight for that.
        timeout: 180_000,
        reuseExistingServer: !process.env['CI'],
      },
});
