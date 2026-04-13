/**
 * Integration tests for the Pipeline Engine (src/server/pipeline/engine.ts).
 *
 * Uses real SQLite with migrations applied.  No mocks of the database layer.
 *
 * Coverage:
 *   AC-1  Stage advancement fires stage_complete only when ALL items terminal.
 *   AC-2  Dependency cascade-blocks transitive dependents in same transaction.
 *   AC-3  Retry ladder: attempt 1=continue, 2=fresh_with_failure_summary, 3=exhausted.
 *   AC-4  Crash recovery: sets recovery_state, no auto-transition.
 *   AC-5  (structural) Pipeline Engine is the only SQLite mutator.
 *   AC-6  Every transition committed in db.transaction before side effects.
 *   RC-1  No long-lived in-memory state; every call re-reads SQLite.
 *   RC-2  Crash recovery sets recovery_state only, no item transitions.
 *   RC-3  max_revisits tracked per (item_id, destination_phase) pair.
 *   RC-4  needs_approval:true inserts pending_attention{kind=stage_needs_approval}
 *         and sets workflows.status='pending_stage_approval' (workflow-level pause).
 *   RC-5  Events table row written for every transition with full correlation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import type { DbPool } from '../../src/server/storage/db.js';
import {
  applyItemTransition,
  checkStageComplete,
  buildCrashRecovery,
} from '../../src/server/pipeline/engine.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

let tmpDir: string;
let pool: DbPool;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-engine-test-'));
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

function makeWfId() {
  return `wf-${++wfSeq}`;
}
function makeItemId() {
  return `item-${++itemSeq}`;
}

function insertWorkflow(id: string, opts: { worktreePath?: string; pipeline?: string } = {}) {
  pool.writer
    .prepare(`
      INSERT INTO workflows
        (id, name, spec, pipeline, config, status, created_at, updated_at, worktree_path)
      VALUES (?, 'test', '{}', ?, '{}', 'in_progress',
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)
    `)
    .run(id, opts.pipeline ?? '[]', opts.worktreePath ?? null);
}

function insertItem(
  id: string,
  wfId: string,
  stageId: string,
  opts: {
    status?: string;
    phase?: string;
    dependsOn?: string[];
    retryCount?: number;
  } = {},
) {
  pool.writer
    .prepare(`
      INSERT INTO items
        (id, workflow_id, stage_id, data, status, current_phase,
         depends_on, retry_count, updated_at)
      VALUES (?, ?, ?, '{}', ?, ?, ?, ?, '2026-01-01T00:00:00Z')
    `)
    .run(
      id,
      wfId,
      stageId,
      opts.status ?? 'pending',
      opts.phase ?? 'implement',
      opts.dependsOn ? JSON.stringify(opts.dependsOn) : null,
      opts.retryCount ?? 0,
    );
}

function insertSession(
  id: string,
  wfId: string,
  opts: { itemId?: string; status?: string; pid?: number | null; phase?: string } = {},
) {
  pool.writer
    .prepare(`
      INSERT INTO sessions
        (id, workflow_id, item_id, stage, phase, agent_profile,
         pid, started_at, status)
      VALUES (?, ?, ?, 'stage1', ?, 'claude', ?, '2026-01-01T00:00:00Z', ?)
    `)
    .run(
      id,
      wfId,
      opts.itemId ?? null,
      opts.phase ?? 'implement',
      opts.pid !== undefined ? opts.pid : null,
      opts.status ?? 'running',
    );
}

function getItem(id: string) {
  return pool.writer
    .prepare('SELECT * FROM items WHERE id = ?')
    .get(id) as {
      id: string;
      status: string;
      current_phase: string | null;
      retry_count: number;
      blocked_reason: string | null;
    } | undefined;
}

function countEvents(workflowId: string, eventType?: string): number {
  const q = eventType
    ? pool.writer
        .prepare('SELECT COUNT(*) AS n FROM events WHERE workflow_id = ? AND event_type = ?')
        .get(workflowId, eventType)
    : pool.writer
        .prepare('SELECT COUNT(*) AS n FROM events WHERE workflow_id = ?')
        .get(workflowId);
  return (q as { n: number }).n;
}

function countPendingAttention(workflowId: string): number {
  const row = pool.writer
    .prepare('SELECT COUNT(*) AS n FROM pending_attention WHERE workflow_id = ?')
    .get(workflowId) as { n: number };
  return row.n;
}

function pendingAttentionKinds(workflowId: string): string[] {
  const rows = pool.writer
    .prepare('SELECT kind FROM pending_attention WHERE workflow_id = ?')
    .all(workflowId) as { kind: string }[];
  return rows.map(r => r.kind);
}

// ---------------------------------------------------------------------------
// applyItemTransition — basic state transitions
// ---------------------------------------------------------------------------

describe('applyItemTransition — direct transitions', () => {
  it('transitions pending → abandoned via user_cancel', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'pending' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'user_cancel',
    });

    expect(result.newState).toBe('abandoned');
    expect(getItem(itemId)?.status).toBe('abandoned');
  });

  it('transitions awaiting_user → blocked via user_block', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'awaiting_user' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'user_block',
    });

    expect(result.newState).toBe('blocked');
    expect(getItem(itemId)?.status).toBe('blocked');
  });

  it('transitions bootstrapping → in_progress via bootstrap_ok', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'bootstrapping' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'bootstrap_ok',
    });

    expect(result.newState).toBe('in_progress');
    expect(getItem(itemId)?.status).toBe('in_progress');
  });
});

// ---------------------------------------------------------------------------
// applyItemTransition — events row for every transition (RC-5)
// ---------------------------------------------------------------------------

describe('applyItemTransition — events table (RC-5)', () => {
  it('writes one events row per transition with full correlation', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    const sessId = 'sess-abc';
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'awaiting_user' });
    insertSession(sessId, wfId, { itemId, status: 'ok' });

    applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: sessId,
      stage: 'stage1',
      phase: 'review',
      attempt: 2,
      event: 'user_retry',
    });

    const row = pool.writer
      .prepare(`
        SELECT * FROM events
         WHERE workflow_id = ? AND event_type = 'user_retry'
      `)
      .get(wfId) as {
        workflow_id: string;
        item_id: string;
        session_id: string;
        stage: string;
        phase: string;
        attempt: number;
      };

    expect(row).toBeDefined();
    expect(row.workflow_id).toBe(wfId);
    expect(row.item_id).toBe(itemId);
    expect(row.session_id).toBe(sessId);
    expect(row.stage).toBe('stage1');
    expect(row.phase).toBe('review');
    expect(row.attempt).toBe(2);
  });

  it('writes event even for no-op unknown (state, event) pairs', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    // 'complete' state does not have a 'session_fail' transition
    insertItem(itemId, wfId, 'stage1', { status: 'complete' });

    applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'session_fail',
    });

    // Item should not have changed
    expect(getItem(itemId)?.status).toBe('complete');
    // But a noop event was written
    expect(countEvents(wfId)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// applyItemTransition — conditional: deps_satisfied
// ---------------------------------------------------------------------------

describe('applyItemTransition — deps_satisfied guard', () => {
  it('pending → ready when all deps are complete', () => {
    const wfId = makeWfId();
    const dep1 = makeItemId();
    const dep2 = makeItemId();
    const depItem = makeItemId();
    insertWorkflow(wfId);
    insertItem(dep1, wfId, 'stage1', { status: 'complete' });
    insertItem(dep2, wfId, 'stage1', { status: 'complete' });
    insertItem(depItem, wfId, 'stage1', {
      status: 'pending',
      dependsOn: [dep1, dep2],
    });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: depItem,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'deps_satisfied',
    });

    expect(result.newState).toBe('ready');
    expect(getItem(depItem)?.status).toBe('ready');
  });

  it('pending stays pending when not all deps complete (guard fails → no-op)', () => {
    const wfId = makeWfId();
    const dep1 = makeItemId();
    const dep2 = makeItemId();
    const depItem = makeItemId();
    insertWorkflow(wfId);
    insertItem(dep1, wfId, 'stage1', { status: 'complete' });
    insertItem(dep2, wfId, 'stage1', { status: 'in_progress' }); // not complete
    insertItem(depItem, wfId, 'stage1', {
      status: 'pending',
      dependsOn: [dep1, dep2],
    });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: depItem,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'deps_satisfied',
    });

    // Guard failed — no-op
    expect(result.newState).toBe('pending');
    expect(getItem(depItem)?.status).toBe('pending');
  });

  it('pending → ready with no depends_on (empty deps always satisfied)', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'pending' }); // no depends_on

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'deps_satisfied',
    });

    expect(result.newState).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// applyItemTransition — conditional: phase_start (worktree guard)
// ---------------------------------------------------------------------------

describe('applyItemTransition — phase_start worktree guard', () => {
  it('ready → bootstrapping when worktree_path is null', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId); // worktree_path defaults to null
    insertItem(itemId, wfId, 'stage1', { status: 'ready' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'phase_start',
    });

    expect(result.newState).toBe('bootstrapping');
  });

  it('ready → in_progress when worktree already exists', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId, { worktreePath: '/tmp/some-worktree' });
    insertItem(itemId, wfId, 'stage1', { status: 'ready' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'phase_start',
    });

    expect(result.newState).toBe('in_progress');
  });
});

// ---------------------------------------------------------------------------
// applyItemTransition — session_fail + retry ladder (AC-3)
// ---------------------------------------------------------------------------

describe('applyItemTransition — retry ladder (AC-3)', () => {
  it('session_fail transient + retry_count=0 → awaiting_retry with continue', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', retryCount: 0 });

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

    expect(result.newState).toBe('awaiting_retry');
    expect(result.retryMode).toBe('continue');
    expect(getItem(itemId)?.retry_count).toBe(1); // incremented
  });

  it('session_fail transient + retry_count=1 → awaiting_retry with fresh_with_failure_summary', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', retryCount: 1 });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 2,
      event: 'session_fail',
      guardCtx: { classifierResult: 'transient' },
    });

    expect(result.newState).toBe('awaiting_retry');
    expect(result.retryMode).toBe('fresh_with_failure_summary');
    expect(getItem(itemId)?.retry_count).toBe(2);
  });

  it('session_fail transient + retry_count=2 → awaiting_user (exhausted)', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', retryCount: 2 });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 3,
      event: 'session_fail',
      guardCtx: { classifierResult: 'transient' },
    });

    expect(result.newState).toBe('awaiting_user');
    expect(result.retryMode).toBeUndefined();
  });

  it('session_fail permanent → awaiting_user (no retry)', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', retryCount: 0 });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_fail',
      guardCtx: { classifierResult: 'permanent' },
    });

    expect(result.newState).toBe('awaiting_user');
    expect(result.retryMode).toBeUndefined();
    expect(getItem(itemId)?.retry_count).toBe(0); // not incremented
  });

  it('session_fail unknown → awaiting_user (D07 safe default)', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', retryCount: 0 });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_fail',
      guardCtx: { classifierResult: 'unknown' },
    });

    expect(result.newState).toBe('awaiting_user');
  });

  it('retry_count is incremented exactly once on awaiting_retry (test assertion #7)', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', retryCount: 0 });

    applyItemTransition({
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

    expect(getItem(itemId)?.retry_count).toBe(1);
  });

  it('awaiting_retry → in_progress via backoff_elapsed returns retryMode', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', {
      status: 'awaiting_retry',
      retryCount: 1, // one retry already done
    });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'backoff_elapsed',
      guardCtx: { currentRetryMode: 'continue' },
    });

    expect(result.newState).toBe('in_progress');
    expect(result.retryMode).toBe('continue');
  });

  it('custom retry_ladder is honoured', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', retryCount: 0 });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_fail',
      guardCtx: {
        classifierResult: 'transient',
        retryLadder: ['fresh_with_diff', 'fresh_with_failure_summary', 'awaiting_user'],
        maxOuterRetries: 3,
      },
    });

    expect(result.retryMode).toBe('fresh_with_diff');
  });
});

// ---------------------------------------------------------------------------
// applyItemTransition — session_ok phase advance (AC-1 prerequisite)
// ---------------------------------------------------------------------------

describe('applyItemTransition — session_ok phase advance', () => {
  it('session_ok with more phases advances current_phase', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'implement' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_ok',
      guardCtx: {
        morePhases: true,
        nextPhase: 'review',
        allPostCommandsOk: true,
        validatorsOk: true,
        diffCheckOk: true,
      },
    });

    expect(result.newState).toBe('in_progress');
    expect(result.newPhase).toBe('review');
    expect(getItem(itemId)?.current_phase).toBe('review');
  });

  it('session_ok with no more phases → complete', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'review' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'review',
      attempt: 1,
      event: 'session_ok',
      guardCtx: { morePhases: false },
    });

    expect(result.newState).toBe('complete');
    expect(getItem(itemId)?.status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// applyItemTransition — post_command_action dispatch
// ---------------------------------------------------------------------------

describe('applyItemTransition — post_command_action', () => {
  it('action=stop-and-ask inserts pending_attention', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress' });

    applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'post_command_action',
      guardCtx: { postCommandAction: { kind: 'stop-and-ask' } },
    });

    expect(getItem(itemId)?.status).toBe('awaiting_user');
    expect(countPendingAttention(wfId)).toBeGreaterThan(0);
  });

  it('action=stop transitions to abandoned', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress' });

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

    expect(result.newState).toBe('abandoned');
  });

  it('action=continue with morePhases → in_progress (phase advance)', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'implement' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'post_command_action',
      guardCtx: {
        postCommandAction: { kind: 'continue' },
        morePhases: true,
        nextPhase: 'review',
      },
    });

    expect(result.newState).toBe('in_progress');
    expect(result.newPhase).toBe('review');
  });

  it('action=continue last phase → complete', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'review' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'review',
      attempt: 1,
      event: 'post_command_action',
      guardCtx: { postCommandAction: { kind: 'continue' }, morePhases: false },
    });

    expect(result.newState).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// applyItemTransition — pending_attention for bootstrap_failed
// ---------------------------------------------------------------------------

describe('applyItemTransition — pending_attention', () => {
  it('bootstrap_fail inserts pending_attention{kind=bootstrap_failed}', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'bootstrapping' });

    applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'bootstrap',
      attempt: 0,
      event: 'bootstrap_fail',
    });

    expect(getItem(itemId)?.status).toBe('bootstrap_failed');
    const kinds = pendingAttentionKinds(wfId);
    expect(kinds).toContain('bootstrap_failed');
  });
});

// ---------------------------------------------------------------------------
// Cascade block — AC-2
// ---------------------------------------------------------------------------

describe('cascade block — AC-2', () => {
  it('transitioning to awaiting_user blocks all direct dependents', () => {
    const wfId = makeWfId();
    const parent = makeItemId();
    const child = makeItemId();
    insertWorkflow(wfId);
    insertItem(parent, wfId, 'stage1', { status: 'in_progress' });
    insertItem(child, wfId, 'stage1', { status: 'pending', dependsOn: [parent] });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: parent,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_fail',
      guardCtx: { classifierResult: 'permanent' },
    });

    expect(result.cascadeBlocked).toBe(true);
    expect(getItem(child)?.status).toBe('blocked');
  });

  it('cascade blocks transitive dependents (A → B → C)', () => {
    const wfId = makeWfId();
    const a = makeItemId();
    const b = makeItemId();
    const c = makeItemId();
    insertWorkflow(wfId);
    insertItem(a, wfId, 'stage1', { status: 'in_progress' });
    insertItem(b, wfId, 'stage1', { status: 'pending', dependsOn: [a] });
    insertItem(c, wfId, 'stage1', { status: 'pending', dependsOn: [b] });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: a,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'user_cancel',
    });

    // a goes to abandoned; b and c should be cascade-blocked
    expect(result.cascadeBlocked).toBe(true);
    expect(getItem(b)?.status).toBe('blocked');
    expect(getItem(c)?.status).toBe('blocked');
  });

  it('does not cascade-block already terminal items', () => {
    const wfId = makeWfId();
    const parent = makeItemId();
    const alreadyComplete = makeItemId();
    insertWorkflow(wfId);
    insertItem(parent, wfId, 'stage1', { status: 'in_progress' });
    insertItem(alreadyComplete, wfId, 'stage1', {
      status: 'complete',
      dependsOn: [parent],
    });

    applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: parent,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'user_cancel',
    });

    // complete item must remain complete
    expect(getItem(alreadyComplete)?.status).toBe('complete');
  });

  it('cascade writes events row for each blocked item (RC-5)', () => {
    const wfId = makeWfId();
    const parent = makeItemId();
    const child1 = makeItemId();
    const child2 = makeItemId();
    insertWorkflow(wfId);
    insertItem(parent, wfId, 'stage1', { status: 'in_progress' });
    insertItem(child1, wfId, 'stage1', { status: 'pending', dependsOn: [parent] });
    insertItem(child2, wfId, 'stage1', { status: 'pending', dependsOn: [parent] });

    applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: parent,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'user_cancel',
    });

    const cascadeEvents = pool.writer
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE workflow_id = ? AND event_type = 'cascade_block'",
      )
      .get(wfId) as { n: number };
    expect(cascadeEvents.n).toBe(2);
  });

  it('all cascade blocks are committed in the same transaction', () => {
    // Verify atomicity: after applyItemTransition returns, ALL blocked items
    // are visible to the reader connection (WAL snapshot after commit).
    const wfId = makeWfId();
    const parent = makeItemId();
    const child = makeItemId();
    insertWorkflow(wfId);
    insertItem(parent, wfId, 'stage1', { status: 'in_progress' });
    insertItem(child, wfId, 'stage1', { status: 'pending', dependsOn: [parent] });

    applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: parent,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'user_cancel',
    });

    // Reader sees the blocked state
    const childRow = pool.reader()
      .prepare('SELECT status FROM items WHERE id = ?')
      .get(child) as { status: string };
    expect(childRow.status).toBe('blocked');
  });

  it('transitioning from blocked → blocked does NOT re-cascade (idempotent)', () => {
    const wfId = makeWfId();
    const parent = makeItemId();
    const child = makeItemId();
    insertWorkflow(wfId);
    insertItem(parent, wfId, 'stage1', { status: 'blocked' });
    insertItem(child, wfId, 'stage1', { status: 'pending', dependsOn: [parent] });

    // blocked → user_cancel → abandoned: WAS in cascade state already
    // So wasNotCascade = false → no second cascade
    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: parent,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'user_cancel',
    });

    // parent goes to abandoned; cascadeBlocked should be false (was already in cascade state)
    expect(result.newState).toBe('abandoned');
    expect(result.cascadeBlocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkStageComplete — AC-1
// ---------------------------------------------------------------------------

describe('checkStageComplete — AC-1', () => {
  it('returns false when a stage has in_progress items', () => {
    const wfId = makeWfId();
    insertWorkflow(wfId);
    insertItem(makeItemId(), wfId, 'stage1', { status: 'complete' });
    insertItem(makeItemId(), wfId, 'stage1', { status: 'in_progress' }); // not terminal

    expect(checkStageComplete(pool, wfId, 'stage1')).toBe(false);
  });

  it('returns false when a stage has pending items', () => {
    const wfId = makeWfId();
    insertWorkflow(wfId);
    insertItem(makeItemId(), wfId, 'stage1', { status: 'complete' });
    insertItem(makeItemId(), wfId, 'stage1', { status: 'pending' });

    expect(checkStageComplete(pool, wfId, 'stage1')).toBe(false);
  });

  it('returns true when all items are complete', () => {
    const wfId = makeWfId();
    insertWorkflow(wfId);
    insertItem(makeItemId(), wfId, 'stage1', { status: 'complete' });
    insertItem(makeItemId(), wfId, 'stage1', { status: 'complete' });

    expect(checkStageComplete(pool, wfId, 'stage1')).toBe(true);
  });

  it('returns true with mixed terminal states (complete, blocked, abandoned)', () => {
    const wfId = makeWfId();
    insertWorkflow(wfId);
    insertItem(makeItemId(), wfId, 'stage1', { status: 'complete' });
    insertItem(makeItemId(), wfId, 'stage1', { status: 'blocked' });
    insertItem(makeItemId(), wfId, 'stage1', { status: 'abandoned' });

    expect(checkStageComplete(pool, wfId, 'stage1')).toBe(true);
  });

  it('returns false with empty stage (no items)', () => {
    const wfId = makeWfId();
    insertWorkflow(wfId);

    expect(checkStageComplete(pool, wfId, 'stage1')).toBe(false);
  });

  it('single non-terminal item prevents stage completion (AC-1)', () => {
    const wfId = makeWfId();
    insertWorkflow(wfId);
    for (let i = 0; i < 9; i++) {
      insertItem(makeItemId(), wfId, 'stage1', { status: 'complete' });
    }
    insertItem(makeItemId(), wfId, 'stage1', { status: 'awaiting_retry' }); // 1 non-terminal

    expect(checkStageComplete(pool, wfId, 'stage1')).toBe(false);
  });

  it('stageComplete flag is set in applyItemTransition when last item completes', () => {
    const wfId = makeWfId();
    const item1 = makeItemId();
    const item2 = makeItemId();
    insertWorkflow(wfId);
    insertItem(item1, wfId, 'stage1', { status: 'complete' });   // already done
    insertItem(item2, wfId, 'stage1', { status: 'in_progress' }); // last one

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: item2,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_ok',
      guardCtx: { morePhases: false },
    });

    expect(result.newState).toBe('complete');
    expect(result.stageComplete).toBe(true);
  });

  it('stageComplete is false when other items in stage remain', () => {
    const wfId = makeWfId();
    const item1 = makeItemId();
    const item2 = makeItemId();
    insertWorkflow(wfId);
    insertItem(item1, wfId, 'stage1', { status: 'in_progress' }); // still running
    insertItem(item2, wfId, 'stage1', { status: 'in_progress' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: item2,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_ok',
      guardCtx: { morePhases: false },
    });

    expect(result.newState).toBe('complete');
    expect(result.stageComplete).toBe(false); // item1 still in_progress
  });
});

// ---------------------------------------------------------------------------
// max_revisits tracking — RC-3
// ---------------------------------------------------------------------------

describe('max_revisits — RC-3', () => {
  it('goto within max_revisits → in_progress with destination phase', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'review' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'review',
      attempt: 1,
      event: 'post_command_action',
      guardCtx: {
        postCommandAction: { kind: 'goto', goto: 'implement', maxRevisits: 3 },
      },
    });

    expect(result.newState).toBe('in_progress');
    expect(result.newPhase).toBe('implement');
  });

  it('goto exceeding max_revisits → awaiting_user (RC-3)', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'review' });

    // Insert 3 existing revisit events to simulate max reached
    for (let i = 0; i < 3; i++) {
      pool.writer.prepare(`
        INSERT INTO events (ts, workflow_id, item_id, session_id, stage, phase, attempt,
                            event_type, level, message, extra)
        VALUES ('2026-01-01T00:00:00Z', ?, ?, null, 'stage1', 'review', ?,
                'prepost.revisit', 'info', 'goto to phase "implement"',
                '{"destination":"implement"}')
      `).run(wfId, itemId, i);
    }

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'review',
      attempt: 4,
      event: 'post_command_action',
      guardCtx: {
        postCommandAction: { kind: 'goto', goto: 'implement', maxRevisits: 3 },
      },
    });

    expect(result.newState).toBe('awaiting_user');
  });

  it('max_revisits counter is per (item_id, destination) pair (RC-3)', () => {
    const wfId = makeWfId();
    const item1 = makeItemId();
    const item2 = makeItemId();
    insertWorkflow(wfId);
    insertItem(item1, wfId, 'stage1', { status: 'in_progress', phase: 'review' });
    insertItem(item2, wfId, 'stage1', { status: 'in_progress', phase: 'review' });

    // item1 has 3 revisits to 'implement' (at max)
    for (let i = 0; i < 3; i++) {
      pool.writer.prepare(`
        INSERT INTO events (ts, workflow_id, item_id, session_id, stage, phase, attempt,
                            event_type, level, message, extra)
        VALUES ('2026-01-01T00:00:00Z', ?, ?, null, 'stage1', 'review', ?,
                'prepost.revisit', 'info', 'goto', '{"destination":"implement"}')
      `).run(wfId, item1, i);
    }

    // item2 has 0 revisits — should still work
    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: item2,
      sessionId: null,
      stage: 'stage1',
      phase: 'review',
      attempt: 1,
      event: 'post_command_action',
      guardCtx: {
        postCommandAction: { kind: 'goto', goto: 'implement', maxRevisits: 3 },
      },
    });

    expect(result.newState).toBe('in_progress'); // item2 is NOT blocked
    expect(result.newPhase).toBe('implement');
  });

  it('revisit event is inserted into events table for every goto', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'review' });

    applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'review',
      attempt: 1,
      event: 'post_command_action',
      guardCtx: {
        postCommandAction: { kind: 'goto', goto: 'implement', maxRevisits: 3 },
      },
    });

    expect(countEvents(wfId, 'prepost.revisit')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildCrashRecovery — AC-4
// ---------------------------------------------------------------------------

describe('buildCrashRecovery — AC-4', () => {
  it('sets recovery_state on workflow with stale session PID', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress' });
    // Use PID 99999999 which almost certainly does not exist
    insertSession('sess-stale', wfId, { itemId, status: 'running', pid: 99999999 });

    const result = buildCrashRecovery(pool);

    expect(result).toHaveLength(1);
    expect(result[0].workflowId).toBe(wfId);
    expect(result[0].staleSessions).toHaveLength(1);
    expect(result[0].staleSessions[0].pid).toBe(99999999);

    // recovery_state should be written on the workflow row
    const wfRow = pool.writer
      .prepare('SELECT recovery_state FROM workflows WHERE id = ?')
      .get(wfId) as { recovery_state: string };
    expect(wfRow.recovery_state).toBeTruthy();
    const parsed = JSON.parse(wfRow.recovery_state);
    expect(parsed.staleSessions).toHaveLength(1);
  });

  it('does NOT set recovery_state for alive PIDs (AC-4)', () => {
    const wfId = makeWfId();
    insertWorkflow(wfId);
    // Use current process PID — guaranteed alive
    const alivePid = process.pid;
    insertSession('sess-alive', wfId, { status: 'running', pid: alivePid });

    const result = buildCrashRecovery(pool);

    expect(result).toHaveLength(0);

    const wfRow = pool.writer
      .prepare('SELECT recovery_state FROM workflows WHERE id = ?')
      .get(wfId) as { recovery_state: string | null };
    expect(wfRow.recovery_state).toBeNull();
  });

  it('does NOT transition items during crash recovery (RC-2)', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress' });
    insertSession('sess-dead', wfId, { itemId, status: 'running', pid: 99999998 });

    buildCrashRecovery(pool);

    // Item status must be unchanged — no auto-transition (RC-2)
    expect(getItem(itemId)?.status).toBe('in_progress');
  });

  it('returns empty array when all workflows are terminal', () => {
    const wfId = makeWfId();
    pool.writer
      .prepare(`
        INSERT INTO workflows
          (id, name, spec, pipeline, config, status, created_at, updated_at)
        VALUES (?, 'done', '{}', '[]', '{}', 'completed',
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `)
      .run(wfId);

    const result = buildCrashRecovery(pool);
    expect(result).toHaveLength(0);
  });

  it('handles workflow with no sessions gracefully', () => {
    const wfId = makeWfId();
    insertWorkflow(wfId); // non-terminal, no sessions

    const result = buildCrashRecovery(pool);
    expect(result).toHaveLength(0);
  });

  it('recovery_state has detectedAt timestamp', () => {
    const wfId = makeWfId();
    insertWorkflow(wfId);
    insertSession('sess-gone', wfId, { status: 'running', pid: 99999997 });

    buildCrashRecovery(pool);

    const wfRow = pool.writer
      .prepare('SELECT recovery_state FROM workflows WHERE id = ?')
      .get(wfId) as { recovery_state: string };
    const parsed = JSON.parse(wfRow.recovery_state);
    expect(parsed.detectedAt).toBeTruthy();
    expect(typeof parsed.detectedAt).toBe('string');
  });

  it('commits recovery_state for all affected workflows in one transaction', () => {
    // Two workflows, each with a stale session.  Both should be written;
    // neither should be skipped if a future crash interrupts the loop.
    const wfId1 = makeWfId();
    const wfId2 = makeWfId();
    insertWorkflow(wfId1);
    insertWorkflow(wfId2);
    insertSession(`sess-stale-${wfId1}`, wfId1, { status: 'running', pid: 99999990 });
    insertSession(`sess-stale-${wfId2}`, wfId2, { status: 'running', pid: 99999991 });

    const result = buildCrashRecovery(pool);
    expect(result).toHaveLength(2);

    const wf1Row = pool.writer.prepare('SELECT recovery_state FROM workflows WHERE id = ?').get(wfId1) as { recovery_state: string };
    const wf2Row = pool.writer.prepare('SELECT recovery_state FROM workflows WHERE id = ?').get(wfId2) as { recovery_state: string };
    expect(wf1Row.recovery_state).toBeTruthy();
    expect(wf2Row.recovery_state).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// stageComplete — widened guard (AC-1 fix)
// ---------------------------------------------------------------------------

describe('stageComplete — widened guard covers all terminal states (AC-1)', () => {
  it('stageComplete=true when last item transitions to blocked (awaiting_user → blocked)', () => {
    // awaiting_user → user_block → blocked; if this is the last item, stage is complete.
    const wfId = makeWfId();
    const item1 = makeItemId();
    const item2 = makeItemId();
    insertWorkflow(wfId);
    insertItem(item1, wfId, 'stage1', { status: 'complete' });       // already terminal
    insertItem(item2, wfId, 'stage1', { status: 'awaiting_user' });  // last non-terminal

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: item2,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'user_block',
    });

    expect(result.newState).toBe('blocked');
    expect(result.stageComplete).toBe(true);
  });

  it('stageComplete=true when last item transitions to abandoned (awaiting_user → abandoned)', () => {
    const wfId = makeWfId();
    const item1 = makeItemId();
    const item2 = makeItemId();
    insertWorkflow(wfId);
    insertItem(item1, wfId, 'stage1', { status: 'blocked' });
    insertItem(item2, wfId, 'stage1', { status: 'awaiting_user' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: item2,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'user_cancel',
    });

    expect(result.newState).toBe('abandoned');
    expect(result.stageComplete).toBe(true);
  });

  it('stageComplete=false when transitioning to blocked but other items remain non-terminal', () => {
    const wfId = makeWfId();
    const item1 = makeItemId();
    const item2 = makeItemId();
    insertWorkflow(wfId);
    insertItem(item1, wfId, 'stage1', { status: 'in_progress' }); // still running
    insertItem(item2, wfId, 'stage1', { status: 'awaiting_user' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: item2,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 0,
      event: 'user_block',
    });

    expect(result.newState).toBe('blocked');
    expect(result.stageComplete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RC-4: needs_approval — stage_needs_approval pending_attention
// ---------------------------------------------------------------------------

describe('needs_approval — RC-4', () => {
  it('inserts pending_attention{kind=stage_needs_approval} when needsApproval=true and stage completes', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_ok',
      guardCtx: { morePhases: false },
      needsApproval: true,
    });

    expect(result.newState).toBe('complete');
    expect(result.stageComplete).toBe(true);

    const kinds = pendingAttentionKinds(wfId);
    expect(kinds).toContain('stage_needs_approval');
  });

  it('sets workflows.status = pending_stage_approval when needsApproval=true and stage completes', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress' });

    applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_ok',
      guardCtx: { morePhases: false },
      needsApproval: true,
    });

    const wfRow = pool.writer
      .prepare('SELECT status FROM workflows WHERE id = ?')
      .get(wfId) as { status: string };
    expect(wfRow.status).toBe('pending_stage_approval');
  });

  it('does NOT insert stage_needs_approval when needsApproval=false (default)', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_ok',
      guardCtx: { morePhases: false },
      // needsApproval omitted → defaults to false
    });

    expect(result.stageComplete).toBe(true);
    const kinds = pendingAttentionKinds(wfId);
    expect(kinds).not.toContain('stage_needs_approval');
  });

  it('does NOT insert stage_needs_approval when needsApproval=true but stage is NOT yet complete', () => {
    const wfId = makeWfId();
    const item1 = makeItemId();
    const item2 = makeItemId();
    insertWorkflow(wfId);
    insertItem(item1, wfId, 'stage1', { status: 'in_progress' }); // still running
    insertItem(item2, wfId, 'stage1', { status: 'in_progress' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: item2,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_ok',
      guardCtx: { morePhases: false },
      needsApproval: true,
    });

    expect(result.stageComplete).toBe(false); // item1 still running
    const kinds = pendingAttentionKinds(wfId);
    expect(kinds).not.toContain('stage_needs_approval');
  });

  it('stage_needs_approval and transition are committed atomically (AC-6)', () => {
    // Verify both the item status change AND pending_attention are visible
    // to the reader in the same read after applyItemTransition returns.
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress' });

    applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_ok',
      guardCtx: { morePhases: false },
      needsApproval: true,
    });

    // Both visible via the read-only connection
    const itemStatus = pool.reader()
      .prepare('SELECT status FROM items WHERE id = ?')
      .get(itemId) as { status: string };
    const attentionCount = pool.reader()
      .prepare("SELECT COUNT(*) AS n FROM pending_attention WHERE workflow_id = ? AND kind = 'stage_needs_approval'")
      .get(wfId) as { n: number };

    expect(itemStatus.status).toBe('complete');
    expect(attentionCount.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// session_fail: policy classifier — non-blocking review feedback
// ---------------------------------------------------------------------------

describe('session_fail — policy classifier', () => {
  it('policy classifier → awaiting_user with no retry (same as unknown)', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', retryCount: 0 });

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

    // policy is treated as unknown: awaiting_user, no retry
    expect(result.newState).toBe('awaiting_user');
    expect(result.retryMode).toBeUndefined();
    expect(getItem(itemId)?.status).toBe('awaiting_user');
  });
});
