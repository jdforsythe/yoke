/**
 * Real-backend spec for r2-07 RC-3: clicking the Retry button in ControlMatrix
 * POSTs to /api/workflows/:id/retry rather than sending a WS control frame.
 *
 * Seeds a workflow with one awaiting_user item and an active session (so the
 * ControlMatrix toolbar renders after the item is clicked). Clicks Retry and
 * asserts the item transitions to in_progress via the item.state broadcast.
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';
import { randomUUID } from 'node:crypto';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'stage-1', run: 'per-item', phases: ['implement'] }],
});

function seedRetryWorkflow(
  db: BackendHandle['db'],
  wfId: string,
  itemId: string,
  sessionId: string,
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?)`,
    )
    .run(wfId, `Retry Ctrl ${wfId}`, PIPELINE, now, now);

  db.writer
    .prepare(
      `INSERT INTO items
         (id, workflow_id, stage_id, data, status, current_phase, retry_count, updated_at)
       VALUES (?, ?, 'stage-1', '{}', 'awaiting_user', 'implement', 3, ?)`,
    )
    .run(itemId, wfId, now);

  // Active session so ControlMatrix renders when the item is selected.
  db.writer
    .prepare(
      `INSERT INTO sessions
         (id, workflow_id, item_id, stage, phase, agent_profile, started_at, status)
       VALUES (?, ?, ?, 'stage-1', 'implement', 'default', ?, 'in_progress')`,
    )
    .run(sessionId, wfId, itemId, now);
}

test.describe('retry — ControlMatrix Retry button POSTs to /api/workflows/:id/retry', () => {
  test('clicking Retry transitions awaiting_user item to in_progress', async ({
    page,
    backend,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const wfId = `wf-retry-ctrl-${suffix}`;
    const itemId = `item-retry-ctrl-${suffix}`;
    const sessionId = `sess-retry-ctrl-${suffix}`;

    seedRetryWorkflow(backend.db, wfId, itemId, sessionId);

    await page.goto(`/workflow/${wfId}`);

    // Wait for item to appear in FeatureBoard from workflow.snapshot.
    const itemCard = page.locator(`#item-${itemId}`);
    await expect(itemCard).toBeVisible({ timeout: 6000 });
    // Item starts in awaiting_user state.
    await expect(itemCard.getByText('awaiting_user')).toBeVisible();

    // Click item to select it — activates the per-item session scope so
    // ControlMatrix renders with items[] including this awaiting_user item.
    await itemCard.click();

    // Retry button visible because the item is awaiting_user (RETRY_ELIGIBLE).
    const retryBtn = page.getByRole('button', { name: 'Retry', exact: true });
    await expect(retryBtn).toBeVisible({ timeout: 3000 });

    // Click Retry — routed to POST /api/workflows/:id/retry (not WS control).
    await retryBtn.click();

    // Server broadcasts item.state{status:in_progress} for the retried item.
    await expect(itemCard.getByText('in_progress')).toBeVisible({ timeout: 3000 });

    // DB sanity: item transitioned to in_progress via user_retry.
    const row = backend.db.reader()
      .prepare('SELECT status FROM items WHERE id = ?')
      .get(itemId) as { status: string } | undefined;
    expect(row?.status).toBe('in_progress');
  });
});
