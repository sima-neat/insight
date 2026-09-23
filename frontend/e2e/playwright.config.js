import { defineConfig } from '@playwright/test'

// Runs against a live neat-insight over its self-signed HTTPS. INSIGHT_BASE_URL and
// INSIGHT_MEDIA_ROOT come from scripts/test-folder-navigation.sh (issue #113).
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.INSIGHT_BASE_URL || 'https://127.0.0.1:19900',
    // A desktop-sized viewport: at 1280 px the Streaming Sources rows overflow their panel and the
    // Start/Copy buttons end up under the preview panel, which intercepts clicks (seen in CI).
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
})
