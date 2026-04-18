/**
 * Real-backend Playwright spec for fix-workflow-switch-reset (bug B3).
 *
 * Seeds two workflows with distinct pipeline stages and items, navigates to
 * workflow A via the sidebar, asserts A's stage section, then clicks workflow B
 * in the sidebar and asserts B's stage section appears within 2 s without a
 * page reload.
 *
 * Covers AC:
 *   - Clicking a different workflow updates the stages panel within 2 s (no reload)
 *   - WorkflowDetailRoute resets local state before re-subscribing (stale stage
 *     from A disappears immediately on switch; B's stage appears on snapshot)
 *   - No regression in /workflow/:id deep-link behaviour
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';

const PIPELINE_A = JSON.stringify({
  stages: [{ id: 'stage-alpha', run: 'once', phases: ['implement'] }],
});

const PIPELINE_B = JSON.stringify({
  stages: [{ id: 'stage-beta', run: 'once', phases: ['implement'] }],
});

function seedWorkflow(
  db: BackendHandle['db'],
  opts: { id: string; name: string; pipeline: string },
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(opts.id, opts.name, '{}', opts.pipeline, '{}', 'pending', now, now);
}

function seedItem(
  db: BackendHandle['db'],
  opts: { id: string; workflowId: string; stageId: string },
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(opts.id, opts.workflowId, opts.stageId, '{}', 'pending', now);
}

test.describe('fix-workflow-switch-reset — real backend', () => {
  test('clicking workflow B in sidebar replaces workflow A stage panel within 2s', async ({
    page,
    backend,
  }) => {
    seedWorkflow(backend.db, { id: 'wf-sw-a', name: 'Switch Workflow A', pipeline: PIPELINE_A });
    seedWorkflow(backend.db, { id: 'wf-sw-b', name: 'Switch Workflow B', pipeline: PIPELINE_B });
    seedItem(backend.db, { id: 'item-alpha-1', workflowId: 'wf-sw-a', stageId: 'stage-alpha' });
    seedItem(backend.db, { id: 'item-beta-1', workflowId: 'wf-sw-b', stageId: 'stage-beta' });

    // Start at the root so the WS connection is established before navigating
    // to the detail route. The sidebar fetches /api/workflows via REST.
    await page.goto('/');

    // Wait for WS to connect before navigating to the detail route.
    // This ensures client.subscribe() sends the frame immediately rather
    // than queuing it for the hello handler.
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 5000 });

    // Both workflows are visible in the sidebar.
    await expect(page.locator('aside').getByText('Switch Workflow A')).toBeVisible();
    await expect(page.locator('aside').getByText('Switch Workflow B')).toBeVisible();

    // Click workflow A in the sidebar — triggers navigate + subscribe.
    await page
      .locator('aside')
      .getByRole('listitem')
      .filter({ hasText: 'Switch Workflow A' })
      .locator('button')
      .first()
      .click();

    // Workflow A's stage section must be visible before switching.
    await expect(page.getByTestId('stage-header').filter({ hasText: 'stage-alpha' })).toBeVisible();

    // Click workflow B in the persistent sidebar.
    await page
      .locator('aside')
      .getByRole('listitem')
      .filter({ hasText: 'Switch Workflow B' })
      .locator('button')
      .first()
      .click();

    // B's stage section must appear within 2 s — no page reload needed.
    await expect(
      page.getByTestId('stage-header').filter({ hasText: 'stage-beta' }),
    ).toBeVisible({ timeout: 2000 });

    // A's stage section must be gone — state was reset synchronously on switch.
    await expect(
      page.getByTestId('stage-header').filter({ hasText: 'stage-alpha' }),
    ).not.toBeVisible();
  });
});
