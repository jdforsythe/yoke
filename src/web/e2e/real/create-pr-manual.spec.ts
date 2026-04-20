/**
 * Real-backend Playwright spec for r2-11 — manual Create PR flow.
 *
 * AC: seeds a completed workflow with github_state='idle', clicks "Create PR",
 * asserts WS sequence {creating → created} and final button text "PR #N".
 *
 * The spec uses page.route() to intercept POST create-pr, injects WS frames
 * via backend.broadcast(), and asserts the GithubButton transitions without
 * a page reload.
 */

import { test, expect } from '../fixtures/realBackend.js';
import { randomUUID } from 'node:crypto';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'stage-1', run: 'once', phases: ['implement'] }],
});

test.describe('Create PR manual flow — real backend', () => {
  test('seeds a completed workflow, clicks Create PR, asserts WS sequence {creating → created} and final button text PR #N', async ({
    page,
    backend,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const wfId = `wf-cpr-e2e-${suffix}`;
    const wfName = `Create PR E2E ${suffix}`;
    const now = new Date().toISOString();
    const prUrl = 'https://github.com/test/repo/pull/7';

    // Seed a completed workflow with github_state='idle'.
    backend.db.writer
      .prepare(
        `INSERT INTO workflows
           (id, name, spec, pipeline, config, status, github_state, created_at, updated_at)
         VALUES (?, ?, '{}', ?, '{}', 'completed', 'idle', ?, ?)`,
      )
      .run(wfId, wfName, PIPELINE, now, now);

    // Intercept POST create-pr: broadcast WS transitions then return success.
    await page.route(`**/api/workflows/${wfId}/github/create-pr`, async (route) => {
      // Broadcast 'creating' so the spinner appears.
      backend.broadcast(wfId, null, 'workflow.update', {
        githubState: { status: 'creating', lastCheckedAt: new Date().toISOString() },
      });

      // Fulfill with the created response body.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'created',
          prNumber: 7,
          prUrl,
          usedPath: 'octokit',
        }),
      });
    });

    await page.goto(`/workflow/${wfId}`);

    // Wait for snapshot (workflow name in header).
    await expect(
      page.getByRole('heading', { level: 1 }).filter({ hasText: wfName }),
    ).toBeVisible({ timeout: 8000 });

    // "Create PR" button should be visible (completed + idle = true).
    const createPrBtn = page.getByRole('button', { name: 'Create PR' });
    await expect(createPrBtn).toBeVisible({ timeout: 3000 });

    // Click — route handler broadcasts 'creating' and fulfills 200.
    await createPrBtn.click();

    // Spinner from 'creating' broadcast.
    await expect(page.getByText('Creating PR…')).toBeVisible({ timeout: 3000 });

    // Broadcast 'created' state after asserting spinner.
    backend.broadcast(wfId, null, 'workflow.update', {
      githubState: {
        status: 'created',
        prNumber: 7,
        prUrl,
        lastCheckedAt: new Date().toISOString(),
      },
    });

    // Final state: PR #7 link.
    await expect(page.getByRole('link', { name: /PR #7/ })).toBeVisible({ timeout: 3000 });

    // "Create PR" button should no longer be visible (github_state='created').
    await expect(createPrBtn).not.toBeVisible({ timeout: 2000 });
  });

  test('Create PR button is hidden when workflowStatus is in_progress', async ({
    page,
    backend,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const wfId = `wf-cpr-hidden-${suffix}`;
    const wfName = `Create PR Hidden ${suffix}`;
    const now = new Date().toISOString();

    backend.db.writer
      .prepare(
        `INSERT INTO workflows
           (id, name, spec, pipeline, config, status, github_state, created_at, updated_at)
         VALUES (?, ?, '{}', ?, '{}', 'in_progress', 'idle', ?, ?)`,
      )
      .run(wfId, wfName, PIPELINE, now, now);

    await page.goto(`/workflow/${wfId}`);
    await expect(
      page.getByRole('heading', { level: 1 }).filter({ hasText: wfName }),
    ).toBeVisible({ timeout: 8000 });

    // "Create PR" should NOT be visible for in_progress workflow.
    await expect(page.getByRole('button', { name: 'Create PR' })).not.toBeVisible({
      timeout: 2000,
    });
    // The read-only "GitHub" indicator should be visible instead.
    await expect(page.getByText('GitHub', { exact: true })).toBeVisible({ timeout: 2000 });
  });
});
