/**
 * Smoke tests: WorkflowList sidebar component.
 *
 * Verifies:
 *  - Empty-state message when no workflows
 *  - Workflow rows render with name, status chip, unread badge
 *  - Status dropdown and search input are present
 *  - Clicking a row navigates to /workflow/:id
 *  - Real-time index.update patch via mocked WS frame
 */

import { test, expect } from '@playwright/test';
import { setupWs, mockWorkflowsApi, indexUpdateFrame, WF_ID, WF_NAME } from './helpers';

test('shows empty state when API returns no workflows', async ({ page }) => {
  await setupWs(page);
  await mockWorkflowsApi(page, []);
  await page.goto('/');

  await expect(page.getByText('No workflows yet.')).toBeVisible();
});

test('renders workflow rows with name and status chip', async ({ page }) => {
  await setupWs(page);
  await mockWorkflowsApi(page, [
    { id: WF_ID, name: WF_NAME, status: 'in_progress' },
    { id: 'wf-002', name: 'Another Workflow', status: 'complete' },
  ]);
  await page.goto('/');

  await expect(page.getByText(WF_NAME)).toBeVisible();
  await expect(page.getByText('Another Workflow')).toBeVisible();
  // Status chips — scope to list items to avoid matching the dropdown options
  const firstRow = page.getByRole('listitem').filter({ hasText: WF_NAME });
  const secondRow = page.getByRole('listitem').filter({ hasText: 'Another Workflow' });
  await expect(firstRow.getByText('in_progress')).toBeVisible();
  await expect(secondRow.getByText('complete')).toBeVisible();
});

test('renders unread badge when unreadEvents > 0', async ({ page }) => {
  await setupWs(page);
  await mockWorkflowsApi(page, [
    { id: WF_ID, name: WF_NAME, status: 'in_progress', unreadEvents: 5 },
  ]);
  await page.goto('/');

  await expect(page.getByLabel('5 unread events')).toBeVisible();
});

test('filter bar has status dropdown and search input', async ({ page }) => {
  await setupWs(page);
  await mockWorkflowsApi(page);
  await page.goto('/');

  await expect(page.getByRole('combobox', { name: 'Filter by status' })).toBeVisible();
  await expect(page.getByPlaceholder('Search workflows…')).toBeVisible();
});

test('clicking a workflow row navigates to /workflow/:id', async ({ page }) => {
  await setupWs(page);
  await mockWorkflowsApi(page, [
    { id: WF_ID, name: WF_NAME, status: 'in_progress' },
  ]);
  await page.goto('/');

  await page.getByRole('listitem').click();
  await expect(page).toHaveURL(`/workflow/${WF_ID}`);
});

test('active workflow row is highlighted when navigated to', async ({ page }) => {
  await setupWs(page);
  await mockWorkflowsApi(page, [
    { id: WF_ID, name: WF_NAME, status: 'in_progress' },
  ]);
  await page.goto(`/workflow/${WF_ID}`);

  // The active row uses aria-current="page"
  await expect(page.getByRole('listitem').filter({ hasText: WF_NAME })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('real-time index.update frame patches existing row', async ({ page }) => {
  let capturedWs: Parameters<Parameters<typeof page.routeWebSocket>[1]>[0] | null = null;

  await page.routeWebSocket('**/stream', (ws) => {
    capturedWs = ws;
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'hello',
        seq: 0,
        ts: new Date().toISOString(),
        payload: { serverVersion: '0.1.0', protocolVersion: 1, capabilities: [], heartbeatIntervalMs: 30_000 },
      }),
    );
  });
  await mockWorkflowsApi(page, [
    { id: WF_ID, name: WF_NAME, status: 'in_progress' },
  ]);
  await page.goto('/');

  // Verify initial status
  await expect(page.getByText('in_progress').first()).toBeVisible();

  // Push an index.update frame changing status to "paused"
  await page.evaluate(
    ({ frame }) => {
      // Trigger the WS handler by dispatching the message event
      // (capturedWs.send() is not available in-process; use evaluate to dispatch)
      // Playwright sends from mock, so we use capturedWs in the route.
      void frame; // used below
    },
    { frame: indexUpdateFrame(WF_ID, WF_NAME, 'paused') },
  );

  // The capturedWs is in the Node.js test process; send from there.
  if (capturedWs) {
    (capturedWs as { send: (m: string) => void }).send(
      indexUpdateFrame(WF_ID, WF_NAME, 'paused'),
    );
  }

  // Scope to listitem to avoid matching the "Paused" dropdown option
  await expect(
    page.getByRole('listitem').filter({ hasText: WF_NAME }).getByText('paused'),
  ).toBeVisible();
});
