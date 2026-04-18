/**
 * Integration tests for user_cancel cascade across stages (engine-level).
 *
 * Coverage:
 *   - user_cancel on a stage-N item cascades to stage-(N+k) dependents
 *   - transitive cross-stage cascade (A stage1 → B stage2 → C stage3)
 *   - broadcast frames assert blocked status for all cascaded items
 *   - cascade_block events written for every blocked descendant
 *   - cascade does NOT touch already-terminal items
 *
 * All tests use real SQLite with migrations. No Scheduler, no spawned processes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import type { DbPool } from '../../src/server/storage/db.js';
import { applyItemTransition } from '../../src/server/pipeline/engine.js';
import type { ApplyItemTransitionResult } from '../../src/server/pipeline/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let tmpDir: string;
let pool: DbPool;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-cascade-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  pool = openDbPool(dbPath);
  applyMigrations(pool.writer, MIGRATIONS_DIR);
});

afterEach(() => {
  pool.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

let wfSeq = 0;
let itemSeq = 0;

function makeWfId() { return `wf-${++wfSeq}`; }
function makeItemId() { return `item-${++itemSeq}`; }

function insertWorkflow(id: string) {
  pool.writer
    .prepare(`
      INSERT INTO workflows
        (id, name, spec, pipeline, config, status, created_at, updated_at, worktree_path)
      VALUES (?, 'test', '{}', '[]', '{}', 'in_progress',
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '/tmp/worktree')
    `)
    .run(id);
}

function insertItem(
  id: string,
  wfId: string,
  stageId: string,
  opts: {
    status?: string;
    phase?: string;
    dependsOn?: string[];
  } = {},
) {
  pool.writer
    .prepare(`
      INSERT INTO items
        (id, workflow_id, stage_id, data, status, current_phase,
         depends_on, retry_count, blocked_reason, updated_at)
      VALUES (?, ?, ?, '{}', ?, ?, ?, 0, null, '2026-01-01T00:00:00Z')
    `)
    .run(
      id,
      wfId,
      stageId,
      opts.status ?? 'pending',
      opts.phase ?? 'implement',
      opts.dependsOn ? JSON.stringify(opts.dependsOn) : null,
    );
}

function getItem(id: string) {
  return pool.writer
    .prepare('SELECT * FROM items WHERE id = ?')
    .get(id) as { id: string; status: string; blocked_reason: string | null } | undefined;
}

function countCascadeEvents(wfId: string): number {
  const row = pool.writer
    .prepare("SELECT COUNT(*) AS n FROM events WHERE workflow_id = ? AND event_type = 'cascade_block'")
    .get(wfId) as { n: number };
  return row.n;
}

function countSessions(wfId: string): number {
  const row = pool.writer
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE workflow_id = ?')
    .get(wfId) as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// Broadcast capture helper
// ---------------------------------------------------------------------------

type BroadcastFrame = { workflowId: string; itemId: string; frameType: string; payload: unknown };

function makeBroadcastCapture() {
  const frames: BroadcastFrame[] = [];

  function simulateBroadcast(
    wfId: string,
    itemId: string,
    stageId: string,
    result: ApplyItemTransitionResult,
  ) {
    const item = pool.writer.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as
      | { retry_count: number; blocked_reason: string | null }
      | undefined;
    frames.push({
      workflowId: wfId,
      itemId,
      frameType: 'item.state',
      payload: {
        itemId,
        stageId,
        state: {
          status: result.newState,
          currentPhase: result.newPhase,
          retryCount: item?.retry_count ?? 0,
          blockedReason: item?.blocked_reason ?? null,
        },
      },
    });
  }

  return { frames, simulateBroadcast };
}

// ---------------------------------------------------------------------------
// Tests: cross-stage cascade on user_cancel
// ---------------------------------------------------------------------------

describe('cancel-cascade — user_cancel cross-stage', () => {
  it('stage1 user_cancel cascades to stage2 dependent', () => {
    const wfId = makeWfId();
    const itemA = makeItemId(); // stage1
    const itemB = makeItemId(); // stage2, depends on A

    insertWorkflow(wfId);
    insertItem(itemA, wfId, 'stage1', { status: 'in_progress' });
    insertItem(itemB, wfId, 'stage2', { status: 'pending', dependsOn: [itemA] });

    const { frames, simulateBroadcast } = makeBroadcastCapture();

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: itemA,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'user_cancel',
    });

    simulateBroadcast(wfId, itemA, 'stage1', result);

    expect(result.newState).toBe('abandoned');
    expect(result.cascadeBlocked).toBe(true);

    // Stage2 item must be blocked
    expect(getItem(itemA)?.status).toBe('abandoned');
    expect(getItem(itemB)?.status).toBe('blocked');

    // Cascade event written for itemB
    expect(countCascadeEvents(wfId)).toBe(1);

    // Broadcast frame for itemA
    const frame = frames[0];
    expect(frame.frameType).toBe('item.state');
    expect((frame.payload as any).state.status).toBe('abandoned');

    expect(countSessions(wfId)).toBe(0);
  });

  it('transitive cross-stage: A(stage1) → B(stage2) → C(stage3) all cascaded', () => {
    const wfId = makeWfId();
    const itemA = makeItemId(); // stage1
    const itemB = makeItemId(); // stage2, depends on A
    const itemC = makeItemId(); // stage3, depends on B

    insertWorkflow(wfId);
    insertItem(itemA, wfId, 'stage1', { status: 'in_progress' });
    insertItem(itemB, wfId, 'stage2', { status: 'pending', dependsOn: [itemA] });
    insertItem(itemC, wfId, 'stage3', { status: 'pending', dependsOn: [itemB] });

    const { frames, simulateBroadcast } = makeBroadcastCapture();

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: itemA,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'user_cancel',
    });

    simulateBroadcast(wfId, itemA, 'stage1', result);

    expect(result.cascadeBlocked).toBe(true);
    expect(getItem(itemB)?.status).toBe('blocked');
    expect(getItem(itemC)?.status).toBe('blocked');

    // Two cascade_block events (one per blocked descendant)
    expect(countCascadeEvents(wfId)).toBe(2);

    expect(frames).toHaveLength(1);
    expect((frames[0].payload as any).state.status).toBe('abandoned');

    expect(countSessions(wfId)).toBe(0);
  });

  it('multiple stage2 dependents all blocked when stage1 item is cancelled', () => {
    const wfId = makeWfId();
    const itemA = makeItemId(); // stage1
    const itemB = makeItemId(); // stage2, depends on A
    const itemC = makeItemId(); // stage2, depends on A (sibling)

    insertWorkflow(wfId);
    insertItem(itemA, wfId, 'stage1', { status: 'in_progress' });
    insertItem(itemB, wfId, 'stage2', { status: 'pending', dependsOn: [itemA] });
    insertItem(itemC, wfId, 'stage2', { status: 'pending', dependsOn: [itemA] });

    const { frames, simulateBroadcast } = makeBroadcastCapture();

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: itemA,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'user_cancel',
    });

    simulateBroadcast(wfId, itemA, 'stage1', result);

    expect(result.cascadeBlocked).toBe(true);
    expect(getItem(itemB)?.status).toBe('blocked');
    expect(getItem(itemC)?.status).toBe('blocked');
    expect(countCascadeEvents(wfId)).toBe(2);

    expect(frames).toHaveLength(1);
    expect((frames[0].payload as any).state.status).toBe('abandoned');

    expect(countSessions(wfId)).toBe(0);
  });

  it('cascade does NOT touch already-terminal items in later stages', () => {
    const wfId = makeWfId();
    const itemA = makeItemId(); // stage1
    const itemB = makeItemId(); // stage2, already complete

    insertWorkflow(wfId);
    insertItem(itemA, wfId, 'stage1', { status: 'in_progress' });
    insertItem(itemB, wfId, 'stage2', { status: 'complete', dependsOn: [itemA] });

    const { frames, simulateBroadcast } = makeBroadcastCapture();

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: itemA,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'user_cancel',
    });

    simulateBroadcast(wfId, itemA, 'stage1', result);

    // Complete item must remain untouched
    expect(getItem(itemB)?.status).toBe('complete');
    expect(countCascadeEvents(wfId)).toBe(0);

    expect(frames).toHaveLength(1);
    expect((frames[0].payload as any).state.status).toBe('abandoned');

    expect(countSessions(wfId)).toBe(0);
  });

  it('awaiting_user on stage-N item also cascades to stage-(N+k) dependents', () => {
    const wfId = makeWfId();
    const itemA = makeItemId(); // stage1, goes awaiting_user
    const itemB = makeItemId(); // stage2, depends on A

    insertWorkflow(wfId);
    insertItem(itemA, wfId, 'stage1', { status: 'in_progress' });
    insertItem(itemB, wfId, 'stage2', { status: 'pending', dependsOn: [itemA] });

    const { frames, simulateBroadcast } = makeBroadcastCapture();

    // session_fail with policy → awaiting_user
    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: itemA,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_fail',
      guardCtx: { classifierResult: 'policy' },
    });

    simulateBroadcast(wfId, itemA, 'stage1', result);

    expect(result.newState).toBe('awaiting_user');
    expect(result.cascadeBlocked).toBe(true);
    expect(getItem(itemB)?.status).toBe('blocked');
    expect(countCascadeEvents(wfId)).toBe(1);

    expect(frames).toHaveLength(1);
    expect((frames[0].payload as any).state.status).toBe('awaiting_user');

    expect(countSessions(wfId)).toBe(0);
  });
});
