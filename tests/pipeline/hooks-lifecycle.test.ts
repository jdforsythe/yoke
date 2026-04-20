/**
 * Integration tests for pre/post hook lifecycle (engine-level).
 *
 * Coverage:
 *   - pre_command_failed + preCommandAction='fail': retry ladder steps
 *   - pre_command_failed + preCommandAction='stop-and-ask': immediately awaiting_user
 *   - post_command_action + {kind:'stop'}: abandoned
 *   - session_ok after a failing session: phase does NOT auto-advance
 *   - broadcast frames emitted for each transition
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-hooks-test-'));
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
    retryCount?: number;
  } = {},
) {
  pool.writer
    .prepare(`
      INSERT INTO items
        (id, workflow_id, stage_id, data, status, current_phase,
         depends_on, retry_count, blocked_reason, updated_at)
      VALUES (?, ?, ?, '{}', ?, ?, null, ?, null, '2026-01-01T00:00:00Z')
    `)
    .run(id, wfId, stageId, opts.status ?? 'in_progress', opts.phase ?? 'implement', opts.retryCount ?? 0);
}

function getItem(id: string) {
  return pool.writer
    .prepare('SELECT * FROM items WHERE id = ?')
    .get(id) as { id: string; status: string; current_phase: string | null; retry_count: number } | undefined;
}

function countSessions(wfId: string): number {
  const row = pool.writer
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE workflow_id = ?')
    .get(wfId) as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// Broadcast capture helper (replicates Scheduler._broadcastItemState logic)
// ---------------------------------------------------------------------------

type BroadcastFrame = { workflowId: string; frameType: string; payload: unknown };

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
// Tests: pre_command_failed — retry ladder via 'fail' action
// ---------------------------------------------------------------------------

describe('hooks-lifecycle — pre_command_failed + action=fail', () => {
  it('retry_count=0 → awaiting_retry with mode=continue, retry_count bumped to 1', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'implement', retryCount: 0 });

    const { frames, simulateBroadcast } = makeBroadcastCapture();

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'pre_command_failed',
      guardCtx: { preCommandAction: 'fail' },
    });

    simulateBroadcast(wfId, itemId, 'stage1', result);

    expect(result.newState).toBe('awaiting_retry');
    expect(result.retryMode).toBe('continue');
    expect(getItem(itemId)?.retry_count).toBe(1);
    expect(getItem(itemId)?.status).toBe('awaiting_retry');

    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame.frameType).toBe('item.state');
    expect((frame.payload as any).state.status).toBe('awaiting_retry');
    expect((frame.payload as any).state.retryCount).toBe(1);

    // No session rows — pre command failed before any session was spawned
    expect(countSessions(wfId)).toBe(0);
  });

  it('retry_count=1 → awaiting_retry with mode=fresh_with_failure_summary, retry_count=2', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'implement', retryCount: 1 });

    const { frames, simulateBroadcast } = makeBroadcastCapture();

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'pre_command_failed',
      guardCtx: { preCommandAction: 'fail' },
    });

    simulateBroadcast(wfId, itemId, 'stage1', result);

    expect(result.newState).toBe('awaiting_retry');
    expect(result.retryMode).toBe('fresh_with_failure_summary');
    expect(getItem(itemId)?.retry_count).toBe(2);
    expect(getItem(itemId)?.status).toBe('awaiting_retry');

    expect(frames).toHaveLength(1);
    expect((frames[0].payload as any).state.status).toBe('awaiting_retry');
    expect((frames[0].payload as any).state.retryCount).toBe(2);

    expect(countSessions(wfId)).toBe(0);
  });

  it('retry_count=2 → awaiting_user (ladder exhausted at awaiting_user sentinel)', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'implement', retryCount: 2 });

    const { frames, simulateBroadcast } = makeBroadcastCapture();

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 2,
      event: 'pre_command_failed',
      guardCtx: { preCommandAction: 'fail' },
    });

    simulateBroadcast(wfId, itemId, 'stage1', result);

    expect(result.newState).toBe('awaiting_user');
    expect(getItem(itemId)?.status).toBe('awaiting_user');

    expect(frames).toHaveLength(1);
    expect((frames[0].payload as any).state.status).toBe('awaiting_user');

    expect(countSessions(wfId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: pre_command_failed — stop-and-ask bypasses retry ladder
// ---------------------------------------------------------------------------

describe('hooks-lifecycle — pre_command_failed + action=stop-and-ask', () => {
  it('stop-and-ask at retry_count=0 → immediately awaiting_user (no retry)', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'implement', retryCount: 0 });

    const { frames, simulateBroadcast } = makeBroadcastCapture();

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'pre_command_failed',
      guardCtx: { preCommandAction: 'stop-and-ask' },
    });

    simulateBroadcast(wfId, itemId, 'stage1', result);

    expect(result.newState).toBe('awaiting_user');
    expect(result.retryMode).toBeUndefined();
    expect(getItem(itemId)?.retry_count).toBe(0);
    expect(getItem(itemId)?.status).toBe('awaiting_user');

    expect((frames[0].payload as any).state.status).toBe('awaiting_user');
    expect((frames[0].payload as any).state.retryCount).toBe(0);

    expect(countSessions(wfId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: post_command_action — abort (stop)
// ---------------------------------------------------------------------------

describe('hooks-lifecycle — post_command_action=stop → abandoned', () => {
  it('post abort leaves item in abandoned, retry_count unchanged', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'implement', retryCount: 0 });

    const { frames, simulateBroadcast } = makeBroadcastCapture();

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'post_command_action',
      guardCtx: { postCommandAction: { kind: 'stop' } },
    });

    simulateBroadcast(wfId, itemId, 'stage1', result);

    expect(result.newState).toBe('abandoned');
    expect(getItem(itemId)?.status).toBe('abandoned');
    expect(getItem(itemId)?.retry_count).toBe(0);

    expect((frames[0].payload as any).state.status).toBe('abandoned');

    expect(countSessions(wfId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: session_fail after success does NOT advance phase
// ---------------------------------------------------------------------------

describe('hooks-lifecycle — session_fail after prior success', () => {
  it('session_fail (transient) → awaiting_retry, current_phase unchanged', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'implement', retryCount: 0 });

    const { frames, simulateBroadcast } = makeBroadcastCapture();

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_fail',
      guardCtx: { classifierResult: 'transient' },
    });

    simulateBroadcast(wfId, itemId, 'stage1', result);

    // Session fail → awaiting_retry (transient classifier)
    expect(result.newState).toBe('awaiting_retry');
    expect(getItem(itemId)?.current_phase).toBe('implement');
    expect(getItem(itemId)?.retry_count).toBe(1);

    expect((frames[0].payload as any).state.status).toBe('awaiting_retry');
    expect((frames[0].payload as any).state.currentPhase).toBe('implement');

    expect(countSessions(wfId)).toBe(0);
  });

  it('session_fail (policy) → awaiting_user, current_phase unchanged', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'implement', retryCount: 0 });

    const { frames, simulateBroadcast } = makeBroadcastCapture();

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_fail',
      guardCtx: { classifierResult: 'policy' },
    });

    simulateBroadcast(wfId, itemId, 'stage1', result);

    expect(result.newState).toBe('awaiting_user');
    expect(getItem(itemId)?.current_phase).toBe('implement');
    expect(getItem(itemId)?.retry_count).toBe(0);

    expect(frames).toHaveLength(1);
    expect((frames[0].payload as any).state.status).toBe('awaiting_user');
    expect((frames[0].payload as any).state.currentPhase).toBe('implement');

    expect(countSessions(wfId)).toBe(0);
  });
});
