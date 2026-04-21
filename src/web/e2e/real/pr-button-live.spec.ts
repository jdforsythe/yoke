/**
 * Real-backend Playwright spec for r2-12 — GithubButton live WS transitions.
 *
 * AC-3: Asserts the button transitions idle → Creating PR spinner → PR #N
 *       in response to WS workflow.update frames injected via backend.broadcast(),
 *       without a page reload.
 *
 * The spec uses backend.broadcast() to inject workflow.update frames that patch
 * snapshot.workflow.githubState.  WorkflowDetailRoute's WS handler spreads the
 * patch over the existing state, which React re-renders into GithubButton.
 */

import { test, expect } from '../fixtures/realBackend.js';
import { randomUUID } from 'node:crypto';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'stage-1', run: 'once', phases: ['implement'] }],
});

test.describe('GithubButton live transitions — real backend', () => {
  test('button transitions idle → Creating PR spinner → PR #N via WS frames without reload', async ({
    page,
    backend,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const wfId = `wf-pr-live-${suffix}`;
    const wfName = `PR Button Live ${suffix}`;
    const now = new Date().toISOString();

    backend.db.writer
      .prepare(
        `INSERT INTO workflows
           (id, name, spec, pipeline, config, status, created_at, updated_at)
         VALUES (?, ?, '{}', ?, '{}', 'completed', ?, ?)`,
      )
      .run(wfId, wfName, PIPELINE, now, now);

    await page.goto(`/workflow/${wfId}`);

    // Wait for the WS snapshot to arrive (workflow name in header).
    await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: wfName })).toBeVisible({
      timeout: 8000,
    });

    // --- Step 1: inject idle state ---
    backend.broadcast(wfId, null, 'workflow.update', {
      githubState: { status: 'idle', lastCheckedAt: now },
    });
    // completed + idle → GithubButton renders "Create PR" button
    const createPrBtn = page.getByRole('button', { name: 'Create PR', exact: true });
    await expect(createPrBtn).toBeVisible({ timeout: 3000 });

    // --- Step 2: inject creating state ---
    backend.broadcast(wfId, null, 'workflow.update', {
      githubState: { status: 'creating', lastCheckedAt: new Date().toISOString() },
    });
    // GithubButton for 'creating' renders "Creating PR…" text with spinner
    await expect(page.getByText('Creating PR…')).toBeVisible({ timeout: 3000 });
    // The "Create PR" button should no longer be visible
    await expect(createPrBtn).not.toBeVisible({ timeout: 1000 });

    // --- Step 3: inject created state ---
    const prUrl = `https://github.com/test/test/pull/42`;
    backend.broadcast(wfId, null, 'workflow.update', {
      githubState: {
        status: 'created',
        prNumber: 42,
        prUrl,
        lastCheckedAt: new Date().toISOString(),
      },
    });
    // GithubButton for 'created' renders "PR #42" link
    const prLink = page.getByRole('link', { name: /PR #42/ });
    await expect(prLink).toBeVisible({ timeout: 3000 });
    // Spinner should be gone
    await expect(page.getByText('Creating PR…')).not.toBeVisible({ timeout: 1000 });
  });
});
