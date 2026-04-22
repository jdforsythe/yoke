/**
 * Real-backend Playwright spec for feat-stage-history.
 *
 * Seeds a completed workflow + item + session into SQLite via the realBackend
 * fixture, writes a JSONL log file, then asserts the full History tab
 * round-trip: item select → History tab enabled → session click → log renders.
 *
 * Covers AC:
 *   - GET /api/workflows/:workflowId/items/:itemId/timeline returns the
 *     session rows HistoryPane renders (filtered client-side to
 *     `kind === 'session'`)
 *   - History tab is disabled when no sessions exist
 *   - History tab is enabled and shows count when sessions exist
 *   - Selecting a past session renders its log via LiveStreamPane
 *   - Switching back to Live is instant (no crash, live subscription intact)
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'stage-1', run: 'once', phases: ['implement'] }],
});

function writeTestSessionLog(logPath: string, sessionId: string, wfId: string): void {
  const lines = [
    JSON.stringify({
      type: 'session.started',
      sessionId,
      workflowId: wfId,
      ts: '2026-01-01T00:00:00Z',
      seq: 0,
      payload: { sessionId, phase: 'implement', attempt: 1, startedAt: '2026-01-01T00:00:00Z', parentSessionId: null },
    }),
    JSON.stringify({
      type: 'stream.system_notice',
      sessionId,
      workflowId: wfId,
      ts: '2026-01-01T00:01:00Z',
      seq: 1,
      payload: { blockId: `notice-${sessionId}`, severity: 'info', source: 'test', message: 'History test content' },
    }),
  ].join('\n') + '\n';
  fs.writeFileSync(logPath, lines);
}

function seedWorkflowItemSession(
  db: BackendHandle['db'],
  opts: { wfId: string; itemId: string; sessionId: string; logPath: string },
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', 'completed', ?, ?)`,
    )
    .run(opts.wfId, 'History Test Workflow', PIPELINE, now, now);
  db.writer
    .prepare(
      `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
       VALUES (?, ?, 'stage-1', '{}', 'complete', ?)`,
    )
    .run(opts.itemId, opts.wfId, now);
  db.writer
    .prepare(
      `INSERT INTO sessions
       (id, workflow_id, item_id, stage, phase, agent_profile,
        started_at, ended_at, exit_code, status, session_log_path)
       VALUES (?, ?, ?, 'stage-1', 'implement', 'default',
               '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 0, 'complete', ?)`,
    )
    .run(opts.sessionId, opts.wfId, opts.itemId, opts.logPath);
}

test('stage-history: History tab disabled for item with no sessions', async ({
  page,
  backend,
}) => {
  const now = new Date().toISOString();
  const wfId = `wf-hist-nosess-${randomUUID().slice(0, 8)}`;
  const itemId = `item-nosess-${randomUUID().slice(0, 8)}`;

  backend.db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', 'pending', ?, ?)`,
    )
    .run(wfId, 'No Sessions Workflow', PIPELINE, now, now);

  backend.db.writer
    .prepare(
      `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
       VALUES (?, ?, 'stage-1', '{}', 'pending', ?)`,
    )
    .run(itemId, wfId, now);

  await page.goto(`/workflow/${wfId}`);
  await expect(page.locator(`#item-${itemId}`)).toBeVisible({ timeout: 5000 });

  // Select item — triggers sessions fetch
  await page.locator(`#item-${itemId}`).click();

  const historyTab = page.getByTestId('tab-history');
  await expect(historyTab).toBeVisible();
  // No sessions → History tab is disabled
  await expect(historyTab).toBeDisabled();
});

test('stage-history: past session log renders in History tab', async ({ page, backend }) => {
  const wfId = `wf-hist-${randomUUID().slice(0, 8)}`;
  const itemId = `item-hist-${randomUUID().slice(0, 8)}`;
  const sessionId = `sess-hist-${randomUUID().slice(0, 8)}`;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-hist-log-'));
  const logPath = path.join(logDir, `${sessionId}.jsonl`);

  try {
    writeTestSessionLog(logPath, sessionId, wfId);
    seedWorkflowItemSession(backend.db, { wfId, itemId, sessionId, logPath });

    await page.goto(`/workflow/${wfId}`);
    await expect(page.locator(`#item-${itemId}`)).toBeVisible({ timeout: 5000 });
    await page.locator(`#item-${itemId}`).click();

    const historyTab = page.getByTestId('tab-history');
    await expect(historyTab).toBeVisible();
    await expect(historyTab).not.toBeDisabled();
    await expect(historyTab).toContainText('History (1)');
    await historyTab.click();

    const sessionRow = page.getByTestId(`history-session-${sessionId}`);
    await expect(sessionRow).toBeVisible();
    await sessionRow.click();

    // The system notice message from the log file must render.
    await expect(page.getByText('History test content')).toBeVisible({ timeout: 5000 });

    // Switch back to Live — subscription is intact, no crash.
    await page.getByTestId('tab-live').click();
    await expect(page.getByTestId('tab-live')).toBeVisible();
    await expect(page.getByText('No active session')).toBeVisible();
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});
