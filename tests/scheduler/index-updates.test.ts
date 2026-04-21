/**
 * Unit tests for Scheduler.scheduleIndexUpdate — workflow.index.update emission.
 *
 * AC-1: scheduleIndexUpdate emits workflow.index.update after 500 ms.
 * AC-2: Coalescing — N calls within 500 ms produce exactly one frame.
 * AC-3: Two calls 600 ms apart produce two frames (separate debounce windows).
 * AC-4: unreadEvents is computed fresh from pending_attention at emission time.
 * AC-5: Cross-workflow isolation — scheduleIndexUpdate(wfA) does not cancel wfB's timer.
 * AC-6: stop() clears pending timers — no broadcast after scheduler shutdown.
 * AC-7: _applyTransition schedules an index update when pendingAttentionRowId != null.
 * AC-8: _handleStageComplete (last stage) schedules an index update.
 * AC-9: makeControlExecutor cancel path calls the injected scheduleIndexUpdate callback.
 *
 * Uses real SQLite with migrations; fake setTimeout/clearTimeout to control debounce.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import type { DbPool } from '../../src/server/storage/db.js';
import { Scheduler } from '../../src/server/scheduler/scheduler.js';
import type { BroadcastFn } from '../../src/server/scheduler/scheduler.js';
import type { ProcessManager } from '../../src/server/process/manager.js';
import type { WorktreeManager } from '../../src/server/worktree/manager.js';
import type { ResolvedConfig } from '../../src/shared/types/config.js';
import type { ApplyItemTransitionParams } from '../../src/server/pipeline/engine.js';
import { makeControlExecutor } from '../../src/server/pipeline/control-executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let tmpDir: string;
let pool: DbPool;

beforeEach(() => {
  // Only fake timer functions — leave Date real so SQLite timestamps work.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-idx-upd-'));
  pool = openDbPool(path.join(tmpDir, 'test.db'));
  applyMigrations(pool.writer, MIGRATIONS_DIR);
});

afterEach(() => {
  pool.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Unique ID counters
// ---------------------------------------------------------------------------

let wfSeq = 0;
let itemSeq = 0;
function mkWf() { return `wf-idx-${++wfSeq}`; }
function mkItem() { return `item-idx-${++itemSeq}`; }

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function insertWorkflow(id: string, status = 'in_progress') {
  pool.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at, worktree_path)
       VALUES (?, 'test-idx', '{}', '[]', '{}', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`,
    )
    .run(id, status, tmpDir);
}

function insertItem(
  id: string,
  wfId: string,
  opts: { status?: string; phase?: string; retryCount?: number } = {},
) {
  pool.writer
    .prepare(
      `INSERT INTO items
         (id, workflow_id, stage_id, data, status, current_phase,
          depends_on, retry_count, blocked_reason, updated_at)
       VALUES (?, ?, 'stage1', '{}', ?, ?, null, ?, null, '2026-01-01T00:00:00Z')`,
    )
    .run(id, wfId, opts.status ?? 'in_progress', opts.phase ?? 'implement', opts.retryCount ?? 0);
}

function insertPendingAttention(wfId: string, acknowledged = false) {
  const ackAt = acknowledged ? new Date().toISOString() : null;
  pool.writer
    .prepare(
      `INSERT INTO pending_attention (workflow_id, kind, payload, created_at, acknowledged_at)
       VALUES (?, 'awaiting_user_retry', '{}', '2026-01-01T00:00:00Z', ?)`,
    )
    .run(wfId, ackAt);
}

// ---------------------------------------------------------------------------
// Fake scheduler dependencies
// ---------------------------------------------------------------------------

const fakeProcessManager = {
  spawn: () => { throw new Error('spawn must not be called'); },
} as unknown as ProcessManager;

const fakeWorktreeManager = {
  createWorktree: () => { throw new Error('createWorktree must not be called'); },
  runBootstrap: () => { throw new Error('runBootstrap must not be called'); },
  runTeardown: () => { throw new Error('runTeardown must not be called'); },
  cleanup: () => {},
} as unknown as WorktreeManager;

function makeConfig(configDir: string): ResolvedConfig {
  return {
    version: '1',
    configDir,
    template: { name: 'test' },
    pipeline: { stages: [{ id: 'stage1', run: 'once', phases: ['implement'] }] },
    phases: {
      implement: {
        command: 'echo',
        args: [],
        prompt_template: path.join(configDir, 'prompt.md'),
      },
    },
  } as unknown as ResolvedConfig;
}

interface CapturedFrame {
  workflowId: string | undefined;
  frameType: string;
  payload: unknown;
}

function makeScheduler() {
  const frames: CapturedFrame[] = [];
  const broadcastFn: BroadcastFn = (wfId, _sessId, frameType, payload) => {
    frames.push({ workflowId: wfId, frameType, payload });
  };
  const scheduler = new Scheduler({
    db: pool,
    config: makeConfig(tmpDir),
    processManager: fakeProcessManager,
    worktreeManager: fakeWorktreeManager,
    prepostRunner: async () => ({ kind: 'complete', runs: [] }),
    assemblePrompt: async () => 'prompt',
    broadcast: broadcastFn,
    artifactValidator: async () => ({ kind: 'validators_ok' as const }),
  });
  return { scheduler, frames };
}

function indexFrames(frames: CapturedFrame[]) {
  return frames.filter((f) => f.frameType === 'workflow.index.update');
}

function applyTransition(
  scheduler: Scheduler,
  params: ApplyItemTransitionParams,
) {
  return (scheduler as unknown as { _applyTransition(p: ApplyItemTransitionParams): unknown })
    ._applyTransition(params);
}

function handleStageComplete(scheduler: Scheduler, wfId: string, stageId: string) {
  (scheduler as unknown as { _handleStageComplete(w: string, s: string): void })
    ._handleStageComplete(wfId, stageId);
}

// ---------------------------------------------------------------------------
// AC-1: broadcasts workflow.index.update after 500 ms
// ---------------------------------------------------------------------------

describe('scheduleIndexUpdate — basic debounce', () => {
  it('AC-1: emits workflow.index.update with correct fields after 500 ms', () => {
    const wfId = mkWf();
    insertWorkflow(wfId, 'completed');

    const { scheduler, frames } = makeScheduler();

    scheduler.scheduleIndexUpdate(wfId);
    expect(indexFrames(frames)).toHaveLength(0); // not yet

    vi.advanceTimersByTime(500);

    const idxFrames = indexFrames(frames);
    expect(idxFrames).toHaveLength(1);

    const payload = idxFrames[0]!.payload as Record<string, unknown>;
    expect(payload.id).toBe(wfId);
    expect(payload.status).toBe('completed');
    expect(typeof payload.name).toBe('string');
    expect(typeof payload.updatedAt).toBe('string');
    expect(typeof payload.unreadEvents).toBe('number');
  });

  it('does not emit before 500 ms', () => {
    const wfId = mkWf();
    insertWorkflow(wfId);

    const { scheduler, frames } = makeScheduler();
    scheduler.scheduleIndexUpdate(wfId);

    vi.advanceTimersByTime(499);
    expect(indexFrames(frames)).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(indexFrames(frames)).toHaveLength(1);
  });

  it('does nothing if workflow does not exist in DB', () => {
    const { scheduler, frames } = makeScheduler();
    scheduler.scheduleIndexUpdate('wf-nonexistent');
    vi.advanceTimersByTime(500);
    expect(indexFrames(frames)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-4: unreadEvents from pending_attention at emission time
// ---------------------------------------------------------------------------

describe('scheduleIndexUpdate — unreadEvents', () => {
  it('AC-4: unreadEvents=0 when no pending_attention rows exist', () => {
    const wfId = mkWf();
    insertWorkflow(wfId);

    const { scheduler, frames } = makeScheduler();
    scheduler.scheduleIndexUpdate(wfId);
    vi.advanceTimersByTime(500);

    const payload = indexFrames(frames)[0]!.payload as Record<string, unknown>;
    expect(payload.unreadEvents).toBe(0);
  });

  it('AC-4: unreadEvents counts only unacknowledged rows', () => {
    const wfId = mkWf();
    insertWorkflow(wfId);
    insertPendingAttention(wfId);           // unacked — count
    insertPendingAttention(wfId);           // unacked — count
    insertPendingAttention(wfId, true);     // acked — skip

    const { scheduler, frames } = makeScheduler();
    scheduler.scheduleIndexUpdate(wfId);
    vi.advanceTimersByTime(500);

    const payload = indexFrames(frames)[0]!.payload as Record<string, unknown>;
    expect(payload.unreadEvents).toBe(2);
  });

  it('AC-4: unreadEvents is computed fresh at emission time, not at schedule time', () => {
    const wfId = mkWf();
    insertWorkflow(wfId);

    const { scheduler, frames } = makeScheduler();
    scheduler.scheduleIndexUpdate(wfId);

    // Insert a pending_attention row AFTER scheduling but BEFORE timer fires.
    insertPendingAttention(wfId);

    vi.advanceTimersByTime(500);

    const payload = indexFrames(frames)[0]!.payload as Record<string, unknown>;
    expect(payload.unreadEvents).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-2 / AC-3: Coalescing
// ---------------------------------------------------------------------------

describe('scheduleIndexUpdate — coalescing', () => {
  it('AC-2: two calls within 500 ms produce exactly one frame', () => {
    const wfId = mkWf();
    insertWorkflow(wfId);

    const { scheduler, frames } = makeScheduler();

    scheduler.scheduleIndexUpdate(wfId);
    vi.advanceTimersByTime(200);
    scheduler.scheduleIndexUpdate(wfId); // reset the timer

    vi.advanceTimersByTime(499); // 200 + 499 = 699 ms from first call, but only 499 from second
    expect(indexFrames(frames)).toHaveLength(0);

    vi.advanceTimersByTime(1); // 500 ms from second call
    expect(indexFrames(frames)).toHaveLength(1);
  });

  it('AC-3: two calls 600 ms apart produce two separate frames', () => {
    const wfId = mkWf();
    insertWorkflow(wfId);

    const { scheduler, frames } = makeScheduler();

    scheduler.scheduleIndexUpdate(wfId);
    vi.advanceTimersByTime(500); // first timer fires
    expect(indexFrames(frames)).toHaveLength(1);

    scheduler.scheduleIndexUpdate(wfId);
    vi.advanceTimersByTime(500); // second timer fires
    expect(indexFrames(frames)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC-5: Cross-workflow isolation
// ---------------------------------------------------------------------------

describe('scheduleIndexUpdate — cross-workflow isolation', () => {
  it('AC-5: scheduling wfA does not cancel or delay wfB timer', () => {
    const wfA = mkWf();
    const wfB = mkWf();
    insertWorkflow(wfA);
    insertWorkflow(wfB);

    const { scheduler, frames } = makeScheduler();

    scheduler.scheduleIndexUpdate(wfA);
    scheduler.scheduleIndexUpdate(wfB);

    vi.advanceTimersByTime(500);

    const idxFrames = indexFrames(frames);
    expect(idxFrames).toHaveLength(2);
    const wfIds = idxFrames.map((f) => f.workflowId);
    expect(wfIds).toContain(wfA);
    expect(wfIds).toContain(wfB);
  });

  it('AC-5: coalescing wfA does not affect wfB', () => {
    const wfA = mkWf();
    const wfB = mkWf();
    insertWorkflow(wfA);
    insertWorkflow(wfB);

    const { scheduler, frames } = makeScheduler();

    scheduler.scheduleIndexUpdate(wfA);
    scheduler.scheduleIndexUpdate(wfB);
    vi.advanceTimersByTime(200);
    scheduler.scheduleIndexUpdate(wfA); // reset only wfA

    vi.advanceTimersByTime(300); // 500 ms from wfB schedule
    // wfB timer has fired; wfA not yet (only 300 ms from its second schedule)
    const afterFirst = indexFrames(frames);
    expect(afterFirst.map((f) => f.workflowId)).toContain(wfB);
    expect(afterFirst.filter((f) => f.workflowId === wfA)).toHaveLength(0);

    vi.advanceTimersByTime(200); // wfA timer fires (500 ms from second schedule)
    expect(indexFrames(frames).filter((f) => f.workflowId === wfA)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC-6: stop() clears pending timers
// ---------------------------------------------------------------------------

describe('scheduleIndexUpdate — stop() cleanup', () => {
  it('AC-6: stop() prevents a pending index update from broadcasting', async () => {
    const wfId = mkWf();
    insertWorkflow(wfId);

    const { scheduler, frames } = makeScheduler();

    scheduler.scheduleIndexUpdate(wfId);
    await scheduler.stop(); // cancels pending timers

    vi.advanceTimersByTime(1000); // timers would have fired here
    expect(indexFrames(frames)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-7: _applyTransition schedules index update on pending_attention insert
// ---------------------------------------------------------------------------

describe('_applyTransition — schedules index update on pending_attention', () => {
  it('AC-7: bootstrap_fail (inserts pending_attention) schedules an index update', () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, { status: 'bootstrapping' });

    const { scheduler, frames } = makeScheduler();

    applyTransition(scheduler, {
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'bootstrap_fail',
    });

    // Timer not yet fired
    expect(indexFrames(frames)).toHaveLength(0);

    vi.advanceTimersByTime(500);
    expect(indexFrames(frames)).toHaveLength(1);

    const payload = indexFrames(frames)[0]!.payload as Record<string, unknown>;
    expect(payload.id).toBe(wfId);
    expect(typeof payload.unreadEvents).toBe('number');
    expect((payload.unreadEvents as number)).toBeGreaterThan(0);
  });

  it('AC-7: session_fail+transient (no pending_attention) does NOT schedule an index update', () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, { status: 'in_progress', retryCount: 0 });

    const { scheduler, frames } = makeScheduler();

    applyTransition(scheduler, {
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

    vi.advanceTimersByTime(500);
    expect(indexFrames(frames)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-8: _handleStageComplete (last stage) schedules an index update
// ---------------------------------------------------------------------------

describe('_handleStageComplete — last stage schedules index update', () => {
  it('AC-8: completing the last stage emits workflow.index.update with completed status', () => {
    const wfId = mkWf();
    insertWorkflow(wfId, 'in_progress');

    const { scheduler, frames } = makeScheduler();

    handleStageComplete(scheduler, wfId, 'stage1');

    expect(indexFrames(frames)).toHaveLength(0); // not yet

    vi.advanceTimersByTime(500);

    const idxFrames = indexFrames(frames);
    expect(idxFrames).toHaveLength(1);

    const payload = idxFrames[0]!.payload as Record<string, unknown>;
    expect(payload.id).toBe(wfId);
    expect(payload.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// AC-9: makeControlExecutor cancel path calls scheduleIndexUpdate
// ---------------------------------------------------------------------------

describe('makeControlExecutor — cancel calls scheduleIndexUpdate', () => {
  it('AC-9: cancelling a workflow calls the injected scheduleIndexUpdate callback', () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId, 'in_progress');
    insertItem(itemId, wfId, { status: 'in_progress' });

    const captured: string[] = [];
    const executor = makeControlExecutor(
      pool.writer,
      () => {},
      () => {},
      (w) => captured.push(w),
    );

    const result = executor(wfId, 'cancel');

    expect(result.status).toBe('accepted');
    expect(captured).toEqual([wfId]);
  });

  it('AC-9: scheduleIndexUpdate is NOT called for invalid_action', () => {
    const wfId = mkWf();
    insertWorkflow(wfId, 'in_progress');

    const captured: string[] = [];
    const executor = makeControlExecutor(
      pool.writer,
      () => {},
      () => {},
      (w) => captured.push(w),
    );

    const result = executor(wfId, 'rewind');

    expect(result.status).toBe('invalid_action');
    expect(captured).toHaveLength(0);
  });

  it('AC-9: scheduleIndexUpdate is NOT called when workflow is already terminal', () => {
    const wfId = mkWf();
    insertWorkflow(wfId, 'abandoned');

    const captured: string[] = [];
    const executor = makeControlExecutor(
      pool.writer,
      () => {},
      () => {},
      (w) => captured.push(w),
    );

    const result = executor(wfId, 'cancel');

    expect(result.status).toBe('already_terminal');
    expect(captured).toHaveLength(0);
  });
});
