/**
 * Real-backend Playwright spec for test-e2e-full-suite — FeatureBoard regressions.
 *
 * Covers:
 *   A5 — clicking an item triggers exactly one fetch (infinite-loop fix): the
 *        item.data endpoint is called once per selection, not on every re-render.
 *   "no data" path — item with null data shows "No data available." (not blank)
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';
import { randomUUID } from 'node:crypto';

function seedWorkflow(
  db: BackendHandle['db'],
  opts: { id: string; name: string; pipeline: string },
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', 'pending', ?, ?)`,
    )
    .run(opts.id, opts.name, opts.pipeline, now, now);
}

function seedItem(
  db: BackendHandle['db'],
  opts: { id: string; workflowId: string; stageId: string; data: string },
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .run(opts.id, opts.workflowId, opts.stageId, opts.data, now);
}

const PIPELINE = JSON.stringify({
  stages: [{ id: 'stage-1', run: 'once', phases: ['implement'] }],
});

test.describe('feature-board regressions — real backend', () => {
  test('A5: clicking an item fetches item.data exactly once (no infinite loop)', async ({
    page,
    backend,
  }) => {
    // fix-feat-item-data: the FeatureBoard previously called fetch() on every
    // re-render because fetchingData was state (not a ref), causing it to reset on
    // each render tick, bypassing the "already fetching" guard. Now it's a ref.
    const wfId = `wf-fb-a5-${randomUUID().slice(0, 8)}`;
    const itemId = `item-fb-a5-${randomUUID().slice(0, 8)}`;

    seedWorkflow(backend.db, { id: wfId, name: 'FeatureBoard A5 Workflow', pipeline: PIPELINE });
    seedItem(backend.db, {
      id: itemId,
      workflowId: wfId,
      stageId: 'stage-1',
      data: JSON.stringify({ key: 'value', version: 42 }),
    });

    // Count requests to the item data endpoint.
    let dataFetchCount = 0;
    page.on('request', (req) => {
      if (req.url().includes(`/items/${itemId}/data`)) dataFetchCount++;
    });

    await page.goto(`/workflow/${wfId}`);

    // Wait for item card to appear in FeatureBoard.
    await expect(page.locator(`#item-${itemId}`)).toBeVisible({ timeout: 6000 });

    // Click the item — triggers GET .../items/:id/data exactly once.
    await page.locator(`#item-${itemId}`).click();

    // "Show data" button confirms the fetch succeeded and data is cached.
    await expect(page.getByRole('button', { name: /show data/i })).toBeVisible({ timeout: 3000 });

    // Give any rogue re-renders a moment to fire additional fetches.
    await page.waitForTimeout(500);

    expect(dataFetchCount).toBe(1);
  });

  test('no data: item with null data shows "No data available."', async ({ page, backend }) => {
    // The server returns HTTP 200 with JSON body `null` when items.data IS NULL.
    // The frontend treats any falsy successful response as "no data".
    const wfId = `wf-fb-nodata-${randomUUID().slice(0, 8)}`;
    const itemId = `item-fb-nodata-${randomUUID().slice(0, 8)}`;

    seedWorkflow(backend.db, { id: wfId, name: 'No-Data Workflow', pipeline: PIPELINE });
    seedItem(backend.db, {
      id: itemId,
      workflowId: wfId,
      stageId: 'stage-1',
      // Insert the JSON string 'null' (not SQL NULL — items.data is NOT NULL).
      // JSON.parse('null') = null on the server → reply.send(null) → HTTP 200
      // with body `null`. The frontend treats null as "no data cached" and shows
      // "No data available." (same path as a 4xx response).
      data: 'null',
    });

    await page.goto(`/workflow/${wfId}`);
    await expect(page.locator(`#item-${itemId}`)).toBeVisible({ timeout: 6000 });

    await page.locator(`#item-${itemId}`).click();

    // The UI must surface "No data available." — not a blank panel, not "Loading data…".
    await expect(page.getByText('No data available.')).toBeVisible({ timeout: 3000 });
  });
});
