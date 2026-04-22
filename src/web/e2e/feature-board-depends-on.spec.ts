/**
 * Regression test: FeatureBoard surfaces `dependsOn` as a "Waiting on: …"
 * line for pending/blocked items whose dependencies have not completed,
 * and hides the line when a pushed `item.state` frame flips the dependency
 * to `complete`.
 *
 * Also verifies the description line renders from displayDescription.
 */

import { test, expect } from '@playwright/test';
import {
  setupWs,
  mockWorkflowsApi,
  snapshotFrame,
  itemStateFrame,
  WF_ID,
  WF_NAME,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await mockWorkflowsApi(page, [{ id: WF_ID, name: WF_NAME, status: 'in_progress' }]);
});

test('renders description and Waiting-on line for a pending item with unmet deps', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        stages: [
          {
            id: 'stage-1',
            run: 'per-item',
            phases: ['implement'],
            status: 'in_progress',
            needsApproval: false,
          },
        ],
        items: [
          {
            id: 'row-a',
            stageId: 'stage-1',
            stableId: 'feat-a',
            displayTitle: 'Feature A',
            displaySubtitle: null,
            displayDescription: 'Wire the A path',
            dependsOn: [],
            state: {
              status: 'in_progress',
              currentPhase: 'implement',
              retryCount: 0,
              blockedReason: null,
            },
          },
          {
            id: 'row-b',
            stageId: 'stage-1',
            stableId: 'feat-b',
            displayTitle: 'Feature B',
            displaySubtitle: null,
            displayDescription: 'Depends on A',
            dependsOn: ['feat-a'],
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
  await expect(page.getByText('Feature A')).toBeVisible();
  await expect(page.getByText('Feature B')).toBeVisible();

  // Description renders for both items.
  const descriptions = page.getByTestId('item-description');
  await expect(descriptions).toHaveCount(2);
  await expect(descriptions.nth(0)).toHaveText('Wire the A path');
  await expect(descriptions.nth(1)).toHaveText('Depends on A');

  // Only B is pending with an unmet dep → only one "Waiting on" line.
  const waitingOn = page.getByTestId('item-waiting-on');
  await expect(waitingOn).toHaveCount(1);
  await expect(waitingOn).toHaveText('Waiting on: feat-a');
});

test('Waiting-on line disappears once the dep completes', async ({ page }) => {
  let wsRef: import('@playwright/test').WebSocketRoute | undefined;

  await setupWs(page, (ws) => {
    wsRef = ws;
    ws.send(
      snapshotFrame({
        stages: [
          {
            id: 'stage-1',
            run: 'per-item',
            phases: ['implement'],
            status: 'in_progress',
            needsApproval: false,
          },
        ],
        items: [
          {
            id: 'row-a',
            stageId: 'stage-1',
            stableId: 'feat-a',
            displayTitle: 'Feature A',
            displaySubtitle: null,
            dependsOn: [],
            state: {
              status: 'in_progress',
              currentPhase: 'implement',
              retryCount: 0,
              blockedReason: null,
            },
          },
          {
            id: 'row-b',
            stageId: 'stage-1',
            stableId: 'feat-b',
            displayTitle: 'Feature B',
            displaySubtitle: null,
            dependsOn: ['feat-a'],
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

  // Initially the Waiting-on line is present.
  await expect(page.getByTestId('item-waiting-on')).toHaveText('Waiting on: feat-a');

  // Push item.state flipping A to complete — B's dep is now satisfied.
  await expect.poll(() => wsRef !== undefined).toBe(true);
  wsRef!.send(
    itemStateFrame({
      itemId: 'row-a',
      stageId: 'stage-1',
      state: { status: 'complete' },
    }),
  );

  // Waiting-on line disappears.
  await expect(page.getByTestId('item-waiting-on')).toHaveCount(0);
});

test('blocked badge tooltip rewrites UUID to stable ID', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        stages: [
          {
            id: 'stage-1',
            run: 'per-item',
            phases: ['implement'],
            status: 'in_progress',
            needsApproval: false,
          },
        ],
        items: [
          {
            id: 'row-a',
            stageId: 'stage-1',
            stableId: 'feat-a',
            displayTitle: 'Feature A',
            displaySubtitle: null,
            dependsOn: [],
            state: {
              status: 'awaiting_user',
              currentPhase: null,
              retryCount: 0,
              blockedReason: null,
            },
          },
          {
            id: 'row-b',
            stageId: 'stage-1',
            stableId: 'feat-b',
            displayTitle: 'Feature B',
            displaySubtitle: null,
            dependsOn: ['feat-a'],
            state: {
              // backend sets this in the "dependency <rowUuid> <state>" form
              status: 'blocked',
              currentPhase: null,
              retryCount: 0,
              blockedReason: 'dependency row-a awaiting_user',
            },
          },
        ],
      }),
    );
  });

  await page.goto(`/workflow/${WF_ID}`);
  const badge = page.getByTestId('item-blocked-badge');
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveAttribute('title', 'dependency feat-a awaiting_user');
});
