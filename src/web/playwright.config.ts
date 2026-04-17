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
      // Mocked suite — all specs outside e2e/real/ (no real backend required).
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/real/**'],
    },
    {
      // Real-backend suite — specs under e2e/real/ use the realBackend fixture
      // which boots a real Fastify + SQLite server per test on port 0.
      // Run independently with: pnpm test:e2e --project real-backend
      name: 'real-backend',
      use: { ...devices['Desktop Chrome'] },
      testMatch: ['**/real/**'],
    },
  ],
  webServer: {
    command: 'vite preview --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
