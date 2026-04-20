/**
 * Playwright spec for feat-item-data-endpoint.
 *
 * NOTE: test-real-backend-fixture (src/web/e2e/fixtures/realBackend.ts) has
 * not been implemented yet, so this spec uses page.route() mocks while
 * exercising the full UI path. When realBackend fixture lands, update to seed
 * items via db.writer and assert against a live server.
 *
 * Covers:
 *   AC-5: selecting an item triggers the data fetch; JSON renders in the
 *         expandable panel when the endpoint returns 200.
 *         "No data available." renders when the endpoint returns 404.
 */

import { test, expect } from '@playwright/test';
import { setupWs, mockWorkflowsApi, snapshotFrame, WF_ID, WF_NAME } from '../helpers';

const ITEM = {
  id: 'item-data-001',
  stageId: 'stage-1',
  displayTitle: 'Feature With Data',
  displaySubtitle: null,
  state: {
    status: 'pending',
    currentPhase: null,
    retryCount: 0,
    blockedReason: null,
  },
};

test.beforeEach(async ({ page }) => {
  await mockWorkflowsApi(page, [{ id: WF_ID, name: WF_NAME, status: 'in_progress' }]);
});

test.describe('feat-item-data-endpoint — FeatureBoard expandable panel', () => {
  test('JSON data renders in expandable section when endpoint returns 200', async ({ page }) => {
    const payload = { description: 'Build the auth layer', priority: 1 };

    // Register item data route AFTER mockWorkflowsApi so it takes priority.
    await page.route('**/api/workflows/*/items/*/data', (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });

    await setupWs(page, (ws) => {
      ws.send(snapshotFrame({ items: [ITEM] }));
    });

    await page.goto(`/workflow/${WF_ID}`);
    await expect(page.getByText(ITEM.displayTitle)).toBeVisible();

    // Select the item — triggers the /data fetch.
    await page.locator(`#item-${ITEM.id}`).click();

    // "▶ Show data" button appears once data is loaded.
    const showBtn = page.getByRole('button', { name: /show data/i });
    await expect(showBtn).toBeVisible();

    // Expand the data panel and assert JSON content renders.
    await showBtn.click();
    const pre = page.locator('pre');
    await expect(pre).toContainText('"description"');
    await expect(pre).toContainText('"Build the auth layer"');
  });

  test('shows "No data available." when endpoint returns 404', async ({ page }) => {
    await page.route('**/api/workflows/*/items/*/data', (route) => {
      void route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'not found' }),
      });
    });

    await setupWs(page, (ws) => {
      ws.send(snapshotFrame({ items: [ITEM] }));
    });

    await page.goto(`/workflow/${WF_ID}`);
    await expect(page.getByText(ITEM.displayTitle)).toBeVisible();

    await page.locator(`#item-${ITEM.id}`).click();

    await expect(page.getByText('No data available.')).toBeVisible();
    await expect(page.getByRole('button', { name: /show data/i })).not.toBeVisible();
  });
});
