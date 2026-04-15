import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for Yoke dashboard e2e smoke tests.
 *
 * Tests run against the production build served by `vite preview`.
 * All network calls (WebSocket + REST API) are mocked at the browser level
 * via page.routeWebSocket() and page.route() — no real backend required.
 *
 * Build the app first: `pnpm build` (or ensure dist/web is up to date).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 15_000,
  expect: { timeout: 8_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'vite preview --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
