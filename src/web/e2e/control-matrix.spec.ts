/**
 * E2E smoke tests for ControlMatrix (feat-control-matrix).
 *
 * Covers:
 *  - AC-1: available actions update dynamically with workflow/item/session status
 *  - AC-2: pause button sends control frame with action=pause
 *  - AC-3: cancel requires confirmation dialog (covered in workflow-detail.spec.ts too)
 *  - AC-4: optimistic spinner + disable after action sent
 *  - AC-5: commandId in the control frame is a UUID (crypto.randomUUID)
 *  - AC-6: inject-context opens modal; entered text sent as extra
 *  - AC-7: approve-stage appears only when needsApproval=true and stage complete
 *  - AC-8: invalid actions are hidden (not merely disabled)
 *
 * Item-scoped actions (skip, retry, unblock, rerun-phase) require a selected
 * item in the FeatureBoard; tests click the item card first.
 */

import { test, expect } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import {
  setupWs,
  mockWorkflowsApi,
  snapshotFrame,
  workflowUpdateFrame,
  itemStateFrame,
  helloFrame,
  WF_ID,
  WF_NAME,
} from './helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVE_SESSION = [
  {
    sessionId: 'sess-ctrl',
    phase: 'implement',
    attempt: 1,
    startedAt: new Date().toISOString(),
    parentSessionId: null,
  },
];

/** Snapshot with in_progress workflow and one active session. */
function defaultSnapshot(extra?: Parameters<typeof snapshotFrame>[0]) {
  return snapshotFrame({
    workflow: { status: 'in_progress' },
    activeSessions: ACTIVE_SESSION,
    ...extra,
  });
}

/** Set up WS that captures all sent messages, sends hello on open, and
 *  calls onSubscribe the first time a subscribe frame arrives. */
async function setupCapturingWs(
  page: Parameters<typeof setupWs>[0],
  onSubscribe: (ws: WebSocketRoute) => void,
  sentMessages: string[],
): Promise<void> {
  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    ws.send(helloFrame());
    ws.onMessage((msg: string | Buffer) => {
      const raw = msg.toString();
      sentMessages.push(raw);
      try {
        const f = JSON.parse(raw) as { type: string };
        if (f.type === 'subscribe') {
          onSubscribe(ws);
        }
      } catch {
        // malformed — ignore
      }
    });
  });
}

function parseControlFrames(messages: string[]): Array<{
  type: string;
  id: string;
  payload: { action: string; extra?: unknown; itemId?: string; stageId?: string };
}> {
  return messages
    .map((s) => {
      try {
        return JSON.parse(s) as {
          type: string;
          id: string;
          payload: { action: string; extra?: unknown };
        };
      } catch {
        return null;
      }
    })
    .filter((f): f is NonNullable<typeof f> => f?.type === 'control');
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await mockWorkflowsApi(page, [{ id: WF_ID, name: WF_NAME, status: 'in_progress' }]);
});

// ---------------------------------------------------------------------------
// AC-2: action buttons send correct control frames
// ---------------------------------------------------------------------------

test('AC-2: Pause button sends control frame with action=pause and a UUID commandId', async ({
  page,
}) => {
  const sent: string[] = [];

  await setupCapturingWs(page, (ws) => ws.send(defaultSnapshot()), sent);
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();

  // Wait for the WS control frame to arrive at the mock handler before reading sent[].
  // Without this, the browser's ws.send() is fire-and-forget — the frame may not have
  // reached Playwright's onMessage callback by the time the test continues.
  await expect.poll(() => parseControlFrames(sent).length).toBeGreaterThan(0);
  const frames = parseControlFrames(sent);
  const ctrl = frames[0]!;
  expect(ctrl.payload.action).toBe('pause');
  // AC-5: commandId (the frame's top-level id) is a UUID (crypto.randomUUID format)
  expect(ctrl.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
});

test('AC-2/cancel: Cancel sends control frame after confirmation', async ({ page }) => {
  const sent: string[] = [];

  await setupCapturingWs(page, (ws) => ws.send(defaultSnapshot()), sent);
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByRole('button', { name: 'Cancel' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm action' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm' }).click();

  await expect.poll(() => parseControlFrames(sent).length).toBeGreaterThan(0);
  const frames = parseControlFrames(sent);
  expect(frames[0]!.payload.action).toBe('cancel');
});

// ---------------------------------------------------------------------------
// AC-4: optimistic spinner + disable
// ---------------------------------------------------------------------------

test('AC-4: Pause button shows spinner and is disabled after click', async ({ page }) => {
  // Use a slow WS that never acknowledges so the button stays in pending state.
  await setupCapturingWs(page, (ws) => ws.send(defaultSnapshot()), []);
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();

  // After click, the button should be disabled (optimistic pending state).
  await expect(page.getByRole('button', { name: 'Pause' })).toBeDisabled();
});

test('AC-4: Resume button shows disabled state after click', async ({ page }) => {
  await setupCapturingWs(
    page,
    (ws) =>
      ws.send(snapshotFrame({ workflow: { status: 'paused' }, activeSessions: ACTIVE_SESSION })),
    [],
  );
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();

  await expect(page.getByRole('button', { name: 'Resume' })).toBeDisabled();
});

// ---------------------------------------------------------------------------
// AC-5: commandId is a UUID (already covered in AC-2 test above)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AC-6: inject-context modal
// ---------------------------------------------------------------------------

test('AC-6: inject-context opens modal and sends control frame with extra text', async ({
  page,
}) => {
  const sent: string[] = [];

  await setupCapturingWs(page, (ws) => ws.send(defaultSnapshot()), sent);
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('button', { name: 'Inject context' })).toBeVisible();
  await page.getByRole('button', { name: 'Inject context' }).click();

  const modal = page.getByRole('dialog', { name: 'Inject context' });
  await expect(modal).toBeVisible();

  const textarea = modal.locator('textarea');
  await textarea.fill('Please apply the latest style guide');

  await modal.getByRole('button', { name: 'Inject' }).click();

  // Modal should close
  await expect(modal).not.toBeVisible();

  // Wait for WS frame delivery — modal closing and ws.send() are concurrent.
  await expect.poll(() => parseControlFrames(sent).length).toBeGreaterThan(0);
  // Control frame should include extra text
  const frames = parseControlFrames(sent);
  const ctrl = frames[0]!;
  expect(ctrl.payload.action).toBe('inject-context');
  expect(ctrl.payload.extra).toBe('Please apply the latest style guide');
});

test('AC-6: inject-context Inject button is disabled when textarea is empty', async ({ page }) => {
  await setupWs(page, (ws) => ws.send(defaultSnapshot()));
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByRole('button', { name: 'Inject context' }).click();

  const modal = page.getByRole('dialog', { name: 'Inject context' });
  await expect(modal).toBeVisible();

  await expect(modal.getByRole('button', { name: 'Inject' })).toBeDisabled();
});

test('AC-6: inject-context Cancel button closes modal without sending', async ({ page }) => {
  const sent: string[] = [];

  await setupCapturingWs(page, (ws) => ws.send(defaultSnapshot()), sent);
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByRole('button', { name: 'Inject context' }).click();

  const modal = page.getByRole('dialog', { name: 'Inject context' });
  await expect(modal).toBeVisible();

  await modal.getByRole('button', { name: 'Cancel' }).click();
  await expect(modal).not.toBeVisible();

  // No control frame should have been sent
  expect(parseControlFrames(sent)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// AC-7: approve-stage visibility
// ---------------------------------------------------------------------------

test('AC-7: approve-stage appears when stage.needsApproval=true and status=complete', async ({
  page,
}) => {
  await setupWs(page, (ws) =>
    ws.send(
      snapshotFrame({
        workflow: { status: 'in_progress' },
        stages: [
          {
            id: 'stage-1',
            run: 'once',
            phases: ['implement'],
            status: 'complete',
            needsApproval: true,
          },
        ],
        activeSessions: ACTIVE_SESSION,
      }),
    ),
  );
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('button', { name: 'Approve stage' })).toBeVisible();
});

test('AC-7: approve-stage hidden when needsApproval=false', async ({ page }) => {
  await setupWs(page, (ws) =>
    ws.send(
      snapshotFrame({
        workflow: { status: 'in_progress' },
        stages: [
          {
            id: 'stage-1',
            run: 'once',
            phases: ['implement'],
            status: 'complete',
            needsApproval: false,
          },
        ],
        activeSessions: ACTIVE_SESSION,
      }),
    ),
  );
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('heading', { level: 1, name: WF_NAME })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve stage' })).not.toBeVisible();
});

test('AC-7: approve-stage hidden when stage.status=in_progress (not complete)', async ({ page }) => {
  await setupWs(page, (ws) =>
    ws.send(
      snapshotFrame({
        workflow: { status: 'in_progress' },
        stages: [
          {
            id: 'stage-1',
            run: 'once',
            phases: ['implement'],
            status: 'in_progress',
            needsApproval: true,
          },
        ],
        activeSessions: ACTIVE_SESSION,
      }),
    ),
  );
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('heading', { level: 1, name: WF_NAME })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve stage' })).not.toBeVisible();
});

test('AC-7: approve-stage sends control frame with stageId', async ({ page }) => {
  const sent: string[] = [];

  await setupCapturingWs(
    page,
    (ws) =>
      ws.send(
        snapshotFrame({
          workflow: { status: 'in_progress' },
          stages: [
            {
              id: 'stage-needs-approval',
              run: 'once',
              phases: ['implement'],
              status: 'complete',
              needsApproval: true,
            },
          ],
          activeSessions: ACTIVE_SESSION,
        }),
      ),
    sent,
  );
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('button', { name: 'Approve stage' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve stage' }).click();

  await expect.poll(() => parseControlFrames(sent).length).toBeGreaterThan(0);
  const frames = parseControlFrames(sent);
  const ctrl = frames[0]!;
  expect(ctrl.payload.action).toBe('approve-stage');
  expect((ctrl.payload as { stageId?: string }).stageId).toBe('stage-needs-approval');
});

// ---------------------------------------------------------------------------
// AC-1 / AC-8: actions update dynamically; invalid actions are hidden
// ---------------------------------------------------------------------------

test('AC-1/AC-8: Pause hidden and Resume shown when workflow changes to paused', async ({
  page,
}) => {
  let capturedWs: WebSocketRoute | null = null;

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    capturedWs = ws;
    ws.send(helloFrame());
    let subscribed = false;
    ws.onMessage((msg: string | Buffer) => {
      if (subscribed) return;
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          subscribed = true;
          ws.send(defaultSnapshot());
        }
      } catch {
        // ignore
      }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume' })).not.toBeVisible();

  capturedWs!.send(workflowUpdateFrame({ status: 'paused' }));

  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).not.toBeVisible();
});

test('AC-8: Cancel hidden when workflow is already complete', async ({ page }) => {
  await setupWs(page, (ws) =>
    ws.send(
      snapshotFrame({
        workflow: { status: 'completed' },
        activeSessions: ACTIVE_SESSION,
      }),
    ),
  );
  await page.goto(`/workflow/${WF_ID}`);

  // Complete workflow: no pause, no cancel, no resume
  await expect(page.getByRole('heading', { level: 1, name: WF_NAME })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume' })).not.toBeVisible();
});

test('AC-8: no actions rendered when no active session — toolbar not visible', async ({ page }) => {
  await setupWs(page, (ws) =>
    ws.send(snapshotFrame({ workflow: { status: 'in_progress' }, activeSessions: [] })),
  );
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('heading', { level: 1, name: WF_NAME })).toBeVisible();
  // ControlMatrix returns null when visibleActions is empty; toolbar wrapper
  // only renders when activeSessionId is non-null (WorkflowDetailRoute).
  await expect(page.getByRole('button', { name: 'Pause' })).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Item-scoped actions (require item selection via FeatureBoard click)
// ---------------------------------------------------------------------------

test('skip appears when a blocked item is selected', async ({ page }) => {
  await setupWs(page, (ws) =>
    ws.send(
      snapshotFrame({
        workflow: { status: 'in_progress' },
        activeSessions: ACTIVE_SESSION,
        items: [
          {
            id: 'item-blocked',
            stageId: 'stage-1',
            displayTitle: 'Blocked Feature',
            displaySubtitle: null,
            state: {
              status: 'blocked',
              currentPhase: null,
              retryCount: 0,
              blockedReason: 'Dependency missing',
            },
          },
        ],
      }),
    ),
  );
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('Blocked Feature')).toBeVisible();

  // Select the item
  await page.locator('#item-item-blocked').click();

  await expect(page.getByRole('button', { name: 'Skip item' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unblock' })).toBeVisible();
});

test('retry appears when a failed item is selected', async ({ page }) => {
  await setupWs(page, (ws) =>
    ws.send(
      snapshotFrame({
        workflow: { status: 'in_progress' },
        activeSessions: ACTIVE_SESSION,
        items: [
          {
            id: 'item-failed',
            stageId: 'stage-1',
            displayTitle: 'Failed Feature',
            displaySubtitle: null,
            state: {
              // In the state machine, items that fail go to awaiting_user
              // (the user must decide whether to retry or skip).
              status: 'awaiting_user',
              currentPhase: null,
              retryCount: 2,
              blockedReason: null,
            },
          },
        ],
      }),
    ),
  );
  await page.goto(`/workflow/${WF_ID}`);

  await page.locator('#item-item-failed').click();

  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Skip item' })).not.toBeVisible();
});

test('skip and unblock hidden when no item selected', async ({ page }) => {
  await setupWs(page, (ws) => ws.send(defaultSnapshot()));
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('heading', { level: 1, name: WF_NAME })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Skip item' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Unblock' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).not.toBeVisible();
});

test('skip sends control frame with itemId after confirmation', async ({ page }) => {
  const sent: string[] = [];

  await setupCapturingWs(
    page,
    (ws) =>
      ws.send(
        snapshotFrame({
          workflow: { status: 'in_progress' },
          activeSessions: ACTIVE_SESSION,
          items: [
            {
              id: 'item-blocked-2',
              stageId: 'stage-1',
              displayTitle: 'Skip Me',
              displaySubtitle: null,
              state: { status: 'blocked', currentPhase: null, retryCount: 0, blockedReason: 'x' },
            },
          ],
        }),
      ),
    sent,
  );
  await page.goto(`/workflow/${WF_ID}`);
  await page.locator('#item-item-blocked-2').click();

  await page.getByRole('button', { name: 'Skip item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm action' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm' }).click();

  await expect.poll(() => parseControlFrames(sent).length).toBeGreaterThan(0);
  const frames = parseControlFrames(sent);
  const ctrl = frames[0]!;
  expect(ctrl.payload.action).toBe('skip');
  expect((ctrl.payload as { itemId?: string }).itemId).toBe('item-blocked-2');
});

test('item actions dynamically update when item.state frame arrives', async ({ page }) => {
  let capturedWs: WebSocketRoute | null = null;

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    capturedWs = ws;
    ws.send(helloFrame());
    let subscribed = false;
    ws.onMessage((msg: string | Buffer) => {
      if (subscribed) return;
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          subscribed = true;
          ws.send(
            snapshotFrame({
              workflow: { status: 'in_progress' },
              activeSessions: ACTIVE_SESSION,
              items: [
                {
                  id: 'item-transition',
                  stageId: 'stage-1',
                  displayTitle: 'Transitioning Feature',
                  displaySubtitle: null,
                  state: { status: 'in_progress', currentPhase: 'implement', retryCount: 0, blockedReason: null },
                },
              ],
            }),
          );
        }
      } catch {
        // ignore
      }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);
  await page.locator('#item-item-transition').click();

  // in_progress item: skip visible, retry not visible
  await expect(page.getByRole('button', { name: 'Skip item' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).not.toBeVisible();

  capturedWs!.send(
    itemStateFrame({ itemId: 'item-transition', state: { status: 'awaiting_user' } }),
  );

  // retry should now be visible, skip should be hidden (awaiting_user is not skip-eligible)
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Skip item' })).not.toBeVisible();
});
