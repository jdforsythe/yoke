/**
 * Regression test: FeatureBoard must not enter an infinite refetch loop
 * when /api/workflows/:id/items/:itemId/data returns a non-ok response
 * (e.g. 404 before the endpoint is implemented).
 *
 * The original bug: fetchingData was useState<Set<string>> and listed in
 * the fetch effect's dependency array. Each mutate produced a new Set
 * reference → re-fired the effect → and since 404 responses were not cached,
 * the effect fetched again forever (flashing UI + console flood).
 *
 * The fix: fetchingData is now a ref (not an effect dep) and non-ok
 * responses are cached as null so the effect short-circuits on re-render.
 *
 * This test mocks the endpoint to always return 404, clicks the item, and
 * asserts exactly one fetch fires during a 2 s window.
 */

import { test, expect } from '@playwright/test';
import { setupWs, mockWorkflowsApi, snapshotFrame, WF_ID, WF_NAME } from './helpers';

test.beforeEach(async ({ page }) => {
  await mockWorkflowsApi(page, [{ id: WF_ID, name: WF_NAME, status: 'in_progress' }]);
});

test('does not loop when item.data endpoint returns 404', async ({ page }) => {
  let fetchCount = 0;

  await page.route('**/api/workflows/*/items/*/data', async (route) => {
    fetchCount++;
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'not found' }),
    });
  });

  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        items: [
          {
            id: 'item-1',
            stageId: 'stage-1',
            displayTitle: 'Missing-Data Feature',
            displaySubtitle: null,
            state: {
              status: 'pending',
              currentPhase: null,
              retryCount: 0,
              blockedReason: null,
            },
          },
        ],
      }),
    );
  });

  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByText('Missing-Data Feature')).toBeVisible();

  // Select the item → triggers the item.data fetch.
  await page.locator('#item-item-1').click();

  // Wait long enough that any refetch loop would have fired dozens of times.
  // The whole point is to confirm *nothing happens* during this window.
  await page.waitForTimeout(2000);

  // Exactly one fetch — no loop.
  expect(fetchCount).toBe(1);

  // UI renders the graceful fallback, not "Loading data…".
  await expect(page.getByText('No data available.')).toBeVisible();
  await expect(page.getByText('Loading data…')).not.toBeVisible();
});
