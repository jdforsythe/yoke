#!/usr/bin/env node
/**
 * pipeline-watch.js — live pipeline status for `watch -n 10`.
 *
 * Shows the most recent active workflow with per-stage item counts,
 * running sessions (with feature label), retry info, and blocked reasons.
 *
 * Usage: node scripts/pipeline-watch.js [workflow-id]
 */

import Database from "better-sqlite3";
import { join } from "path";
import { existsSync } from "fs";

const dbPath = join(process.cwd(), ".yoke", "yoke.db");
if (!existsSync(dbPath)) {
  process.stderr.write(`No DB at ${dbPath}\n`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

// Find the workflow: explicit ID arg, or most recent active one.
const explicitId = process.argv[2];

const workflow = explicitId
  ? db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(explicitId)
  : db
      .prepare(
        `SELECT * FROM workflows
         WHERE status NOT IN ('completed','completed_with_blocked','abandoned')
           AND archived_at IS NULL
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get();

if (!workflow) {
  console.log(explicitId ? `No workflow found: ${explicitId}` : "No active workflow found.");
  process.exit(0);
}

const pipeline = JSON.parse(workflow.pipeline);
const stages   = pipeline.stages ?? [];
const now      = new Date().toISOString();

// ── Running sessions (across whole workflow) ────────────────────────────────
// Join with items to get the human-readable feature label from items.data.
const runningSessions = db
  .prepare(
    `SELECT s.stage, s.phase, s.status, s.status_flags, s.pid,
            s.started_at, s.last_event_at, s.last_event_type,
            json_extract(i.data, '$.id') AS item_label
     FROM sessions s
     LEFT JOIN items i ON s.item_id = i.id
     WHERE s.workflow_id = ? AND s.status = 'running'
     ORDER BY s.started_at`
  )
  .all(workflow.id);

// ── Header ─────────────────────────────────────────────────────────────────
console.log(`${"─".repeat(80)}`);
console.log(`  PIPELINE WATCH  ${now}`);
console.log(`${"─".repeat(80)}`);
console.log(`  Workflow : ${workflow.name}`);
console.log(`  Status   : ${workflow.status}  |  Running sessions: ${runningSessions.length}`);
console.log(`  Updated  : ${workflow.updated_at}`);
console.log(`${"─".repeat(80)}`);

// ── Per-stage breakdown ─────────────────────────────────────────────────────
for (const stage of stages) {
  // Item counts grouped by (status, current_phase).
  const itemRows = db
    .prepare(
      `SELECT status, current_phase, COUNT(*) AS cnt,
              SUM(retry_count) AS total_retries,
              MAX(retry_count) AS max_retry
       FROM items
       WHERE workflow_id = ? AND stage_id = ?
       GROUP BY status, current_phase
       ORDER BY status, current_phase`
    )
    .all(workflow.id, stage.id);

  const runningHere = runningSessions.filter(s => s.stage === stage.id).length;

  // Blocked items with reasons.
  const blocked = db
    .prepare(
      `SELECT json_extract(data, '$.id') AS label, blocked_reason
       FROM items
       WHERE workflow_id = ? AND stage_id = ? AND status = 'blocked' AND blocked_reason IS NOT NULL
       LIMIT 5`
    )
    .all(workflow.id, stage.id);

  // Awaiting-retry items with feature labels.
  const retrying = db
    .prepare(
      `SELECT json_extract(data, '$.id') AS label, retry_count, retry_window_start
       FROM items
       WHERE workflow_id = ? AND stage_id = ? AND status = 'awaiting_retry'
       ORDER BY retry_count DESC LIMIT 5`
    )
    .all(workflow.id, stage.id);

  const totalItems = itemRows.reduce((s, r) => s + r.cnt, 0);

  console.log(`\n  ${stage.id}  [${stage.run}]`);
  console.log(`  ${"─".repeat(76)}`);

  if (totalItems === 0) {
    console.log(`    (no items)`);
  } else {
    console.log(`    Items: ${totalItems}  |  Running sessions: ${runningHere}`);
    for (const row of itemRows) {
      const phase   = row.current_phase ? `/${row.current_phase}` : "";
      const retries = row.total_retries > 0 ? `  [retries: ${row.total_retries} total, max ${row.max_retry}]` : "";
      console.log(`      ${(row.status + phase).padEnd(30)} ${String(row.cnt).padStart(3)}${retries}`);
    }

    if (retrying.length > 0) {
      console.log(`    Awaiting retry:`);
      for (const r of retrying) {
        const since = r.retry_window_start ? ` since ${r.retry_window_start}` : "";
        console.log(`      ${(r.label ?? "?").padEnd(12)} retry #${r.retry_count}${since}`);
      }
    }

    if (blocked.length > 0) {
      console.log(`    Blocked:`);
      for (const b of blocked) {
        console.log(`      ${(b.label ?? "?").padEnd(12)} ${b.blocked_reason}`);
      }
    }
  }
}

// ── Running sessions ────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(80)}`);
console.log(`  RUNNING SESSIONS (${runningSessions.length})`);
console.log(`${"─".repeat(80)}`);

// Items that are in_progress but have no running session (transition lag).
const awaitingSession = db
  .prepare(
    `SELECT json_extract(i.data, '$.id') AS label, i.stage_id, i.current_phase
     FROM items i
     WHERE i.workflow_id = ? AND i.status = 'in_progress'
       AND NOT EXISTS (
         SELECT 1 FROM sessions s
         WHERE s.item_id = i.id AND s.status = 'running'
       )`
  )
  .all(workflow.id);

if (runningSessions.length === 0 && awaitingSession.length === 0) {
  console.log(`  (none)`);
} else {
  for (const s of runningSessions) {
    const label  = s.item_label ?? "(no item)";
    const flags  = s.status_flags ? ` [${s.status_flags}]` : "";
    const pid    = s.pid ? ` pid=${s.pid}` : "";
    const last   = s.last_event_at
      ? `  last ${s.last_event_type ?? "?"} @ ${s.last_event_at}`
      : "";
    console.log(`  ${label.padEnd(12)} ${s.phase.padEnd(12)} ${s.stage}${flags}${pid}${last}`);
  }
  for (const a of awaitingSession) {
    console.log(`  ${(a.label ?? "?").padEnd(12)} ${(a.current_phase ?? "?").padEnd(12)} ${a.stage_id}  (awaiting session)`);
  }
}

console.log(`\n${"─".repeat(80)}`);
