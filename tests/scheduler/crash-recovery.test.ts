/**
 * Crash-recovery integration tests for Scheduler + FaultInjector.
 *
 * Uses real SQLite (with migrations) and stub ProcessManager / WorktreeManager
 * so no real git, worktrees, or agent processes are required.
 *
 * Coverage (feat-fault-injector):
 *   AC-2  Fault injection at 'bootstrap_ok' triggers bootstrap_fail recovery path.
 *   AC-3  Fault injection at 'session_ok' triggers crash-recovery restart projection.
 *   AC-4a Stale PID at restart — buildCrashRecovery detects stale session → session_fail.
 *   AC-4b Item in_progress at restart — recovered via stale PID detection on new start.
 *   AC-4c Item rate_limited at restart — rate_limit_window_elapsed fired immediately
 *         when resetAt is unknown (new scheduler, no prior in-memory state).
 *   AC-5  All tests reference checkpoints by name (not positionally).
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
import { ActiveFaultInjector } from '../../src/server/fault/injector.js';
import type { ResolvedConfig } from '../../src/shared/types/config.js';

// ---------------------------------------------------------------------------
// Test infrastructure — mirrors scheduler.test.ts helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

let tmpDir: string;
let db: DbPool;
const activeSchedulers: Scheduler[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-crash-test-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));
  applyMigrations(db.writer, MIGRATIONS_DIR);
});

afterEach(async () => {
  for (const s of activeSchedulers) {
    await s.stop().catch(() => {});
  }
  activeSchedulers.length = 0;
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Minimal config factory
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    version: '1',
    configDir: tmpDir,
    template: { name: 'crash-test' },
    pipeline: {
      stages: [{ id: 'stage-alpha', run: 'once', phases: ['phase-one'] }],
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
// Stub SpawnHandle — controllable fake process
// ---------------------------------------------------------------------------

/** Fake PID that is guaranteed not to be a live OS process in tests. */
const FAKE_PID = 99877;

class StubSpawnHandle extends EventEmitter implements SpawnHandle {
  readonly pid = FAKE_PID;
  readonly pgid = FAKE_PID;
  private _alive = true;

  isAlive(): boolean { return this._alive; }

  async cancel(): Promise<void> {
    this._alive = false;
    setImmediate(() => this.emit('exit', null, 'SIGTERM'));
  }

  /** Emit a clean exit (exit code 0). */
  emitExit(code = 0): void {
    this._alive = false;
    setImmediate(() => this.emit('exit', code, null));
  }

  // SpawnHandle interface overloads.
  on(event: 'stdout_line', listener: (line: string) => void): this;
  on(event: 'stderr_data', listener: (chunk: string) => void): this;
  on(event: 'stderr_cap_reached', listener: () => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: import('../../src/server/process/manager.js').ProcessError) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, listener: (...args: any[]) => void): this { return super.on(event, listener); }

  once(event: 'stdout_line', listener: (line: string) => void): this;
  once(event: 'stderr_data', listener: (chunk: string) => void): this;
  once(event: 'stderr_cap_reached', listener: () => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (err: import('../../src/server/process/manager.js').ProcessError) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string | symbol, listener: (...args: any[]) => void): this { return super.once(event, listener); }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string | symbol, listener: (...args: any[]) => void): this { return super.off(event, listener); }
}

// ---------------------------------------------------------------------------
// Stub ProcessManager — controllable, collects handles
// ---------------------------------------------------------------------------

class ControlledProcessManager implements ProcessManager {
  readonly handles: StubSpawnHandle[] = [];

  async spawn(_opts: SpawnOpts): Promise<SpawnHandle> {
    const handle = new StubSpawnHandle();
    this.handles.push(handle);
    // Automatically emit exit(0) on the next tick so sessions complete.
    handle.emitExit(0);
    return handle;
  }
}

// ---------------------------------------------------------------------------
// Stub WorktreeManager
// ---------------------------------------------------------------------------

function makeWorktreeManager(opts: {
  bootstrapEvent?: BootstrapEvent;
} = {}): WorktreeManager {
  const wt = path.join(tmpDir, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  return {
    async createWorktree(): Promise<WorktreeInfo> {
      return { branchName: 'yoke/test-abc123', worktreePath: wt };
    },
    async runBootstrap(): Promise<BootstrapEvent> {
      return opts.bootstrapEvent ?? { type: 'bootstrap_ok' };
    },
    async cleanup(): Promise<{ worktreeRemoved: boolean; branchRetained: boolean }> {
      return { worktreeRemoved: true, branchRetained: false };
    },
  } as unknown as WorktreeManager;
}

// ---------------------------------------------------------------------------
// pollUntil — wait for SQLite condition
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
// Helper — build and start a Scheduler
// ---------------------------------------------------------------------------

function buildScheduler(opts: {
  config?: ResolvedConfig;
  processManager?: ProcessManager;
  worktreeManager?: WorktreeManager;
  faultInjector?: ConstructorParameters<typeof Scheduler>[0]['faultInjector'];
  pollIntervalMs?: number;
}): Scheduler {
  const s = new Scheduler({
    db,
    config: opts.config ?? makeConfig(),
    processManager: opts.processManager ?? new ControlledProcessManager(),
    worktreeManager: opts.worktreeManager ?? makeWorktreeManager(),
    prepostRunner: async () => ({ kind: 'complete', runs: [] }),
    assemblePrompt: async () => 'stub prompt',
    broadcast: () => {},
    maxParallel: 4,
    pollIntervalMs: opts.pollIntervalMs ?? 50,
    gracePeriodMs: 500,
    faultInjector: opts.faultInjector,
    artifactValidator: async () => ({ kind: 'validators_ok' as const }),
  });
  activeSchedulers.push(s);
  return s;
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

function readItemStatus(itemId: string): string | undefined {
  const row = db.reader()
    .prepare('SELECT status FROM items WHERE id = ?')
    .get(itemId) as { status: string } | undefined;
  return row?.status;
}

function readAllItems(workflowId: string): Array<{ id: string; status: string }> {
  return db.reader()
    .prepare('SELECT id, status FROM items WHERE workflow_id = ? ORDER BY rowid')
    .all(workflowId) as Array<{ id: string; status: string }>;
}

function readRunningSessionCount(workflowId: string): number {
  const row = db.reader()
    .prepare(`SELECT COUNT(*) AS cnt FROM sessions WHERE workflow_id = ? AND status = 'running'`)
    .get(workflowId) as { cnt: number };
  return row.cnt;
}

// ---------------------------------------------------------------------------
// AC-2: bootstrap_ok fault injection
//
// Removed: the bootstrap_ok fault checkpoint lived inside _doBootstrapThenSpawn,
// which is no longer on the hot path. Worktree creation + bootstrap run
// deterministically in Scheduler.start() via _ensureWorktree — a bootstrap
// failure there surfaces as a rejection from start() (see scheduler.test.ts
// "bootstrap_fail → scheduler.start() rejects …"), not an item-level state.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AC-3 / AC-4a / AC-4b: session_ok fault injection + crash recovery restart
// ---------------------------------------------------------------------------

describe('AC-3: session_ok fault injection → crash recovery restart', () => {
  it('stale PID detected on restart; item recovered via session_fail transition (AC-4a, AC-4b)', async () => {
    const config = makeConfig();

    // --- Phase 1: Scheduler with fault injector at 'session_ok' ---
    //
    // The session starts, the agent process exits 0, validators pass,
    // post commands pass, then check('session_ok') throws BEFORE
    // applyItemTransition('session_ok') is called.
    //
    // Result in SQLite:
    //   sessions row: status='running', pid=FAKE_PID (stale)
    //   items row:    status='in_progress'
    const fi = new ActiveFaultInjector(['session_ok']);
    const scheduler1 = buildScheduler({ config, faultInjector: fi });

    const { workflowId } = ingestWorkflow(db, config);
    await scheduler1.start();

    // Wait for the session row to appear (means spawn happened, PID written).
    await pollUntil(() => readRunningSessionCount(workflowId) > 0);

    // Wait for the fault to fire: the session row should stay 'running'
    // (session_ok was NOT committed) but the item stays 'in_progress'.
    // The handle emits exit(0) immediately, so by the time we see the
    // running session, the fault has already fired.
    await pollUntil(
      () => {
        const items = readAllItems(workflowId);
        const sessions = readRunningSessionCount(workflowId);
        // Fault fired: item still in_progress, session still 'running' (not ended).
        return items[0]?.status === 'in_progress' && sessions === 1;
      },
      { timeoutMs: 3000 },
    );

    // Stop the first scheduler.  It does NOT clean up the stale session row.
    await scheduler1.stop();

    // Sanity: session row is still 'running' — crash left it that way.
    expect(readRunningSessionCount(workflowId)).toBe(1);
    const items1 = readAllItems(workflowId);
    expect(items1[0].status).toBe('in_progress');

    // --- Phase 2: New Scheduler without fault injector (simulating restart) ---
    //
    // buildCrashRecovery probes FAKE_PID with kill(pid, 0).  Since FAKE_PID is
    // not a real OS process, ESRCH is thrown → session is stale.
    // Scheduler.start() fires session_fail on the stale session.
    // Item transitions to awaiting_retry (retry budget > 0) or awaiting_user.
    const scheduler2 = buildScheduler({ config });  // no fault injector
    await scheduler2.start();

    await pollUntil(() => {
      const s = readItemStatus(items1[0].id);
      return s === 'awaiting_retry' || s === 'awaiting_user' || s === 'complete';
    });

    const finalStatus = readItemStatus(items1[0].id);
    // Item must have exited 'in_progress' — crash recovery worked.
    expect(['awaiting_retry', 'awaiting_user', 'complete', 'ready']).toContain(finalStatus);

    // feat-pipeline-hardening: stale session rows are now ended during crash
    // recovery. The session should have status='failed' (no longer 'running')
    // so it does not count against maxParallel.
    expect(readRunningSessionCount(workflowId)).toBe(0);

    await scheduler2.stop();
  });
});

describe('feat-pipeline-hardening: stale sessions ended during crash recovery', () => {
  it('stale sessions have status=failed after crash recovery, not running', async () => {
    const config = makeConfig();
    const fi = new ActiveFaultInjector(['session_ok']);
    const scheduler1 = buildScheduler({ config, faultInjector: fi });

    const { workflowId } = ingestWorkflow(db, config);
    await scheduler1.start();

    // Wait for session to be created with 'running' status.
    await pollUntil(() => readRunningSessionCount(workflowId) > 0);
    // Wait for the fault to fire.
    await pollUntil(
      () => {
        const items = readAllItems(workflowId);
        return items[0]?.status === 'in_progress' && readRunningSessionCount(workflowId) === 1;
      },
      { timeoutMs: 3000 },
    );
    await scheduler1.stop();

    // Capture the session id for verification.
    const sessionsBefore = db.reader()
      .prepare(`SELECT id, status FROM sessions WHERE workflow_id = ?`)
      .all(workflowId) as { id: string; status: string }[];
    const staleSession = sessionsBefore.find(s => s.status === 'running');
    expect(staleSession).toBeDefined();

    // Start a new scheduler — crash recovery should end the stale session.
    const scheduler2 = buildScheduler({ config });
    await scheduler2.start();

    await pollUntil(() => {
      const s = readItemStatus(readAllItems(workflowId)[0].id);
      return s !== 'in_progress';
    });

    // The stale session must now be ended (status != 'running').
    const sessionsAfter = db.reader()
      .prepare(`SELECT id, status, ended_at FROM sessions WHERE id = ?`)
      .get(staleSession!.id) as { id: string; status: string; ended_at: string | null };
    expect(sessionsAfter.status).toBe('failed');
    expect(sessionsAfter.ended_at).not.toBeNull();

    // No more running sessions — concurrency is unblocked.
    expect(readRunningSessionCount(workflowId)).toBe(0);

    await scheduler2.stop();
  });
});

// ---------------------------------------------------------------------------
// AC-4c: rate_limited item at restart fires rate_limit_window_elapsed
// ---------------------------------------------------------------------------

describe('AC-4c: rate_limited item at restart', () => {
  it('rate_limited item with unknown resetAt is promoted to ready on new scheduler start', async () => {
    const config = makeConfig();

    // Seed the workflow so we have the ids.
    const { workflowId } = ingestWorkflow(db, config);
    const items = readAllItems(workflowId);
    const itemId = items[0].id;

    // Manually force item to 'rate_limited' without a known reset_at window.
    // This simulates a scheduler restart where the in-memory rateLimitResetAt
    // map was lost (new process, no persistent reset_at in the items table).
    db.writer
      .prepare(`UPDATE items SET status = 'rate_limited', updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), itemId);

    // Start a fresh scheduler (no fault injector, no prior in-memory state).
    // The tick sees 'rate_limited' + no resetAt entry → fires rate_limit_window_elapsed.
    const scheduler = buildScheduler({ config });
    await scheduler.start();

    // Item should advance from rate_limited → ready → in_progress → complete.
    await pollUntil(() => {
      const s = readItemStatus(itemId);
      return s === 'complete' || s === 'awaiting_retry' || s === 'awaiting_user';
    }, { timeoutMs: 5000 });

    const finalStatus = readItemStatus(itemId);
    // Item must have left 'rate_limited' — the elapsed handler fired.
    expect(finalStatus).not.toBe('rate_limited');
    expect(['complete', 'awaiting_retry', 'awaiting_user', 'ready', 'in_progress']).toContain(finalStatus);

    await scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Additional: NoopFaultInjector (default) leaves the happy path intact
// ---------------------------------------------------------------------------

describe('default (no fault injector): happy path completes normally', () => {
  it('item reaches complete without a fault injector', async () => {
    const config = makeConfig();
    const { workflowId } = ingestWorkflow(db, config);
    const items = readAllItems(workflowId);

    const scheduler = buildScheduler({ config });  // no faultInjector = NoopFaultInjector
    await scheduler.start();

    await pollUntil(() => readItemStatus(items[0].id) === 'complete', { timeoutMs: 5000 });

    expect(readItemStatus(items[0].id)).toBe('complete');
    await scheduler.stop();
  });
});
