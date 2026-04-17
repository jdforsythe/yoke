/**
 * Regression: a SystemNoticeBlock with an unexpected severity must NOT
 * white-screen the dashboard.
 *
 * Prior bug: SystemNoticeRenderer's `severityClasses` had no `default`
 * branch, so any severity outside the declared union returned `undefined`,
 * and reading `.border` on it threw "Cannot read properties of undefined
 * (reading 'border')". React bubbled the error up, react-router-dom had no
 * errorElement, and the whole page went blank.
 *
 * Defence in depth:
 *   1. `severityClasses` now has a `default` branch (unit-tested in
 *      tests/web/severityClasses.test.ts).
 *   2. The /workflow/:workflowId route has an errorElement so a future
 *      render bug won't white-screen the page.
 *
 * This spec simulates a malformed frame on the wire (severity='unknown')
 * and asserts the workflow header remains visible and no route-level
 * error fallback appears.
 */

import { test, expect } from '@playwright/test';
import {
  setupWs,
  mockWorkflowsApi,
  snapshotFrame,
  sessionStartedFrame,
  WF_ID,
  WF_NAME,
} from './helpers';

const SESS = 'sess-unknown-severity-1';

function makeActiveSession() {
  return {
    sessionId: SESS,
    phase: 'implement',
    attempt: 1,
    startedAt: new Date().toISOString(),
    parentSessionId: null,
  };
}

/**
 * Build a stream.system_notice frame with an arbitrary severity string.
 * The existing `streamSystemNoticeFrame` helper constrains severity to
 * 'info' | 'warn' | 'error' at the type level; this spec deliberately
 * sends an out-of-union value.
 */
function unknownSeverityFrame(sessionId: string, seq: number): string {
  return JSON.stringify({
    v: 1,
    type: 'stream.system_notice',
    workflowId: WF_ID,
    sessionId,
    seq,
    ts: new Date().toISOString(),
    payload: {
      sessionId,
      severity: 'unknown',
      source: 'harness',
      message: 'Notice with an unexpected severity value',
    },
  });
}

test.beforeEach(async ({ page }) => {
  await mockWorkflowsApi(page, [{ id: WF_ID, name: WF_NAME, status: 'in_progress' }]);
});

test('stream.system_notice with unknown severity does not white-screen the dashboard', async ({
  page,
}) => {
  // Capture unhandled page errors so we can assert the render did not throw.
  const pageErrors: Error[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err);
  });

  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(unknownSeverityFrame(SESS, 3));
  });

  await page.goto(`/workflow/${WF_ID}`);

  // The workflow header remains visible — a white-screen would wipe this.
  await expect(page.getByRole('heading', { name: WF_NAME })).toBeVisible();

  // The notice message itself should still render (fallback palette applied).
  await expect(
    page.getByText('Notice with an unexpected severity value'),
  ).toBeVisible();

  // No route-level error fallback text should appear.
  await expect(page.getByText(/Unexpected Application Error/i)).toHaveCount(0);
  await expect(
    page.getByText(/Something went wrong rendering this workflow/i),
  ).toHaveCount(0);

  // No uncaught page-level errors should have fired for 'border' access.
  const borderErrors = pageErrors.filter((e) =>
    /reading 'border'/.test(e.message),
  );
  expect(borderErrors).toEqual([]);
});
