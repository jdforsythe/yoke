/**
 * Unit tests for the centralized attention emitter in Scheduler._applyTransition.
 *
 * AC-1: Every state-machine transition whose side-effects contain
 * 'insert pending_attention' results in a notice frame with the correct
 * persistedAttentionId when driven through Scheduler._applyTransition.
 *
 * Coverage:
 *   - bootstrapping → bootstrap_fail  (kind=bootstrap_failed)
 *   - in_progress  → pre_command_failed+stop-and-ask  (kind=awaiting_user_retry)
 *   - in_progress  → post_command_action+revisit_limit (kind=revisit_limit)
 *   - in_progress  → session_fail+permanent  (kind=awaiting_user_retry)
 *   - awaiting_retry → retries_exhausted  (kind=awaiting_user_retry)
 *   - No double-broadcast: single pending_attention → single notice frame
 *   - Transitions WITHOUT pending_attention do NOT emit a notice frame
 *   - notifyFn fires independently; omitting it does NOT suppress WS broadcast
 *
 * Uses real SQLite with migrations; fake BroadcastFn captures emitted frames.
 * ProcessManager.spawn is never called (pre command fails before spawn or
 * _applyTransition is called directly).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import type { DbPool } from '../../src/server/storage/db.js';
import { Scheduler } from '../../src/server/scheduler/scheduler.js';
import type {
  BroadcastFn,
  NotifyFn,
} from '../../src/server/scheduler/scheduler.js';
import type { ProcessManager } from '../../src/server/process/manager.js';
import type { WorktreeManager } from '../../src/server/worktree/manager.js';
import type { ResolvedConfig } from '../../src/shared/types/config.js';
import type { ApplyItemTransitionParams } from '../../src/server/pipeline/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let tmpDir: string;
let pool: DbPool;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-attn-bcast-'));
  pool = openDbPool(path.join(tmpDir, 'test.db'));
  applyMigrations(pool.writer, MIGRATIONS_DIR);
});

afterEach(() => {
  pool.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Counters for unique IDs per test
// ---------------------------------------------------------------------------

let wfSeq = 0;
let itemSeq = 0;
function mkWf() { return `wf-ab-${++wfSeq}`; }
function mkItem() { return `item-ab-${++itemSeq}`; }

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function insertWorkflow(id: string, status = 'in_progress') {
  pool.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at, worktree_path)
       VALUES (?, 'test-attn', '{}', '[]', '{}', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`,
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

function countNotices(frames: { frameType: string; payload: unknown }[]) {
  return frames.filter((f) => f.frameType === 'notice');
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
    project: { name: 'test' },
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

/**
 * Access the private _applyTransition via a typed cast.
 * Scheduler._applyTransition is private but unit-testable in isolation (RC).
 */
function applyTransition(
  scheduler: Scheduler,
  params: ApplyItemTransitionParams,
) {
  return (scheduler as unknown as { _applyTransition(p: ApplyItemTransitionParams): unknown })
    ._applyTransition(params);
}

/**
 * Create a Scheduler wired to a capturing broadcast array.
 * Returns both the scheduler and the array for assertions.
 */
function makeScheduler(opts: { notifyFn?: NotifyFn } = {}) {
  const frames: { frameType: string; payload: unknown }[] = [];
  const broadcastFn: BroadcastFn = (_wfId, _sessId, frameType, payload) => {
    frames.push({ frameType, payload });
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
    notify: opts.notifyFn,
  });
  return { scheduler, frames };
}

// ---------------------------------------------------------------------------
// Helpers that read back the pending_attention row
// ---------------------------------------------------------------------------

function getAttentionRow(id: number): { kind: string; payload: string } | undefined {
  return pool.reader()
    .prepare('SELECT kind, payload FROM pending_attention WHERE id = ?')
    .get(id) as { kind: string; payload: string } | undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scheduler._applyTransition — attention broadcasts', () => {
  // -------------------------------------------------------------------------
  // bootstrapping → bootstrap_fail → bootstrap_failed
  // -------------------------------------------------------------------------
  it('bootstrap_fail emits notice with kind=bootstrap_failed and correct persistedAttentionId', () => {
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

    const notices = countNotices(frames);
    expect(notices).toHaveLength(1);

    const notice = notices[0]!.payload as Record<string, unknown>;
    expect(notice.severity).toBe('requires_attention');
    expect(notice.kind).toBe('bootstrap_failed');
    expect(typeof notice.persistedAttentionId).toBe('number');
    expect(typeof notice.message).toBe('string');

    // persistedAttentionId must match the actual DB row
    const row = getAttentionRow(notice.persistedAttentionId as number);
    expect(row).toBeDefined();
    expect(row!.kind).toBe('bootstrap_failed');
  });

  // -------------------------------------------------------------------------
  // in_progress → pre_command_failed + stop-and-ask → awaiting_user
  // -------------------------------------------------------------------------
  it('pre_command_failed+stop-and-ask emits notice with persistedAttentionId', () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, { status: 'in_progress' });

    const { scheduler, frames } = makeScheduler();

    applyTransition(scheduler, {
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'pre_command_failed',
      guardCtx: { preCommandAction: 'stop-and-ask' },
    });

    const notices = countNotices(frames);
    expect(notices).toHaveLength(1);

    const notice = notices[0]!.payload as Record<string, unknown>;
    expect(notice.severity).toBe('requires_attention');
    expect(typeof notice.persistedAttentionId).toBe('number');

    const row = getAttentionRow(notice.persistedAttentionId as number);
    expect(row).toBeDefined();
    expect(row!.kind).toBe('awaiting_user_retry');
  });

  // -------------------------------------------------------------------------
  // in_progress → post_command_action + revisit_limit exceeded → awaiting_user
  // -------------------------------------------------------------------------
  it('post_command_action+revisit_limit emits notice with kind=revisit_limit', () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, { status: 'in_progress' });

    const { scheduler, frames } = makeScheduler();

    // maxRevisits=0 means 0 revisits allowed; 0 existing revisits → 0 >= 0 → exceeded
    applyTransition(scheduler, {
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'post_command_action',
      guardCtx: { postCommandAction: { kind: 'goto', goto: 'implement', maxRevisits: 0 } },
    });

    const notices = countNotices(frames);
    expect(notices).toHaveLength(1);

    const notice = notices[0]!.payload as Record<string, unknown>;
    expect(notice.severity).toBe('requires_attention');
    expect(notice.kind).toBe('revisit_limit');
    expect(typeof notice.persistedAttentionId).toBe('number');

    const row = getAttentionRow(notice.persistedAttentionId as number);
    expect(row).toBeDefined();
    expect(row!.kind).toBe('revisit_limit');
  });

  // -------------------------------------------------------------------------
  // in_progress → post_command_action + stop-and-ask → awaiting_user
  // -------------------------------------------------------------------------
  it('post_command_action+stop-and-ask emits notice with persistedAttentionId', () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, { status: 'in_progress' });

    const { scheduler, frames } = makeScheduler();

    applyTransition(scheduler, {
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

    const notices = countNotices(frames);
    expect(notices).toHaveLength(1);

    const notice = notices[0]!.payload as Record<string, unknown>;
    expect(notice.severity).toBe('requires_attention');
    expect(typeof notice.persistedAttentionId).toBe('number');
    expect(typeof notice.message).toBe('string');
  });

  // -------------------------------------------------------------------------
  // in_progress → session_fail + permanent → awaiting_user (permanent classifier)
  // -------------------------------------------------------------------------
  it('session_fail+permanent emits notice with persistedAttentionId', () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, { status: 'in_progress' });

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
      guardCtx: { classifierResult: 'permanent' },
    });

    const notices = countNotices(frames);
    expect(notices).toHaveLength(1);

    const notice = notices[0]!.payload as Record<string, unknown>;
    expect(notice.severity).toBe('requires_attention');
    expect(typeof notice.persistedAttentionId).toBe('number');

    const row = getAttentionRow(notice.persistedAttentionId as number);
    expect(row).toBeDefined();
    expect(row!.kind).toBe('awaiting_user_retry');
  });

  // -------------------------------------------------------------------------
  // awaiting_retry → retries_exhausted → awaiting_user
  // -------------------------------------------------------------------------
  it('retries_exhausted emits notice with persistedAttentionId', () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, { status: 'awaiting_retry', retryCount: 3 });

    const { scheduler, frames } = makeScheduler();

    applyTransition(scheduler, {
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 3,
      event: 'retries_exhausted',
    });

    const notices = countNotices(frames);
    expect(notices).toHaveLength(1);

    const notice = notices[0]!.payload as Record<string, unknown>;
    expect(notice.severity).toBe('requires_attention');
    expect(typeof notice.persistedAttentionId).toBe('number');

    const row = getAttentionRow(notice.persistedAttentionId as number);
    expect(row).toBeDefined();
    expect(row!.kind).toBe('awaiting_user_retry');
  });

  // -------------------------------------------------------------------------
  // No double-broadcast: single transition → single notice
  // -------------------------------------------------------------------------
  it('single pending_attention insertion produces exactly one notice frame', () => {
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

    expect(countNotices(frames)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Transitions WITHOUT pending_attention do NOT emit a notice frame
  // -------------------------------------------------------------------------
  it('session_fail+transient with retries remaining does NOT emit a notice frame', () => {
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

    expect(countNotices(frames)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // notifyFn fires independently; omitting it does NOT suppress WS broadcast
  // -------------------------------------------------------------------------
  it('WS broadcast fires even when notifyFn is not provided', () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, { status: 'bootstrapping' });

    // No notifyFn passed
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

    expect(countNotices(frames)).toHaveLength(1);
  });

  it('notifyFn fires alongside the WS broadcast — both fire on the same transition', () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, { status: 'bootstrapping' });

    const notifyCallCount = { value: 0 };
    const notifyFn: NotifyFn = () => { notifyCallCount.value++; };

    const { scheduler, frames } = makeScheduler({ notifyFn });

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

    // Both fire
    expect(countNotices(frames)).toHaveLength(1);
    expect(notifyCallCount.value).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Broadcast order: notice frame before item.state frame
  // (The caller emits item.state AFTER _applyTransition returns,
  //  so in the scheduler the notice is always first; here we just assert
  //  notice is present and has correct shape.)
  // -------------------------------------------------------------------------
  it('notice frame has persistedAttentionId matching the pending_attention row id', () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, { status: 'awaiting_retry', retryCount: 3 });

    const { scheduler, frames } = makeScheduler();

    applyTransition(scheduler, {
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 3,
      event: 'retries_exhausted',
    });

    const notice = frames.find((f) => f.frameType === 'notice')!;
    const payload = notice.payload as Record<string, unknown>;
    const attId = payload.persistedAttentionId as number;

    // The row must exist in the DB with the same id
    const dbRow = pool.reader()
      .prepare('SELECT id FROM pending_attention WHERE id = ?')
      .get(attId) as { id: number } | undefined;
    expect(dbRow).toBeDefined();
    expect(dbRow!.id).toBe(attId);
  });
});
