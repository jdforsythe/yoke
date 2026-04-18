/**
 * Real-backend Playwright spec for test-e2e-full-suite — workflow list regressions.
 *
 * Covers:
 *   A1 — distinct workflow names (fix-workflow-rename): two workflows show unique names
 *   A2 — timestamps render correctly (fix-camelcase-api): "Xs ago" not "NaNd ago"
 *   A3 — status filter URL round-trip (fix-status-vocabulary): ?status= param applied on load
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';

function seedWorkflow(
  db: BackendHandle['db'],
  opts: { id: string; name: string; status: string; createdAt?: string },
): void {
  const now = opts.createdAt ?? new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', '{}', '{}', ?, ?, ?)`,
    )
    .run(opts.id, opts.name, opts.status, now, now);
}

test.describe('workflow-list regressions — real backend', () => {
  test('A1: two distinct workflow names both appear in the sidebar', async ({ page, backend }) => {
    // fix-workflow-rename: names now include a unique 8-char UUID suffix so every
    // run is distinguishable. Seed two workflows with different suffix-style names.
    seedWorkflow(backend.db, { id: 'wf-list-a1-001', name: 'yoke-aabbccdd', status: 'pending' });
    seedWorkflow(backend.db, { id: 'wf-list-a1-002', name: 'yoke-11223344', status: 'pending' });

    await page.goto('/');

    await expect(page.getByText('yoke-aabbccdd', { exact: true })).toBeVisible();
    await expect(page.getByText('yoke-11223344', { exact: true })).toBeVisible();
    // Confirm the two names are different (regression: both used to show 'yoke')
    const count = await page.getByRole('listitem').filter({ hasText: /^yoke-/ }).count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('A2: workflow timestamps render as relative time, not "NaN"', async ({ page, backend }) => {
    // fix-camelcase-api: created_at/updated_at were snake_case; relativeTime got
    // new Date(undefined) → NaN. Now mapped to camelCase at the API boundary.
    const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1_000).toISOString();
    seedWorkflow(backend.db, {
      id: 'wf-list-a2-001',
      name: 'Timestamp Workflow',
      status: 'pending',
      createdAt: twoMinsAgo,
    });

    await page.goto('/');

    await expect(page.getByText('Timestamp Workflow')).toBeVisible();
    // The sidebar row shows a relative timestamp like "2m ago".
    // Match any valid relative-time format; assert "NaN" never appears.
    const row = page.getByRole('listitem').filter({ hasText: 'Timestamp Workflow' });
    const rowText = await row.textContent();
    expect(rowText).toMatch(/\d+[smhd] ago/);
    expect(rowText).not.toContain('NaN');
  });

  test('A3: ?status=completed on initial load selects filter and hides non-matching rows', async ({
    page,
    backend,
  }) => {
    // fix-status-vocabulary: status filter now uses real engine values; URL param
    // round-trips correctly through the WorkflowList filter state.
    seedWorkflow(backend.db, { id: 'wf-list-a3-comp', name: 'Completed Run', status: 'completed' });
    seedWorkflow(backend.db, { id: 'wf-list-a3-pend', name: 'Pending Run', status: 'pending' });

    await page.goto('/?status=completed');

    // Dropdown must reflect the URL param.
    await expect(page.getByLabel('Filter by status')).toHaveValue('completed');

    // Only the completed workflow is visible.
    await expect(page.getByText('Completed Run', { exact: true })).toBeVisible();
    await expect(page.getByText('Pending Run', { exact: true })).not.toBeVisible();
  });
});
