/**
 * r2-04 AC3: 3 parallel per-item sessions — clicking item A/B scopes the
 * stream pane to that item's session without bleeding between items.
 *
 * Seeds 3 in-progress items but NO sessions in the DB so the snapshot has
 * empty activeSessions. After items appear, drives session.started for each
 * via backend.broadcast() — this exercises the upsert path (not buildFromSnapshot).
 * Then asserts:
 *   - Clicking item A shows A's content only
 *   - Clicking item B shows B's content only
 *   - Clicking item A again shows A's content (map preserved — no auto-switch)
 *   - "Session ended" banner does not appear (sessions are still live)
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';
import { randomUUID } from 'node:crypto';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'stage-1', run: 'per-item', phases: ['implement'] }],
});

function seedParallelWorkflow(
  db: BackendHandle['db'],
  wfId: string,
  itemIds: string[],
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?)`,
    )
    .run(wfId, `Parallel Items ${wfId}`, PIPELINE, now, now);

  for (const itemId of itemIds) {
    db.writer
      .prepare(
        `INSERT INTO items
           (id, workflow_id, stage_id, data, status, current_phase, retry_count, updated_at)
         VALUES (?, ?, 'stage-1', '{}', 'in_progress', 'implement', 0, ?)`,
      )
      .run(itemId, wfId, now);
  }
}

test.describe('parallel-items-stream — r2-04 AC3', () => {
  test('session.started upserts map; clicking A/B scopes pane; clicking A again preserves map', async ({
    page,
    backend,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const wfId = `wf-par-${suffix}`;
    const itemA = { itemId: `item-par-a-${suffix}`, sessionId: `sess-par-a-${suffix}` };
    const itemB = { itemId: `item-par-b-${suffix}`, sessionId: `sess-par-b-${suffix}` };
    const itemC = { itemId: `item-par-c-${suffix}`, sessionId: `sess-par-c-${suffix}` };

    // Seed workflow + items but NO sessions — snapshot activeSessions will be empty,
    // so buildFromSnapshot produces an empty map. Sessions are driven via broadcast below.
    seedParallelWorkflow(backend.db, wfId, [itemA.itemId, itemB.itemId, itemC.itemId]);

    await page.goto(`/workflow/${wfId}`);

    // Wait for all 3 items to appear in the feature board via workflow.snapshot.
    await expect(page.locator(`#item-${itemA.itemId}`)).toBeVisible({ timeout: 6000 });
    await expect(page.locator(`#item-${itemB.itemId}`)).toBeVisible({ timeout: 3000 });
    await expect(page.locator(`#item-${itemC.itemId}`)).toBeVisible({ timeout: 3000 });

    // Drive session.started for each item via the real backend (upsert path).
    // This populates itemActiveSession via session.started handler, not buildFromSnapshot.
    const now = new Date().toISOString();
    for (const { itemId, sessionId } of [itemA, itemB, itemC]) {
      backend.broadcast(wfId, sessionId, 'session.started', {
        sessionId,
        itemId,
        phase: 'implement',
        attempt: 1,
        startedAt: now,
      });
    }

    // Broadcast distinguishable stream.text for sessions A and B so assertions
    // can tell which session's content is in the visible pane.
    backend.broadcast(wfId, itemA.sessionId, 'stream.text', {
      sessionId: itemA.sessionId,
      blockId: 'blk-par-a',
      textDelta: 'Stream content for item A',
      final: true,
    });
    backend.broadcast(wfId, itemB.sessionId, 'stream.text', {
      sessionId: itemB.sessionId,
      blockId: 'blk-par-b',
      textDelta: 'Stream content for item B',
      final: true,
    });

    // --- Click item A ---
    await page.locator(`#item-${itemA.itemId}`).click();
    // A's content must appear in the stream pane.
    await expect(page.getByText('Stream content for item A')).toBeVisible({ timeout: 5000 });
    // B's content must NOT bleed into A's pane.
    await expect(page.getByText('Stream content for item B')).not.toBeVisible();
    // No "Session ended" banner — session A is still active.
    await expect(page.getByTestId('session-ended-banner')).not.toBeVisible();

    // --- Click item B ---
    await page.locator(`#item-${itemB.itemId}`).click();
    // B's content must appear in the stream pane.
    await expect(page.getByText('Stream content for item B')).toBeVisible({ timeout: 5000 });
    // A's content must NOT bleed into B's pane.
    await expect(page.getByText('Stream content for item A')).not.toBeVisible();
    // No "Session ended" banner — session B is still active.
    await expect(page.getByTestId('session-ended-banner')).not.toBeVisible();

    // --- Click item A again: assert map preserved A's session state ---
    // A's session was never ended, so itemActiveSession still holds it.
    // Selecting A must show A's content without switching to B or clearing.
    await page.locator(`#item-${itemA.itemId}`).click();
    await expect(page.getByText('Stream content for item A')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Stream content for item B')).not.toBeVisible();
    await expect(page.getByTestId('session-ended-banner')).not.toBeVisible();
  });
});
