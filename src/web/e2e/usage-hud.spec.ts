/**
 * UsageHUD e2e smoke tests — feat-usage-hud
 *
 * Covers all 8 acceptance criteria:
 *   AC-1  HUD displays input, output, cache-read, cache-write token counts
 *   AC-2  Abbreviated formatting (k/M suffixes, one decimal)
 *   AC-3  Real-time update on stream.usage frames
 *   AC-4  Workflow total sums across multiple sessions
 *   AC-5  Click toggles the per-session breakdown dropdown
 *   AC-6  Per-session rows show phase label and individual counts
 *   AC-7  Dash shown when no usage data is available
 *   AC-8  Dropdown closes on outside click and on Escape key
 */

import { test, expect } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import {
  setupWs,
  mockWorkflowsApi,
  snapshotFrame,
  sessionStartedFrame,
  usageFrame,
  helloFrame,
  WF_ID,
  WF_NAME,
} from './helpers';

const SID_1 = 'session-aabbcc001';
const SID_2 = 'session-ddeeff002';

test.beforeEach(async ({ page }) => {
  await mockWorkflowsApi(page, [{ id: WF_ID, name: WF_NAME, status: 'in_progress' }]);
});

// ---------------------------------------------------------------------------
// AC-7: dash when no usage data
// ---------------------------------------------------------------------------

test('AC-7: shows dash indicator when no usage data is available', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
  });
  await page.goto(`/workflow/${WF_ID}`);
  // Wait for snapshot to render — use the <h1> heading to avoid matching the
  // WorkflowList sidebar row that also contains the workflow name.
  await expect(page.getByRole('heading', { level: 1, name: WF_NAME })).toBeVisible();
  // The HUD renders the dash variant (aria-label="No token usage data").
  await expect(page.getByLabel('No token usage data')).toBeVisible();
});

// ---------------------------------------------------------------------------
// AC-1 + AC-2: abbreviated formatting for all four token types
// ---------------------------------------------------------------------------

test('AC-1+AC-2: shows abbreviated input and output counts in compact button', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
    ws.send(sessionStartedFrame(SID_1, 'implement'));
    ws.send(usageFrame(SID_1, {
      inputTokens: 12_300,
      outputTokens: 5_400,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    }));
  });
  await page.goto(`/workflow/${WF_ID}`);
  const btn = page.getByRole('button', { name: /Token usage/ });
  await expect(btn).toBeVisible();
  await expect(btn).toContainText('12.3k');
  await expect(btn).toContainText('5.4k');
});

test('AC-1: shows cache-read tokens in compact button when present', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
    ws.send(sessionStartedFrame(SID_1));
    ws.send(usageFrame(SID_1, {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 2_500,
    }));
  });
  await page.goto(`/workflow/${WF_ID}`);
  const btn = page.getByRole('button', { name: /Token usage/ });
  await expect(btn).toContainText('2.5k'); // cache read shown
});

test('AC-1: shows cache-write tokens in compact button when present', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
    ws.send(sessionStartedFrame(SID_1));
    ws.send(usageFrame(SID_1, {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheCreationInputTokens: 800,
      cacheReadInputTokens: 0,
    }));
  });
  await page.goto(`/workflow/${WF_ID}`);
  const btn = page.getByRole('button', { name: /Token usage/ });
  await expect(btn).toContainText('800'); // cache write shown (< 1k → no suffix)
});

test('AC-2: uses M suffix for values >= 1 million', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
    ws.send(sessionStartedFrame(SID_1));
    ws.send(usageFrame(SID_1, {
      inputTokens: 1_200_000,
      outputTokens: 500_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    }));
  });
  await page.goto(`/workflow/${WF_ID}`);
  const btn = page.getByRole('button', { name: /Token usage/ });
  await expect(btn).toContainText('1.2M');
  await expect(btn).toContainText('500.0k');
});

// ---------------------------------------------------------------------------
// AC-3: real-time update
// ---------------------------------------------------------------------------

test('AC-3: counts update in real-time when stream.usage arrives mid-session', async ({ page }) => {
  let wsRef: WebSocketRoute | null = null;
  await setupWs(page, (ws) => {
    wsRef = ws;
    ws.send(snapshotFrame());
    ws.send(sessionStartedFrame(SID_1));
    // No usage frame yet — HUD should show dash.
  });
  await page.goto(`/workflow/${WF_ID}`);

  // Initially no usage data.
  await expect(page.getByLabel('No token usage data')).toBeVisible();

  // Send a usage frame after the page has loaded.
  wsRef!.send(usageFrame(SID_1, {
    inputTokens: 5_000,
    outputTokens: 2_000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }));

  // HUD should transition to the button with updated counts.
  const btn = page.getByRole('button', { name: /Token usage/ });
  await expect(btn).toBeVisible();
  await expect(btn).toContainText('5.0k');
  await expect(btn).toContainText('2.0k');
});

test('AC-3: counts update when a second usage frame replaces the first', async ({ page }) => {
  let wsRef: WebSocketRoute | null = null;
  await setupWs(page, (ws) => {
    wsRef = ws;
    ws.send(snapshotFrame());
    ws.send(sessionStartedFrame(SID_1));
    ws.send(usageFrame(SID_1, { inputTokens: 1_000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }));
  });
  await page.goto(`/workflow/${WF_ID}`);

  const btn = page.getByRole('button', { name: /Token usage/ });
  await expect(btn).toContainText('1.0k');

  // Second usage frame (token count grew) — seq must be higher than first (5) to
  // pass WS client deduplication (per-session HWM drops frames with seq <= hwm).
  wsRef!.send(usageFrame(SID_1, { inputTokens: 8_000, outputTokens: 3_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, 6));
  await expect(btn).toContainText('8.0k');
});

// ---------------------------------------------------------------------------
// AC-4: workflow total sums across sessions
// ---------------------------------------------------------------------------

test('AC-4: workflow total sums usage across multiple sessions', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
    ws.send(sessionStartedFrame(SID_1, 'implement'));
    ws.send(usageFrame(SID_1, { inputTokens: 5_000, outputTokens: 2_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }));
    ws.send(sessionStartedFrame(SID_2, 'review'));
    ws.send(usageFrame(SID_2, { inputTokens: 3_000, outputTokens: 1_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }));
  });
  await page.goto(`/workflow/${WF_ID}`);

  const btn = page.getByRole('button', { name: /Token usage/ });
  // Total input: 5000 + 3000 = 8000 → 8.0k
  await expect(btn).toContainText('8.0k');
  // Total output: 2000 + 1000 = 3000 → 3.0k
  await expect(btn).toContainText('3.0k');
});

// ---------------------------------------------------------------------------
// AC-5: dropdown toggle
// ---------------------------------------------------------------------------

test('AC-5: clicking HUD opens per-session breakdown dropdown', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
    ws.send(sessionStartedFrame(SID_1, 'implement'));
    ws.send(usageFrame(SID_1, { inputTokens: 10_000, outputTokens: 3_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }));
  });
  await page.goto(`/workflow/${WF_ID}`);

  const btn = page.getByRole('button', { name: /Token usage/ });
  await expect(btn).toBeVisible();

  // Dropdown not shown before click.
  await expect(page.getByText('Workflow Tokens')).not.toBeVisible();

  await btn.click();
  await expect(page.getByText('Workflow Tokens')).toBeVisible();
});

test('AC-5: clicking HUD again closes the dropdown', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
    ws.send(sessionStartedFrame(SID_1));
    ws.send(usageFrame(SID_1, { inputTokens: 10_000, outputTokens: 3_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }));
  });
  await page.goto(`/workflow/${WF_ID}`);

  const btn = page.getByRole('button', { name: /Token usage/ });
  await btn.click();
  await expect(page.getByText('Workflow Tokens')).toBeVisible();

  await btn.click();
  await expect(page.getByText('Workflow Tokens')).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// AC-6: per-session breakdown shows phase label and counts
// ---------------------------------------------------------------------------

test('AC-6: per-session breakdown shows phase badge and token counts', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
    ws.send(sessionStartedFrame(SID_1, 'implement'));
    ws.send(usageFrame(SID_1, { inputTokens: 7_500, outputTokens: 2_500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }));
  });
  await page.goto(`/workflow/${WF_ID}`);

  const btn = page.getByRole('button', { name: /Token usage/ });
  await btn.click();

  // Per-session section header.
  // Per-session section header.
  const dropdown = page.locator('[style*="position: fixed"]').filter({ hasText: 'Workflow Tokens' });
  await expect(dropdown.getByText('Per Session')).toBeVisible();
  // Phase badge — use exact match inside dropdown to avoid matching the
  // LiveStreamPane's session-notice text ("Session started — phase: implement, ...").
  await expect(dropdown.getByText('implement', { exact: true })).toBeVisible();
  // Per-session counts (7.5k input, 2.5k output).
  await expect(dropdown).toContainText('7.5k');
  await expect(dropdown).toContainText('2.5k');
});

test('AC-6: per-session breakdown shows cache tokens for that session', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
    ws.send(sessionStartedFrame(SID_1, 'review'));
    ws.send(usageFrame(SID_1, {
      inputTokens: 4_000,
      outputTokens: 1_000,
      cacheCreationInputTokens: 600,
      cacheReadInputTokens: 1_200,
    }));
  });
  await page.goto(`/workflow/${WF_ID}`);

  const btn = page.getByRole('button', { name: /Token usage/ });
  await btn.click();

  const dropdown = page.locator('[style*="position: fixed"]').filter({ hasText: 'Workflow Tokens' });
  // Review phase label.
  await expect(dropdown).toContainText('review');
  // Cache tokens in per-session row.
  await expect(dropdown).toContainText('1.2k'); // cache read
  await expect(dropdown).toContainText('600');  // cache write (< 1k)
});

// ---------------------------------------------------------------------------
// AC-8: dropdown closes on outside click or Escape
// ---------------------------------------------------------------------------

test('AC-8: dropdown closes when Escape is pressed', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
    ws.send(sessionStartedFrame(SID_1));
    ws.send(usageFrame(SID_1, { inputTokens: 5_000, outputTokens: 2_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }));
  });
  await page.goto(`/workflow/${WF_ID}`);

  const btn = page.getByRole('button', { name: /Token usage/ });
  await btn.click();
  await expect(page.getByText('Workflow Tokens')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByText('Workflow Tokens')).not.toBeVisible();
});

test('AC-8: dropdown closes on outside click (body outside trigger and portal)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
    ws.send(sessionStartedFrame(SID_1));
    ws.send(usageFrame(SID_1, { inputTokens: 5_000, outputTokens: 2_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }));
  });
  await page.goto(`/workflow/${WF_ID}`);

  const btn = page.getByRole('button', { name: /Token usage/ });
  await btn.click();
  await expect(page.getByText('Workflow Tokens')).toBeVisible();

  // Click on an area clearly outside both the trigger and the portal.
  await page.locator('main').click({ position: { x: 10, y: 10 } });
  await expect(page.getByText('Workflow Tokens')).not.toBeVisible();
});

test('AC-8: clicking inside dropdown does NOT close it', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
    ws.send(sessionStartedFrame(SID_1, 'implement'));
    ws.send(usageFrame(SID_1, { inputTokens: 5_000, outputTokens: 2_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }));
  });
  await page.goto(`/workflow/${WF_ID}`);

  const btn = page.getByRole('button', { name: /Token usage/ });
  await btn.click();
  await expect(page.getByText('Workflow Tokens')).toBeVisible();

  // Click on the "Workflow Tokens" heading inside the portal — should NOT close.
  await page.getByText('Workflow Tokens').click();
  await expect(page.getByText('Workflow Tokens')).toBeVisible();
});
