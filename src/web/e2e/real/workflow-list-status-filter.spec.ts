/**
 * Real-backend Playwright spec for fix-status-vocabulary.
 *
 * Seeds one workflow per WorkflowStatus value, then cycles through each filter
 * option in the dropdown and asserts only the matching row is visible.
 * Also verifies the ?status= URL query param round-trips correctly on page load.
 *
 * Covers AC:
 *   AC-1: Each filter option returns the correct subset against seeded backend
 *   AC-2: Display labels are derived from WorkflowStatus union (select options visible)
 *   AC-3: URL ?status=in_progress on initial load selects the filter
 *   AC-4: tests/api/workflows-list.test.ts covers every WorkflowStatus value (Vitest)
 *   AC-5: this file
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';
import { WORKFLOW_STATUS_VALUES, WORKFLOW_STATUS_LABELS } from '../../../shared/types/workflow.js';

function seedWorkflow(
  db: BackendHandle['db'],
  opts: { id: string; name: string; status: string },
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(opts.id, opts.name, '{}', '{}', '{}', opts.status, now, now);
}

test.describe('fix-status-vocabulary — status filter real backend', () => {
  test('each status filter option returns exactly the matching seeded workflow', async ({
    page,
    backend,
  }) => {
    // Seed one workflow per status with a recognisable name.
    for (const status of WORKFLOW_STATUS_VALUES) {
      seedWorkflow(backend.db, {
        id: `wf-sv-${status}`,
        name: `Status-${status}`,
        status,
      });
    }

    await page.goto('/');

    // Verify "All" shows every seeded workflow.
    await expect(page.getByLabel('Filter by status')).toHaveValue('all');
    for (const status of WORKFLOW_STATUS_VALUES) {
      // exact:true prevents 'Status-pending' from matching 'Status-pending_stage_approval'.
      await expect(page.getByText(`Status-${status}`, { exact: true })).toBeVisible();
    }

    // For each status, select the filter and assert only the matching row appears.
    for (const status of WORKFLOW_STATUS_VALUES) {
      await page.getByLabel('Filter by status').selectOption(status);
      await expect(page.getByText(`Status-${status}`, { exact: true })).toBeVisible();

      // All other status rows must not be visible.
      for (const other of WORKFLOW_STATUS_VALUES) {
        if (other !== status) {
          await expect(page.getByText(`Status-${other}`, { exact: true })).not.toBeVisible();
        }
      }
    }

    // Return to "All" and all rows are visible again.
    await page.getByLabel('Filter by status').selectOption('all');
    for (const status of WORKFLOW_STATUS_VALUES) {
      await expect(page.getByText(`Status-${status}`, { exact: true })).toBeVisible();
    }
  });

  test('dropdown options render the human-readable label, not the raw status key', async ({
    page,
    backend,
  }) => {
    // Seed one workflow so the page renders meaningfully.
    seedWorkflow(backend.db, { id: 'wf-sv-label-check', name: 'Label Check', status: 'pending' });
    await page.goto('/');

    const select = page.getByLabel('Filter by status');

    // "All" option must exist.
    await expect(select.locator('option[value="all"]')).toHaveText('All');

    // Each status option must show its human-readable label.
    for (const status of WORKFLOW_STATUS_VALUES) {
      await expect(select.locator(`option[value="${status}"]`)).toHaveText(
        WORKFLOW_STATUS_LABELS[status],
      );
    }
  });

  test('?status=in_progress on initial load selects the filter and fetches matching rows', async ({
    page,
    backend,
  }) => {
    seedWorkflow(backend.db, { id: 'wf-sv-active', name: 'Active Workflow', status: 'in_progress' });
    seedWorkflow(backend.db, { id: 'wf-sv-done', name: 'Done Workflow', status: 'completed' });

    await page.goto('/?status=in_progress');

    // The dropdown must reflect the URL param.
    await expect(page.getByLabel('Filter by status')).toHaveValue('in_progress');

    // Only the in_progress workflow is visible.
    await expect(page.getByText('Active Workflow')).toBeVisible();
    await expect(page.getByText('Done Workflow')).not.toBeVisible();
  });
});
