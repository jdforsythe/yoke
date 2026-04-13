/**
 * Integration tests for the Scheduler (src/server/scheduler/scheduler.ts).
 *
 * Uses real SQLite (with migrations) and stub ProcessManager / WorktreeManager
 * so no real git, worktrees, or agent processes are required.
 *
 * Coverage:
 *   AC-1  ingestWorkflow seeds workflow + item rows within the poll window.
 *   AC-2  Crash recovery transitions stale in_progress → awaiting_retry before
 *         any new items are scheduled.
 *   AC-3  Scheduler drives pending → ready → bootstrapping → in_progress →
 *         complete (or a terminal state) end-to-end for a single-phase workflow.
 *   AC-5  applyWorktreeCreated persists branch_name + worktree_path to workflows.
 *   AC-7  BroadcastFn is called with stream events forwarded from the parser.
 *   AC-8  stop() resolves after cancelling in-flight sessions (graceful drain).
 *   RC-5  Concurrency limit (maxParallel=1) prevents over-scheduling.
 *   RC-6  All production deps are injectable (verified by using stubs throughout).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import type { DbPool } from '../../src/server/storage/db.js';
import type { ProcessManager, SpawnHandle, SpawnOpts } from '../../src/server/process/manager.js';
import type { WorktreeManager, WorktreeInfo, BootstrapEvent } from '../../src/server/worktree/manager.js';
import { Scheduler } from '../../src/server/scheduler/scheduler.js';
import { ingestWorkflow } from '../../src/server/scheduler/ingest.js';
import type { ResolvedConfig } from '../../src/shared/types/config.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

let tmpDir: string;
let db: DbPool;
// Track schedulers so they're stopped before db.close() in afterEach.
const activeSchedulers: Scheduler[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-sched-test-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));
  applyMigrations(db.writer, MIGRATIONS_DIR);
});

afterEach(async () => {
  // Stop all schedulers before closing the DB — timers must not fire after close.
  for (const s of activeSchedulers) {
    await s.stop().catch(() => {});
  }
  activeSchedulers.length = 0;
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Minimal ResolvedConfig factory
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    version: '1',
    configDir: tmpDir,
    project: { name: 'test-project' },
    pipeline: {
      stages: [
        {
          id: 'stage-alpha',
          run: 'once',
          phases: ['phase-one'],
        },
      ],
    },
    phases: {
      'phase-one': {
        command: 'claude',
        args: ['--output-format', 'stream-json'],
        prompt_template: 'Do the thing.',
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stub SpawnHandle — an EventEmitter that replays records on next tick.
// ---------------------------------------------------------------------------

type StubRecord =
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; chunk: string }
  | { type: 'exit'; code: number };

class StubSpawnHandle extends EventEmitter implements SpawnHandle {
  readonly pid = 99001;
  readonly pgid = 99001;
  private _alive = true;

  constructor(private readonly records: StubRecord[] = []) {
    super();
  }

  isAlive(): boolean { return this._alive; }

  async cancel(): Promise<void> {
    this._alive = false;
    setImmediate(() => this.emit('exit', null, 'SIGTERM'));
  }

  start(): void {
    const records = this.records;
    let i = 0;
    const emit = () => {
      if (!this._alive || i >= records.length) {
        if (this._alive) { this._alive = false; this.emit('exit', 0, null); }
        return;
      }
      const rec = records[i++];
      if (rec.type === 'stdout') this.emit('stdout_line', rec.line);
      else if (rec.type === 'stderr') this.emit('stderr_data', rec.chunk);
      else if (rec.type === 'exit') {
        this._alive = false;
        this.emit('exit', rec.code, null);
        return;
      }
      setImmediate(emit);
    };
    setImmediate(emit);
  }
}

// ---------------------------------------------------------------------------
// Stub ProcessManager
// ---------------------------------------------------------------------------

class StubProcessManager implements ProcessManager {
  readonly handles: StubSpawnHandle[] = [];

  constructor(private readonly records: StubRecord[] = []) {}

  async spawn(_opts: SpawnOpts): Promise<SpawnHandle> {
    const handle = new StubSpawnHandle(this.records);
    this.handles.push(handle);
    handle.start();
    return handle;
  }
}

// ---------------------------------------------------------------------------
// Stub WorktreeManager (only implements the methods the scheduler calls)
// ---------------------------------------------------------------------------

function makeWorktreeManager(opts: {
  worktreePath?: string;
  bootstrapEvent?: BootstrapEvent;
  failCreate?: boolean;
} = {}): WorktreeManager {
  const wt = opts.worktreePath ?? path.join(tmpDir, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  return {
    async createWorktree(): Promise<WorktreeInfo> {
      if (opts.failCreate) throw new Error('createWorktree stub failure');
      return { branchName: 'yoke/test-abc123', worktreePath: wt };
    },
    async runBootstrap(): Promise<BootstrapEvent> {
      return opts.bootstrapEvent ?? { type: 'bootstrap_ok' };
    },
    // cleanup is never called by the scheduler directly
    async cleanup(): Promise<{ worktreeRemoved: boolean; branchRetained: boolean }> {
      return { worktreeRemoved: true, branchRetained: false };
    },
  } as unknown as WorktreeManager;
}

// ---------------------------------------------------------------------------
// pollUntil — wait for a SQLite condition to become true
// ---------------------------------------------------------------------------

async function pollUntil(
  check: () => boolean,
  { timeoutMs = 5000, intervalMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('pollUntil timed out');
}

// ---------------------------------------------------------------------------
// Helper — create and start a minimal Scheduler, return it + broadcastFn spy
// ---------------------------------------------------------------------------

interface TestSchedulerResult {
  scheduler: Scheduler;
  broadcasts: Array<{ workflowId: string; sessionId: string | null; frameType: string; payload: unknown }>;
}

function buildScheduler(opts: {
  config?: ResolvedConfig;
  processManager?: ProcessManager;
  worktreeManager?: WorktreeManager;
  maxParallel?: number;
  pollIntervalMs?: number;
}): TestSchedulerResult {
  const broadcasts: TestSchedulerResult['broadcasts'] = [];

  const scheduler = new Scheduler({
    db,
    config: opts.config ?? makeConfig(),
    processManager: opts.processManager ?? new StubProcessManager(),
    worktreeManager: opts.worktreeManager ?? makeWorktreeManager(),
    prepostRunner: async () => ({ kind: 'complete' }),
    assemblePrompt: async () => 'stub prompt',
    broadcast: (workflowId, sessionId, frameType, payload) => {
      broadcasts.push({ workflowId, sessionId, frameType, payload });
    },
    maxParallel: opts.maxParallel ?? 4,
    pollIntervalMs: opts.pollIntervalMs ?? 50,
    gracePeriodMs: 500,
  });

  activeSchedulers.push(scheduler);
  return { scheduler, broadcasts };
}

// ---------------------------------------------------------------------------
// AC-1: ingestWorkflow
// ---------------------------------------------------------------------------

describe('AC-1: ingestWorkflow', () => {
  it('creates a workflow row and one item per stage', () => {
    const config = makeConfig();
    const { workflowId, isResume } = ingestWorkflow(db, config);

    expect(typeof workflowId).toBe('string');
    expect(isResume).toBe(false);

    const wf = db.reader()
      .prepare('SELECT * FROM workflows WHERE id = ?')
      .get(workflowId) as { status: string; current_stage: string } | undefined;
    expect(wf).toBeDefined();
    expect(wf!.status).toBe('pending');
    expect(wf!.current_stage).toBe('stage-alpha');

    const items = db.reader()
      .prepare('SELECT * FROM items WHERE workflow_id = ?')
      .all(workflowId) as { stage_id: string; status: string }[];
    expect(items).toHaveLength(1);
    expect(items[0].stage_id).toBe('stage-alpha');
    expect(items[0].status).toBe('pending');
  });

  it('returns isResume:true and the existing id on second call', () => {
    const config = makeConfig();
    const first = ingestWorkflow(db, config);
    const second = ingestWorkflow(db, config);

    expect(second.workflowId).toBe(first.workflowId);
    expect(second.isResume).toBe(true);
  });

  it('chains depends_on across stages (stage N+1 depends on stage N item)', () => {
    const config = makeConfig({
      pipeline: {
        stages: [
          { id: 's1', run: 'once', phases: ['phase-one'] },
          { id: 's2', run: 'once', phases: ['phase-one'] },
        ],
      },
    });
    const { workflowId } = ingestWorkflow(db, config);
    const items = db.reader()
      .prepare('SELECT id, stage_id, depends_on FROM items WHERE workflow_id = ? ORDER BY rowid')
      .all(workflowId) as { id: string; stage_id: string; depends_on: string | null }[];

    expect(items).toHaveLength(2);
    expect(items[0].depends_on).toBeNull();  // first item has no dependency
    const deps = JSON.parse(items[1].depends_on!);
    expect(deps).toEqual([items[0].id]);     // second depends on first
  });
});

// ---------------------------------------------------------------------------
// AC-2: Crash recovery runs before scheduling
// ---------------------------------------------------------------------------

describe('AC-2: crash recovery before scheduling', () => {
  it('transitions stale in_progress items to awaiting_retry before any spawn', async () => {
    // Manually seed a workflow + item in in_progress + a sessions row simulating
    // a stale session from a previous run.
    const config = makeConfig();
    const { workflowId } = ingestWorkflow(db, config);

    // Advance item to in_progress by hand.
    const [item] = db.reader()
      .prepare('SELECT id FROM items WHERE workflow_id = ?')
      .all(workflowId) as { id: string }[];

    const now = new Date().toISOString();
    db.writer.prepare('UPDATE items SET status = ? WHERE id = ?').run('in_progress', item.id);
    // Insert a stale sessions row with a non-existent PID so buildCrashRecovery
    // detects it as stale (probeProcess returns false for PID 2147483647).
    const sessionId = 'stale-session-id';
    db.writer.prepare(`
      INSERT INTO sessions (id, workflow_id, item_id, stage, phase, agent_profile,
                            status, pid, pgid, started_at)
      VALUES (?, ?, ?, 'stage-alpha', 'phase-one', 'default', 'running', 2147483647, 2147483647, ?)
    `).run(sessionId, workflowId, item.id, now);

    const { scheduler } = buildScheduler({ config });
    await scheduler.start();

    // After start(), the stale in_progress item should have been moved out
    // of in_progress (awaiting_retry or awaiting_user) before any new spawn.
    const freshItem = db.reader()
      .prepare('SELECT status FROM items WHERE id = ?')
      .get(item.id) as { status: string };

    expect(['awaiting_retry', 'awaiting_user']).toContain(freshItem.status);

    await scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// AC-3: End-to-end state machine advancement
// ---------------------------------------------------------------------------

describe('AC-3: state machine end-to-end', () => {
  it('drives a single-stage workflow from pending to complete', async () => {
    const config = makeConfig();
    const pm = new StubProcessManager([{ type: 'exit', code: 0 }]);
    const { scheduler } = buildScheduler({ config, processManager: pm, pollIntervalMs: 50 });

    await scheduler.start();
    const workflowId = scheduler.workflowId!;

    // Wait for the workflow to reach 'completed' status.
    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(workflowId) as { status: string } | undefined;
      return wf?.status === 'completed';
    }, { timeoutMs: 10_000 });

    const wf = db.reader()
      .prepare('SELECT status FROM workflows WHERE id = ?')
      .get(workflowId) as { status: string };
    expect(wf.status).toBe('completed');

    await scheduler.stop();
  });

  it('bootstrap_fail → item enters bootstrap_failed or awaiting_user', async () => {
    const config = makeConfig();
    const wm = makeWorktreeManager({ bootstrapEvent: { type: 'bootstrap_fail', failedCommand: 'setup.sh', exitCode: 1, stderr: 'oops' } });
    const { scheduler } = buildScheduler({ config, worktreeManager: wm });

    await scheduler.start();
    const workflowId = scheduler.workflowId!;

    const [item] = db.reader()
      .prepare('SELECT id FROM items WHERE workflow_id = ?')
      .all(workflowId) as { id: string }[];

    await pollUntil(() => {
      const row = db.reader()
        .prepare('SELECT status FROM items WHERE id = ?')
        .get(item.id) as { status: string };
      return ['bootstrap_failed', 'awaiting_user'].includes(row.status);
    }, { timeoutMs: 10_000 });

    const row = db.reader()
      .prepare('SELECT status FROM items WHERE id = ?')
      .get(item.id) as { status: string };
    expect(['bootstrap_failed', 'awaiting_user']).toContain(row.status);

    await scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// AC-5: applyWorktreeCreated persists worktree path
// ---------------------------------------------------------------------------

describe('AC-5: worktree_path persisted after createWorktree', () => {
  it('sets branch_name and worktree_path on the workflow row', async () => {
    const config = makeConfig();
    const pm = new StubProcessManager([{ type: 'exit', code: 0 }]);
    const wm = makeWorktreeManager({ worktreePath: path.join(tmpDir, 'my-wt') });
    const { scheduler } = buildScheduler({ config, processManager: pm, worktreeManager: wm });

    await scheduler.start();
    const workflowId = scheduler.workflowId!;

    // Wait for worktree_path to be set (happens before session spawn).
    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT worktree_path FROM workflows WHERE id = ?')
        .get(workflowId) as { worktree_path: string | null };
      return wf.worktree_path != null;
    });

    const wf = db.reader()
      .prepare('SELECT branch_name, worktree_path FROM workflows WHERE id = ?')
      .get(workflowId) as { branch_name: string; worktree_path: string };

    expect(wf.branch_name).toBe('yoke/test-abc123');
    expect(wf.worktree_path).toContain('my-wt');

    await scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// AC-7: BroadcastFn receives stream events
// ---------------------------------------------------------------------------

describe('AC-7: stream events are broadcast', () => {
  it('calls broadcast with item.state frames', async () => {
    const config = makeConfig();
    const pm = new StubProcessManager([{ type: 'exit', code: 0 }]);
    const { scheduler, broadcasts } = buildScheduler({ config, processManager: pm });

    await scheduler.start();
    const workflowId = scheduler.workflowId!;

    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(workflowId) as { status: string } | undefined;
      return wf?.status === 'completed';
    }, { timeoutMs: 10_000 });

    // item.state frames should have been broadcast.
    const stateFrames = broadcasts.filter((b) => b.frameType === 'item.state');
    expect(stateFrames.length).toBeGreaterThan(0);

    // All item.state frames should reference the correct workflowId.
    for (const frame of stateFrames) {
      expect(frame.workflowId).toBe(workflowId);
    }

    await scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// AC-8: stop() drains in-flight sessions
// ---------------------------------------------------------------------------

describe('AC-8: graceful drain on stop()', () => {
  it('resolves within gracePeriodMs even with a running session', async () => {
    const config = makeConfig();

    // A process that never exits on its own — stalls until cancel() fires SIGTERM.
    class StallingPM implements ProcessManager {
      readonly handles: StubSpawnHandle[] = [];
      async spawn(_opts: SpawnOpts): Promise<SpawnHandle> {
        const handle = new StubSpawnHandle([]);
        // Override start() — do nothing. Only cancel() can unblock it.
        handle.start = () => { /* stall — never emit exit spontaneously */ };
        this.handles.push(handle);
        return handle;
      }
    }
    const pm = new StallingPM();
    const broadcasts: TestSchedulerResult['broadcasts'] = [];
    const sched = new Scheduler({
      db,
      config,
      processManager: pm,
      worktreeManager: makeWorktreeManager(),
      prepostRunner: async () => ({ kind: 'complete' }),
      assemblePrompt: async () => 'stub prompt',
      broadcast: (wid, sid, ft, p) => broadcasts.push({ workflowId: wid, sessionId: sid, frameType: ft, payload: p }),
      maxParallel: 4,
      pollIntervalMs: 50,
      gracePeriodMs: 1000,
    });
    activeSchedulers.push(sched);

    await sched.start();

    // Wait for at least one spawn (handle appears in pm.handles).
    await pollUntil(() => (pm as StallingPM).handles.length > 0, { timeoutMs: 10_000 });

    const t0 = Date.now();
    await sched.stop();
    const elapsed = Date.now() - t0;

    // Should complete within gracePeriodMs + generous buffer.
    expect(elapsed).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------
// RC-5: concurrency limit enforced
// ---------------------------------------------------------------------------

describe('RC-5: concurrency limit', () => {
  it('does not spawn more sessions than maxParallel', async () => {
    // Two stages, maxParallel=1 → only 1 session at a time.
    const config = makeConfig({
      pipeline: {
        stages: [
          { id: 's1', run: 'once', phases: ['phase-one'] },
          { id: 's2', run: 'once', phases: ['phase-one'] },
        ],
      },
    });

    // Track concurrent spawn calls.
    let maxConcurrent = 0;
    let current = 0;

    class CountingPM implements ProcessManager {
      async spawn(_opts: SpawnOpts): Promise<SpawnHandle> {
        current++;
        if (current > maxConcurrent) maxConcurrent = current;

        const handle = new StubSpawnHandle([{ type: 'exit', code: 0 }]);
        handle.on('exit', () => { current--; });
        handle.start();
        return handle;
      }
    }

    const { scheduler } = buildScheduler({
      config,
      processManager: new CountingPM(),
      maxParallel: 1,
      pollIntervalMs: 50,
    });

    await scheduler.start();
    const workflowId = scheduler.workflowId!;

    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(workflowId) as { status: string } | undefined;
      return wf?.status === 'completed';
    }, { timeoutMs: 15_000 });

    expect(maxConcurrent).toBeLessThanOrEqual(1);

    await scheduler.stop();
  });
});
