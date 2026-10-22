import { defineConfig, devices } from '@playwright/test';

/**
 * A deployed build (Flask serving `frontend/dist`, e.g. in the SDK container) is tested when
 * `INSIGHT_BASE_URL` is set; otherwise the tests start the dev server and run against it.
 */
const deployedUrl = process.env['INSIGHT_BASE_URL'];

export default defineConfig({
  testDir: '.',
  // Playwright's artifacts (traces, screenshots) stay under a git-ignored path.
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: deployedUrl ?? 'http://localhost:4200',
    // Flask serves its self-signed HTTPS certificate on the SDK container.
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
        url: 'http://localhost:4200',
        reuseExistingServer: !process.env['CI'],
      },
});
