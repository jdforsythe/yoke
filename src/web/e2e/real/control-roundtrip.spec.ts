/**
 * Real-backend Playwright spec for test-e2e-full-suite — control round-trips.
 *
 * Covers:
 *   Cancel   — clicking Cancel → Confirm sends the WS control frame; the
 *              control executor updates item states to 'abandoned' and the
 *              workflow.update broadcast makes the UI reflect the new status.
 *   Ack-attention — clicking Acknowledge clears the banner item (optimistic)
 *              AND the pending_attention row is acknowledged in the DB.
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';
import { randomUUID } from 'node:crypto';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'stage-1', run: 'once', phases: ['implement'] }],
});

function seedWorkflow(
  db: BackendHandle['db'],
  opts: { id: string; name: string; status: string },
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', ?, ?, ?)`,
    )
    .run(opts.id, opts.name, PIPELINE, opts.status, now, now);
}

test.describe('control round-trips — real backend', () => {
  test('cancel: confirmation dialog → control executor updates DB → UI reflects abandoned', async ({
    page,
    backend,
  }) => {
    const wfId = `wf-ctrl-cancel-${randomUUID().slice(0, 8)}`;
    const sessionId = `sess-ctrl-cancel-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    seedWorkflow(backend.db, { id: wfId, name: 'Cancellable Ctrl Workflow', status: 'in_progress' });
    backend.db.writer
      .prepare(
        `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
         VALUES (?, ?, 'stage-1', '{}', 'in_progress', ?)`,
      )
      .run(`item-ctrl-cancel-${randomUUID().slice(0, 8)}`, wfId, now);
    // Active session (ended_at IS NULL) so ControlMatrix shows.
    backend.db.writer
      .prepare(
        `INSERT INTO sessions
         (id, workflow_id, item_id, stage, phase, agent_profile, started_at, status)
         VALUES (?, ?, NULL, 'stage-1', 'implement', 'default', ?, 'in_progress')`,
      )
      .run(sessionId, wfId, now);

    await page.goto(`/workflow/${wfId}`);

    // ControlMatrix appears when activeSessionId is non-null.
    const cancelBtn = page.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancelBtn).toBeVisible({ timeout: 6000 });

    // First click opens the confirmation dialog.
    await cancelBtn.click();
    const dialog = page.getByRole('dialog', { name: 'Confirm action' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Cancel this workflow? This cannot be undone.');

    // Confirm triggers the WS control frame → control executor → DB update.
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog).not.toBeVisible();

    // The control executor transitions items to 'abandoned' and broadcasts
    // workflow.update — the status chip in the header must reflect this.
    // Wait up to 5 s for the workflow.update broadcast to arrive.
    const statusChip = page.locator('h1').locator('..').getByText('abandoned');
    await expect(statusChip).toBeVisible({ timeout: 5000 });

    // DB: workflow status is 'abandoned'.
    const row = backend.db.writer
      .prepare('SELECT status FROM workflows WHERE id = ?')
      .get(wfId) as { status: string } | undefined;
    expect(row?.status).toBe('abandoned');
  });

  test('ack-attention: Acknowledge button clears banner and marks DB row acknowledged', async ({
    page,
    backend,
  }) => {
    const wfId = `wf-ctrl-ack-${randomUUID().slice(0, 8)}`;
    seedWorkflow(backend.db, { id: wfId, name: 'Attention Workflow', status: 'in_progress' });

    // Seed a pending_attention row — the snapshot query includes it.
    const res = backend.db.writer
      .prepare(
        `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
         VALUES (?, 'awaiting_user_retry', '"test attention message"', datetime('now'))`,
      )
      .run(wfId);
    const attentionId = Number(res.lastInsertRowid);

    await page.goto(`/workflow/${wfId}`);

    // The attention banner shows pending items from the workflow.snapshot payload.
    const banner = page.getByRole('region', { name: 'Attention required' });
    await expect(banner).toBeVisible({ timeout: 6000 });
    await expect(banner).toContainText('awaiting_user_retry');

    // Click Acknowledge — triggers POST /api/workflows/:id/attention/:id/ack.
    await banner.getByRole('button', { name: 'Acknowledge' }).click();

    // Optimistic removal: the banner item disappears immediately on success.
    await expect(banner.getByText('awaiting_user_retry')).not.toBeVisible({ timeout: 3000 });

    // DB: acknowledged_at IS NOT NULL — the ack was persisted.
    const attn = backend.db.writer
      .prepare('SELECT acknowledged_at FROM pending_attention WHERE id = ?')
      .get(attentionId) as { acknowledged_at: string | null } | undefined;
    expect(attn?.acknowledged_at).not.toBeNull();
  });
});
