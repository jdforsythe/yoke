/**
 * Real-backend Playwright spec for r2-03 sidebar live status.
 *
 * AC-1: The sidebar status chip updates to reflect a workflow status change
 *       via workflow.index.update without a page reload.
 * AC-4: The unreadEvents badge appears when pending_attention rows are inserted
 *       and the index update frame is broadcast.
 *
 * Uses the realBackend fixture (real Fastify + real SQLite).
 * backend.scheduleIndexUpdate() triggers the 500 ms debounced broadcast, giving
 * the frontend a real workflow.index.update frame over the WebSocket.
 */

import { test, expect } from '../fixtures/realBackend.js';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'stage-1', run: 'once', phases: ['implement'] }],
});

test.describe('sidebar live status — real backend', () => {
  test('AC-1: status chip updates from in_progress to completed without page reload', async ({
    page,
    backend,
  }) => {
    const wfId = 'wf-sidebar-live-001';
    const wfName = 'Sidebar Live Status Test';
    const now = new Date().toISOString();

    backend.db.writer
      .prepare(
        `INSERT INTO workflows
           (id, name, spec, pipeline, config, status, created_at, updated_at)
         VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?)`,
      )
      .run(wfId, wfName, PIPELINE, now, now);

    await page.goto('/');

    // Sidebar row is visible with the workflow name.
    const row = page.getByRole('listitem').filter({ hasText: wfName });
    await expect(row).toBeVisible({ timeout: 6000 });

    // Initial chip shows 'in_progress'.
    await expect(row.getByText('in_progress')).toBeVisible({ timeout: 3000 });

    // Update DB to 'completed' and trigger the debounced broadcast.
    backend.db.writer
      .prepare(`UPDATE workflows SET status = 'completed', updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), wfId);

    backend.scheduleIndexUpdate(wfId);

    // Chip must update to 'completed' without a page reload (500 ms debounce + WS latency).
    await expect(row.getByText('completed')).toBeVisible({ timeout: 3000 });
    // 'in_progress' must no longer be visible in the row.
    await expect(row.getByText('in_progress')).not.toBeVisible({ timeout: 1000 });
  });

  test('AC-4: unreadEvents badge appears when pending_attention row is inserted and index update fires', async ({
    page,
    backend,
  }) => {
    const wfId = 'wf-sidebar-badge-001';
    const wfName = 'Sidebar Badge Test';
    const now = new Date().toISOString();

    backend.db.writer
      .prepare(
        `INSERT INTO workflows
           (id, name, spec, pipeline, config, status, created_at, updated_at)
         VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?)`,
      )
      .run(wfId, wfName, PIPELINE, now, now);

    await page.goto('/');

    const row = page.getByRole('listitem').filter({ hasText: wfName });
    await expect(row).toBeVisible({ timeout: 6000 });

    // No unread badge initially.
    await expect(row.getByLabel(/unread events/)).not.toBeVisible({ timeout: 1000 });

    // Insert a pending_attention row and trigger the index update.
    backend.db.writer
      .prepare(
        `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
         VALUES (?, 'awaiting_user_retry', '{}', ?)`,
      )
      .run(wfId, now);

    backend.scheduleIndexUpdate(wfId);

    // Badge must appear showing at least 1 unread event.
    await expect(row.getByLabel(/unread events/)).toBeVisible({ timeout: 3000 });
    await expect(row.getByLabel('1 unread events')).toBeVisible({ timeout: 1000 });
  });
});
