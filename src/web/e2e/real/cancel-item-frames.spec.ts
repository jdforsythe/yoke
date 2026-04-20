/**
 * Real-backend Playwright spec for r2-05 — per-item item.state frames on cancel.
 *
 * Seeds a running workflow with 3 in-progress items, clicks Cancel,
 * and asserts every item's chip flips to 'abandoned' without a page reload.
 * The item.state frames emitted by the control executor drive the FeatureBoard
 * update — this spec exercises that full round-trip.
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';
import { randomUUID } from 'node:crypto';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'stage-1', run: 'per-item', phases: ['implement'] }],
});

function seedCancelWorkflow(
  db: BackendHandle['db'],
  wfId: string,
  itemIds: string[],
  sessionId: string,
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?)`,
    )
    .run(wfId, 'Cancel Frames Workflow', PIPELINE, now, now);

  for (const itemId of itemIds) {
    db.writer
      .prepare(
        `INSERT INTO items
           (id, workflow_id, stage_id, data, status, current_phase, retry_count, updated_at)
         VALUES (?, ?, 'stage-1', '{}', 'in_progress', 'implement', 0, ?)`,
      )
      .run(itemId, wfId, now);
  }

  // Active session (ended_at IS NULL) so the ControlMatrix shows the Cancel button.
  db.writer
    .prepare(
      `INSERT INTO sessions
         (id, workflow_id, item_id, stage, phase, agent_profile, started_at, status)
       VALUES (?, ?, ?, 'stage-1', 'implement', 'default', ?, 'in_progress')`,
    )
    .run(sessionId, wfId, itemIds[0] ?? null, now);
}

test.describe('cancel — per-item item.state frames update FeatureBoard', () => {
  test('clicking Cancel flips all 3 in-progress item chips to abandoned without a reload', async ({
    page,
    backend,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const wfId = `wf-cancel-frames-${suffix}`;
    const itemIds = [
      `item-cf-a-${suffix}`,
      `item-cf-b-${suffix}`,
      `item-cf-c-${suffix}`,
    ];
    const sessionId = `sess-cf-${suffix}`;

    seedCancelWorkflow(backend.db, wfId, itemIds, sessionId);

    await page.goto(`/workflow/${wfId}`);

    // Wait for the FeatureBoard to render the items from the workflow.snapshot.
    const cancelBtn = page.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancelBtn).toBeVisible({ timeout: 8000 });

    // All three items should start as 'in_progress'.
    for (const itemId of itemIds) {
      await expect(page.locator(`#item-${itemId}`).getByText('in_progress')).toBeVisible();
    }

    // Click Cancel → confirm dialog → server emits item.state × 3 then workflow.update.
    await cancelBtn.click();
    const dialog = page.getByRole('dialog', { name: 'Confirm action' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog).not.toBeVisible();

    // Each item's status chip must flip to 'abandoned' via the item.state WS frames
    // — no page reload. All three assertions must pass within the timeout.
    for (const itemId of itemIds) {
      await expect(
        page.locator(`#item-${itemId}`).getByText('abandoned'),
        `item ${itemId} should show abandoned`,
      ).toBeVisible({ timeout: 5000 });
    }

    // Confirm the workflow-level status chip also reflects abandoned
    // (from the workflow.update frame that follows the item.state frames).
    const statusChip = page.locator('h1').locator('..').getByText('abandoned');
    await expect(statusChip).toBeVisible({ timeout: 5000 });

    // DB sanity: all three items are abandoned.
    for (const itemId of itemIds) {
      const row = backend.db.writer
        .prepare('SELECT status FROM items WHERE id = ?')
        .get(itemId) as { status: string } | undefined;
      expect(row?.status).toBe('abandoned');
    }
  });
});
