/**
 * Real-backend smoke tests for WebSocket connectivity.
 *
 * Verifies that the realBackend fixture correctly routes the frontend's WS
 * connection to the per-test Fastify server so WS subscribes work end-to-end.
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';

function seedWfAndItem(db: BackendHandle['db'], id: string, name: string): void {
  const now = new Date().toISOString();
  const pipeline = JSON.stringify({ stages: [{ id: 'test-stage', run: 'once', phases: ['implement'] }] });
  db.writer.prepare(
    `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, '{}', pipeline, '{}', 'pending', now, now);
  db.writer.prepare(
    `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`item-${id}`, id, 'test-stage', '{}', 'pending', now);
}

test('WS connection establishes after navigation to root', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Connected')).toBeVisible({ timeout: 5000 });
});

test('seeded workflow appears in sidebar and WS subscription succeeds', async ({ page, backend }) => {
  seedWfAndItem(backend.db, 'wf-diag-002', 'Diagnostic Workflow 2');

  // Must attach websocket listener before page.goto so the existing connection is captured.
  const messages: Array<{ type: string }> = [];
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      if (typeof frame.payload === 'string') {
        const data = JSON.parse(frame.payload) as { type: string };
        messages.push({ type: data.type });
      }
    });
  });

  await page.goto('/');
  await expect(page.getByText('Connected')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('aside').getByText('Diagnostic Workflow 2')).toBeVisible();

  await page.locator('aside').getByRole('listitem').filter({ hasText: 'Diagnostic Workflow 2' }).locator('button').first().click();
  // Wait for snapshot frame from subscription
  await page.waitForTimeout(1500);

  const types = messages.map(m => m.type);
  expect(types).toContain('workflow.snapshot');
  expect(types).not.toContain('error');
});
