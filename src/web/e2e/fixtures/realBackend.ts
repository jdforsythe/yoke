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
  /** URL of the real Fastify backend (http://127.0.0.1:PORT). */
  backendUrl: string;
  /**
   * The per-test config directory (also used as homeDir for fingerprint-
   * scoped paths like the prepost output tree). Exposed so tests that seed
   * artifact files can compute the expected on-disk path via
   * makePrepostOutputDir({ configDir, workflowId, homeDir: configDir }).
   */
  configDir: string;
  /** Writer DbPool — use db.writer to seed rows before page.goto(). */
  db: DbPool;
  /**
   * Schedule a coalesced workflow.index.update broadcast (500 ms debounce).
   * Use in tests that update the DB directly and need the sidebar to reflect
   * the new status without a page reload.
   */
  scheduleIndexUpdate: (workflowId: string) => void;
  /**
   * Broadcast a server frame to all WS clients subscribed to workflowId.
   * Use in tests to inject notice frames without running the full scheduler.
   * Example: backend.broadcast(wfId, null, 'notice', { severity: 'requires_attention', ... })
   */
  broadcast(workflowId: string, sessionId: string | null, frameType: string, payload: unknown): void;
}

/**
 * Minimal template that passes loadTemplate validation.
 * noScheduler: true means prompt_template is never read at runtime,
 * so the dummy path is fine.
 */
const MINIMAL_CONFIG = `version: "1"
template:
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

    const templatesDir = path.join(tempDir, '.yoke', 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(templatesDir, 'default.yml'), MINIMAL_CONFIG, 'utf8');

    let handle: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      handle = await startServer({
        configDir: tempDir,
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
        // Drop the `host` header so the proxied request carries the backend's host,
        // not the vite server's host. Other headers (cookies, content-type, etc.) pass through.
        const { host: _host, ...forwardHeaders } = route.request().headers();
        try {
          const response = await route.fetch({
            url: proxyUrl,
            method: route.request().method(),
            headers: forwardHeaders,
            postData: route.request().postData() ?? undefined,
          });
          await route.fulfill({ response });
        } catch {
          await route.abort();
        }
      });

      // Redirect the frontend's WebSocket /stream connection to the real backend.
      // page.routeWebSocket + connectToServer doesn't reliably reach our in-process
      // Fastify server in Playwright 1.59 (the vite preview server's proxy intercepts
      // first). Instead, override the WebSocket constructor in the browser so that any
      // connection to a /stream URL goes directly to the real backend port.
      const wsTarget = `${wsBackendUrl}/stream`;
      await page.addInitScript((target: string) => {
        const OrigWS = globalThis.WebSocket;
        class OverrideWS extends OrigWS {
          constructor(url: string | URL, protocols?: string | string[]) {
            const urlStr = url.toString();
            const resolved = urlStr.includes('/stream') ? target : urlStr;
            super(resolved, protocols);
          }
        }
        globalThis.WebSocket = OverrideWS as typeof WebSocket;
      }, wsTarget);

      await use({
        baseURL: 'http://localhost:4173',
        backendUrl,
        configDir: tempDir,
        db: handle.db,
        scheduleIndexUpdate: (wfId) => handle!.scheduler.scheduleIndexUpdate(wfId),
        broadcast: (wfId, sessId, frameType, payload) =>
          handle!.broadcast(wfId, sessId, frameType, payload),
      });
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
