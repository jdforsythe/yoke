#!/usr/bin/env -S tsx
/**
 * scripts/demo/seed.ts — populate a yoke configDir with the demo fixture.
 *
 * Usage:
 *   tsx scripts/demo/seed.ts --config-dir <path>
 *
 * What it does:
 *   1. mkdir -p <configDir>/.yoke/templates
 *   2. Copy scripts/demo/templates/*.yml into the templates dir.
 *   3. Open the SQLite DB at <configDir>/yoke.db and apply migrations.
 *   4. DELETE FROM workflows (cascades to items/sessions/events).
 *   5. Insert the fixture in a single transaction.
 *   6. For sessions with logFrames, write the JSONL file at the canonical
 *      path (computed via makeSessionLogPath, which honors $HOME) and
 *      record session_log_path on the row.
 *
 * Idempotent: re-runs wipe and re-insert.
 */

import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import { makeSessionLogPath } from '../../src/server/session-log/writer.js';

import {
  FIXTURE,
  type DemoFixture,
  type DemoLogFrame,
  type DemoWorkflow,
  type OffsetSec,
} from './fixture.js';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { configDir: string } {
  const i = argv.indexOf('--config-dir');
  if (i === -1 || !argv[i + 1]) {
    console.error('usage: tsx scripts/demo/seed.ts --config-dir <path>');
    process.exit(2);
  }
  return { configDir: path.resolve(argv[i + 1]!) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'src', 'server', 'storage', 'migrations');
const TEMPLATES_SRC = path.join(HERE, 'templates');

function copyTemplates(configDir: string): number {
  const dest = path.join(configDir, '.yoke', 'templates');
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(TEMPLATES_SRC)) {
    if (!f.endsWith('.yml')) continue;
    fs.copyFileSync(path.join(TEMPLATES_SRC, f), path.join(dest, f));
    n++;
  }
  return n;
}

function iso(now: number, off: OffsetSec | null | undefined): string | null {
  if (off === null || off === undefined) return null;
  return new Date(now + off * 1000).toISOString();
}

function rewriteFrameTimestamps(frames: DemoLogFrame[], now: number, fixtureBaselineNow: number): DemoLogFrame[] {
  // The fixture builds frame `ts` strings against its own Date.now() at module
  // load time. To keep the transcript timestamps relative to *seed* time, we
  // shift each ts by (now - fixtureBaselineNow).
  const drift = now - fixtureBaselineNow;
  return frames.map((f) => ({
    ...f,
    ts: new Date(new Date(f.ts).getTime() + drift).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Insert helpers
// ---------------------------------------------------------------------------

function insertWorkflow(
  writer: import('better-sqlite3').Database,
  wf: DemoWorkflow,
  now: number,
  configDir: string,
): void {
  const created = iso(now, wf.createdAtOffset)!;
  const updated = iso(now, wf.updatedAtOffset)!;
  const paused = iso(now, wf.pausedAtOffset);
  const archived = iso(now, wf.archivedAtOffset);

  // pipeline column: full stages + phases (matches createWorkflow's shape).
  const pipelineJson = JSON.stringify({ stages: wf.stages, phases: wf.phases });
  const specJson = JSON.stringify({ stages: wf.stages.map((s) => s.id) });
  const configJson = JSON.stringify({ configDir });

  writer
    .prepare(`
      INSERT INTO workflows
        (id, name, template_name, spec, pipeline, config, status, current_stage,
         worktree_path, branch_name, paused_at, archived_at,
         github_state, github_pr_number, github_pr_url, github_pr_state,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?)
    `)
    .run(
      wf.id,
      wf.name,
      wf.templateName,
      specJson,
      pipelineJson,
      configJson,
      wf.status,
      wf.currentStage,
      wf.worktreePath ?? null,
      wf.branchName ?? null,
      paused,
      archived,
      wf.github?.state ?? 'disabled',
      wf.github?.prNumber ?? null,
      wf.github?.prUrl ?? null,
      wf.github?.prState ?? null,
      created,
      updated,
    );

  const itemStmt = writer.prepare(`
    INSERT INTO items
      (id, workflow_id, stage_id, data, status, current_phase,
       depends_on, retry_count, blocked_reason, stable_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
  for (const item of wf.items) {
    itemStmt.run(
      item.id,
      wf.id,
      item.stageId,
      JSON.stringify(item.data),
      item.status,
      item.currentPhase,
      item.dependsOn ? JSON.stringify(item.dependsOn) : null,
      item.blockedReason ?? null,
      item.stableId,
      iso(now, item.updatedAtOffset),
    );
  }

  const sessionStmt = writer.prepare(`
    INSERT INTO sessions
      (id, workflow_id, item_id, stage, phase, agent_profile,
       started_at, ended_at, exit_code, status)
    VALUES (?, ?, ?, ?, ?, 'default', ?, ?, ?, ?)
  `);
  for (const s of wf.sessions) {
    sessionStmt.run(
      s.id,
      wf.id,
      s.itemId,
      s.stage,
      s.phase,
      iso(now, s.startedAtOffset),
      iso(now, s.endedAtOffset),
      s.exitCode ?? null,
      s.status === 'running' ? 'running' : 'ended',
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { configDir } = parseArgs(process.argv.slice(2));

  fs.mkdirSync(configDir, { recursive: true });
  const nTemplates = copyTemplates(configDir);

  // Production CLI puts the DB at <configDir>/.yoke/yoke.db; mirror that so
  // the seeded data is what `bin/yoke start --config-dir <dir>` reads.
  const yokeDir = path.join(configDir, '.yoke');
  fs.mkdirSync(yokeDir, { recursive: true });
  const dbPath = path.join(yokeDir, 'yoke.db');
  const pool = openDbPool(dbPath);
  applyMigrations(pool.writer, MIGRATIONS_DIR);

  const fixture: DemoFixture = FIXTURE;
  const now = Date.now();
  // Capture roughly when the fixture module was evaluated (close to now);
  // any small drift just shifts the transcript timestamps a few ms.
  const fixtureBaselineNow = now;

  let totalItems = 0;
  let totalSessions = 0;
  const logsToWrite: Array<{ sessionId: string; workflowId: string; frames: DemoLogFrame[] }> = [];

  pool.transaction((writer) => {
    writer.exec('DELETE FROM workflows');
    writer.exec('DELETE FROM pending_attention');

    for (const wf of fixture.workflows) {
      insertWorkflow(writer, wf, now, configDir);
      totalItems += wf.items.length;
      totalSessions += wf.sessions.length;

      for (const s of wf.sessions) {
        if (s.logFrames && s.logFrames.length > 0) {
          logsToWrite.push({
            sessionId: s.id,
            workflowId: wf.id,
            frames: rewriteFrameTimestamps(s.logFrames, now, fixtureBaselineNow),
          });
        }
      }
    }

    const attnStmt = writer.prepare(`
      INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const a of fixture.pendingAttention) {
      attnStmt.run(a.workflowId, a.kind, JSON.stringify(a.payload), iso(now, a.createdAtOffset));
    }
  });

  // Write session log JSONL files outside the transaction (filesystem I/O).
  // Use real $HOME so the path matches what the running yoke server resolves.
  const homeDir = process.env.HOME || os.homedir();
  let firstLogDir: string | null = null;
  const updateLogPath = pool.writer.prepare(
    'UPDATE sessions SET session_log_path = ? WHERE id = ?',
  );

  for (const { sessionId, workflowId, frames } of logsToWrite) {
    const logPath = makeSessionLogPath({ configDir, workflowId, sessionId, homeDir });
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const body = frames.map((f) => JSON.stringify(f)).join('\n') + '\n';
    fs.writeFileSync(logPath, body, 'utf8');
    updateLogPath.run(logPath, sessionId);
    if (!firstLogDir) firstLogDir = path.dirname(path.dirname(logPath));
  }

  pool.close();

  console.log(
    `Seeded ${fixture.workflows.length} workflows, ${totalItems} items, ${totalSessions} sessions; ` +
      `templates copied: ${nTemplates}; logs at ${firstLogDir ?? '(none)'}`,
  );
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
