/**
 * Smoke tests: feat-macos-deep-link
 *
 * Covers:
 *  - AC-1: /workflow/:id?attention=<id> subscribes and renders attention banner
 *  - AC-2: /workflow/:id/item/:itemId subscribes and scrolls to item card
 *  - AC-3: 2-second pulse highlight animation on deep-linked element (item and attention)
 *  - AC-4: Invalid workflow ID renders "Workflow not found" error page with back link
 *  - AC-5: Deep links work on in-app navigation (not just cold start)
 *  - AC-6: ?attention query param cleared from URL after processing (standalone variant)
 *  - AC-7: Subscribe frame sent exactly once even when navigating to the same
 *          workflow via different route paths (ItemDetailRoute → WorkflowDetailRoute)
 */

import { test, expect } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import {
  setupWs,
  mockWorkflowsApi,
  snapshotFrame,
  helloFrame,
  WF_ID,
  WF_NAME,
} from './helpers';

const ITEM_ID = 'item-dl-001';
const ATTN_ID = 42;

const ATTENTION_FIXTURE = {
  id: ATTN_ID,
  kind: 'validator_fail',
  payload: 'Validation failed for deep-link test',
  createdAt: new Date(Date.now() - 5_000).toISOString(),
};

const ITEM_FIXTURE = {
  id: ITEM_ID,
  stageId: 'stage-1',
  displayTitle: 'Deep Link Item',
  displaySubtitle: null,
  state: {
    status: 'pending' as const,
    currentPhase: null,
    retryCount: 0,
    blockedReason: null,
  },
};

test.beforeEach(async ({ page }) => {
  await mockWorkflowsApi(page, [{ id: WF_ID, name: WF_NAME, status: 'in_progress' }]);
});

// ---------------------------------------------------------------------------
// AC-1 — Attention deep link on cold start
// ---------------------------------------------------------------------------

test('AC-1: /workflow/:id?attention=<id> renders the attention banner on cold start', async ({
  page,
}) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ pendingAttention: [ATTENTION_FIXTURE] }));
  });

  await page.goto(`/workflow/${WF_ID}?attention=${ATTN_ID}`);

  await expect(page.getByRole('region', { name: 'Attention required' })).toBeVisible();
  await expect(page.locator(`#attention-item-${ATTN_ID}`)).toBeVisible();
  await expect(page.getByText('validator_fail')).toBeVisible();
});

test('AC-3: attention deep-link applies 2s pulse highlight to the targeted item', async ({
  page,
}) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ pendingAttention: [ATTENTION_FIXTURE] }));
  });

  await page.goto(`/workflow/${WF_ID}?attention=${ATTN_ID}`);

  const item = page.locator(`#attention-item-${ATTN_ID}`);
  await expect(item).toBeVisible();
  // The 2s pulse CSS class is controlled by data-highlight=true on the element.
  await expect(item).toHaveAttribute('data-highlight', 'true');
});

test('AC-6: ?attention query param is cleared from the URL after cold-start processing', async ({
  page,
}) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ pendingAttention: [ATTENTION_FIXTURE] }));
  });

  await page.goto(`/workflow/${WF_ID}?attention=${ATTN_ID}`);

  // Attention banner should render (param was consumed).
  await expect(page.locator(`#attention-item-${ATTN_ID}`)).toBeVisible();
  // URL param must be removed — history.replaceState cleans it.
  await expect(page).not.toHaveURL(/attention=/);
});

// ---------------------------------------------------------------------------
// AC-2 / AC-3 — Item deep link on cold start
// ---------------------------------------------------------------------------

test('AC-2: /workflow/:id/item/:itemId subscribes and highlights item card on cold start', async ({
  page,
}) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ items: [ITEM_FIXTURE] }));
  });

  await page.goto(`/workflow/${WF_ID}/item/${ITEM_ID}`);

  // Snapshot should load and item card should appear
  await expect(page.getByText('Deep Link Item')).toBeVisible();

  // AC-3: item card receives the 2-second pulse highlight
  const card = page.locator(`#item-${ITEM_ID}`);
  await expect(card).toHaveAttribute('data-highlight', 'true');
});

test('AC-2: item card is automatically selected (stream pane reflects it)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ items: [ITEM_FIXTURE] }));
  });

  await page.goto(`/workflow/${WF_ID}/item/${ITEM_ID}`);

  // FeatureBoard calls onSelectItem(itemId) on deep link — card gets aria-selected=true
  const card = page.locator(`#item-${ITEM_ID}`);
  await expect(card).toHaveAttribute('aria-selected', 'true');
});

// ---------------------------------------------------------------------------
// AC-4 — Invalid workflow shows error page
// ---------------------------------------------------------------------------

test('AC-4: invalid workflow ID renders Workflow not found page with back link', async ({
  page,
}) => {
  // Install fake clock so the 8-second not-found timeout fires instantly.
  await page.clock.install();

  // WS sends hello but never sends a snapshot — simulating an unknown workflow ID.
  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    ws.send(helloFrame());
    // No snapshot sent for subscribe frames → not-found timeout fires.
  });

  await page.goto('/workflow/invalid-wf-id-does-not-exist');

  // Fast-forward past the 8-second timeout
  await page.clock.fastForward(9_000);

  await expect(page.getByText('Workflow not found')).toBeVisible();
  await expect(page.getByText('invalid-wf-id-does-not-exist')).toBeVisible();

  // AC-4: back link is present and points to the workflow list
  const backLink = page.getByRole('link', { name: /Back to workflow list/ });
  await expect(backLink).toBeVisible();
  await expect(backLink).toHaveAttribute('href', '/');
});

test('AC-4: clicking back link from error page navigates to workflow list', async ({ page }) => {
  await page.clock.install();

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    ws.send(helloFrame());
  });

  await page.goto('/workflow/no-such-workflow');
  await page.clock.fastForward(9_000);

  await expect(page.getByText('Workflow not found')).toBeVisible();

  await page.getByRole('link', { name: /Back to workflow list/ }).click();
  await expect(page).toHaveURL('/');
});

// ---------------------------------------------------------------------------
// AC-5 — Deep link works on in-app navigation
// ---------------------------------------------------------------------------

test('AC-5: item deep link works on in-app navigation (history.pushState)', async ({ page }) => {
  // WS mock responds to every subscribe frame with the same snapshot so that
  // both the initial and post-navigation subscriptions receive items.
  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    ws.send(helloFrame());
    ws.onMessage((msg: string | Buffer) => {
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          ws.send(snapshotFrame({ items: [ITEM_FIXTURE] }));
        }
      } catch {
        // malformed — ignore
      }
    });
  });

  // Start at the workflow detail page (cold start)
  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: WF_NAME })).toBeVisible();
  // Item is rendered (from snapshot) but NOT yet deep-linked (no :itemId param)
  await expect(page.getByText('Deep Link Item')).toBeVisible();
  const card = page.locator(`#item-${ITEM_ID}`);
  await expect(card).toHaveAttribute('data-highlight', 'false');

  // Simulate in-app navigation to the item deep link (macOS notification click
  // opens the URL in an already-open tab → React Router handles the route change)
  await page.evaluate(
    ([wfId, itemId]: string[]) => {
      history.pushState({}, '', `/workflow/${wfId}/item/${itemId}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
    [WF_ID, ITEM_ID],
  );

  // After navigation the highlight should be applied (AC-3)
  await expect(card).toHaveAttribute('data-highlight', 'true');
});

// ---------------------------------------------------------------------------
// AC-7 — No duplicate subscribe frames
// ---------------------------------------------------------------------------

test('AC-7: subscribe frame sent exactly once for the same workflow (cold start via ItemDetailRoute)', async ({
  page,
}) => {
  const sentMessages: string[] = [];

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    ws.send(helloFrame());
    ws.onMessage((msg: string | Buffer) => {
      const raw = msg.toString();
      sentMessages.push(raw);
      try {
        const f = JSON.parse(raw) as { type: string };
        if (f.type === 'subscribe') {
          ws.send(snapshotFrame({ items: [ITEM_FIXTURE] }));
        }
      } catch {
        // malformed — ignore
      }
    });
  });

  // Navigate directly to the item deep link (ItemDetailRoute → WorkflowDetailRoute)
  await page.goto(`/workflow/${WF_ID}/item/${ITEM_ID}`);
  await expect(page.getByText('Deep Link Item')).toBeVisible();

  // Exactly one subscribe frame should have been sent (RC-4: dedup checks the
  // active subscription set; calling subscribe() for an already-subscribed
  // workflow must not emit a second frame)
  const subscribes = sentMessages.filter((s) => {
    try {
      return (JSON.parse(s) as { type: string }).type === 'subscribe';
    } catch {
      return false;
    }
  });
  expect(subscribes).toHaveLength(1);
});
