/**
 * Real-backend Playwright spec for FeatureBoard's inline timeline (phase 7).
 *
 * Seeds rows directly into SQLite via the realBackend fixture, then drives
 * the end-to-end expand-into-timeline UX:
 *   - click the disclosure caret on an item → the lazy timeline fetch fires
 *     against /api/workflows/:id/items/:itemId/timeline and the rows render
 *   - click a session row → loadSessionIntoStore pulls the log, the route
 *     swings to the History tab, and the log renders in the right pane
 *   - click a prepost row with a captured stdout path (F4) → the right pane
 *     fetches /api/workflows/:wf/items/:item/prepost/:id/stdout and renders
 *     the real captured text; the old "prepost-output-notice" placeholder
 *     testid is gone
 *
 * Seeded path is used (not mock-only) because the realBackend fixture
 * boots the full Fastify + SQLite stack, the timeline endpoint was
 * landed in phase 3, and seeding a workflow + item + session + log
 * file + prepost_runs row is straightforward via db.writer.
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makePrepostOutputDir } from '../../../server/session-log/writer.js';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'stage-1', run: 'once', phases: ['implement'] }],
});

function writeTestSessionLog(logPath: string, sessionId: string, wfId: string): void {
  const lines =
    [
      JSON.stringify({
        type: 'session.started',
        sessionId,
        workflowId: wfId,
        ts: '2026-01-01T00:00:00Z',
        seq: 0,
        payload: {
          sessionId,
          phase: 'implement',
          attempt: 1,
          startedAt: '2026-01-01T00:00:00Z',
          parentSessionId: null,
        },
      }),
      JSON.stringify({
        type: 'stream.system_notice',
        sessionId,
        workflowId: wfId,
        ts: '2026-01-01T00:01:00Z',
        seq: 1,
        payload: {
          blockId: `notice-${sessionId}`,
          severity: 'info',
          source: 'test',
          message: 'Timeline session content',
        },
      }),
    ].join('\n') + '\n';
  fs.writeFileSync(logPath, lines);
}

function seedWorkflowAndItem(
  db: BackendHandle['db'],
  opts: { wfId: string; itemId: string },
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', 'in_progress', ?, ?)`,
    )
    .run(opts.wfId, 'Timeline Test Workflow', PIPELINE, now, now);
  db.writer
    .prepare(
      `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
       VALUES (?, ?, 'stage-1', '{}', 'complete', ?)`,
    )
    .run(opts.itemId, opts.wfId, now);
}

function seedSession(
  db: BackendHandle['db'],
  opts: { wfId: string; itemId: string; sessionId: string; logPath: string },
): void {
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

function seedFailedPostCommand(
  db: BackendHandle['db'],
  opts: {
    wfId: string;
    itemId: string;
    sessionId: string | null;
    commandName: string;
    stdoutPath: string;
  },
): void {
  db.writer
    .prepare(
      `INSERT INTO prepost_runs
       (session_id, workflow_id, item_id, stage, phase, when_phase,
        command_name, argv, started_at, ended_at, exit_code,
        action_taken, stdout_path, stderr_path)
       VALUES (?, ?, ?, 'stage-1', 'implement', 'post',
               ?, '["check"]',
               '2026-01-01T02:00:00Z', '2026-01-01T02:00:05Z', 1,
               ?, ?, NULL)`,
    )
    .run(
      opts.sessionId,
      opts.wfId,
      opts.itemId,
      opts.commandName,
      JSON.stringify({ goto: 'implement' }),
      opts.stdoutPath,
    );
}

test.describe('item-timeline (phase 7)', () => {
  test('expand item → click session row → log loads in right pane', async ({
    page,
    backend,
  }) => {
    const wfId = `wf-tl-sess-${randomUUID().slice(0, 8)}`;
    const itemId = `item-tl-sess-${randomUUID().slice(0, 8)}`;
    const sessionId = `sess-tl-${randomUUID().slice(0, 8)}`;
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-tl-log-'));
    const logPath = path.join(logDir, `${sessionId}.jsonl`);

    try {
      writeTestSessionLog(logPath, sessionId, wfId);
      seedWorkflowAndItem(backend.db, { wfId, itemId });
      seedSession(backend.db, { wfId, itemId, sessionId, logPath });

      await page.goto(`/workflow/${wfId}`);
      await expect(page.locator(`#item-${itemId}`)).toBeVisible({ timeout: 5000 });

      // Expand the item card via the disclosure caret. Caret click stops
      // propagation so it does NOT also select the item — only the inline
      // timeline row click does that.
      await page.getByTestId(`item-caret-${itemId}`).click();

      // Session row from the timeline endpoint must appear.
      const sessionRow = page.getByTestId(`timeline-session-${sessionId}`);
      await expect(sessionRow).toBeVisible({ timeout: 5000 });

      // Click it — this should load the log into the store, select the item,
      // switch to the History tab, and display the session log.
      await sessionRow.click();

      // History tab is now active (route flipped streamTab = 'history').
      await expect(page.getByTestId('tab-history')).toBeVisible();

      // Right pane must render the system notice from the seeded log file.
      await expect(page.getByText('Timeline session content')).toBeVisible({
        timeout: 5000,
      });
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  test('expand item → click prepost row → captured output rendered in right pane', async ({
    page,
    backend,
  }) => {
    const wfId = `wf-tl-pp-${randomUUID().slice(0, 8)}`;
    const itemId = `item-tl-pp-${randomUUID().slice(0, 8)}`;
    const sessionId = `sess-tl-pp-${randomUUID().slice(0, 8)}`;
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-tl-pp-log-'));
    const sessionLogPath = path.join(logDir, `${sessionId}.jsonl`);

    // F4: the artifact endpoint's path-traversal guard requires stdout_path
    // to resolve under makePrepostOutputDir({ configDir, workflowId }). The
    // server uses the default homeDir (os.homedir()), so the seeded file
    // must live under that same tree. The per-workflow directory is
    // fingerprint-scoped (SHA-256 of configDir) so it's isolated per test
    // run and safe to write/remove under $HOME.
    const outputRoot = makePrepostOutputDir({
      configDir: backend.configDir,
      workflowId: wfId,
    });
    fs.mkdirSync(outputRoot, { recursive: true });
    const stdoutPath = path.join(outputRoot, 'post-check.stdout.log');
    const capturedText = 'hello stdout\ntriggered goto implement\n';
    fs.writeFileSync(stdoutPath, capturedText);

    try {
      writeTestSessionLog(sessionLogPath, sessionId, wfId);
      seedWorkflowAndItem(backend.db, { wfId, itemId });
      // Seed a session so the owning item has a plausible shape, then a
      // failed post-command that resolved to { goto: 'implement' }.
      seedSession(backend.db, { wfId, itemId, sessionId, logPath: sessionLogPath });
      seedFailedPostCommand(backend.db, {
        wfId,
        itemId,
        sessionId,
        commandName: 'check',
        stdoutPath,
      });

      await page.goto(`/workflow/${wfId}`);
      await expect(page.locator(`#item-${itemId}`)).toBeVisible({ timeout: 5000 });

      // Expand the item card.
      await page.getByTestId(`item-caret-${itemId}`).click();

      // The prepost row for the failed post-command must render with the
      // "triggered goto implement" action label (prepostActionLabel in
      // TimelineList.tsx for { goto: 'implement' }).
      const prepostRow = page
        .locator('[data-testid^="timeline-prepost-"]')
        .filter({ hasText: 'triggered goto implement' });
      await expect(prepostRow).toBeVisible({ timeout: 5000 });

      // Click it — F4 fetches /api/workflows/:wf/items/:item/prepost/:id/stdout
      // and renders the captured text in the right pane.
      await prepostRow.click();

      const pane = page.getByTestId('prepost-output-pane');
      await expect(pane).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId('prepost-output-text')).toContainText('hello stdout');

      // The F3-era placeholder testid must no longer appear anywhere in the
      // DOM — the 3-second disappearing notice was removed in F4.
      await expect(page.getByTestId('prepost-output-notice')).toHaveCount(0);
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
      // Clean up the fingerprint-scoped output dir under $HOME/.yoke/.
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});
