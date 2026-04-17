/**
 * Playwright spec for feat-workflow-archive.
 *
 * NOTE: test-real-backend-fixture (src/web/e2e/fixtures/realBackend.ts) has
 * not been implemented yet, so this spec uses page.route() mocks for the HTTP
 * API while exercising the full UI path.  When the realBackend fixture lands,
 * this file should be updated to seed workflows via db.writer and assert
 * against a live server.
 *
 * Covers:
 *   AC: archive button appears on row hover
 *   AC: clicking archive removes the row from the default view
 *   AC: 409 on in_progress workflow shows no crash (button silently no-ops)
 *   AC: Show archived checkbox fetches ?archived=true and shows archived rows
 *   AC: clicking unarchive in archived view removes the row
 */

import { test, expect } from '@playwright/test';
import { setupWs, mockWorkflowsApi } from '../helpers';

const ACTIVE_WF = {
  id: 'wf-active-001',
  name: 'Active Workflow',
  status: 'completed',
};

const IN_PROGRESS_WF = {
  id: 'wf-live-002',
  name: 'In-Progress Workflow',
  status: 'in_progress',
};

const ARCHIVED_WF = {
  id: 'wf-arch-003',
  name: 'Archived Workflow',
  status: 'completed',
};

test.describe('feat-workflow-archive — UI round-trip', () => {
  test('archive button appears on row hover and removes row on success', async ({ page }) => {
    await setupWs(page);

    // Default view: only active workflow.
    await page.route('**/api/workflows**', (route) => {
      const url = route.request().url();
      if (url.includes('archived=true')) {
        void route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ workflows: [], hasMore: false }),
        });
        return;
      }
      const now = new Date().toISOString();
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          workflows: [{ ...ACTIVE_WF, createdAt: now, updatedAt: now, unreadEvents: 0, activeSessions: 0 }],
          hasMore: false,
        }),
      });
    });

    // Archive endpoint returns 200.
    await page.route(`**/api/workflows/${ACTIVE_WF.id}/archive`, (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'archived', workflowId: ACTIVE_WF.id }),
      });
    });

    await page.goto('/');
    await expect(page.getByText(ACTIVE_WF.name)).toBeVisible();

    // Hover the row to reveal the archive button.
    const row = page.getByRole('listitem').filter({ hasText: ACTIVE_WF.name });
    await row.hover();

    const archiveBtn = row.getByRole('button', { name: /archive workflow/i });
    await expect(archiveBtn).toBeVisible();

    // Click archive — row should disappear from the default view.
    await archiveBtn.click();
    await expect(page.getByText(ACTIVE_WF.name)).not.toBeVisible();
  });

  test('409 response (in_progress workflow) does not crash the UI', async ({ page }) => {
    await setupWs(page);
    await mockWorkflowsApi(page, [IN_PROGRESS_WF]);

    // Archive endpoint returns 409.
    await page.route(`**/api/workflows/${IN_PROGRESS_WF.id}/archive`, (route) => {
      void route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: "cannot archive a workflow with status 'in_progress'",
          currentStatus: 'in_progress',
        }),
      });
    });

    await page.goto('/');
    await expect(page.getByText(IN_PROGRESS_WF.name)).toBeVisible();

    const row = page.getByRole('listitem').filter({ hasText: IN_PROGRESS_WF.name });
    await row.hover();

    const archiveBtn = row.getByRole('button', { name: /archive workflow/i });
    await archiveBtn.click();

    // Row stays visible since the archive failed (409 → ok=false → no optimistic remove).
    await expect(page.getByText(IN_PROGRESS_WF.name)).toBeVisible();
    // No crash: page is still functional.
    await expect(page.getByLabel('Filter by status')).toBeVisible();
  });

  test('Show archived checkbox fetches ?archived=true and shows archived row', async ({ page }) => {
    await setupWs(page);
    const now = new Date().toISOString();

    await page.route('**/api/workflows**', (route) => {
      const url = route.request().url();
      if (url.includes('archived=true')) {
        void route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            workflows: [{ ...ARCHIVED_WF, createdAt: now, updatedAt: now, unreadEvents: 0, activeSessions: 0 }],
            hasMore: false,
          }),
        });
        return;
      }
      // Default view: no archived workflows.
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ workflows: [], hasMore: false }),
      });
    });

    await page.goto('/');
    // Archived row not visible initially.
    await expect(page.getByText(ARCHIVED_WF.name)).not.toBeVisible();

    // Toggle "Show archived".
    await page.getByLabel('Show archived workflows').check();
    await expect(page.getByText(ARCHIVED_WF.name)).toBeVisible();
  });

  test('unarchive button in archived view removes row from archived list', async ({ page }) => {
    await setupWs(page);
    const now = new Date().toISOString();

    await page.route('**/api/workflows**', (route) => {
      const url = route.request().url();
      if (url.includes('archived=true')) {
        void route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            workflows: [{ ...ARCHIVED_WF, createdAt: now, updatedAt: now, unreadEvents: 0, activeSessions: 0 }],
            hasMore: false,
          }),
        });
        return;
      }
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ workflows: [], hasMore: false }),
      });
    });

    await page.route(`**/api/workflows/${ARCHIVED_WF.id}/unarchive`, (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'unarchived', workflowId: ARCHIVED_WF.id }),
      });
    });

    await page.goto('/');
    await page.getByLabel('Show archived workflows').check();
    await expect(page.getByText(ARCHIVED_WF.name)).toBeVisible();

    const row = page.getByRole('listitem').filter({ hasText: ARCHIVED_WF.name });
    await row.hover();

    const unarchiveBtn = row.getByRole('button', { name: /unarchive workflow/i });
    await expect(unarchiveBtn).toBeVisible();
    await unarchiveBtn.click();

    // Row removed from archived view after unarchive.
    await expect(page.getByText(ARCHIVED_WF.name)).not.toBeVisible();
  });
});
