/**
 * Playwright fixture that boots a real Yoke backend for e2e testing.
 *
 * Each test that uses `backend` gets:
 *   - Its own real Fastify server on a random OS-assigned port (port: 0)
 *   - Its own temp .yoke/ directory under os.tmpdir() — isolated, no shared state
 *   - A DbPool with the writer connection for seeding test data directly
 *   - Playwright page.route() + page.routeWebSocket() handlers that proxy
 *     all /api/** and /stream traffic to the real backend, so the vite-served
 *     frontend talks to real server logic without any mocking
 *
 * Tear-down runs in a `finally` block: stops the server, closes the pool,
 * and removes the temp directory even if the test itself throws.
 *
 * Review criteria:
 *   RC: Tear-down is in a `finally` block — runs on test failure, not just success
 *   RC: No port collisions — port:0 everywhere, OS assigns
 *   RC: Imports startServer from src/cli/start.ts (production entry point)
 *   RC: Temp dirs under os.tmpdir(), never inside the repo
 *   RC: Each test gets its own backend instance, not a shared one
 */

import { test as base } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { startServer } from '../../../cli/start.js';
import type { DbPool } from '../../../server/storage/db.js';

export interface BackendHandle {
  /** Base URL of the vite preview server (for page.goto('/')). */
  baseURL: string;
  /** Writer DbPool — use db.writer to seed rows before page.goto(). */
  db: DbPool;
}

/**
 * Minimal .yoke.yml that passes loadConfig validation.
 * noScheduler: true means prompt_template is never read at runtime,
 * so the dummy path is fine.
 */
const MINIMAL_CONFIG = `version: "1"
project:
  name: e2e-test
pipeline:
  stages:
    - id: stage-1
      run: once
      phases:
        - implement
phases:
  implement:
    command: echo
    args: []
    prompt_template: prompt.md
`;

export const test = base.extend<{ backend: BackendHandle }>({
  backend: async ({ page }, use) => {
    // Each test gets its own isolated temp directory under os.tmpdir().
    const tempDir = path.join(os.tmpdir(), `yoke-e2e-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const configPath = path.join(tempDir, '.yoke.yml');
    fs.writeFileSync(configPath, MINIMAL_CONFIG, 'utf8');

    let handle: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      handle = await startServer({
        configPath,
        port: 0,            // OS-assigned port — no collisions between parallel tests
        noScheduler: true,  // no items advance, no worktree ops, no git needed
        _gitCheck: async () => {}, // bypass git-repo guard for temp dirs
      });

      const backendUrl = handle.url; // e.g. http://127.0.0.1:54321
      const wsBackendUrl = backendUrl.replace('http:', 'ws:');

      // Proxy all REST API calls from the vite-served frontend to the real backend.
      // Registered before page.goto() so every request during navigation is caught.
      await page.route('**/api/**', async (route) => {
        const originalUrl = new URL(route.request().url());
        const proxyUrl = backendUrl + originalUrl.pathname + originalUrl.search;
        try {
          const response = await route.fetch(proxyUrl, {
            method: route.request().method(),
            headers: route.request().headers(),
            postData: route.request().postData() ?? undefined,
          });
          await route.fulfill({ response });
        } catch {
          await route.abort();
        }
      });

      // Proxy the WebSocket /stream connection to the real backend.
      // connectToServer() sets up bidirectional forwarding automatically.
      await page.routeWebSocket('**/stream', (ws) => {
        ws.connectToServer(`${wsBackendUrl}/stream`);
      });

      await use({ baseURL: 'http://localhost:4173', db: handle.db });
    } finally {
      // Always clean up — even if the test threw. Order matters:
      // close() stops the scheduler (noop here) and fastify, then closes the pool.
      if (handle) {
        await handle.close();
      }
      // Remove the temp dir and all its contents (DB file, server.json, etc.).
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
});

export { expect } from '@playwright/test';
