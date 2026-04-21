/**
 * E2E smoke tests for ReviewPanel (feat-review-panel + r3-03).
 *
 * Covers:
 *  - AC-1: review-phase sessions render in ReviewPanel, not standard stream pane
 *  - AC-2: Task tool_use calls render as collapsible subagent rows with task description
 *  - AC-3: each row shows status (pending/running/ok/error) with color-coded indicator
 *  - AC-4: subagent rows display in invocation order
 *  - AC-5: summary header shows counts: total subagents, passed, failed, pending
 *  - AC-6: expanding a subagent row shows nested stream output
 *  - AC-7: non-Task tool calls in a review session render with ToolCallRenderer
 *  - AC-8: collapsing/expanding subagent rows does not disrupt scroll position
 *
 *  r3-03: detection is Task tool_use based — phase name alone does not control
 *  the renderer. A phase named "audit" with Task calls gets ReviewPanel; a review
 *  phase with no Task calls gets LiveStreamPane.
 */

import { test, expect } from '@playwright/test';
import {
  setupWs,
  mockWorkflowsApi,
  snapshotFrame,
  WF_ID,
  sessionStartedFrame,
  streamToolUseFrame,
  streamToolResultFrame,
} from './helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESS = 'sess-review-test-1';
// Item associated with the review session (required for per-item session map).
const ITEM_ID = 'item-review-1';
const ITEM_TITLE = 'Review Item';

function reviewItem() {
  return {
    id: ITEM_ID,
    stageId: 'stage-1',
    displayTitle: ITEM_TITLE,
    displaySubtitle: null,
    state: { status: 'in_progress', currentPhase: 'review', retryCount: 0, blockedReason: null },
  };
}

function reviewSession(phase = 'review') {
  return {
    sessionId: SESS,
    itemId: ITEM_ID,
    phase,
    attempt: 1,
    startedAt: new Date().toISOString(),
    parentSessionId: null,
  };
}

test.beforeEach(async ({ page }) => {
  await mockWorkflowsApi(page, [{ id: WF_ID, name: 'Test Workflow', status: 'in_progress' }]);
});

// ---------------------------------------------------------------------------
// AC-1: Task-based detection routes correctly
// ---------------------------------------------------------------------------

test('AC-1: session with Task tool_use renders ReviewPanel summary header', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
    ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
    ws.send(streamToolUseFrame(SESS, 'tool-ac1', 'Task', { description: 'Review check' }, 3));
  });
  await page.goto(`/workflow/${WF_ID}`);

  // Select the item to activate its session pane
  await page.getByText(ITEM_TITLE).click();

  // ReviewPanel summary header — only ReviewPanel renders this, not LiveStreamPane
  await expect(page.getByText('Review', { exact: true })).toBeVisible();
  await expect(page.getByText('1 subagents')).toBeVisible();
});

test('AC-1: session with no Task tool_use falls back to LiveStreamPane (r3-03 AC-2)', async ({ page }) => {
  // No Task calls → LiveStreamPane regardless of phase name (was: hardcoded 'implement' → stream)
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({
      activeSessions: [reviewSession('implement')],
      items: [reviewItem()],
    }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    // Non-Task tool call — must NOT activate ReviewPanel (r3-03 detection is Task-based)
    ws.send(streamToolUseFrame(SESS, 'tool-bash', 'Bash', { command: 'ls' }, 3));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByText(ITEM_TITLE).click();

  // Summary header is ReviewPanel-specific — must NOT appear when no Task blocks present
  await expect(page.getByText(/subagents/)).not.toBeVisible();
  // Non-Task tool name appears via standard ToolCallRenderer in LiveStreamPane
  await expect(page.getByText('Bash')).toBeVisible();
});

// ---------------------------------------------------------------------------
// AC-2: Task tool_use renders as a collapsible subagent row
// ---------------------------------------------------------------------------

test('AC-2: Task tool_use renders collapsible subagent row with task description', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
    ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
    ws.send(streamToolUseFrame(SESS, 'tool-ac2', 'Task', { description: 'Verify auth logic' }, 3));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByText(ITEM_TITLE).click();

  // Task description appears in the collapsed row header
  await expect(page.getByText('Verify auth logic')).toBeVisible();
  // Row button has aria-expanded (collapsed by default)
  await expect(
    page.getByRole('button', { expanded: false }).filter({ hasText: 'Verify auth logic' }),
  ).toBeVisible();
});

test('AC-2: task description extracted from input.prompt field', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
    ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
    ws.send(streamToolUseFrame(SESS, 'tool-prompt', 'Task', { prompt: 'Run lint checks' }, 3));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByText(ITEM_TITLE).click();

  await expect(page.getByText('Run lint checks')).toBeVisible();
});

// ---------------------------------------------------------------------------
// AC-3: status indicators update reactively
// ---------------------------------------------------------------------------

test('AC-3: Task row with ok tool_result shows passed count in summary', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
    ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
    ws.send(streamToolUseFrame(SESS, 'tool-ok', 'Task', { description: 'Passing task' }, 3));
    ws.send(streamToolResultFrame(SESS, 'tool-ok', 'ok', 'All checks passed', 4));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByText(ITEM_TITLE).click();

  await expect(page.getByText('Passing task')).toBeVisible();
  // Summary shows ✓ 1 for passed
  await expect(page.getByText(/✓\s*1/)).toBeVisible();
});

test('AC-3: Task row with error tool_result shows failed count in summary', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
    ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
    ws.send(streamToolUseFrame(SESS, 'tool-err', 'Task', { description: 'Failing task' }, 3));
    ws.send(streamToolResultFrame(SESS, 'tool-err', 'error', 'Lint errors found', 4));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByText(ITEM_TITLE).click();

  await expect(page.getByText('Failing task')).toBeVisible();
  // Summary shows ✗ 1 for failed
  await expect(page.getByText(/✗\s*1/)).toBeVisible();
});

test('AC-3: Task row with pending status shows pending count in summary', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
    ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
    ws.send(streamToolUseFrame(SESS, 'tool-pend', 'Task', { description: 'Pending task' }, 3, 'pending'));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByText(ITEM_TITLE).click();

  await expect(page.getByText('Pending task')).toBeVisible();
  // Summary shows … 1 for pending/running
  await expect(page.getByText(/…\s*1/)).toBeVisible();
});

// ---------------------------------------------------------------------------
// AC-4: subagent rows in invocation order
// ---------------------------------------------------------------------------

test('AC-4: multiple Task rows render in invocation order', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
    ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
    ws.send(streamToolUseFrame(SESS, 'tool-a', 'Task', { description: 'Alpha task' }, 3));
    ws.send(streamToolUseFrame(SESS, 'tool-b', 'Task', { description: 'Beta task' }, 4));
    ws.send(streamToolUseFrame(SESS, 'tool-c', 'Task', { description: 'Gamma task' }, 5));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByText(ITEM_TITLE).click();

  // All three task rows are visible
  await expect(page.getByText('Alpha task')).toBeVisible();
  await expect(page.getByText('Beta task')).toBeVisible();
  await expect(page.getByText('Gamma task')).toBeVisible();

  // Summary confirms 3 subagents
  await expect(page.getByText('3 subagents')).toBeVisible();

  // Index labels appear in order: #1 = Alpha, #2 = Beta, #3 = Gamma
  // Use nth selectors on aria-expanded buttons within the scrollable content area
  const rows = page.locator('button[aria-expanded]').filter({ hasText: /^#\d/ });
  await expect(rows.nth(0)).toContainText('Alpha task');
  await expect(rows.nth(1)).toContainText('Beta task');
  await expect(rows.nth(2)).toContainText('Gamma task');
});

// ---------------------------------------------------------------------------
// AC-5: summary header counts
// ---------------------------------------------------------------------------

test('AC-5: summary shows correct total, passed, failed, pending counts', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
    ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
    // 1 pending, 1 running, 1 ok, 1 error = 4 total; 2 pending+running, 1 ok, 1 error
    ws.send(streamToolUseFrame(SESS, 't-pend', 'Task', { description: 'Pending' }, 3, 'pending'));
    ws.send(streamToolUseFrame(SESS, 't-run',  'Task', { description: 'Running' }, 4, 'running'));
    ws.send(streamToolUseFrame(SESS, 't-ok',   'Task', { description: 'Ok task' }, 5));
    ws.send(streamToolResultFrame(SESS, 't-ok', 'ok', 'done', 6));
    ws.send(streamToolUseFrame(SESS, 't-err',  'Task', { description: 'Err task' }, 7));
    ws.send(streamToolResultFrame(SESS, 't-err', 'error', 'failed', 8));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByText(ITEM_TITLE).click();

  await expect(page.getByText('4 subagents')).toBeVisible();
  await expect(page.getByText(/✓\s*1/)).toBeVisible();
  await expect(page.getByText(/✗\s*1/)).toBeVisible();
  await expect(page.getByText(/…\s*2/)).toBeVisible();
});

test('AC-5: summary updates as results arrive after initial render', async ({ page }) => {
  let sendFrame!: (frame: string) => void;

  await page.routeWebSocket('**/stream', (ws) => {
    sendFrame = (f) => ws.send(f);
    ws.send(
      JSON.stringify({ v: 1, type: 'hello', seq: 0, ts: new Date().toISOString(), payload: { serverVersion: '0.1.0', protocolVersion: 1, capabilities: [], heartbeatIntervalMs: 30_000 } }),
    );
    let subscribed = false;
    ws.onMessage((msg) => {
      if (subscribed) return;
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          subscribed = true;
          ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
          ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
          ws.send(streamToolUseFrame(SESS, 't-dyn', 'Task', { description: 'Dynamic task' }, 3));
        }
      } catch { /* ignore */ }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);

  // Select item first
  await page.getByText(ITEM_TITLE).click();

  // Initially: 1 subagent, pending
  await expect(page.getByText('1 subagents')).toBeVisible();
  await expect(page.getByText(/…\s*1/)).toBeVisible();

  // Result arrives after initial render — summary should update
  sendFrame(streamToolResultFrame(SESS, 't-dyn', 'ok', 'done', 4));

  await expect(page.getByText(/✓\s*1/)).toBeVisible();
  // Pending count disappears when result is ok
  await expect(page.getByText(/…\s*1/)).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// AC-6: expanding a subagent row shows nested output
// ---------------------------------------------------------------------------

test('AC-6: expanding a subagent row reveals its output', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
    ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
    ws.send(streamToolUseFrame(SESS, 'tool-exp', 'Task', { description: 'Expandable task' }, 3));
    ws.send(streamToolResultFrame(SESS, 'tool-exp', 'ok', 'Output text here', 4));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByText(ITEM_TITLE).click();

  // Output is hidden while row is collapsed
  await expect(page.getByText('Output text here')).not.toBeVisible();

  // Click to expand
  await page.getByText('Expandable task').click();

  // Output becomes visible
  await expect(page.getByText('Output text here')).toBeVisible();
});

test('AC-6: collapsing an expanded row hides its output', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
    ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
    ws.send(streamToolUseFrame(SESS, 'tool-coll', 'Task', { description: 'Collapsible task' }, 3));
    ws.send(streamToolResultFrame(SESS, 'tool-coll', 'ok', 'Hidden output', 4));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByText(ITEM_TITLE).click();

  // Expand
  await page.getByText('Collapsible task').click();
  await expect(page.getByText('Hidden output')).toBeVisible();

  // Collapse
  await page.getByText('Collapsible task').click();
  await expect(page.getByText('Hidden output')).not.toBeVisible();
});

test('AC-6: row with running status shows "Running…" when expanded with no output yet', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
    ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
    ws.send(streamToolUseFrame(SESS, 'tool-run', 'Task', { description: 'In-flight task' }, 3, 'running'));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByText(ITEM_TITLE).click();

  await page.getByText('In-flight task').click();

  await expect(page.getByText('Running…')).toBeVisible();
});

// ---------------------------------------------------------------------------
// AC-7: non-Task tool calls render with standard ToolCallRenderer
// ---------------------------------------------------------------------------

test('AC-7: non-Task tool call in review session renders with ToolCallRenderer', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
    ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
    ws.send(streamToolUseFrame(SESS, 'tool-read', 'ReadFile', { path: '/foo.ts' }, 3));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByText(ITEM_TITLE).click();

  // Standard ToolCallRenderer shows the tool name
  await expect(page.getByText('ReadFile')).toBeVisible();

  // No summary header — ReadFile is not a Task block, so LiveStreamPane renders
  await expect(page.getByText(/subagents/)).not.toBeVisible();
});

test('AC-7: non-Task tool call is excluded from subagent count', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
    ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
    // One Task + one non-Task
    ws.send(streamToolUseFrame(SESS, 'tool-task', 'Task', { description: 'Real task' }, 3));
    ws.send(streamToolUseFrame(SESS, 'tool-bash', 'Bash', { command: 'ls' }, 4));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByText(ITEM_TITLE).click();

  // Summary counts only Task blocks
  await expect(page.getByText('1 subagents')).toBeVisible();
  // Non-Task tool renders via ToolCallRenderer
  await expect(page.getByText('Bash')).toBeVisible();
});

// ---------------------------------------------------------------------------
// AC-8: expand/collapse does not disrupt scroll position
// ---------------------------------------------------------------------------

test('AC-8: expand/collapse does not disrupt scroll position', async ({ page }) => {
  // Use a narrow viewport so that 15 collapsed rows (≈45px each ≈ 675px total)
  // overflow the ~300px available scroll area after layout headers are accounted for.
  await page.setViewportSize({ width: 900, height: 400 });

  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [reviewSession()], items: [reviewItem()] }));
    ws.send(sessionStartedFrame(SESS, 'review', 1, 2));
    // Send tool_use first (seq 3–17), then tool_result (seq 18–32) to keep
    // HWM monotonically increasing so no frame is dropped by deduplication.
    for (let i = 1; i <= 15; i++) {
      ws.send(streamToolUseFrame(SESS, `ts${i}`, 'Task', { description: `Scroll task ${i}` }, i + 2));
    }
    for (let i = 1; i <= 15; i++) {
      ws.send(streamToolResultFrame(SESS, `ts${i}`, 'ok', `Output ${i}`, i + 17));
    }
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByText(ITEM_TITLE).click();

  // All 15 rows are rendered (collapsed); use exact match to avoid substring conflicts
  await expect(page.getByText('Scroll task 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Scroll task 15', { exact: true })).toBeVisible();

  // Scroll the last row into view so we're looking at the bottom of the list
  await page.getByText('Scroll task 15', { exact: true }).scrollIntoViewIfNeeded();

  // Expand then collapse a row near the bottom (row 12)
  await page.getByText('Scroll task 12', { exact: true }).click();
  await expect(page.getByText('Output 12', { exact: true })).toBeVisible();
  await page.getByText('Scroll task 12', { exact: true }).click();
  await expect(page.getByText('Output 12', { exact: true })).not.toBeVisible();

  // After collapse, the last row is still reachable (scroll position not reset to 0)
  await expect(page.getByText('Scroll task 15', { exact: true })).toBeVisible();
});
