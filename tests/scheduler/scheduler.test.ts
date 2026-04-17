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
 *   AC-2b Capture mode: fixture file written when .yoke/record.json is present;
 *         marker cleared on success and non-zero exit; ScriptedProcessManager
 *         replays the captured fixture with identical event sequence (RC-2).
 *   AC-3  Scheduler drives pending → ready → bootstrapping → in_progress →
 *         complete (or a terminal state) end-to-end for a single-phase workflow.
 *   AC-5  applyWorktreeCreated persists branch_name + worktree_path to workflows.
 *   AC-7  BroadcastFn is called with stream events forwarded from the parser.
 *   AC-8  stop() resolves after cancelling in-flight sessions (graceful drain).
 *   RC-5  Concurrency limit (maxParallel=1) prevents over-scheduling.
 *   RC-6  All production deps are injectable (verified by using stubs throughout).
 *
 *   feat-artifact-validators:
 *   AV-1  Passing validators_ok → workflow reaches completed.
 *   AV-2  validator_fail → item transitions to awaiting_retry (budget > 0).
 *   AV-3  validator_fail → post commands are NOT called.
 *   AV-4  Validators called with phase output_artifacts + worktreePath.
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
import type { ArtifactValidatorFn } from '../../src/server/scheduler/scheduler.js';
import { ingestWorkflow } from '../../src/server/scheduler/ingest.js';
import type { ResolvedConfig } from '../../src/shared/types/config.js';
import { runRecord } from '../../src/cli/record.js';
import { parseFixture } from '../../src/server/process/scripted-manager.js';

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
    prepostRunner: async () => ({ kind: 'complete', runs: [] }),
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

  it('bootstrap_fail → scheduler.start() rejects with the failed command in the message', async () => {
    // Worktree bootstrap now runs in Scheduler.start() via _ensureWorktree,
    // before the tick loop begins. A bootstrap failure therefore surfaces as
    // a rejection from start() (caller exits non-zero), not an item-level
    // bootstrap_failed state. The workflow row still exists — the user
    // repairs whatever failed and restarts.
    const config = makeConfig({
      worktrees: { base_dir: '.worktrees', bootstrap: { commands: ['setup.sh'] } },
    });
    const wm = makeWorktreeManager({ bootstrapEvent: { type: 'bootstrap_fail', failedCommand: 'setup.sh', exitCode: 1, stderr: 'oops' } });
    const { scheduler } = buildScheduler({ config, worktreeManager: wm });

    await expect(scheduler.start()).rejects.toThrow(/setup\.sh/);

    // Workflow row still exists so the user can resume after fixing the issue.
    const wf = db.reader()
      .prepare('SELECT id FROM workflows WHERE id = ?')
      .get(scheduler.workflowId!) as { id: string } | undefined;
    expect(wf).toBeDefined();

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
      prepostRunner: async () => ({ kind: 'complete', runs: [] }),
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
// AC-4: Pre-phase non-continue action blocks spawn
// ---------------------------------------------------------------------------

describe('AC-4: pre-phase non-continue action blocks spawn', () => {
  it('fires pre_command_failed and does not call spawn when pre returns stop-and-ask', async () => {
    // Phase config must have at least one pre command so the runner is invoked.
    const config = makeConfig({
      phases: {
        'phase-one': {
          command: 'claude',
          args: ['--output-format', 'stream-json'],
          prompt_template: 'Do the thing.',
          pre: [{ name: 'pre-check', run: ['echo', 'checking'], actions: {} }],
        },
      },
    });

    let spawnCount = 0;
    class SpyPM implements ProcessManager {
      async spawn(_opts: SpawnOpts): Promise<SpawnHandle> {
        spawnCount++;
        const handle = new StubSpawnHandle([{ type: 'exit', code: 0 }]);
        handle.start();
        return handle;
      }
    }

    const sched = new Scheduler({
      db,
      config,
      processManager: new SpyPM(),
      worktreeManager: makeWorktreeManager(),
      // Pre runner returns stop-and-ask → pre_command_failed → awaiting_user.
      prepostRunner: async (opts) => {
        if (opts.when === 'pre') {
          return { kind: 'action' as const, command: 'pre-check', action: 'stop-and-ask' as const, runs: [] };
        }
        return { kind: 'complete' as const, runs: [] };
      },
      assemblePrompt: async () => 'stub prompt',
      broadcast: () => {},
      pollIntervalMs: 50,
      gracePeriodMs: 500,
    });
    activeSchedulers.push(sched);

    await sched.start();
    const workflowId = sched.workflowId!;
    const [item] = db.reader()
      .prepare('SELECT id FROM items WHERE workflow_id = ?')
      .all(workflowId) as { id: string }[];

    // Item must reach awaiting_user — stop-and-ask maps there directly.
    await pollUntil(() => {
      const row = db.reader()
        .prepare('SELECT status FROM items WHERE id = ?')
        .get(item.id) as { status: string };
      return row.status === 'awaiting_user';
    }, { timeoutMs: 10_000 });

    // Spawn must never have been called — pre-command blocked it.
    expect(spawnCount).toBe(0);
    const row = db.reader()
      .prepare('SELECT status FROM items WHERE id = ?')
      .get(item.id) as { status: string };
    expect(row.status).toBe('awaiting_user');

    await sched.stop();
  });
});

// ---------------------------------------------------------------------------
// AC-5 (spec): Post-phase non-continue action forwarded to applyItemTransition
// ---------------------------------------------------------------------------

describe('AC-5 (spec): post-phase non-continue action forwarded to engine', () => {
  it('post action=fail after session_ok sends item to awaiting_retry, not complete', async () => {
    // Phase config must have at least one post command so the runner is invoked.
    const config = makeConfig({
      phases: {
        'phase-one': {
          command: 'claude',
          args: ['--output-format', 'stream-json'],
          prompt_template: 'Do the thing.',
          post: [{ name: 'review', run: ['echo', 'reviewing'], actions: {} }],
        },
      },
    });

    // Process exits 0 — session_ok path — but post runner returns non-continue.
    const pm = new StubProcessManager([{ type: 'exit', code: 0 }]);

    const sched = new Scheduler({
      db,
      config,
      processManager: pm,
      worktreeManager: makeWorktreeManager(),
      // Post runner returns fail action → forwarded to post_command_action.
      prepostRunner: async (opts) => {
        if (opts.when === 'post') {
          return {
            kind: 'action' as const,
            command: 'review',
            action: { fail: { reason: 'review-failed' } },
            runs: [],
          };
        }
        return { kind: 'complete' as const, runs: [] };
      },
      assemblePrompt: async () => 'stub prompt',
      broadcast: () => {},
      pollIntervalMs: 50,
      gracePeriodMs: 500,
    });
    activeSchedulers.push(sched);

    await sched.start();
    const workflowId = sched.workflowId!;
    const [item] = db.reader()
      .prepare('SELECT id FROM items WHERE workflow_id = ?')
      .all(workflowId) as { id: string }[];

    // Item must NOT reach complete — post action fail should prevent completion.
    await pollUntil(() => {
      const row = db.reader()
        .prepare('SELECT status FROM items WHERE id = ?')
        .get(item.id) as { status: string };
      return ['awaiting_retry', 'awaiting_user'].includes(row.status);
    }, { timeoutMs: 10_000 });

    const row = db.reader()
      .prepare('SELECT status FROM items WHERE id = ?')
      .get(item.id) as { status: string };
    expect(['awaiting_retry', 'awaiting_user']).toContain(row.status);
    // The post action was forwarded — not re-executed — so item never completed.
    expect(row.status).not.toBe('complete');

    await sched.stop();
  });
});

// ---------------------------------------------------------------------------
// AC-6: rate_limit_detected transitions item to rate_limited + backoff
// ---------------------------------------------------------------------------

describe('AC-6: rate_limit_detected → rate_limited with backoff', () => {
  it('transitions item to rate_limited when parser emits rate_limit_detected', async () => {
    const config = makeConfig();

    // A stdout line that the StreamJsonParser classifies as a rate-limit event.
    const RATE_LIMIT_LINE = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 9_999_999_999 },
    });

    let spawnCount = 0;
    class RateLimitPM implements ProcessManager {
      async spawn(_opts: SpawnOpts): Promise<SpawnHandle> {
        spawnCount++;
        // Emit the rate-limit line, then stall (no exit record) — the scheduler
        // must call cancel() after firing the rate_limit_detected transition.
        const handle = new StubSpawnHandle([
          { type: 'stdout', line: RATE_LIMIT_LINE },
        ]);
        handle.start();
        return handle;
      }
    }

    const { scheduler } = buildScheduler({
      config,
      processManager: new RateLimitPM(),
      pollIntervalMs: 50,
    });

    await scheduler.start();
    const workflowId = scheduler.workflowId!;
    const [item] = db.reader()
      .prepare('SELECT id FROM items WHERE workflow_id = ?')
      .all(workflowId) as { id: string }[];

    // Item should transition to rate_limited.
    await pollUntil(() => {
      const row = db.reader()
        .prepare('SELECT status FROM items WHERE id = ?')
        .get(item.id) as { status: string };
      return row.status === 'rate_limited';
    }, { timeoutMs: 10_000 });

    const row = db.reader()
      .prepare('SELECT status FROM items WHERE id = ?')
      .get(item.id) as { status: string };
    expect(row.status).toBe('rate_limited');

    // Wait briefly to confirm no second spawn occurs during the backoff window.
    await new Promise<void>((r) => setTimeout(r, 200));
    expect(spawnCount).toBe(1);

    await scheduler.stop();
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

// ---------------------------------------------------------------------------
// AC-2b: Capture mode — fixture file written during a live session
// ---------------------------------------------------------------------------

describe('AC-2b: capture mode', () => {
  it('writes a parseable fixture file when .yoke/record.json is present', async () => {
    // Enable capture mode: write the marker pointing to a fixture path.
    const capturePath = path.join(tmpDir, 'fixtures', 'capture-test.jsonl');
    runRecord({ cwd: tmpDir, capturePath });

    const processManager = new StubProcessManager([
      { type: 'stdout', line: '{"type":"text","text":"hello"}' },
      { type: 'stderr', chunk: 'warning: something\n' },
      { type: 'exit', code: 0 },
    ]);

    const config = makeConfig({ configDir: tmpDir });
    const { scheduler } = buildScheduler({ config, processManager, pollIntervalMs: 30 });
    await scheduler.start();

    const workflowId = scheduler.workflowId!;

    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(workflowId) as { status: string } | undefined;
      return wf?.status === 'completed';
    }, { timeoutMs: 10_000 });

    await scheduler.stop();

    // Fixture file must exist and be parseable.
    expect(fs.existsSync(capturePath)).toBe(true);
    const records = parseFixture(capturePath);

    // Must contain a stdout record for the line the stub emitted.
    expect(records).toContainEqual({ type: 'stdout', line: '{"type":"text","text":"hello"}' });
    // Must contain a stderr record.
    expect(records).toContainEqual({ type: 'stderr', chunk: 'warning: something\n' });
    // Must contain an exit record.
    expect(records.find((r) => r.type === 'exit')).toBeDefined();

    // Marker must be cleared after the session.
    const markerPath = path.join(tmpDir, '.yoke', 'record.json');
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('does not write a fixture when no .yoke/record.json exists', async () => {
    const config = makeConfig({ configDir: tmpDir });
    const processManager = new StubProcessManager([
      { type: 'stdout', line: '{"type":"text","text":"no-capture"}' },
      { type: 'exit', code: 0 },
    ]);

    const { scheduler } = buildScheduler({ config, processManager, pollIntervalMs: 30 });
    await scheduler.start();

    const workflowId = scheduler.workflowId!;

    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(workflowId) as { status: string } | undefined;
      return wf?.status === 'completed';
    }, { timeoutMs: 10_000 });

    await scheduler.stop();

    // No .yoke/fixtures directory should have been created.
    const fixturesDir = path.join(tmpDir, '.yoke', 'fixtures');
    expect(fs.existsSync(fixturesDir)).toBe(false);
  });

  it('captured fixture replays via ScriptedProcessManager with identical event sequence (RC-2)', async () => {
    // Set up capture mode.
    const capturePath = path.join(tmpDir, 'fixtures', 'replay-test.jsonl');
    runRecord({ cwd: tmpDir, capturePath });

    const emittedLines = [
      '{"type":"text","text":"step-one"}',
      '{"type":"text","text":"step-two"}',
    ];

    const processManager = new StubProcessManager([
      { type: 'stdout', line: emittedLines[0] },
      { type: 'stdout', line: emittedLines[1] },
      { type: 'exit', code: 0 },
    ]);

    const config = makeConfig({ configDir: tmpDir });
    const { scheduler } = buildScheduler({ config, processManager, pollIntervalMs: 30 });
    await scheduler.start();

    const workflowId = scheduler.workflowId!;
    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(workflowId) as { status: string } | undefined;
      return wf?.status === 'completed';
    }, { timeoutMs: 10_000 });

    await scheduler.stop();

    // Fixture file must exist.
    expect(fs.existsSync(capturePath)).toBe(true);

    // Replay via ScriptedProcessManager and collect events.
    const { ScriptedProcessManager } = await import('../../src/server/process/scripted-manager.js');
    const mgr = new ScriptedProcessManager({ fixturePath: capturePath });
    const handle = await mgr.spawn({ command: 'claude', args: [], cwd: '/tmp', promptBuffer: '' });

    const replayedLines: string[] = [];
    handle.on('stdout_line', (l) => replayedLines.push(l));

    const exitCode = await new Promise<number | null>((r) =>
      handle.once('exit', (code) => r(code)),
    );

    // Replayed event sequence must match what was originally emitted.
    expect(replayedLines).toEqual(emittedLines);
    expect(exitCode).toBe(0);
  });

  it('clearRecordMarker is called even when the session exits non-zero (AC-2 error path)', async () => {
    // Set up capture mode.
    const capturePath = path.join(tmpDir, 'fixtures', 'fail-capture.jsonl');
    runRecord({ cwd: tmpDir, capturePath });

    const processManager = new StubProcessManager([
      { type: 'stdout', line: '{"type":"text","text":"hello"}' },
      { type: 'exit', code: 1 },
    ]);

    const config = makeConfig({ configDir: tmpDir });
    const { scheduler } = buildScheduler({ config, processManager, pollIntervalMs: 30 });
    await scheduler.start();

    const workflowId = scheduler.workflowId!;
    // Non-zero exit + empty stderr → classifier=unknown → awaiting_user
    // (no transient pattern → no retry budget path).
    await pollUntil(() => {
      const item = db.reader()
        .prepare('SELECT status FROM items WHERE workflow_id = ?')
        .get(workflowId) as { status: string } | undefined;
      return item?.status === 'awaiting_user';
    }, { timeoutMs: 10_000 });

    await scheduler.stop();

    // Marker must be cleared even after a non-zero session exit.
    const markerPath = path.join(tmpDir, '.yoke', 'record.json');
    expect(fs.existsSync(markerPath)).toBe(false);

    // Fixture file must contain the emitted stdout line and an exit record.
    expect(fs.existsSync(capturePath)).toBe(true);
    const records = parseFixture(capturePath);
    expect(records).toContainEqual({ type: 'stdout', line: '{"type":"text","text":"hello"}' });
    expect(records.find((r) => r.type === 'exit')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-6: prepost_runs rows written atomically with state transition
// ---------------------------------------------------------------------------

describe('AC-6: prepost_runs rows persisted (AC-6, RC-4)', () => {
  it('writes one prepost_runs row per pre command when pre succeeds and session completes', async () => {
    // Phase must declare a pre command so the scheduler calls prepostRunner.
    const config = makeConfig({
      phases: {
        'phase-one': {
          command: 'claude',
          args: ['--output-format', 'stream-json'],
          prompt_template: 'Do the thing.',
          pre: [{ name: 'lint', run: ['./lint.sh'], actions: { '0': 'continue', '*': 'stop' } }],
        },
      },
    });

    const pm = new StubProcessManager([{ type: 'exit', code: 0 }]);

    // Pre runner produces a record mimicking what runCommands would return.
    const preRunRecord = {
      commandName: 'lint',
      argv: ['./lint.sh'],
      when: 'pre' as const,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 0,
      actionTaken: 'continue' as const,
      output: '',
    };

    const sched = new Scheduler({
      db,
      config,
      processManager: pm,
      worktreeManager: makeWorktreeManager(),
      prepostRunner: async (opts) => {
        if (opts.when === 'pre') {
          return { kind: 'complete' as const, runs: [preRunRecord] };
        }
        return { kind: 'complete' as const, runs: [] };
      },
      assemblePrompt: async () => 'stub prompt',
      broadcast: () => {},
      pollIntervalMs: 50,
      gracePeriodMs: 500,
    });
    activeSchedulers.push(sched);

    await sched.start();
    const workflowId = sched.workflowId!;

    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(workflowId) as { status: string } | undefined;
      return wf?.status === 'completed';
    }, { timeoutMs: 10_000 });

    // One prepost_runs row must exist for the pre command.
    const rows = db.reader()
      .prepare('SELECT * FROM prepost_runs WHERE workflow_id = ?')
      .all(workflowId) as {
        command_name: string;
        when_phase: string;
        argv: string;
        exit_code: number | null;
        action_taken: string | null;
      }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].command_name).toBe('lint');
    expect(rows[0].when_phase).toBe('pre');
    expect(JSON.parse(rows[0].argv)).toEqual(['./lint.sh']);
    expect(rows[0].exit_code).toBe(0);
    expect(JSON.parse(rows[0].action_taken!)).toBe('continue');

    await sched.stop();
  }, 15_000);

  it('writes prepost_runs rows for pre commands when pre_command_failed fires', async () => {
    // Phase must declare a pre command so the scheduler calls prepostRunner.
    const config = makeConfig({
      phases: {
        'phase-one': {
          command: 'claude',
          args: ['--output-format', 'stream-json'],
          prompt_template: 'Do the thing.',
          pre: [{ name: 'check', run: ['./check.sh'], actions: { '0': 'continue', '*': 'stop-and-ask' } }],
        },
      },
    });

    const preRunRecord = {
      commandName: 'check',
      argv: ['./check.sh'],
      when: 'pre' as const,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 1,
      actionTaken: 'stop-and-ask' as const,
      output: '',
    };

    let spawnCount = 0;
    class SpyPM2 implements ProcessManager {
      async spawn(_opts: SpawnOpts): Promise<SpawnHandle> {
        spawnCount++;
        const h = new StubSpawnHandle([{ type: 'exit', code: 0 }]);
        h.start();
        return h;
      }
    }

    const sched = new Scheduler({
      db,
      config,
      processManager: new SpyPM2(),
      worktreeManager: makeWorktreeManager(),
      prepostRunner: async (opts) => {
        if (opts.when === 'pre') {
          return {
            kind: 'action' as const,
            command: 'check',
            action: 'stop-and-ask' as const,
            runs: [preRunRecord],
          };
        }
        return { kind: 'complete' as const, runs: [] };
      },
      assemblePrompt: async () => 'stub prompt',
      broadcast: () => {},
      pollIntervalMs: 50,
      gracePeriodMs: 500,
    });
    activeSchedulers.push(sched);

    await sched.start();
    const workflowId = sched.workflowId!;
    const [item] = db.reader()
      .prepare('SELECT id FROM items WHERE workflow_id = ?')
      .all(workflowId) as { id: string }[];

    await pollUntil(() => {
      const row = db.reader()
        .prepare('SELECT status FROM items WHERE id = ?')
        .get(item.id) as { status: string };
      return row.status === 'awaiting_user';
    }, { timeoutMs: 10_000 });

    // Spawn must never have been called.
    expect(spawnCount).toBe(0);

    // The pre command run must appear in prepost_runs even though spawn never fired.
    const rows = db.reader()
      .prepare('SELECT * FROM prepost_runs WHERE workflow_id = ?')
      .all(workflowId) as {
        command_name: string;
        when_phase: string;
        exit_code: number | null;
        action_taken: string | null;
      }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].command_name).toBe('check');
    expect(rows[0].when_phase).toBe('pre');
    expect(rows[0].exit_code).toBe(1);
    expect(JSON.parse(rows[0].action_taken!)).toBe('stop-and-ask');

    await sched.stop();
  }, 15_000);

  it('writes prepost_runs rows for post commands alongside session_ok transition', async () => {
    // Phase must declare a post command so the scheduler calls prepostRunner.
    const config = makeConfig({
      phases: {
        'phase-one': {
          command: 'claude',
          args: ['--output-format', 'stream-json'],
          prompt_template: 'Do the thing.',
          post: [{ name: 'verify', run: ['./verify.sh'], actions: { '0': 'continue', '*': 'stop' } }],
        },
      },
    });

    const pm = new StubProcessManager([{ type: 'exit', code: 0 }]);

    const postRunRecord = {
      commandName: 'verify',
      argv: ['./verify.sh'],
      when: 'post' as const,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 0,
      actionTaken: 'continue' as const,
      output: '',
    };

    const sched = new Scheduler({
      db,
      config,
      processManager: pm,
      worktreeManager: makeWorktreeManager(),
      prepostRunner: async (opts) => {
        if (opts.when === 'post') {
          return { kind: 'complete' as const, runs: [postRunRecord] };
        }
        return { kind: 'complete' as const, runs: [] };
      },
      assemblePrompt: async () => 'stub prompt',
      broadcast: () => {},
      pollIntervalMs: 50,
      gracePeriodMs: 500,
    });
    activeSchedulers.push(sched);

    await sched.start();
    const workflowId = sched.workflowId!;

    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(workflowId) as { status: string } | undefined;
      return wf?.status === 'completed';
    }, { timeoutMs: 10_000 });

    const rows = db.reader()
      .prepare('SELECT * FROM prepost_runs WHERE workflow_id = ?')
      .all(workflowId) as {
        command_name: string;
        when_phase: string;
        exit_code: number | null;
        action_taken: string | null;
      }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].command_name).toBe('verify');
    expect(rows[0].when_phase).toBe('post');
    expect(rows[0].exit_code).toBe(0);

    await sched.stop();
  }, 15_000);
});

// ---------------------------------------------------------------------------
// feat-artifact-validators: artifact validation wiring in _runSession
// ---------------------------------------------------------------------------

/**
 * Build a scheduler with an injectable artifact validator and a minimal
 * process manager that exits cleanly.
 */
function buildValidatorScheduler(opts: {
  artifactValidator: ArtifactValidatorFn;
  postRunnerSpy?: { called: boolean };
  config?: ResolvedConfig;
}): TestSchedulerResult {
  const broadcasts: TestSchedulerResult['broadcasts'] = [];

  const scheduler = new Scheduler({
    db,
    config: opts.config ?? makeConfig(),
    processManager: new StubProcessManager([{ type: 'exit', code: 0 }]),
    worktreeManager: makeWorktreeManager(),
    prepostRunner: async () => {
      if (opts.postRunnerSpy) opts.postRunnerSpy.called = true;
      return { kind: 'complete', runs: [] };
    },
    assemblePrompt: async () => 'stub prompt',
    artifactValidator: opts.artifactValidator,
    broadcast: (workflowId, sessionId, frameType, payload) => {
      broadcasts.push({ workflowId, sessionId, frameType, payload });
    },
    maxParallel: 4,
    pollIntervalMs: 50,
    gracePeriodMs: 500,
  });

  activeSchedulers.push(scheduler);
  return { scheduler, broadcasts };
}

describe('feat-artifact-validators: scheduler wiring', () => {
  // AV-1: validators pass → workflow completes normally.
  it('AV-1: validators_ok → item reaches completed', async () => {
    const { scheduler } = buildValidatorScheduler({
      artifactValidator: async () => ({ kind: 'validators_ok' }),
    });

    await scheduler.start();
    const workflowId = scheduler.workflowId!;

    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(workflowId) as { status: string } | undefined;
      return wf?.status === 'completed';
    }, { timeoutMs: 10_000 });

    const item = db.reader()
      .prepare('SELECT status FROM items WHERE workflow_id = ?')
      .get(workflowId) as { status: string } | undefined;
    expect(item?.status).toBe('complete');
  }, 15_000);

  // AV-2: validators fail → item transitions to awaiting_retry (budget > 0).
  it('AV-2: validator_fail → item enters awaiting_retry', async () => {
    const { scheduler } = buildValidatorScheduler({
      artifactValidator: async () => ({
        kind: 'validator_fail',
        failures: [
          {
            artifactPath: 'output.json',
            schemaId: 'https://example.com/schemas/test',
            errors: [
              {
                instancePath: '',
                schemaPath: '#/required',
                keyword: 'required',
                params: { missingProperty: 'name' },
                message: 'must have required property name',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any,
            ],
          },
        ],
      }),
    });

    await scheduler.start();
    const workflowId = scheduler.workflowId!;

    await pollUntil(() => {
      const item = db.reader()
        .prepare('SELECT status FROM items WHERE workflow_id = ?')
        .get(workflowId) as { status: string } | undefined;
      // Item should be awaiting_retry (default retry ladder has budget)
      return item?.status === 'awaiting_retry';
    }, { timeoutMs: 10_000 });

    const item = db.reader()
      .prepare('SELECT status, retry_count FROM items WHERE workflow_id = ?')
      .get(workflowId) as { status: string; retry_count: number } | undefined;
    expect(item?.status).toBe('awaiting_retry');
    expect(item?.retry_count).toBeGreaterThan(0);
  }, 15_000);

  // AV-3: validator_fail → post commands NOT called.
  it('AV-3: validator_fail → post runner is not invoked', async () => {
    const spy = { called: false };

    const { scheduler } = buildValidatorScheduler({
      artifactValidator: async () => ({
        kind: 'validator_fail',
        failures: [
          {
            artifactPath: 'missing.json',
            schemaId: 'missing.json',
            errors: [
              {
                instancePath: '',
                schemaPath: '#',
                keyword: 'required',
                params: {},
                message: 'required artifact not found on disk: missing.json',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any,
            ],
          },
        ],
      }),
      postRunnerSpy: spy,
      config: makeConfig({
        phases: {
          'phase-one': {
            command: 'claude',
            args: ['--output-format', 'stream-json'],
            prompt_template: 'Do the thing.',
            post: [
              {
                name: 'verify',
                run: ['true'],
                actions: { '*': 'continue' },
              },
            ],
          },
        },
      }),
    });

    await scheduler.start();
    const workflowId = scheduler.workflowId!;

    await pollUntil(() => {
      const item = db.reader()
        .prepare('SELECT status FROM items WHERE workflow_id = ?')
        .get(workflowId) as { status: string } | undefined;
      return item?.status === 'awaiting_retry';
    }, { timeoutMs: 10_000 });

    // The post runner spy must NOT have been called.
    expect(spy.called).toBe(false);
  }, 15_000);

  // AV-4: artifact validator called with the correct artifacts and worktreePath.
  it('AV-4: validator receives phase output_artifacts and worktreePath', async () => {
    let capturedArtifacts: import('../../src/shared/types/config.js').OutputArtifact[] | null = null;
    let capturedWorktreePath: string | null = null;
    const wt = path.join(tmpDir, 'wt');
    fs.mkdirSync(wt, { recursive: true });

    const config = makeConfig({
      phases: {
        'phase-one': {
          command: 'claude',
          args: ['--output-format', 'stream-json'],
          prompt_template: 'Do the thing.',
          output_artifacts: [
            { path: 'output.json', schema: '/tmp/schema.json', required: false },
          ],
        },
      },
    });

    const scheduler = new Scheduler({
      db,
      config,
      processManager: new StubProcessManager([{ type: 'exit', code: 0 }]),
      worktreeManager: {
        async createWorktree(): Promise<{ branchName: string; worktreePath: string }> {
          return { branchName: 'yoke/test', worktreePath: wt };
        },
        async runBootstrap(): Promise<{ type: string }> {
          return { type: 'bootstrap_ok' };
        },
        async cleanup(): Promise<{ worktreeRemoved: boolean; branchRetained: boolean }> {
          return { worktreeRemoved: true, branchRetained: false };
        },
      } as unknown as import('../../src/server/worktree/manager.js').WorktreeManager,
      prepostRunner: async () => ({ kind: 'complete', runs: [] }),
      assemblePrompt: async () => 'stub prompt',
      artifactValidator: async (artifacts, worktreePath) => {
        capturedArtifacts = artifacts;
        capturedWorktreePath = worktreePath;
        return { kind: 'validators_ok' };
      },
      broadcast: () => {},
      maxParallel: 4,
      pollIntervalMs: 50,
      gracePeriodMs: 500,
    });
    activeSchedulers.push(scheduler);

    await scheduler.start();
    const workflowId = scheduler.workflowId!;

    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(workflowId) as { status: string } | undefined;
      return wf?.status === 'completed';
    }, { timeoutMs: 10_000 });

    expect(capturedArtifacts).not.toBeNull();
    expect(capturedArtifacts).toHaveLength(1);
    expect(capturedArtifacts![0].path).toBe('output.json');
    // worktreePath is the worktree directory, not the configDir
    expect(capturedWorktreePath).toBe(wt);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// feat-hook-contract: scheduler wiring (diff check + manifest reader)
// ---------------------------------------------------------------------------

/**
 * A process manager whose spawn() mutates a file in the worktree before
 * returning the handle.  This lets us simulate the items_from file changing
 * during a session without real process timing constraints.
 */
class FileMutatingProcessManager implements ProcessManager {
  constructor(
    private readonly absFilePath: string,
    private readonly newContent: string,
  ) {}

  async spawn(_opts: SpawnOpts): Promise<SpawnHandle> {
    fs.writeFileSync(this.absFilePath, this.newContent, 'utf8');
    const handle = new StubSpawnHandle([{ type: 'exit', code: 0 }]);
    handle.start();
    return handle;
  }
}

describe('feat-hook-contract: diff_check_fail scheduler wiring', () => {
  it('HC-1: diff_check_fail → item enters awaiting_retry when items_from changes', async () => {
    const wt = path.join(tmpDir, 'wt');
    fs.mkdirSync(wt, { recursive: true });

    const itemsFromPath = 'items.json';
    // Write the file BEFORE the scheduler starts so takeSnapshot captures it.
    fs.writeFileSync(path.join(wt, itemsFromPath), '["original"]', 'utf8');

    const config = makeConfig({
      pipeline: {
        stages: [
          {
            id: 'stage-alpha',
            run: 'once',
            phases: ['phase-one'],
            items_from: itemsFromPath,
          },
        ],
      },
    });

    // PM writes new content to items.json inside spawn() — after takeSnapshot,
    // before checkDiff — simulating the agent modifying the file.
    const pm = new FileMutatingProcessManager(
      path.join(wt, itemsFromPath),
      '["original","added-by-session"]',
    );

    const sched = new Scheduler({
      db,
      config,
      processManager: pm,
      worktreeManager: {
        async createWorktree() { return { branchName: 'yoke/test', worktreePath: wt }; },
        async runBootstrap() { return { type: 'bootstrap_ok' }; },
        async cleanup() { return { worktreeRemoved: true, branchRetained: false }; },
      } as unknown as import('../../src/server/worktree/manager.js').WorktreeManager,
      prepostRunner: async () => ({ kind: 'complete', runs: [] }),
      assemblePrompt: async () => 'stub prompt',
      artifactValidator: async () => ({ kind: 'validators_ok' }),
      broadcast: () => {},
      pollIntervalMs: 50,
      gracePeriodMs: 500,
    });
    activeSchedulers.push(sched);

    await sched.start();
    const workflowId = sched.workflowId!;
    const [item] = db.reader()
      .prepare('SELECT id FROM items WHERE workflow_id = ?')
      .all(workflowId) as { id: string }[];

    // Item must reach awaiting_retry or awaiting_user (diff_check_fail → retry ladder).
    await pollUntil(() => {
      const row = db.reader()
        .prepare('SELECT status FROM items WHERE id = ?')
        .get(item.id) as { status: string };
      return ['awaiting_retry', 'awaiting_user'].includes(row.status);
    }, { timeoutMs: 10_000 });

    const row = db.reader()
      .prepare('SELECT status FROM items WHERE id = ?')
      .get(item.id) as { status: string };
    expect(['awaiting_retry', 'awaiting_user']).toContain(row.status);
    // Must NOT have completed — diff check failed.
    expect(row.status).not.toBe('complete');

    await sched.stop();
  }, 15_000);

  it('HC-2: diff_check_ok → workflow completes when items_from file unchanged', async () => {
    const wt = path.join(tmpDir, 'wt');
    fs.mkdirSync(wt, { recursive: true });

    const itemsFromPath = 'items.json';
    fs.writeFileSync(path.join(wt, itemsFromPath), '["unchanged"]', 'utf8');

    const config = makeConfig({
      pipeline: {
        stages: [
          {
            id: 'stage-alpha',
            run: 'once',
            phases: ['phase-one'],
            items_from: itemsFromPath,
          },
        ],
      },
    });

    // PM does NOT touch the items_from file → diff_check_ok path.
    const pm = new StubProcessManager([{ type: 'exit', code: 0 }]);

    const sched = new Scheduler({
      db,
      config,
      processManager: pm,
      worktreeManager: {
        async createWorktree() { return { branchName: 'yoke/test', worktreePath: wt }; },
        async runBootstrap() { return { type: 'bootstrap_ok' }; },
        async cleanup() { return { worktreeRemoved: true, branchRetained: false }; },
      } as unknown as import('../../src/server/worktree/manager.js').WorktreeManager,
      prepostRunner: async () => ({ kind: 'complete', runs: [] }),
      assemblePrompt: async () => 'stub prompt',
      artifactValidator: async () => ({ kind: 'validators_ok' }),
      broadcast: () => {},
      pollIntervalMs: 50,
      gracePeriodMs: 500,
    });
    activeSchedulers.push(sched);

    await sched.start();
    const workflowId = sched.workflowId!;

    // Workflow must complete normally.
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

    await sched.stop();
  }, 15_000);
});

describe('feat-hook-contract: last-check.json manifest warnings', () => {
  it('HC-4: malformed manifest → stream.system_notice{source:"hook",severity:"warn"} broadcast (AC-5)', async () => {
    const wt = path.join(tmpDir, 'wt');
    fs.mkdirSync(path.join(wt, '.yoke'), { recursive: true });

    // Write a malformed manifest (invalid JSON) BEFORE the session.
    fs.writeFileSync(path.join(wt, '.yoke', 'last-check.json'), 'NOT-JSON!!!', 'utf8');

    const broadcasts: Array<{ workflowId: string; sessionId: string | null; frameType: string; payload: unknown }> = [];
    const pm = new StubProcessManager([{ type: 'exit', code: 0 }]);

    const sched = new Scheduler({
      db,
      config: makeConfig(),
      processManager: pm,
      worktreeManager: {
        async createWorktree() { return { branchName: 'yoke/test', worktreePath: wt }; },
        async runBootstrap() { return { type: 'bootstrap_ok' }; },
        async cleanup() { return { worktreeRemoved: true, branchRetained: false }; },
      } as unknown as import('../../src/server/worktree/manager.js').WorktreeManager,
      prepostRunner: async () => ({ kind: 'complete', runs: [] }),
      assemblePrompt: async () => 'stub prompt',
      artifactValidator: async () => ({ kind: 'validators_ok' }),
      broadcast: (workflowId, sessionId, frameType, payload) => {
        broadcasts.push({ workflowId, sessionId, frameType, payload });
      },
      pollIntervalMs: 50,
      gracePeriodMs: 500,
    });
    activeSchedulers.push(sched);

    await sched.start();
    const workflowId = sched.workflowId!;

    // Workflow must still complete — malformed manifest must not block acceptance (RC-3).
    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(workflowId) as { status: string } | undefined;
      return wf?.status === 'completed';
    }, { timeoutMs: 10_000 });

    // stream.system_notice must have been broadcast with source:"hook", severity:"warn".
    const notices = broadcasts.filter((b) => b.frameType === 'stream.system_notice');
    const hookNotice = notices.find((b) => {
      const p = b.payload as Record<string, unknown>;
      return p['source'] === 'hook' && p['severity'] === 'warn';
    });
    expect(hookNotice).toBeDefined();

    // Workflow must still be completed — manifest didn't block acceptance.
    const wf = db.reader()
      .prepare('SELECT status FROM workflows WHERE id = ?')
      .get(workflowId) as { status: string };
    expect(wf.status).toBe('completed');

    await sched.stop();
  }, 15_000);

  it('HC-5: unknown hook_version → stream.system_notice with rawJson, session still completes (AC-6)', async () => {
    const wt = path.join(tmpDir, 'wt');
    fs.mkdirSync(path.join(wt, '.yoke'), { recursive: true });

    const manifestContent = JSON.stringify({ hook_version: '99', note: 'future version' });
    fs.writeFileSync(path.join(wt, '.yoke', 'last-check.json'), manifestContent, 'utf8');

    const broadcasts: Array<{ workflowId: string; sessionId: string | null; frameType: string; payload: unknown }> = [];
    const pm = new StubProcessManager([{ type: 'exit', code: 0 }]);

    const sched = new Scheduler({
      db,
      config: makeConfig(),
      processManager: pm,
      worktreeManager: {
        async createWorktree() { return { branchName: 'yoke/test', worktreePath: wt }; },
        async runBootstrap() { return { type: 'bootstrap_ok' }; },
        async cleanup() { return { worktreeRemoved: true, branchRetained: false }; },
      } as unknown as import('../../src/server/worktree/manager.js').WorktreeManager,
      prepostRunner: async () => ({ kind: 'complete', runs: [] }),
      assemblePrompt: async () => 'stub prompt',
      artifactValidator: async () => ({ kind: 'validators_ok' }),
      broadcast: (workflowId, sessionId, frameType, payload) => {
        broadcasts.push({ workflowId, sessionId, frameType, payload });
      },
      pollIntervalMs: 50,
      gracePeriodMs: 500,
    });
    activeSchedulers.push(sched);

    await sched.start();
    const workflowId = sched.workflowId!;

    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(workflowId) as { status: string } | undefined;
      return wf?.status === 'completed';
    }, { timeoutMs: 10_000 });

    // stream.system_notice with source:"hook", severity:"warn", and rawJson.
    const notices = broadcasts.filter((b) => b.frameType === 'stream.system_notice');
    const hookNotice = notices.find((b) => {
      const p = b.payload as Record<string, unknown>;
      return p['source'] === 'hook' && p['severity'] === 'warn';
    });
    expect(hookNotice).toBeDefined();
    if (hookNotice) {
      const p = hookNotice.payload as Record<string, unknown>;
      expect(p['rawJson']).toBe(manifestContent);
      expect(String(p['message'])).toMatch(/99/); // hookVersion "99" in the message
    }

    // Session still completes — manifest did not block acceptance.
    const wf = db.reader()
      .prepare('SELECT status FROM workflows WHERE id = ?')
      .get(workflowId) as { status: string };
    expect(wf.status).toBe('completed');

    await sched.stop();
  }, 15_000);
});

// ---------------------------------------------------------------------------
// feat-pipeline-hardening: restart with awaiting_retry items
// ---------------------------------------------------------------------------

describe('feat-pipeline-hardening: restart with awaiting_retry items', () => {
  it('backoff_elapsed fires for awaiting_retry items after scheduler restart', async () => {
    const config = makeConfig();

    // Ingest workflow and manually set the item to awaiting_retry.
    const { workflowId } = ingestWorkflow(db, config);
    const items = db.reader()
      .prepare('SELECT id FROM items WHERE workflow_id = ?')
      .all(workflowId) as { id: string }[];
    const itemId = items.find(i => {
      const row = db.reader().prepare('SELECT stage_id FROM items WHERE id = ?').get(i.id) as { stage_id: string };
      return row.stage_id !== 'plan' || items.length === 1;
    })!.id;

    // Set item to awaiting_retry with retry_count=1 and a worktree path.
    db.writer.prepare(`UPDATE items SET status = 'awaiting_retry', retry_count = 1, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), itemId);
    db.writer.prepare(`UPDATE workflows SET worktree_path = ?, updated_at = ? WHERE id = ?`)
      .run(path.join(tmpDir, 'wt'), new Date().toISOString(), workflowId);
    // Ensure worktree dir exists for the session.
    fs.mkdirSync(path.join(tmpDir, 'wt'), { recursive: true });

    // Start a fresh scheduler (simulating restart — retryAfterAt map is empty).
    const { scheduler } = buildScheduler({ config, pollIntervalMs: 50 });
    await scheduler.start();

    // The scheduler should see awaiting_retry, arm retryAfterAt, then fire
    // backoff_elapsed after the backoff elapses (15s for retry_count=1, but
    // in tests the session spawn completes immediately so we watch for the
    // item to leave awaiting_retry).
    await pollUntil(() => {
      const status = db.reader()
        .prepare('SELECT status FROM items WHERE id = ?')
        .get(itemId) as { status: string };
      return status.status !== 'awaiting_retry';
    }, { timeoutMs: 25_000 });

    const finalStatus = db.reader()
      .prepare('SELECT status FROM items WHERE id = ?')
      .get(itemId) as { status: string };
    // After backoff_elapsed the item should have advanced (in_progress or complete).
    expect(['in_progress', 'complete', 'awaiting_user']).toContain(finalStatus.status);

    await scheduler.stop();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// feat-pipeline-hardening: two-phase workflow
// ---------------------------------------------------------------------------

describe('feat-pipeline-hardening: two-phase workflow', () => {
  it('advances current_phase from phase-a to phase-b and completes', async () => {
    const config = makeConfig({
      pipeline: {
        stages: [
          { id: 'stage-alpha', run: 'once' as const, phases: ['phase-a', 'phase-b'] },
        ],
      },
      phases: {
        'phase-a': {
          command: 'claude',
          args: ['--output-format', 'stream-json'],
          prompt_template: 'Do phase A.',
        },
        'phase-b': {
          command: 'claude',
          args: ['--output-format', 'stream-json'],
          prompt_template: 'Do phase B.',
        },
      },
    });

    const { workflowId } = ingestWorkflow(db, config);
    const { scheduler, broadcasts } = buildScheduler({ config, pollIntervalMs: 50 });
    await scheduler.start();

    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(workflowId) as { status: string };
      return wf.status === 'completed';
    }, { timeoutMs: 15_000 });

    // Verify the workflow completed.
    const wf = db.reader()
      .prepare('SELECT status FROM workflows WHERE id = ?')
      .get(workflowId) as { status: string };
    expect(wf.status).toBe('completed');

    // Verify the item went through both phases: there should be session records
    // for both phase-a and phase-b.
    const sessions = db.reader()
      .prepare(`SELECT phase FROM sessions WHERE workflow_id = ? ORDER BY started_at`)
      .all(workflowId) as { phase: string }[];
    const phases = sessions.map(s => s.phase);
    expect(phases).toContain('phase-a');
    expect(phases).toContain('phase-b');

    // Verify item.state broadcasts show phase advancement.
    const itemStates = broadcasts.filter(b => b.frameType === 'item.state');
    const phaseValues = itemStates.map(b => (b.payload as Record<string, unknown>).state)
      .map(s => (s as Record<string, unknown>).currentPhase);
    expect(phaseValues).toContain('phase-b');

    await scheduler.stop();
  }, 20_000);
});

// ---------------------------------------------------------------------------
// feat-pipeline-hardening AC-9: post_command_action goto → handoff injection → re-spawn
// ---------------------------------------------------------------------------

describe('feat-pipeline-hardening: post_command_action goto injects handoff entry and re-spawns', () => {
  it('goto action writes hook-failure entry to handoff.json and item completes on next session', async () => {
    const worktreePath = path.join(tmpDir, 'wt');
    const config = makeConfig({
      pipeline: {
        stages: [{ id: 'stage-alpha', run: 'once' as const, phases: ['phase-impl'] }],
      },
      phases: {
        'phase-impl': {
          command: 'claude',
          args: ['--output-format', 'stream-json'],
          prompt_template: 'Do the thing.',
          // Post command triggers the runner so post_command_action fires.
          post: [{ name: 'run-check', run: ['echo', 'checking'], actions: {} as never }],
        },
      },
    });

    let postCallCount = 0;

    const sched = new Scheduler({
      db,
      config,
      processManager: new StubProcessManager([{ type: 'exit', code: 0 }]),
      worktreeManager: makeWorktreeManager({ worktreePath }),
      prepostRunner: async (opts) => {
        if (opts.when !== 'post') return { kind: 'complete' as const, runs: [] };
        postCallCount++;
        if (postCallCount === 1) {
          // First post run: goto action with captured output so injectHookFailure fires.
          return {
            kind: 'action' as const,
            command: 'run-check',
            action: { goto: 'phase-impl', max_revisits: 3 },
            runs: [{
              commandName: 'run-check',
              argv: ['echo', 'checking'],
              when: 'post' as const,
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              exitCode: 1,
              actionTaken: null,
              output: 'check failed: missing required changes',
            }],
          };
        }
        // Second+ post run: complete normally.
        return { kind: 'complete' as const, runs: [] };
      },
      assemblePrompt: async () => 'stub prompt',
      broadcast: () => {},
      pollIntervalMs: 50,
      gracePeriodMs: 500,
    });
    activeSchedulers.push(sched);

    await sched.start();
    const workflowId = sched.workflowId!;
    const [item] = db.reader()
      .prepare('SELECT id FROM items WHERE workflow_id = ?')
      .all(workflowId) as { id: string }[];

    // The goto re-spawns the session; item should eventually complete.
    await pollUntil(() => {
      const wf = db.reader()
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(workflowId) as { status: string };
      return wf.status === 'completed';
    }, { timeoutMs: 15_000 });

    const itemRow = db.reader()
      .prepare('SELECT status FROM items WHERE id = ?')
      .get(item.id) as { status: string };
    expect(itemRow.status).toBe('complete');

    // Post runner was invoked at least twice: once for goto, once for complete.
    expect(postCallCount).toBeGreaterThanOrEqual(2);

    // handoff.json must exist in the worktree with a hook-failure entry.
    const handoffPath = path.join(worktreePath, 'handoff.json');
    expect(fs.existsSync(handoffPath)).toBe(true);
    const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8')) as Record<string, unknown>;
    expect(Array.isArray(handoff.entries)).toBe(true);
    const entries = handoff.entries as Array<Record<string, unknown>>;
    const hookEntry = entries.find(e => typeof e.phase === 'string' && e.phase.includes('hook-failure'));
    expect(hookEntry).toBeDefined();
    expect(hookEntry!.harness_injected).toBe(true);
    expect(hookEntry!.command).toBe('run-check');
    const issues = hookEntry!.blocking_issues as string[];
    expect(issues[0]).toContain('check failed: missing required changes');

    await sched.stop();
  }, 20_000);
});
