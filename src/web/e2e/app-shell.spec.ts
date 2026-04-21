/**
 * Smoke tests: AppShell layout and connection indicator.
 *
 * Verifies:
 *  - Brand name, sidebar, bell icon render
 *  - Connection indicator transitions from Connecting → Connected on hello
 *  - Version mismatch surfaces when protocolVersion !== 1
 *  - Bell badge count is derived from pendingAttention array length (RC2)
 */

import { test, expect } from '@playwright/test';
import { setupWs, mockWorkflowsApi, snapshotFrame, helloFrame, WF_ID } from './helpers';

test.beforeEach(async ({ page }) => {
  // Stub the REST API so WorkflowList doesn't show fetch errors.
  await mockWorkflowsApi(page);
});

test('renders brand name, search sidebar, and bell icon', async ({ page }) => {
  await setupWs(page);
  await page.goto('/');

  await expect(page.getByText('Yoke')).toBeVisible();
  await expect(page.getByPlaceholder('Search workflows…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
});

test('connection indicator shows Connected after hello', async ({ page }) => {
  await setupWs(page);
  await page.goto('/');

  await expect(page.getByText('Connected')).toBeVisible();
});

test('connection indicator shows Connecting when hello is not sent', async ({ page }) => {
  // Intercept WS but send nothing.
  await page.routeWebSocket('**/stream', () => {
    /* hold connection open without sending hello */
  });
  await page.goto('/');

  await expect(page.getByText(/Connecting/)).toBeVisible();
});

test('connection indicator shows Version mismatch when protocolVersion is wrong', async ({ page }) => {
  await page.routeWebSocket('**/stream', (ws) => {
    // Send hello with wrong protocol version.
    ws.send(helloFrame(2));
  });
  await page.goto('/');

  await expect(page.getByText('Version mismatch')).toBeVisible();
});

test('WorkflowListRoute renders template picker empty-state in main area', async ({ page }) => {
  await setupWs(page);
  // Return an empty template list so the empty-state copy is shown.
  await page.route('**/api/templates', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ templates: [] }),
    }),
  );
  await page.goto('/');

  await expect(page.getByTestId('empty-state')).toBeVisible();
});

test('bell badge shows count derived from pendingAttention array length in snapshot', async ({ page }) => {
  // feat-attention-banner RC2: badge must be derived from array length, not a separate counter.
  await mockWorkflowsApi(page, [{ id: WF_ID, name: 'Test Workflow', status: 'in_progress' }]);
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({
      pendingAttention: [
        { id: 1, kind: 'approval', payload: null, createdAt: new Date().toISOString() },
        { id: 2, kind: 'review', payload: null, createdAt: new Date().toISOString() },
      ],
    }));
  });
  await page.goto(`/workflow/${WF_ID}`);

  // Badge on the bell button must show "2" (the pendingAttention array length).
  const bell = page.getByRole('button', { name: 'Notifications' });
  await expect(bell.locator('span').filter({ hasText: '2' })).toBeVisible();
});

test('bell badge clears when navigating away from workflow', async ({ page }) => {
  await mockWorkflowsApi(page, [{ id: WF_ID, name: 'Test Workflow', status: 'in_progress' }]);
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({
      pendingAttention: [
        { id: 1, kind: 'approval', payload: null, createdAt: new Date().toISOString() },
      ],
    }));
  });
  await page.goto(`/workflow/${WF_ID}`);

  // Badge shows while on the workflow page.
  const bell = page.getByRole('button', { name: 'Notifications' });
  await expect(bell.locator('span').filter({ hasText: '1' })).toBeVisible();

  // Navigate back to the list — WorkflowDetailRoute unmounts and resets count to 0.
  await page.getByRole('button', { name: /Back to workflow list/ }).click();
  await expect(bell.locator('span')).not.toBeVisible();
});
