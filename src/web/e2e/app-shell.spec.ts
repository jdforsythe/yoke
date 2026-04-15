/**
 * Smoke tests: AppShell layout and connection indicator.
 *
 * Verifies:
 *  - Brand name, sidebar, bell icon render
 *  - Connection indicator transitions from Connecting → Connected on hello
 *  - Version mismatch surfaces when protocolVersion !== 1
 */

import { test, expect } from '@playwright/test';
import { setupWs, mockWorkflowsApi, helloFrame } from './helpers';

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

test('WorkflowListRoute renders empty-state placeholder in main area', async ({ page }) => {
  await setupWs(page);
  await page.goto('/');

  await expect(page.getByText('Select a workflow to get started')).toBeVisible();
});
