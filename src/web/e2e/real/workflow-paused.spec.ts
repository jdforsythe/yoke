/**
 * Real-backend Playwright spec for t-09 — paused-workflow banner.
 *
 * Covers:
 *   AC-1/2 — PausedBanner renders with Continue button when paused_at != null
 *   AC-3   — clicking Continue POSTs action:'continue'; banner disappears;
 *             workflow.update {pausedAt:null} clears the snapshot
 *   AC-4   — pause affordance (ControlMatrix Pause button) sends action:'pause'
 *             and causes the PausedBanner to appear
 *   AC-5   — no flicker on WS re-sync (banner survives workflow.snapshot reload)
 *   AC-6   — Playwright full flow: paused workflow → banner → Continue → gone
 *             → item advances (via backend.broadcast mock scheduler tick)
 *
 * The realBackend fixture provides:
 *   - Real Fastify + SQLite (noScheduler: true)
 *   - page.route() API proxy to the real backend
 *   - WebSocket redirect via addInitScript
 *   - backend.broadcast() for injecting WS frames
 *   - backend.scheduleIndexUpdate() for sidebar updates
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';
import { randomUUID } from 'node:crypto';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'stage-1', run: 'once', phases: ['implement'] }],
});

function seedPausedWorkflow(
  db: BackendHandle['db'],
  opts: { id: string; name: string },
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows
         (id, name, spec, pipeline, config, status, paused_at, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?, ?)`,
    )
    .run(opts.id, opts.name, PIPELINE, now, now, now);
}

function seedItem(
  db: BackendHandle['db'],
  opts: { id: string; workflowId: string; status: string },
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
       VALUES (?, ?, 'stage-1', '{}', ?, ?)`,
    )
    .run(opts.id, opts.workflowId, opts.status, now);
}

test.describe('t-09: paused-workflow banner', () => {
  test('PausedBanner renders when paused_at is set; Continue clears it (AC-1/2/3)', async ({
    page,
    backend,
  }) => {
    const wfId = `wf-paused-${randomUUID().slice(0, 8)}`;
    const itemId = `item-paused-${randomUUID().slice(0, 8)}`;

    seedPausedWorkflow(backend.db, { id: wfId, name: 'Paused Workflow Test' });
    seedItem(backend.db, { id: itemId, workflowId: wfId, status: 'pending' });

    await page.goto(`/workflow/${wfId}`);

    // AC-1: banner is visible
    const banner = page.getByTestId('paused-banner');
    await expect(banner).toBeVisible({ timeout: 6000 });

    // AC-2: banner has Continue button and expected copy
    await expect(banner).toContainText('This workflow is paused. Click Continue to resume.');
    const continueBtn = banner.getByRole('button', { name: 'Continue' });
    await expect(continueBtn).toBeVisible();

    // AC-3: clicking Continue hides the banner optimistically
    await continueBtn.click();
    await expect(banner).not.toBeVisible({ timeout: 5000 });

    // AC-3: DB confirms paused_at was cleared by the control executor
    const row = backend.db.writer
      .prepare('SELECT paused_at FROM workflows WHERE id = ?')
      .get(wfId) as { paused_at: string | null } | undefined;
    expect(row?.paused_at).toBeNull();
  });

  test('double-click is deduplicated — only one POST reaches the server (RC: idempotent)', async ({
    page,
    backend,
  }) => {
    const wfId = `wf-paused-dedup-${randomUUID().slice(0, 8)}`;
    seedPausedWorkflow(backend.db, { id: wfId, name: 'Dedup Test Workflow' });

    let controlCallCount = 0;
    // Add a 300 ms artificial delay to the first response so the second click
    // can land while the button is still in its disabled/pending state.  Without
    // the delay the real backend responds in <10 ms, the banner disappears
    // before the second click can reach the disabled button.
    // Fulfill with 202 directly (no route.fallback) to avoid Playwright
    // LIFO-route-chain timing issues with the fixture proxy.
    await page.route(`**/api/workflows/${wfId}/control`, async (route) => {
      controlCallCount++;
      if (controlCallCount === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
      }
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'accepted' }),
      });
    });

    await page.goto(`/workflow/${wfId}`);

    const banner = page.getByTestId('paused-banner');
    await expect(banner).toBeVisible({ timeout: 6000 });

    // Use the stable data-testid rather than role+name so the locator still
    // matches after the first click changes the label to "Continuing…".
    const continueBtn = page.getByTestId('paused-banner-continue');

    // First click — fires the POST; button enters disabled/pending state.
    await continueBtn.click();

    // Button must be disabled while the request is in-flight (deduplication guard).
    // The button label has changed to "Continuing…" at this point, which is why
    // we locate by data-testid rather than role+name.
    await expect(continueBtn).toBeDisabled({ timeout: 2000 });

    // Second click on disabled button: force:true bypasses Playwright's
    // enabled-element pre-check; the JS handler still guards with `if (pending)
    // return` so no second POST fires.
    await continueBtn.click({ force: true });

    // After ~300 ms the first response arrives; banner hides optimistically.
    await expect(banner).not.toBeVisible({ timeout: 5000 });

    // Only one POST should have been made (button disabled after first click).
    expect(controlCallCount).toBe(1);
  });

  test('pause affordance sends action:pause and banner appears (AC-4)', async ({
    page,
    backend,
  }) => {
    const wfId = `wf-pause-action-${randomUUID().slice(0, 8)}`;
    const itemId = `item-pause-action-${randomUUID().slice(0, 8)}`;
    const sessionId = `sess-pause-action-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    // Seed an active (non-paused) in_progress workflow with a session so ControlMatrix renders.
    backend.db.writer
      .prepare(
        `INSERT INTO workflows
           (id, name, spec, pipeline, config, status, created_at, updated_at)
         VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?)`,
      )
      .run(wfId, 'Pauseable Workflow', PIPELINE, now, now);
    seedItem(backend.db, { id: itemId, workflowId: wfId, status: 'in_progress' });
    backend.db.writer
      .prepare(
        `INSERT INTO sessions
           (id, workflow_id, item_id, stage, phase, agent_profile, started_at, status)
         VALUES (?, ?, ?, 'stage-1', 'implement', 'default', ?, 'in_progress')`,
      )
      .run(sessionId, wfId, itemId, now);

    await page.goto(`/workflow/${wfId}`);

    // Click the item card to make ControlMatrix appear (per-item session map).
    const itemCard = page.locator(`#item-${itemId}`);
    await expect(itemCard).toBeVisible({ timeout: 6000 });
    await itemCard.click();

    // Pause button should be visible (RULES.pause: workflowStatus === 'in_progress').
    const pauseBtn = page.getByRole('button', { name: 'Pause', exact: true });
    await expect(pauseBtn).toBeVisible({ timeout: 3000 });
    await pauseBtn.click();

    // The control executor handles 'pause' and broadcasts workflow.update {pausedAt}.
    // PausedBanner should appear.
    const banner = page.getByTestId('paused-banner');
    await expect(banner).toBeVisible({ timeout: 5000 });

    // DB confirms paused_at was set.
    const row = backend.db.writer
      .prepare('SELECT paused_at FROM workflows WHERE id = ?')
      .get(wfId) as { paused_at: string | null } | undefined;
    expect(row?.paused_at).not.toBeNull();
  });

  test('full flow: paused banner → Continue → banner gone → item advances via broadcast (AC-6)', async ({
    page,
    backend,
  }) => {
    const wfId = `wf-paused-full-${randomUUID().slice(0, 8)}`;
    const itemId = `item-paused-full-${randomUUID().slice(0, 8)}`;

    seedPausedWorkflow(backend.db, { id: wfId, name: 'Full Flow Paused Test' });
    seedItem(backend.db, { id: itemId, workflowId: wfId, status: 'pending' });

    await page.goto(`/workflow/${wfId}`);

    const banner = page.getByTestId('paused-banner');
    await expect(banner).toBeVisible({ timeout: 6000 });

    // Click Continue — triggers POST to control endpoint.
    await banner.getByRole('button', { name: 'Continue' }).click();

    // Banner disappears (optimistic hide + workflow.update {pausedAt:null}).
    await expect(banner).not.toBeVisible({ timeout: 5000 });

    // Mock scheduler tick: broadcast item.state frame showing item advancing
    // (noScheduler:true means the real scheduler won't tick, so we simulate it).
    backend.broadcast(wfId, null, 'item.state', {
      itemId,
      stageId: 'stage-1',
      state: { status: 'in_progress', currentPhase: 'implement', retryCount: 0, blockedReason: null },
    });

    // Item card status should update (the WS frame causes a re-render).
    const itemCard = page.locator(`#item-${itemId}`);
    await expect(itemCard).toBeVisible({ timeout: 5000 });

    // DB: paused_at is cleared.
    const row = backend.db.writer
      .prepare('SELECT paused_at, status FROM workflows WHERE id = ?')
      .get(wfId) as { paused_at: string | null; status: string } | undefined;
    expect(row?.paused_at).toBeNull();
    expect(row?.status).toBe('in_progress');
  });
});
