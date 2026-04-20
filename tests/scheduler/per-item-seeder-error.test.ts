/**
 * Per-item seeder error path — unit tests for r2-06 (seed_failed).
 *
 * Coverage:
 *   AC-1  seed error → pending_attention{kind=seed_failed}, item → awaiting_user,
 *          notice frame broadcast with persistedAttentionId
 *   AC-2  Payload message is human-readable (truncated to ≤ 500 chars, stage present)
 *   AC-3  10 ticks after seed_failed → no further seeding (tight-loop prevention)
 *   AC-4  user_retry → in_progress → seeder re-runs → new seed_failed row
 *
 * Uses real SQLite + migrations; seedPerItemStage fails naturally because the
 * manifest file is absent from tmpDir.  processManager.spawn is never called.
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
import type { BroadcastFn } from '../../src/server/scheduler/scheduler.js';
import type { ProcessManager } from '../../src/server/process/manager.js';
import type { WorktreeManager } from '../../src/server/worktree/manager.js';
import type { ResolvedConfig } from '../../src/shared/types/config.js';
import { applyItemTransition } from '../../src/server/pipeline/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let pool: DbPool;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-seed-err-'));
  pool = openDbPool(path.join(tmpDir, 'test.db'));
  applyMigrations(pool.writer, MIGRATIONS_DIR);
});

afterEach(async () => {
  // Clear pending index-update debounce timers before closing the pool to
  // prevent "database connection is not open" errors on timer fire.
  for (const s of schedulers) {
    await s.stop();
  }
  schedulers.length = 0;
  pool.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ID sequences
// ---------------------------------------------------------------------------

let wfSeq = 0;
let itemSeq = 0;
function mkWf() { return `wf-se-${++wfSeq}`; }
function mkItem() { return `item-se-${++itemSeq}`; }

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function insertWorkflow(id: string) {
  const now = '2026-01-01T00:00:00Z';
  pool.writer
    .prepare(
      `INSERT INTO workflows
         (id, name, spec, pipeline, config, status, current_stage, worktree_path, created_at, updated_at)
       VALUES (?, 'test-seed-err', '{}', '[]', '{}', 'running', 'per-item-stage', ?, ?, ?)`,
    )
    .run(id, tmpDir, now, now);
}

function insertPlaceholderItem(id: string, wfId: string, opts: { status?: string } = {}) {
  const now = '2026-01-01T00:00:00Z';
  pool.writer
    .prepare(
      `INSERT INTO items
         (id, workflow_id, stage_id, data, status, current_phase,
          depends_on, retry_count, blocked_reason, updated_at)
       VALUES (?, ?, 'per-item-stage', '{}', ?, 'phase-one', null, 0, null, ?)`,
    )
    .run(id, wfId, opts.status ?? 'ready', now);
}

function getItemStatus(id: string): string | undefined {
  const row = pool.reader()
    .prepare('SELECT status FROM items WHERE id = ?')
    .get(id) as { status: string } | undefined;
  return row?.status;
}

function getAttentionRows(wfId: string): Array<{ id: number; kind: string; payload: string }> {
  return pool.reader()
    .prepare('SELECT id, kind, payload FROM pending_attention WHERE workflow_id = ? ORDER BY id')
    .all(wfId) as Array<{ id: number; kind: string; payload: string }>;
}

// ---------------------------------------------------------------------------
// Fake scheduler dependencies
// ---------------------------------------------------------------------------

const fakeProcessManager = {
  spawn: () => { throw new Error('spawn must not be called in seeder-error tests'); },
} as unknown as ProcessManager;

const fakeWorktreeManager = {
  createWorktree: () => { throw new Error('createWorktree must not be called'); },
  runBootstrap: () => { throw new Error('runBootstrap must not be called'); },
  runTeardown: () => {},
  cleanup: () => {},
} as unknown as WorktreeManager;

function makePerItemConfig(configDir: string): ResolvedConfig {
  return {
    version: '1',
    configDir,
    project: { name: 'test' },
    pipeline: {
      stages: [
        {
          id: 'per-item-stage',
          run: 'per-item',
          phases: ['phase-one'],
          items_from: 'missing-manifest.json', // will not exist → seeder returns error
          items_list: '$.features',
          items_id: '$.id',
        },
      ],
    },
    phases: {
      'phase-one': {
        command: 'echo',
        args: [],
        prompt_template: path.join(configDir, 'prompt.md'),
      },
    },
  } as unknown as ResolvedConfig;
}

const schedulers: Scheduler[] = [];

function makeScheduler() {
  const frames: { frameType: string; payload: unknown }[] = [];
  const broadcastFn: BroadcastFn = (_wfId, _sessId, frameType, payload) => {
    frames.push({ frameType, payload });
  };
  const scheduler = new Scheduler({
    db: pool,
    config: makePerItemConfig(tmpDir),
    processManager: fakeProcessManager,
    worktreeManager: fakeWorktreeManager,
    prepostRunner: async () => ({ kind: 'complete', runs: [] }),
    assemblePrompt: async () => 'prompt',
    broadcast: broadcastFn,
    artifactValidator: async () => ({ kind: 'validators_ok' as const }),
  });
  schedulers.push(scheduler);
  return { scheduler, frames };
}

function processWorkflows(scheduler: Scheduler): Promise<void> {
  return (scheduler as unknown as { _processWorkflows(): Promise<void> })._processWorkflows();
}

function noticeFrames(frames: { frameType: string; payload: unknown }[]) {
  return frames.filter((f) => f.frameType === 'notice');
}

// ---------------------------------------------------------------------------
// AC-1: seed error → pending_attention, awaiting_user, notice frame
// ---------------------------------------------------------------------------

describe('AC-1: seed error path', () => {
  it('transitions placeholder to awaiting_user and inserts pending_attention{kind=seed_failed}', async () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertPlaceholderItem(itemId, wfId);

    const { scheduler } = makeScheduler();
    await processWorkflows(scheduler);

    expect(getItemStatus(itemId)).toBe('awaiting_user');

    const rows = getAttentionRows(wfId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('seed_failed');
  });

  it('broadcasts a notice frame with severity=requires_attention and kind=seed_failed', async () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertPlaceholderItem(itemId, wfId);

    const { scheduler, frames } = makeScheduler();
    await processWorkflows(scheduler);

    const notices = noticeFrames(frames);
    expect(notices).toHaveLength(1);

    const notice = notices[0]!.payload as Record<string, unknown>;
    expect(notice.severity).toBe('requires_attention');
    expect(notice.kind).toBe('seed_failed');
    expect(typeof notice.persistedAttentionId).toBe('number');
  });

  it('persistedAttentionId in notice frame matches the DB row', async () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertPlaceholderItem(itemId, wfId);

    const { scheduler, frames } = makeScheduler();
    await processWorkflows(scheduler);

    const notice = noticeFrames(frames)[0]!.payload as Record<string, unknown>;
    const attId = notice.persistedAttentionId as number;

    const rows = getAttentionRows(wfId);
    expect(rows[0]!.id).toBe(attId);
  });
});

// ---------------------------------------------------------------------------
// AC-2: payload is human-readable
// ---------------------------------------------------------------------------

describe('AC-2: attention payload content', () => {
  it('payload.message contains a human-readable error (filename present, ≤ 500 chars)', async () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertPlaceholderItem(itemId, wfId);

    const { scheduler } = makeScheduler();
    await processWorkflows(scheduler);

    const rows = getAttentionRows(wfId);
    const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>;

    expect(typeof payload['message']).toBe('string');
    // Error originates from missing manifest file; message should mention the filename.
    expect(payload['message'] as string).toMatch(/missing-manifest\.json/);
    // Truncation guarantee: ≤ 500 chars + optional ellipsis.
    expect((payload['message'] as string).length).toBeLessThanOrEqual(501);
  });

  it('payload.stage matches the stage_id', async () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertPlaceholderItem(itemId, wfId);

    const { scheduler } = makeScheduler();
    await processWorkflows(scheduler);

    const rows = getAttentionRows(wfId);
    const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>;
    expect(payload['stage']).toBe('per-item-stage');
  });

  it('notice.message is the formatted human-readable string', async () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertPlaceholderItem(itemId, wfId);

    const { scheduler, frames } = makeScheduler();
    await processWorkflows(scheduler);

    const notice = noticeFrames(frames)[0]!.payload as Record<string, unknown>;
    expect(typeof notice.message).toBe('string');
    expect(notice.message as string).toMatch(/Seeding failed/);
  });
});

// ---------------------------------------------------------------------------
// AC-3: tight-loop prevention — no re-seeding while awaiting_user
// ---------------------------------------------------------------------------

describe('AC-3: tight-loop prevention', () => {
  it('10 ticks after seed_failed result in exactly 1 pending_attention row (no re-seeding)', async () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertPlaceholderItem(itemId, wfId);

    const { scheduler } = makeScheduler();

    // Tick 1: seeds → fails → awaiting_user
    await processWorkflows(scheduler);
    expect(getItemStatus(itemId)).toBe('awaiting_user');

    // Ticks 2–10: item is awaiting_user, scheduler ignores it (no awaiting_user case)
    for (let i = 0; i < 9; i++) {
      await processWorkflows(scheduler);
    }

    const rows = getAttentionRows(wfId);
    expect(rows).toHaveLength(1);
    expect(getItemStatus(itemId)).toBe('awaiting_user');
  });
});

// ---------------------------------------------------------------------------
// AC-4: user_retry → seeder re-runs → new seed_failed
// ---------------------------------------------------------------------------

describe('AC-4: user_retry triggers re-seeding', () => {
  it('after user_retry moves item to in_progress, next tick re-seeds and fires seed_failed again', async () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertPlaceholderItem(itemId, wfId);

    const { scheduler } = makeScheduler();

    // Tick 1: seed fails → awaiting_user
    await processWorkflows(scheduler);
    expect(getItemStatus(itemId)).toBe('awaiting_user');
    expect(getAttentionRows(wfId)).toHaveLength(1);

    // Simulate user_retry: moves item from awaiting_user → in_progress
    applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'per-item-stage',
      phase: 'phase-one',
      attempt: 1,
      event: 'user_retry',
    });
    expect(getItemStatus(itemId)).toBe('in_progress');

    // Tick 2: in_progress placeholder → re-seed → fails again → awaiting_user
    await processWorkflows(scheduler);

    expect(getItemStatus(itemId)).toBe('awaiting_user');
    const rows = getAttentionRows(wfId);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.kind).toBe('seed_failed');
  });

  it('re-seed failure broadcasts a second notice frame', async () => {
    const wfId = mkWf();
    const itemId = mkItem();
    insertWorkflow(wfId);
    insertPlaceholderItem(itemId, wfId);

    const { scheduler, frames } = makeScheduler();

    // First seed failure
    await processWorkflows(scheduler);

    // user_retry
    applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'per-item-stage',
      phase: 'phase-one',
      attempt: 1,
      event: 'user_retry',
    });

    // Second seed failure
    await processWorkflows(scheduler);

    const notices = noticeFrames(frames);
    expect(notices).toHaveLength(2);
    expect((notices[1]!.payload as Record<string, unknown>).kind).toBe('seed_failed');
  });
});
