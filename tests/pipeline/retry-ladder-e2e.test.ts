/**
 * End-to-end integration test for the retry ladder driven through the Scheduler.
 *
 * Coverage:
 *   - Full continue → fresh_with_failure_summary → awaiting_user cycle
 *   - Injected clock controls retry timer without real waits
 *   - retry_count increments correctly at each step
 *   - broadcast frames emitted for each state transition
 *   - ProcessManager.spawn is never called (pre command fails before spawn)
 *
 * Uses real SQLite with migrations. Fake prepostRunner always fails pre commands.
 * Fake clock (now: () => number) injected via SchedulerOpts.
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
  PrePostRunnerFn,
  BroadcastFn,
} from '../../src/server/scheduler/scheduler.js';
import type { ProcessManager } from '../../src/server/process/manager.js';
import type { WorktreeManager } from '../../src/server/worktree/manager.js';
import type { ResolvedConfig } from '../../src/shared/types/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let tmpDir: string;
let pool: DbPool;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-e2e-retry-'));
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

function insertWorkflow(id: string, worktreePath: string) {
  pool.writer
    .prepare(`
      INSERT INTO workflows
        (id, name, spec, pipeline, config, status, created_at, updated_at, worktree_path)
      VALUES (?, 'test', '{}', '[]', '{}', 'in_progress',
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)
    `)
    .run(id, worktreePath);
}

function insertItem(id: string, wfId: string) {
  pool.writer
    .prepare(`
      INSERT INTO items
        (id, workflow_id, stage_id, data, status, current_phase,
         depends_on, retry_count, blocked_reason, updated_at)
      VALUES (?, ?, 'stage1', '{}', 'ready', 'implement', null, 0, null, '2026-01-01T00:00:00Z')
    `)
    .run(id, wfId);
}

function getItem(id: string) {
  return pool.writer
    .prepare('SELECT * FROM items WHERE id = ?')
    .get(id) as { id: string; status: string; current_phase: string | null; retry_count: number } | undefined;
}

// ---------------------------------------------------------------------------
// Drain helper: waits for all in-flight sessions to complete
// ---------------------------------------------------------------------------

async function drain(scheduler: Scheduler, maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  while ((scheduler as any).inFlight.size > 0) {
    if (Date.now() > deadline) {
      throw new Error('drain timeout: inFlight did not clear');
    }
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// Fake dependencies
// ---------------------------------------------------------------------------

const fakeProcessManager = {
  spawn: () => { throw new Error('ProcessManager.spawn must not be called in this test'); },
} as unknown as ProcessManager;

const fakeWorktreeManager = {
  createWorktree: () => { throw new Error('createWorktree must not be called'); },
  runBootstrap: () => { throw new Error('runBootstrap must not be called'); },
  runTeardown: () => { throw new Error('runTeardown must not be called'); },
  cleanup: () => { throw new Error('cleanup must not be called'); },
} as unknown as WorktreeManager;

// Pre command always fails with spawn_failed — causes pre_command_failed event
const failingPreRunner: PrePostRunnerFn = async (opts) => {
  if (opts.when === 'pre') {
    return {
      kind: 'spawn_failed',
      command: opts.commands[0]?.name ?? 'check',
      error: new Error('injected pre failure'),
      runs: [],
    };
  }
  return { kind: 'complete', runs: [] };
};

// Minimal ResolvedConfig with one phase that has a pre command
function makeConfig(configDir: string): ResolvedConfig {
  return {
    version: '1',
    configDir,
    project: { name: 'test' },
    pipeline: {
      stages: [
        {
          id: 'stage1',
          run: 'once',
          phases: ['implement'],
        },
      ],
    },
    phases: {
      implement: {
        command: 'claude',
        args: [],
        prompt_template: path.join(configDir, 'prompt.md'),
        pre: [
          {
            name: 'check',
            run: ['echo', 'hello'],
            actions: { '*': 'continue' },
          },
        ],
      },
    },
  } as unknown as ResolvedConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('retry-ladder-e2e — injected clock drives full ladder', () => {
  it('cycles continue → fresh_with_failure_summary → awaiting_user without real waits', async () => {
    let fakeNow = 0;
    const clockFn = () => fakeNow;

    const broadcastFrames: { frameType: string; payload: unknown }[] = [];
    const broadcastFn: BroadcastFn = (_wfId, _sessId, frameType, payload) => {
      broadcastFrames.push({ frameType, payload });
    };

    const wfId = 'wf-e2e-1';
    const itemId = 'item-e2e-1';

    insertWorkflow(wfId, tmpDir);
    insertItem(itemId, wfId);

    const config = makeConfig(tmpDir);
    const scheduler = new Scheduler({
      db: pool,
      config,
      processManager: fakeProcessManager,
      worktreeManager: fakeWorktreeManager,
      prepostRunner: failingPreRunner,
      assemblePrompt: async () => 'fake prompt',
      broadcast: broadcastFn,
      artifactValidator: async () => ({ kind: 'validators_ok' as const }),
      now: clockFn,
    });

    const tick = () => (scheduler as any)._processWorkflows() as Promise<void>;

    // ---------------------------------------------------------
    // Cycle 1: ready → in_progress → pre fails → awaiting_retry (continue)
    // ---------------------------------------------------------
    await tick();
    await drain(scheduler);

    let item = getItem(itemId);
    expect(item?.status).toBe('awaiting_retry');
    expect(item?.retry_count).toBe(1);

    // Broadcast: phase_start → in_progress, then pre_command_failed → awaiting_retry
    const cycle1Frames = broadcastFrames.filter(f => f.frameType === 'item.state');
    expect(cycle1Frames.length).toBeGreaterThanOrEqual(2);
    const lastFrame1 = cycle1Frames[cycle1Frames.length - 1];
    expect((lastFrame1.payload as any).state.status).toBe('awaiting_retry');
    expect((lastFrame1.payload as any).state.retryCount).toBe(1);

    // ---------------------------------------------------------
    // Advance clock past the 15 s backoff (retry_count=1 → 15000 ms)
    // ---------------------------------------------------------
    fakeNow = 20_000;

    // Tick: backoff_elapsed → in_progress
    await tick();

    item = getItem(itemId);
    expect(item?.status).toBe('in_progress');

    // Tick + drain: in_progress → pre fails → awaiting_retry (fresh_with_failure_summary)
    broadcastFrames.length = 0; // reset to track cycle 2 frames
    await tick();
    await drain(scheduler);

    item = getItem(itemId);
    expect(item?.status).toBe('awaiting_retry');
    expect(item?.retry_count).toBe(2);

    const cycle2Frames = broadcastFrames.filter(f => f.frameType === 'item.state');
    const lastFrame2 = cycle2Frames[cycle2Frames.length - 1];
    expect((lastFrame2.payload as any).state.status).toBe('awaiting_retry');
    expect((lastFrame2.payload as any).state.retryCount).toBe(2);

    // ---------------------------------------------------------
    // Advance clock past the 30 s backoff (retry_count=2 → 20000 + 30000 = 50000 ms)
    // ---------------------------------------------------------
    fakeNow = 100_000;

    // Tick: backoff_elapsed → in_progress
    await tick();

    item = getItem(itemId);
    expect(item?.status).toBe('in_progress');

    // Tick + drain: in_progress → pre fails → awaiting_user (ladder exhausted)
    broadcastFrames.length = 0;
    await tick();
    await drain(scheduler);

    item = getItem(itemId);
    expect(item?.status).toBe('awaiting_user');

    const cycle3Frames = broadcastFrames.filter(f => f.frameType === 'item.state');
    const lastFrame3 = cycle3Frames[cycle3Frames.length - 1];
    expect((lastFrame3.payload as any).state.status).toBe('awaiting_user');
  });

  it('retry_count increments on each ladder step', async () => {
    let fakeNow = 0;
    const clockFn = () => fakeNow;

    const wfId = 'wf-e2e-2';
    const itemId = 'item-e2e-2';
    insertWorkflow(wfId, tmpDir);
    insertItem(itemId, wfId);

    const scheduler = new Scheduler({
      db: pool,
      config: makeConfig(tmpDir),
      processManager: fakeProcessManager,
      worktreeManager: fakeWorktreeManager,
      prepostRunner: failingPreRunner,
      assemblePrompt: async () => 'fake prompt',
      broadcast: () => {},
      artifactValidator: async () => ({ kind: 'validators_ok' as const }),
      now: clockFn,
    });

    const tick = () => (scheduler as any)._processWorkflows() as Promise<void>;

    // Step 1
    await tick(); await drain(scheduler);
    expect(getItem(itemId)?.retry_count).toBe(1);

    // Step 2
    fakeNow = 20_000;
    await tick();
    await tick(); await drain(scheduler);
    expect(getItem(itemId)?.retry_count).toBe(2);

    // Step 3 (exhaustion — retry_count stays at 2)
    fakeNow = 100_000;
    await tick();
    await tick(); await drain(scheduler);
    expect(getItem(itemId)?.retry_count).toBe(2);
    expect(getItem(itemId)?.status).toBe('awaiting_user');
  });
});
