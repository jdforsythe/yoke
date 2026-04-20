/**
 * Real-backend Playwright spec for r2-01 live attention broadcast.
 *
 * AC-3: Seeds a failing bootstrap scenario, injects a notice frame via the
 * server's broadcast function (simulating what Scheduler._applyTransition
 * emits when a pending_attention row is inserted), and asserts:
 *   - AttentionBanner renders with the correct kind within 2s
 *   - No page reload is needed
 *   - The banner disappears optimistically after Acknowledge is clicked
 *
 * Uses the realBackend fixture (real Fastify + real SQLite) via
 * backend.broadcast() to inject the notice frame into the WS registry.
 */

import { test, expect } from '../fixtures/realBackend.js';
import { randomUUID } from 'node:crypto';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'stage-1', run: 'once', phases: ['implement'] }],
});

test.describe('live attention broadcast — real backend', () => {
  test('notice frame with persistedAttentionId causes AttentionBanner to render within 2s without reload', async ({
    page,
    backend,
  }) => {
    const wfId = `wf-live-attn-${randomUUID().slice(0, 8)}`;
    const wfName = `Live Attention ${wfId}`;
    const now = new Date().toISOString();

    backend.db.writer
      .prepare(
        `INSERT INTO workflows
           (id, name, spec, pipeline, config, status, created_at, updated_at)
         VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?)`,
      )
      .run(wfId, wfName, PIPELINE, now, now);

    // Seed a pending_attention row to simulate what the engine inserts on bootstrap_fail.
    const res = backend.db.writer
      .prepare(
        `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
         VALUES (?, 'bootstrap_failed', '{"stage":"stage-1"}', ?)`,
      )
      .run(wfId, now);
    const attId = Number((res as { lastInsertRowid: bigint | number }).lastInsertRowid);

    // Navigate to the workflow detail page.
    await page.goto(`/workflow/${wfId}`);

    // Wait for the WS snapshot (sidebar shows workflow name).
    await expect(page.getByText(wfName)).toBeVisible({ timeout: 6000 });

    // Inject the notice frame via the server's broadcast — this is what
    // Scheduler._emitAttentionNotice emits after applyItemTransition returns.
    backend.broadcast(wfId, null, 'notice', {
      severity: 'requires_attention',
      kind: 'bootstrap_failed',
      message: 'Bootstrap failed in stage "stage-1"',
      persistedAttentionId: attId,
    });

    // AttentionBanner must render within 2s without a page reload.
    const banner = page.getByRole('region', { name: 'Attention required' });
    await expect(banner).toBeVisible({ timeout: 2000 });

    // Banner shows the correct kind label.
    await expect(banner).toContainText('bootstrap_failed');
  });

  test('banner disappears optimistically after Acknowledge; row is acknowledged in DB', async ({
    page,
    backend,
  }) => {
    const wfId = `wf-live-ack-${randomUUID().slice(0, 8)}`;
    const wfName = `Live Ack ${wfId}`;
    const now = new Date().toISOString();

    backend.db.writer
      .prepare(
        `INSERT INTO workflows
           (id, name, spec, pipeline, config, status, created_at, updated_at)
         VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?)`,
      )
      .run(wfId, wfName, PIPELINE, now, now);

    const res = backend.db.writer
      .prepare(
        `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
         VALUES (?, 'bootstrap_failed', '{"stage":"stage-1"}', ?)`,
      )
      .run(wfId, now);
    const attId = Number((res as { lastInsertRowid: bigint | number }).lastInsertRowid);

    await page.goto(`/workflow/${wfId}`);
    await expect(page.getByText(wfName)).toBeVisible({ timeout: 6000 });

    backend.broadcast(wfId, null, 'notice', {
      severity: 'requires_attention',
      kind: 'bootstrap_failed',
      message: 'Bootstrap failed in stage "stage-1"',
      persistedAttentionId: attId,
    });

    const banner = page.getByRole('region', { name: 'Attention required' });
    await expect(banner).toBeVisible({ timeout: 2000 });

    // Click Acknowledge — optimistic removal hides the item immediately.
    await page.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(banner).not.toBeVisible({ timeout: 3000 });

    // DB row is acknowledged (ack endpoint was called).
    const row = backend.db.reader()
      .prepare('SELECT acknowledged_at FROM pending_attention WHERE id = ?')
      .get(attId) as { acknowledged_at: string | null } | undefined;
    expect(row?.acknowledged_at).toBeTruthy();
  });
});
