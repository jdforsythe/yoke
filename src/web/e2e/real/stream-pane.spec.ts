/**
 * Real-backend Playwright spec for test-e2e-full-suite — stream pane regressions.
 *
 * Covers:
 *   B1 — system notices of every severity render without crashing: info, warn,
 *        error, and requires_attention all show in the LiveStreamPane via History.
 *   A7 — cancel button on an active workflow: ControlMatrix shows Cancel for an
 *        in_progress workflow with an active session.
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

function seedWorkflow(
  db: BackendHandle['db'],
  opts: { id: string; name: string; status: string },
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', ?, ?, ?)`,
    )
    .run(opts.id, opts.name, PIPELINE, opts.status, now, now);
}

test.describe('stream-pane regressions — real backend', () => {
  test('B1: system notices of all severities render without crashing', async ({
    page,
    backend,
  }) => {
    // B1: before the fix, certain severity values could crash the SystemNoticeRenderer
    // or produce unstyled blocks. All four severities must render their message text.
    const wfId = `wf-sp-b1-${randomUUID().slice(0, 8)}`;
    const itemId = `item-sp-b1-${randomUUID().slice(0, 8)}`;
    const sessionId = `sess-sp-b1-${randomUUID().slice(0, 8)}`;

    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-sp-b1-'));
    const logPath = path.join(logDir, `${sessionId}.jsonl`);
    const severities = ['info', 'warn', 'error', 'requires_attention'] as const;

    try {
      const lines = [
        JSON.stringify({
          type: 'session.started',
          sessionId,
          workflowId: wfId,
          ts: '2026-01-01T00:00:00Z',
          seq: 0,
          payload: { sessionId, phase: 'implement', attempt: 1, startedAt: '2026-01-01T00:00:00Z', parentSessionId: null },
        }),
        ...severities.map((severity, i) =>
          JSON.stringify({
            type: 'stream.system_notice',
            sessionId,
            workflowId: wfId,
            ts: '2026-01-01T00:01:00Z',
            seq: i + 1,
            payload: {
              blockId: `notice-${severity}`,
              severity,
              source: 'test',
              message: `Notice severity ${severity}`,
            },
          }),
        ),
      ].join('\n') + '\n';
      fs.writeFileSync(logPath, lines);

      seedWorkflow(backend.db, { id: wfId, name: 'Stream-Pane B1 Workflow', status: 'completed' });
      const now = new Date().toISOString();
      backend.db.writer
        .prepare(
          `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
           VALUES (?, ?, 'stage-1', '{}', 'complete', ?)`,
        )
        .run(itemId, wfId, now);
      backend.db.writer
        .prepare(
          `INSERT INTO sessions
           (id, workflow_id, item_id, stage, phase, agent_profile,
            started_at, ended_at, exit_code, status, session_log_path)
           VALUES (?, ?, ?, 'stage-1', 'implement', 'default',
                   '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 0, 'complete', ?)`,
        )
        .run(sessionId, wfId, itemId, logPath);

      await page.goto(`/workflow/${wfId}`);
      await expect(page.locator(`#item-${itemId}`)).toBeVisible({ timeout: 6000 });
      await page.locator(`#item-${itemId}`).click();

      const historyTab = page.getByTestId('tab-history');
      await expect(historyTab).not.toBeDisabled({ timeout: 3000 });
      await historyTab.click();

      await page.getByTestId(`history-session-${sessionId}`).click();

      // All four severity messages must render without crashing the page.
      for (const severity of severities) {
        await expect(page.getByText(`Notice severity ${severity}`)).toBeVisible({ timeout: 5000 });
      }
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  test('A7: cancel button appears for in_progress workflow with active session', async ({
    page,
    backend,
  }) => {
    // A7: the Cancel button in ControlMatrix must be visible when the workflow is
    // in_progress and there is at least one active session (ended_at IS NULL).
    const wfId = `wf-sp-a7-${randomUUID().slice(0, 8)}`;
    const sessionId = `sess-sp-a7-${randomUUID().slice(0, 8)}`;
    seedWorkflow(backend.db, { id: wfId, name: 'Cancellable Workflow', status: 'in_progress' });
    const now = new Date().toISOString();
    backend.db.writer
      .prepare(
        `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
         VALUES (?, ?, 'stage-1', '{}', 'in_progress', ?)`,
      )
      .run(`item-sp-a7-${randomUUID().slice(0, 8)}`, wfId, now);
    // Active session: ended_at IS NULL so it appears in activeSessions.
    backend.db.writer
      .prepare(
        `INSERT INTO sessions
         (id, workflow_id, item_id, stage, phase, agent_profile, started_at, status)
         VALUES (?, ?, NULL, 'stage-1', 'implement', 'default', ?, 'in_progress')`,
      )
      .run(sessionId, wfId, now);

    await page.goto(`/workflow/${wfId}`);

    // ControlMatrix is visible only when activeSessionId is non-null.
    // The Cancel button rule: !['cancelled', 'complete'].includes(workflowStatus).
    const cancelBtn = page.getByRole('button', { name: 'Cancel' });
    await expect(cancelBtn).toBeVisible({ timeout: 6000 });
  });
});
