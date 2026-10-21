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
    // A desktop-sized viewport. The Streaming Sources preview moves below the source list when the
    // list would get narrower than its rows, so no viewport puts the row buttons under the preview.
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // A fake webcam, granted without a prompt, for the Camera tab of the source dialog.
    permissions: ['camera'],
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  },
})
