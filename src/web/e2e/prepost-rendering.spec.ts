/**
 * Smoke tests: prepost.command.* frame rendering in LiveStreamPane.
 *
 * Covers:
 *  - prepost.command.started renders SystemNotice with pre/post label (AC-1)
 *  - prepost.command.output appends to collapsible log region (AC-2)
 *  - stdout vs stderr visual differentiation (AC-3)
 *  - prepost.command.ended finalizes with exit code badge (AC-4)
 *  - Collapsing log region does not disrupt follow-tail (AC-6)
 *  - Orphan ended (no started) sets needsSnapshot (AC-7)
 *  - Pre and post commands interleave with stream content (AC-8)
 */

import { test, expect } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import {
  setupWs,
  mockWorkflowsApi,
  snapshotFrame,
  helloFrame,
  WF_ID,
  sessionStartedFrame,
  streamTextFrame,
  prepostStartedFrame,
  prepostOutputFrame,
  prepostEndedFrame,
} from './helpers';

const SESS = 'sess-prepost-test-1';

function makeActiveSession() {
  return {
    sessionId: SESS,
    phase: 'implement',
    attempt: 1,
    startedAt: new Date().toISOString(),
    parentSessionId: null,
  };
}

test.beforeEach(async ({ page }) => {
  await mockWorkflowsApi(page, [{ id: WF_ID, name: 'Test Workflow', status: 'in_progress' }]);
});

// ---------------------------------------------------------------------------
// AC-1: prepost.command.started renders SystemNotice with pre/post label
// ---------------------------------------------------------------------------

test('prepost.command.started renders pre-command notice with command name and phase (AC-1)', async ({
  page,
}) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(prepostStartedFrame(SESS, 101, 'lint.sh', 'implement', 'pre', 3));
  });
  await page.goto(`/workflow/${WF_ID}`);

  // Reducer message: "Pre-command: lint.sh (phase: implement)"
  await expect(page.getByText(/Pre-command: lint\.sh/)).toBeVisible();
  await expect(page.getByText(/implement/)).toBeVisible();
  // Source label shows 'hook'
  await expect(page.getByText('hook')).toBeVisible();
});

test('prepost.command.started renders post-command notice with post label (AC-1)', async ({
  page,
}) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(prepostStartedFrame(SESS, 202, 'test-runner.sh', 'implement', 'post', 3));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText(/Post-command: test-runner\.sh/)).toBeVisible();
});

// ---------------------------------------------------------------------------
// AC-2: prepost.command.output appends to collapsible log region
// ---------------------------------------------------------------------------

test('prepost.command.output chunks appear in collapsible log when expanded (AC-2)', async ({
  page,
}) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(prepostStartedFrame(SESS, 301, 'build.sh', 'implement', 'pre', 3));
    ws.send(prepostOutputFrame(SESS, 301, 'stdout', 'Building project...', 4));
    ws.send(prepostOutputFrame(SESS, 301, 'stdout', 'Build complete.', 5));
  });
  await page.goto(`/workflow/${WF_ID}`);

  // Log is collapsed by default — "show log" button visible, content hidden
  const showBtn = page.getByRole('button', { name: 'show log' });
  await expect(showBtn).toBeVisible();
  await expect(page.getByText('Building project...')).not.toBeVisible();

  // Expand the log
  await showBtn.click();
  await expect(page.getByText('Building project...')).toBeVisible();
  await expect(page.getByText('Build complete.')).toBeVisible();

  // Button now shows "hide log" with aria-expanded=true
  const hideBtn = page.getByRole('button', { name: 'hide log' });
  await expect(hideBtn).toBeVisible();
  await expect(hideBtn).toHaveAttribute('aria-expanded', 'true');
});

test('Log region collapses when hide log is clicked (AC-2)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(prepostStartedFrame(SESS, 302, 'check.sh', 'implement', 'pre', 3));
    ws.send(prepostOutputFrame(SESS, 302, 'stdout', 'Check output line', 4));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByRole('button', { name: 'show log' }).click();
  await expect(page.getByText('Check output line')).toBeVisible();

  await page.getByRole('button', { name: 'hide log' }).click();
  await expect(page.getByText('Check output line')).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// AC-3: stdout vs stderr visual differentiation
// ---------------------------------------------------------------------------

test('stderr output uses red text class, stdout uses default (AC-3)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(prepostStartedFrame(SESS, 401, 'mixed.sh', 'implement', 'pre', 3));
    ws.send(prepostOutputFrame(SESS, 401, 'stdout', 'stdout line here', 4));
    ws.send(prepostOutputFrame(SESS, 401, 'stderr', 'stderr error here', 5));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByRole('button', { name: 'show log' }).click();

  await expect(page.getByText('stdout line here')).toBeVisible();
  await expect(page.getByText('stderr error here')).toBeVisible();

  // stderr element must carry the red text class (semantic, not inline style).
  const hasRedClass = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const stderrSpan = spans.find((s) => s.textContent === 'stderr error here');
    return stderrSpan?.className?.includes('text-red-') ?? false;
  });
  expect(hasRedClass).toBe(true);

  // stdout element must NOT carry a red text class.
  const stdoutHasRed = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const stdoutSpan = spans.find((s) => s.textContent === 'stdout line here');
    return stdoutSpan?.className?.includes('text-red-') ?? false;
  });
  expect(stdoutHasRed).toBe(false);
});

// ---------------------------------------------------------------------------
// AC-4: prepost.command.ended finalizes with exit code badge
// ---------------------------------------------------------------------------

test('prepost.command.ended shows green exit 0 badge on success (AC-4)', async ({ page }) => {
  let capturedWs: WebSocketRoute | null = null;

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    capturedWs = ws;
    ws.send(helloFrame());
    ws.onMessage((msg: string | Buffer) => {
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
          ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
          ws.send(prepostStartedFrame(SESS, 501, 'ok-script.sh', 'implement', 'pre', 3));
        }
      } catch { /* ignore */ }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByText(/Pre-command: ok-script\.sh/)).toBeVisible();

  capturedWs!.send(prepostEndedFrame(SESS, 501, 0, { type: 'continue' }, 10));

  // Exit 0 badge visible
  await expect(page.getByText('exit 0')).toBeVisible();

  // Badge must have green styling (bg-green-600/30 or text-green-300)
  const hasGreen = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const badge = spans.find((s) => s.textContent === 'exit 0');
    return badge?.className?.includes('green') ?? false;
  });
  expect(hasGreen).toBe(true);
});

test('prepost.command.ended shows red exit badge for non-zero exit code (AC-4)', async ({
  page,
}) => {
  let capturedWs: WebSocketRoute | null = null;

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    capturedWs = ws;
    ws.send(helloFrame());
    ws.onMessage((msg: string | Buffer) => {
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
          ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
          ws.send(prepostStartedFrame(SESS, 502, 'fail-script.sh', 'implement', 'pre', 3));
        }
      } catch { /* ignore */ }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByText(/Pre-command: fail-script\.sh/)).toBeVisible();

  capturedWs!.send(prepostEndedFrame(SESS, 502, 1, { type: 'abort' }, 10));

  await expect(page.getByText('exit 1')).toBeVisible();

  const hasRed = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const badge = spans.find((s) => s.textContent === 'exit 1');
    return badge?.className?.includes('red') ?? false;
  });
  expect(hasRed).toBe(true);
});

// ---------------------------------------------------------------------------
// AC-6: Collapsing log region does not disrupt scroll position or follow-tail
// ---------------------------------------------------------------------------

test('Expanding/collapsing log region does not disengage follow-tail (AC-6)', async ({
  page,
}) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    // Pre-fill blocks so the pane overflows (follow-tail active at bottom).
    for (let i = 1; i <= 20; i++) {
      ws.send(streamTextFrame(SESS, `pre-${i}`, `Line ${i} filler text content here`, 2 + i, true));
    }
    ws.send(prepostStartedFrame(SESS, 601, 'hook.sh', 'implement', 'pre', 23));
    ws.send(prepostOutputFrame(SESS, 601, 'stdout', 'Hook output', 24));
  });
  await page.goto(`/workflow/${WF_ID}`);

  // Follow-tail should be at the bottom — "show log" button visible.
  const showBtn = page.getByRole('button', { name: 'show log' });
  await expect(showBtn).toBeVisible();

  // Jump to latest pill must NOT be visible (we're at the bottom).
  await expect(page.getByRole('button', { name: /Jump to latest/ })).not.toBeVisible();

  // Expand and collapse the log.
  await showBtn.click();
  await expect(page.getByText('Hook output')).toBeVisible();

  await page.getByRole('button', { name: 'hide log' }).click();
  await expect(page.getByText('Hook output')).not.toBeVisible();

  // Jump to latest pill must still NOT be visible — follow-tail not disrupted.
  await expect(page.getByRole('button', { name: /Jump to latest/ })).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// AC-7: Orphan ended (no matching started) triggers needsSnapshot
// ---------------------------------------------------------------------------

test('Orphan prepost.command.ended (no started) sets needsSnapshot on session (AC-7)', async ({
  page,
}) => {
  let capturedWs: WebSocketRoute | null = null;

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    capturedWs = ws;
    ws.send(helloFrame());
    ws.onMessage((msg: string | Buffer) => {
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
          ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
        }
      } catch { /* ignore */ }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByText(/Session started/)).toBeVisible();

  // Send ended with runId 9999 — no preceding started for this runId.
  capturedWs!.send(prepostEndedFrame(SESS, 9999, 0, null, 10));

  // Verify via window test hook that needsSnapshot is set.
  const needsSnapshot = await page.evaluate((sessionId: string) => {
    const getSnapshot = (window as unknown as Record<string, (sid: string) => unknown>)[
      '__yokeGetSnapshot__'
    ] as (() => { sessions: Map<string, { needsSnapshot: boolean }> }) | undefined;
    if (!getSnapshot) return null;
    const snap = getSnapshot();
    return snap.sessions.get(sessionId)?.needsSnapshot ?? null;
  }, SESS);

  expect(needsSnapshot).toBe(true);
});

// ---------------------------------------------------------------------------
// AC-8: Pre/post commands interleave correctly with other stream content
// ---------------------------------------------------------------------------

test('Pre-command notice appears between surrounding text blocks in order (AC-8)', async ({
  page,
}) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(streamTextFrame(SESS, 'before-blk', 'Text before hook', 3, true));
    ws.send(prepostStartedFrame(SESS, 701, 'interleave.sh', 'implement', 'pre', 4));
    ws.send(prepostOutputFrame(SESS, 701, 'stdout', 'Hook running', 5));
    ws.send(prepostEndedFrame(SESS, 701, 0, null, 6));
    ws.send(streamTextFrame(SESS, 'after-blk', 'Text after hook', 7, true));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('Text before hook')).toBeVisible();
  await expect(page.getByText(/Pre-command: interleave\.sh/)).toBeVisible();
  await expect(page.getByText('exit 0')).toBeVisible();
  await expect(page.getByText('Text after hook')).toBeVisible();

  // Verify DOM order: "before" text appears above the hook notice, which appears
  // above "after" text.
  const order = await page.evaluate(() => {
    const container = document.querySelector('[data-testid="stream-scroll-container"]');
    if (!container) return null;
    const allText = container.innerText;
    const beforeIdx = allText.indexOf('Text before hook');
    const hookIdx = allText.indexOf('Pre-command: interleave.sh');
    const afterIdx = allText.indexOf('Text after hook');
    return { beforeIdx, hookIdx, afterIdx };
  });

  expect(order).not.toBeNull();
  expect(order!.beforeIdx).toBeLessThan(order!.hookIdx);
  expect(order!.hookIdx).toBeLessThan(order!.afterIdx);
});
