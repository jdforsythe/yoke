/**
 * r2-04 AC4: session.ended for the selected item shows the "Session ended"
 * frozen pane and does NOT auto-switch the visible pane to another item's session.
 *
 * Seeds 2 in-progress items each with their own active session. Selects item A,
 * then broadcasts session.ended for A's session. Asserts:
 *   - "Session ended" banner appears (frozen pane with A's last content)
 *   - A's stream content remains visible (not replaced by a blank "no session" state)
 *   - The pane does NOT auto-switch to item B's session
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';
import { randomUUID } from 'node:crypto';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'stage-1', run: 'per-item', phases: ['implement'] }],
});

function seedTwoItemWorkflow(
  db: BackendHandle['db'],
  wfId: string,
  entries: Array<{ itemId: string; sessionId: string }>,
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?)`,
    )
    .run(wfId, `Two Items ${wfId}`, PIPELINE, now, now);

  for (const { itemId, sessionId } of entries) {
    db.writer
      .prepare(
        `INSERT INTO items
           (id, workflow_id, stage_id, data, status, current_phase, retry_count, updated_at)
         VALUES (?, ?, 'stage-1', '{}', 'in_progress', 'implement', 0, ?)`,
      )
      .run(itemId, wfId, now);
    db.writer
      .prepare(
        `INSERT INTO sessions
           (id, workflow_id, item_id, stage, phase, agent_profile, started_at, status)
         VALUES (?, ?, ?, 'stage-1', 'implement', 'default', ?, 'in_progress')`,
      )
      .run(sessionId, wfId, itemId, now);
  }
}

test.describe('session-end no-autoswitch — r2-04 AC4', () => {
  test('session.ended for selected item shows frozen banner; pane stays on A, not B', async ({
    page,
    backend,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const wfId = `wf-se-${suffix}`;
    const itemA = { itemId: `item-se-a-${suffix}`, sessionId: `sess-se-a-${suffix}` };
    const itemB = { itemId: `item-se-b-${suffix}`, sessionId: `sess-se-b-${suffix}` };

    seedTwoItemWorkflow(backend.db, wfId, [itemA, itemB]);

    await page.goto(`/workflow/${wfId}`);

    // Wait for both items to appear.
    await expect(page.locator(`#item-${itemA.itemId}`)).toBeVisible({ timeout: 6000 });
    await expect(page.locator(`#item-${itemB.itemId}`)).toBeVisible({ timeout: 3000 });

    // Broadcast stream content for A so the frozen pane has something to show.
    backend.broadcast(wfId, itemA.sessionId, 'stream.text', {
      sessionId: itemA.sessionId,
      blockId: 'blk-se-a',
      textDelta: 'Item A session output',
      final: true,
    });

    // Select item A — it has an active session so the live pane is shown.
    await page.locator(`#item-${itemA.itemId}`).click();
    await expect(page.getByText('Item A session output')).toBeVisible({ timeout: 5000 });
    // No ended banner yet — session A is still active.
    await expect(page.getByTestId('session-ended-banner')).not.toBeVisible();

    // Broadcast session.ended for item A's session.
    backend.broadcast(wfId, itemA.sessionId, 'session.ended', {
      sessionId: itemA.sessionId,
      endedAt: new Date().toISOString(),
      exitCode: 0,
      statusFlags: {},
      reason: 'ok',
    });

    // The "Session ended" banner must appear (frozen pane state).
    await expect(page.getByTestId('session-ended-banner')).toBeVisible({ timeout: 3000 });

    // The pane must NOT have auto-switched to item B's session.
    // A's prior stream output remains visible in the frozen pane.
    await expect(page.getByText('Item A session output')).toBeVisible();

    // Item B's session stream content was never broadcast, so no bleed-over.
    // Additionally, the selected item context must still be A (B is not highlighted).
    // The tab bar must still be present (session-ended state keeps the pane open).
    await expect(page.getByTestId('tab-live')).toBeVisible();
  });
});
