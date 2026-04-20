/**
 * Real-backend Playwright spec for r2-06 seed_failed attention path.
 *
 * AC: When a per-item seeding failure fires seed_failed, the UI renders an
 * AttentionBanner with kind=seed_failed within 2s of receiving the notice frame.
 *
 * Seeds a workflow with a per-item placeholder item already in awaiting_user
 * (the state reached after seed_failed), inserts a pending_attention row with
 * kind=seed_failed, and injects the notice frame via backend.broadcast().
 * This mirrors exactly what Scheduler._applyTransition emits.
 */

import { test, expect } from '../fixtures/realBackend.js';
import { randomUUID } from 'node:crypto';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'per-item-stage', run: 'per-item', phases: ['implement'] }],
});

test.describe('seed_failed attention — real backend', () => {
  test('notice frame with kind=seed_failed causes AttentionBanner to render within 2s', async ({
    page,
    backend,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const wfId = `wf-seed-fail-${suffix}`;
    const wfName = `Seed Fail ${suffix}`;
    const itemId = `item-seed-fail-${suffix}`;
    const now = new Date().toISOString();

    // Workflow with a per-item stage
    backend.db.writer
      .prepare(
        `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
         VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?)`,
      )
      .run(wfId, wfName, PIPELINE, now, now);

    // Placeholder item in awaiting_user (state after seed_failed fires)
    backend.db.writer
      .prepare(
        `INSERT INTO items
           (id, workflow_id, stage_id, data, status, current_phase, retry_count, updated_at)
         VALUES (?, ?, 'per-item-stage', '{}', 'awaiting_user', 'implement', 0, ?)`,
      )
      .run(itemId, wfId, now);

    // pending_attention row as inserted by the engine on seed_failed
    const res = backend.db.writer
      .prepare(
        `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
         VALUES (?, 'seed_failed', ?, ?)`,
      )
      .run(
        wfId,
        JSON.stringify({ message: 'items.json: ENOENT: no such file', stage: 'per-item-stage', item_id: itemId }),
        now,
      );
    const attId = Number((res as { lastInsertRowid: bigint | number }).lastInsertRowid);

    await page.goto(`/workflow/${wfId}`);
    await expect(page.getByText(wfName)).toBeVisible({ timeout: 6000 });

    // Inject the notice frame — mirrors Scheduler._emitAttentionNotice
    backend.broadcast(wfId, null, 'notice', {
      severity: 'requires_attention',
      kind: 'seed_failed',
      message: 'Seeding failed in stage "per-item-stage": items.json: ENOENT: no such file',
      persistedAttentionId: attId,
    });

    // AttentionBanner must appear within 2s
    const banner = page.getByRole('region', { name: 'Attention required' });
    await expect(banner).toBeVisible({ timeout: 2000 });

    // Banner surface area: kind label present
    await expect(banner).toContainText('seed_failed');
  });

  test('seed_failed banner shows the human-readable message from the payload', async ({
    page,
    backend,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const wfId = `wf-seed-msg-${suffix}`;
    const wfName = `Seed Msg ${suffix}`;
    const itemId = `item-seed-msg-${suffix}`;
    const now = new Date().toISOString();
    const errorMsg = `Cannot read manifest 'items.json': ENOENT: no such file or directory`;

    backend.db.writer
      .prepare(
        `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
         VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?)`,
      )
      .run(wfId, wfName, PIPELINE, now, now);

    backend.db.writer
      .prepare(
        `INSERT INTO items
           (id, workflow_id, stage_id, data, status, current_phase, retry_count, updated_at)
         VALUES (?, ?, 'per-item-stage', '{}', 'awaiting_user', 'implement', 0, ?)`,
      )
      .run(itemId, wfId, now);

    const res = backend.db.writer
      .prepare(
        `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
         VALUES (?, 'seed_failed', ?, ?)`,
      )
      .run(
        wfId,
        JSON.stringify({ message: errorMsg, stage: 'per-item-stage', item_id: itemId }),
        now,
      );
    const attId = Number((res as { lastInsertRowid: bigint | number }).lastInsertRowid);

    await page.goto(`/workflow/${wfId}`);
    await expect(page.getByText(wfName)).toBeVisible({ timeout: 6000 });

    backend.broadcast(wfId, null, 'notice', {
      severity: 'requires_attention',
      kind: 'seed_failed',
      message: `Seeding failed in stage "per-item-stage": ${errorMsg}`,
      persistedAttentionId: attId,
    });

    const banner = page.getByRole('region', { name: 'Attention required' });
    await expect(banner).toBeVisible({ timeout: 2000 });
    // Message is surfaced from the notice frame payload
    await expect(banner).toContainText('Seeding failed');
  });
});
