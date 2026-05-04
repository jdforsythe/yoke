import { defineConfig, devices } from '@playwright/test';

/**
 * Standalone Playwright config for capture/dashboard.spec.ts.
 *
 * Each test starts its own yoke instance (see beforeAll) so the suite has
 * no webServer here. Headless by default; set HEADED=1 to debug visually.
 */
export default defineConfig({
  testDir: '.',
  testMatch: ['dashboard.spec.ts'],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 800 },
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
