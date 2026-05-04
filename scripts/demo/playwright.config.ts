import { defineConfig, devices } from '@playwright/test';

/**
 * Standalone Playwright config for scripts/demo/capture.spec.ts.
 *
 * The seeded DB lives at $YOKE_DEMO_DIR (set by `make demo-shots`).
 * The spec spawns its own yoke instance against that dir; no webServer here.
 */
export default defineConfig({
  testDir: '.',
  testMatch: ['capture.spec.ts'],
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
