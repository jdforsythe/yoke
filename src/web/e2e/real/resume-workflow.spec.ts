/**
 * Real-backend Playwright spec for r2-02: Resume button for retryable kinds.
 *
 * Seeds a workflow with an awaiting_user item (simulating retries exhausted),
 * verifies the AttentionBanner shows 'Resume' (not 'Acknowledge'/'Dismiss'),
 * clicks Resume, and asserts the item transitions back to in_progress within 2s.
 *
 * The full flow: ack POST → optimistic banner hide → fire-and-forget retry POST
 * → server broadcasts item.state{status:in_progress} → FeatureBoard updates.
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';
import { randomUUID } from 'node:crypto';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'stage-1', run: 'once', phases: ['implement'] }],
});

function seedRetriableWorkflow(
  db: BackendHandle['db'],
  opts: { wfId: string; itemId: string; attId: bigint | null },
): bigint {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?)`,
    )
    .run(opts.wfId, `Resume Wf ${opts.wfId}`, PIPELINE, now, now);

  db.writer
    .prepare(
      `INSERT INTO items (id, workflow_id, stage_id, data, status, retry_count, updated_at)
       VALUES (?, ?, 'stage-1', '{}', 'awaiting_user', 3, ?)`,
    )
    .run(opts.itemId, opts.wfId, now);

  const res = db.writer
    .prepare(
      `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
       VALUES (?, 'awaiting_user_retry', '{"stage":"stage-1"}', ?)`,
    )
    .run(opts.wfId, now);
  return (res as { lastInsertRowid: bigint }).lastInsertRowid;
}

test.describe('resume-workflow — real backend', () => {
  test('Resume button shows for retryable kind and transitions item to in_progress', async ({
    page,
    backend,
  }) => {
    const wfId = `wf-resume-${randomUUID().slice(0, 8)}`;
    const itemId = `item-resume-${randomUUID().slice(0, 8)}`;

    const attId = seedRetriableWorkflow(backend.db, { wfId, itemId, attId: null });

    await page.goto(`/workflow/${wfId}`);
    // Use heading role to avoid strict-mode violation (name also appears in sidebar).
    await expect(page.getByRole('heading', { name: `Resume Wf ${wfId}`, exact: true })).toBeVisible({ timeout: 6000 });

    // Inject the notice frame so the banner renders (same pattern as live-attention.spec.ts).
    backend.broadcast(wfId, null, 'notice', {
      severity: 'requires_attention',
      kind: 'awaiting_user_retry',
      message: 'Retry limit reached — awaiting user input',
      persistedAttentionId: Number(attId),
    });

    const banner = page.getByRole('region', { name: 'Attention required' });
    await expect(banner).toBeVisible({ timeout: 2000 });

    // Button label must be 'Resume' for a retryable kind.
    const resumeBtn = banner.getByRole('button', { name: 'Resume' });
    await expect(resumeBtn).toBeVisible();

    // Click Resume — ack fires, then retry fires fire-and-forget.
    await resumeBtn.click();

    // Banner card is optimistically hidden on ack success.
    await expect(banner).not.toBeVisible({ timeout: 3000 });

    // The retry POST broadcasts item.state{status:in_progress} back to the WS client.
    // Assert the item card shows 'in_progress' within 2s.
    await expect(
      page.locator(`#item-${itemId}`).getByText('in_progress'),
    ).toBeVisible({ timeout: 2000 });

    // DB: pending_attention row acknowledged.
    const attRow = backend.db.reader()
      .prepare('SELECT acknowledged_at FROM pending_attention WHERE id = ?')
      .get(Number(attId)) as { acknowledged_at: string | null } | undefined;
    expect(attRow?.acknowledged_at).toBeTruthy();

    // DB: item status transitioned to in_progress.
    const itemRow = backend.db.reader()
      .prepare('SELECT status FROM items WHERE id = ?')
      .get(itemId) as { status: string } | undefined;
    expect(itemRow?.status).toBe('in_progress');
  });

  test('none_awaiting retry response does not surface an error toast', async ({
    page,
    backend,
  }) => {
    const wfId = `wf-resume-noawait-${randomUUID().slice(0, 8)}`;
    const itemId = `item-resume-noawait-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    // Seed item already in_progress (not awaiting_user) — retry will return none_awaiting.
    backend.db.writer
      .prepare(
        `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
         VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?)`,
      )
      .run(wfId, `No-await Wf ${wfId}`, PIPELINE, now, now);

    backend.db.writer
      .prepare(
        `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
         VALUES (?, ?, 'stage-1', '{}', 'in_progress', ?)`,
      )
      .run(itemId, wfId, now);

    const res = backend.db.writer
      .prepare(
        `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
         VALUES (?, 'awaiting_user_retry', '{"stage":"stage-1"}', ?)`,
      )
      .run(wfId, now);
    const attId = Number((res as { lastInsertRowid: bigint | number }).lastInsertRowid);

    await page.goto(`/workflow/${wfId}`);
    await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: `No-await Wf ${wfId}` })).toBeVisible({ timeout: 6000 });

    backend.broadcast(wfId, null, 'notice', {
      severity: 'requires_attention',
      kind: 'awaiting_user_retry',
      message: 'Retry limit reached',
      persistedAttentionId: attId,
    });

    const banner = page.getByRole('region', { name: 'Attention required' });
    await expect(banner).toBeVisible({ timeout: 2000 });

    await banner.getByRole('button', { name: 'Resume' }).click();

    // Banner disappears (ack succeeded) — no error toast visible.
    await expect(banner).not.toBeVisible({ timeout: 3000 });
    // No error toast present anywhere on the page.
    await expect(page.getByRole('alert')).not.toBeVisible();
  });
});
