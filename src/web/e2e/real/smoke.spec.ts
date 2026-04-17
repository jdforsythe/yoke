/**
 * Real-backend smoke test.
 *
 * Uses the realBackend fixture to boot a real Yoke server (no mocks),
 * seeds one workflow directly into SQLite, navigates to the dashboard,
 * and asserts the workflow row is visible in the sidebar.
 *
 * This is the foundation spec — proves the end-to-end wiring (fixture →
 * real Fastify → real SQLite → frontend) before other real-backend specs
 * are written.
 */

import { test, expect } from '../fixtures/realBackend.js';

test('seeded workflow appears in sidebar', async ({ page, backend }) => {
  const now = new Date().toISOString();
  const wfId = 'wf-smoke-001';
  const wfName = 'Smoke Test Workflow';

  // Seed directly into the writer connection — no API call needed.
  backend.db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(wfId, wfName, '{}', '{}', '{}', 'pending', now, now);

  // Navigate to the dashboard. page.route() and page.routeWebSocket() handlers
  // installed by the fixture proxy all /api/** and /stream traffic to the real backend.
  await page.goto('/');

  // The WorkflowList sidebar fetches GET /api/workflows and renders a row per workflow.
  await expect(page.getByText(wfName)).toBeVisible();
});
