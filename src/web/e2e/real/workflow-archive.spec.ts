/**
 * Real-backend Playwright spec for feat-workflow-archive.
 *
 * Seeds workflows directly into SQLite via the realBackend fixture, then
 * asserts the full UI round-trip: archive button hover, click, 409 conflict,
 * Show archived checkbox, and unarchive.
 *
 * Covers AC:
 *   - Archive button appears on row hover and removes row from default view
 *   - 409 on in_progress workflow does not crash the UI
 *   - Show archived checkbox fetches ?archived=true and shows archived rows
 *   - Unarchive button in archived view removes the row
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';

// Helper to insert a workflow row with sensible defaults.
function seedWorkflow(
  db: BackendHandle['db'],
  opts: { id: string; name: string; status: string; archivedAt?: string },
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(opts.id, opts.name, '{}', '{}', '{}', opts.status, opts.archivedAt ?? null, now, now);
}

test.describe('feat-workflow-archive — real backend round-trip', () => {
  test('archive button appears on row hover and removes row on success', async ({ page, backend }) => {
    seedWorkflow(backend.db, { id: 'wf-arch-001', name: 'Archivable Workflow', status: 'completed' });

    await page.goto('/');
    await expect(page.getByText('Archivable Workflow')).toBeVisible();

    const row = page.getByRole('listitem').filter({ hasText: 'Archivable Workflow' });
    await row.hover();

    const archiveBtn = row.getByRole('button', { name: /archive workflow/i });
    await expect(archiveBtn).toBeVisible();

    await archiveBtn.click();
    await expect(page.getByText('Archivable Workflow')).not.toBeVisible();
  });

  test('409 response (in_progress workflow) does not crash the UI', async ({ page, backend }) => {
    seedWorkflow(backend.db, { id: 'wf-live-002', name: 'Running Workflow', status: 'in_progress' });

    await page.goto('/');
    await expect(page.getByText('Running Workflow')).toBeVisible();

    const row = page.getByRole('listitem').filter({ hasText: 'Running Workflow' });
    await row.hover();

    const archiveBtn = row.getByRole('button', { name: /archive workflow/i });
    await archiveBtn.click();

    // Row stays visible — server returned 409, optimistic remove did not fire.
    await expect(page.getByText('Running Workflow')).toBeVisible();
    // Page remains functional after the conflict.
    await expect(page.getByLabel('Filter by status')).toBeVisible();
  });

  test('Show archived checkbox shows archived workflow', async ({ page, backend }) => {
    const archivedAt = new Date().toISOString();
    seedWorkflow(backend.db, {
      id: 'wf-arch-003',
      name: 'Hidden Archived Workflow',
      status: 'completed',
      archivedAt,
    });

    await page.goto('/');
    // Default view excludes archived rows.
    await expect(page.getByText('Hidden Archived Workflow')).not.toBeVisible();

    // Toggle "Show archived" checkbox.
    await page.getByLabel('Show archived workflows').check();
    await expect(page.getByText('Hidden Archived Workflow')).toBeVisible();
  });

  test('unarchive button in archived view removes row from archived list', async ({ page, backend }) => {
    const archivedAt = new Date().toISOString();
    seedWorkflow(backend.db, {
      id: 'wf-arch-004',
      name: 'To Be Unarchived',
      status: 'completed',
      archivedAt,
    });

    await page.goto('/');
    await page.getByLabel('Show archived workflows').check();
    await expect(page.getByText('To Be Unarchived')).toBeVisible();

    const row = page.getByRole('listitem').filter({ hasText: 'To Be Unarchived' });
    await row.hover();

    const unarchiveBtn = row.getByRole('button', { name: /unarchive workflow/i });
    await expect(unarchiveBtn).toBeVisible();
    await unarchiveBtn.click();

    // Row disappears from the archived view after successful unarchive.
    await expect(page.getByText('To Be Unarchived')).not.toBeVisible();
  });
});
