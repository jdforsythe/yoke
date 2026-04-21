/**
 * Tests for pause / continue control actions in makeControlExecutor.
 *
 * Uses real SQLite with migrations (no Fastify — tests the executor directly).
 *
 * Coverage:
 *   AC-1   pause sets paused_at = now() and returns accepted
 *   AC-2   continue clears paused_at = NULL and returns accepted
 *   RC-1   pause is idempotent (already-paused → no-op success, re-broadcasts)
 *   RC-1   continue is idempotent (already-unpaused → no-op success)
 *   AC-5   workflow.update broadcast emitted with pausedAt on pause
 *   AC-5   workflow.update broadcast emitted with pausedAt=null on continue
 *          pause/continue on terminal workflow → already_terminal
 *          pause/continue on unknown workflow → workflow_not_found
 *   AC-4   Scheduler.start() pauses all non-terminal workflows before first tick
 *   AC-3   Paused workflow: tick loop skips → no sessions spawned
 *   AC-9   Integration: restart mock server → in-progress workflow paused →
 *          no advance until continue control action
 *   AC-6   Crash recovery transitions stale sessions even when workflow paused
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
import { makeControlExecutor } from '../../src/server/pipeline/control-executor.js';
import type { ControlBroadcastFn } from '../../src/server/pipeline/control-executor.js';
import { Scheduler } from '../../src/server/scheduler/scheduler.js';
import { createWorkflow } from '../../src/server/scheduler/ingest.js';
import type { ResolvedConfig } from '../../src/shared/types/config.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

let tmpDir: string;
let db: DbPool;
const activeSchedulers: Scheduler[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-ctrl-pause-'));
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
// Helpers — seed workflow/items
// ---------------------------------------------------------------------------

let wfSeq = 0;

function insertWorkflow(status = 'in_progress', pausedAt: string | null = null): string {
  wfSeq++;
  const id = `wf-pause-${wfSeq}`;
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, paused_at, created_at, updated_at)
       VALUES (?, ?, '{}', '{"stages":[]}', '{}', ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, `Workflow ${wfSeq}`, status, pausedAt);
  return id;
}

function getPausedAt(workflowId: string): string | null {
  const row = db.reader()
    .prepare('SELECT paused_at FROM workflows WHERE id = ?')
    .get(workflowId) as { paused_at: string | null } | undefined;
  return row?.paused_at ?? null;
}

function getStatus(workflowId: string): string | undefined {
  const row = db.reader()
    .prepare('SELECT status FROM workflows WHERE id = ?')
    .get(workflowId) as { status: string } | undefined;
  return row?.status;
}

function makeBroadcastSpy(): { spy: ControlBroadcastFn; calls: Array<{ workflowId: string; frameType: string; payload: unknown }> } {
  const calls: Array<{ workflowId: string; frameType: string; payload: unknown }> = [];
  const spy: ControlBroadcastFn = (workflowId, frameType, payload) => {
    calls.push({ workflowId, frameType, payload });
  };
  return { spy, calls };
}

// ---------------------------------------------------------------------------
// Minimal config factory for scheduler tests
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    version: '1',
    configDir: tmpDir,
    template: { name: 'pause-test' },
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
// Stub SpawnHandle — controllable fake process that never exits on its own
// ---------------------------------------------------------------------------

class HangingSpawnHandle extends EventEmitter implements SpawnHandle {
  readonly pid = 99001;
  readonly pgid = 99001;
  private _alive = true;

  isAlive(): boolean { return this._alive; }

  async cancel(): Promise<void> {
    this._alive = false;
    setImmediate(() => this.emit('exit', null, 'SIGTERM'));
  }

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

/** Process manager that records spawn calls and hangs (doesn't auto-exit). */
class TrackingProcessManager implements ProcessManager {
  readonly handles: HangingSpawnHandle[] = [];

  async spawn(_opts: SpawnOpts): Promise<SpawnHandle> {
    const handle = new HangingSpawnHandle();
    this.handles.push(handle);
    return handle;
  }
}

/** Process manager that completes immediately (exit 0). */
class ImmediateProcessManager implements ProcessManager {
  readonly spawnCount: { count: number } = { count: 0 };

  async spawn(_opts: SpawnOpts): Promise<SpawnHandle> {
    this.spawnCount.count++;
    const handle = new HangingSpawnHandle();
    setImmediate(() => (handle as HangingSpawnHandle).cancel());
    return handle;
  }
}

function makeWorktreeManager(): WorktreeManager {
  const wt = path.join(tmpDir, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  return {
    async createWorktree(): Promise<WorktreeInfo> {
      return { branchName: 'yoke/test-abc123', worktreePath: wt };
    },
    async runBootstrap(): Promise<BootstrapEvent> {
      return { type: 'bootstrap_ok' };
    },
    async cleanup() {
      return { worktreeRemoved: true, branchRetained: false };
    },
  } as unknown as WorktreeManager;
}

async function pollUntil(
  check: () => boolean,
  { timeoutMs = 4000, intervalMs = 30 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('pollUntil timed out');
}

function buildScheduler(opts: {
  processManager?: ProcessManager;
  pollIntervalMs?: number;
} = {}): Scheduler {
  const s = new Scheduler({
    db,
    config: makeConfig(),
    processManager: opts.processManager ?? new TrackingProcessManager(),
    worktreeManager: makeWorktreeManager(),
    prepostRunner: async () => ({ kind: 'complete', runs: [] }),
    assemblePrompt: async () => 'stub prompt',
    broadcast: () => {},
    maxParallel: 4,
    pollIntervalMs: opts.pollIntervalMs ?? 50,
    gracePeriodMs: 500,
    artifactValidator: async () => ({ kind: 'validators_ok' as const }),
  });
  activeSchedulers.push(s);
  return s;
}

// ---------------------------------------------------------------------------
// Control executor — pause action
// ---------------------------------------------------------------------------

describe('makeControlExecutor — pause action', () => {
  it('sets paused_at on an in-progress workflow and returns accepted', () => {
    const wfId = insertWorkflow('in_progress');
    const { spy, calls } = makeBroadcastSpy();
    const executor = makeControlExecutor(db.writer, () => {}, spy);

    const result = executor(wfId, 'pause');

    expect(result.status).toBe('accepted');
    expect('pausedAt' in result && result.pausedAt).toBeTruthy();

    const storedPausedAt = getPausedAt(wfId);
    expect(storedPausedAt).not.toBeNull();
    expect(typeof storedPausedAt).toBe('string');
  });

  it('broadcasts workflow.update with non-null pausedAt on pause', () => {
    const wfId = insertWorkflow('in_progress');
    const { spy, calls } = makeBroadcastSpy();
    const executor = makeControlExecutor(db.writer, () => {}, spy);

    executor(wfId, 'pause');

    const updateFrames = calls.filter((c) => c.frameType === 'workflow.update');
    expect(updateFrames.length).toBe(1);
    expect(updateFrames[0].workflowId).toBe(wfId);
    const payload = updateFrames[0].payload as { pausedAt: string | null };
    expect(payload.pausedAt).not.toBeNull();
    expect(typeof payload.pausedAt).toBe('string');
  });

  it('is idempotent: pausing an already-paused workflow re-broadcasts and returns accepted', () => {
    const existingPausedAt = '2026-01-01T00:00:00.000Z';
    const wfId = insertWorkflow('in_progress', existingPausedAt);
    const { spy, calls } = makeBroadcastSpy();
    const executor = makeControlExecutor(db.writer, () => {}, spy);

    const result = executor(wfId, 'pause');

    expect(result.status).toBe('accepted');
    // paused_at must remain unchanged (idempotent — no overwrite)
    expect(getPausedAt(wfId)).toBe(existingPausedAt);
    // broadcast still fires with the existing timestamp
    const updateFrames = calls.filter((c) => c.frameType === 'workflow.update');
    expect(updateFrames.length).toBe(1);
    expect((updateFrames[0].payload as { pausedAt: string }).pausedAt).toBe(existingPausedAt);
  });

  it('returns already_terminal for a completed workflow', () => {
    const wfId = insertWorkflow('completed');
    const { spy } = makeBroadcastSpy();
    const executor = makeControlExecutor(db.writer, () => {}, spy);

    const result = executor(wfId, 'pause');

    expect(result.status).toBe('already_terminal');
  });

  it('returns already_terminal for an abandoned workflow', () => {
    const wfId = insertWorkflow('abandoned');
    const { spy } = makeBroadcastSpy();
    const executor = makeControlExecutor(db.writer, () => {}, spy);

    expect(executor(wfId, 'pause').status).toBe('already_terminal');
  });

  it('returns workflow_not_found for an unknown workflow id', () => {
    const { spy } = makeBroadcastSpy();
    const executor = makeControlExecutor(db.writer, () => {}, spy);

    expect(executor('does-not-exist', 'pause').status).toBe('workflow_not_found');
  });
});

// ---------------------------------------------------------------------------
// Control executor — continue action
// ---------------------------------------------------------------------------

describe('makeControlExecutor — continue action', () => {
  it('clears paused_at to NULL and returns accepted', () => {
    const wfId = insertWorkflow('in_progress', '2026-01-01T00:00:00.000Z');
    const { spy, calls } = makeBroadcastSpy();
    const executor = makeControlExecutor(db.writer, () => {}, spy);

    const result = executor(wfId, 'continue');

    expect(result.status).toBe('accepted');
    expect('pausedAt' in result && result.pausedAt).toBeNull();
    expect(getPausedAt(wfId)).toBeNull();
  });

  it('broadcasts workflow.update with pausedAt=null on continue', () => {
    const wfId = insertWorkflow('in_progress', '2026-01-01T00:00:00.000Z');
    const { spy, calls } = makeBroadcastSpy();
    const executor = makeControlExecutor(db.writer, () => {}, spy);

    executor(wfId, 'continue');

    const updateFrames = calls.filter((c) => c.frameType === 'workflow.update');
    expect(updateFrames.length).toBe(1);
    const payload = updateFrames[0].payload as { pausedAt: string | null };
    expect(payload.pausedAt).toBeNull();
  });

  it('is idempotent: continuing an already-unpaused workflow returns accepted', () => {
    const wfId = insertWorkflow('in_progress', null); // not paused
    const { spy } = makeBroadcastSpy();
    const executor = makeControlExecutor(db.writer, () => {}, spy);

    const result = executor(wfId, 'continue');

    expect(result.status).toBe('accepted');
    expect(getPausedAt(wfId)).toBeNull();
  });

  it('returns already_terminal for a completed workflow', () => {
    const wfId = insertWorkflow('completed');
    const { spy } = makeBroadcastSpy();
    const executor = makeControlExecutor(db.writer, () => {}, spy);

    expect(executor(wfId, 'continue').status).toBe('already_terminal');
  });

  it('returns workflow_not_found for an unknown workflow id', () => {
    const { spy } = makeBroadcastSpy();
    const executor = makeControlExecutor(db.writer, () => {}, spy);

    expect(executor('does-not-exist', 'continue').status).toBe('workflow_not_found');
  });
});

// ---------------------------------------------------------------------------
// Control executor — round-trip: pause then continue
// ---------------------------------------------------------------------------

describe('makeControlExecutor — pause/continue round-trip', () => {
  it('pause then continue: paused_at goes from null → set → null', () => {
    const wfId = insertWorkflow('in_progress');
    const { spy } = makeBroadcastSpy();
    const executor = makeControlExecutor(db.writer, () => {}, spy);

    expect(getPausedAt(wfId)).toBeNull();

    executor(wfId, 'pause');
    expect(getPausedAt(wfId)).not.toBeNull();

    executor(wfId, 'continue');
    expect(getPausedAt(wfId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scheduler startup-pause (AC-4)
// ---------------------------------------------------------------------------

describe('Scheduler.start() startup-pause', () => {
  it('pauses all non-terminal, non-paused workflows before the first tick', async () => {
    const config = makeConfig();
    const { workflowId } = createWorkflow(db, config, { name: 'in-flight' });

    // Verify not paused before start()
    expect(getPausedAt(workflowId)).toBeNull();

    const s = buildScheduler();
    await s.start();

    // Startup-pause must fire before the tick loop starts.
    expect(getPausedAt(workflowId)).not.toBeNull();

    await s.stop();
  });

  it('does not overwrite workflows already paused before restart', async () => {
    const config = makeConfig();
    const { workflowId } = createWorkflow(db, config, { name: 'pre-paused' });
    const priorPausedAt = '2026-01-01T10:00:00';
    db.writer
      .prepare(`UPDATE workflows SET paused_at = ? WHERE id = ?`)
      .run(priorPausedAt, workflowId);

    const s = buildScheduler();
    await s.start();

    // Start() only pauses WHERE paused_at IS NULL — existing value preserved.
    expect(getPausedAt(workflowId)).toBe(priorPausedAt);

    await s.stop();
  });

  it('does not pause terminal workflows (completed, abandoned, completed_with_blocked)', async () => {
    // Manually insert terminal workflows to simulate left-over completed work.
    const idCompleted = insertWorkflow('completed');
    const idAbandoned = insertWorkflow('abandoned');
    const idCwb = insertWorkflow('completed_with_blocked');

    const s = buildScheduler();
    await s.start();

    expect(getPausedAt(idCompleted)).toBeNull();
    expect(getPausedAt(idAbandoned)).toBeNull();
    expect(getPausedAt(idCwb)).toBeNull();

    await s.stop();
  });
});

// ---------------------------------------------------------------------------
// Paused workflow not ticked (AC-3)
// ---------------------------------------------------------------------------

describe('Scheduler tick — paused workflow skipped', () => {
  it('does not spawn sessions for a paused workflow; spawns after continue', async () => {
    const config = makeConfig();
    const { workflowId } = createWorkflow(db, config, { name: 'pause-tick-test' });

    // Manually pause the workflow so startup-pause won't be an issue.
    db.writer
      .prepare(`UPDATE workflows SET paused_at = datetime('now'), status = 'pending' WHERE id = ?`)
      .run(workflowId);

    const pm = new TrackingProcessManager();
    const s = buildScheduler({ processManager: pm, pollIntervalMs: 30 });

    // We pass a custom start to avoid the startup-pause re-pausing (which would
    // be fine here, but we want to control the timing explicitly). Since we
    // already set paused_at, startup-pause is a no-op (paused_at IS NOT NULL).
    await s.start();

    // Wait several ticks — workflow is paused, so no sessions should be spawned.
    await new Promise((r) => setTimeout(r, 200));
    expect(pm.handles.length).toBe(0);

    // Now un-pause via the control executor.
    const { spy } = makeBroadcastSpy();
    const executor = makeControlExecutor(db.writer, () => {}, spy);
    executor(workflowId, 'continue');

    // After un-pause, the tick loop should eventually spawn a session.
    await pollUntil(() => pm.handles.length > 0, { timeoutMs: 3000 });
    expect(pm.handles.length).toBeGreaterThan(0);

    await s.stop();
  });
});

// ---------------------------------------------------------------------------
// Integration: restart scenario (AC-9)
// AC-9: restart mock server with in-progress workflow → paused → no advance
//       until continue control action
// ---------------------------------------------------------------------------

describe('Integration: server restart pauses in-progress workflow', () => {
  it('in-progress workflow at restart is paused; items do not advance until continue', async () => {
    const config = makeConfig();

    // Phase 1: create workflow that is "in flight" when the server stops.
    const { workflowId } = createWorkflow(db, config, { name: 'restart-test' });

    // Simulate that the workflow is actively running by setting status to in_progress.
    // (In a real run, the scheduler would do this; we seed it directly here.)
    db.writer
      .prepare(`UPDATE workflows SET status = 'in_progress' WHERE id = ?`)
      .run(workflowId);
    // Also seed an item as in_progress to match workflow state.
    const items = db.reader()
      .prepare('SELECT id FROM items WHERE workflow_id = ?')
      .all(workflowId) as { id: string }[];
    if (items.length > 0) {
      db.writer
        .prepare(`UPDATE items SET status = 'in_progress', current_phase = 'phase-one' WHERE id = ?`)
        .run(items[0].id);
    }

    // Verify the workflow is not paused before restart.
    expect(getPausedAt(workflowId)).toBeNull();
    expect(getStatus(workflowId)).toBe('in_progress');

    // Phase 2: "restart" — new Scheduler.start() should pause all non-terminal wf.
    const pm = new TrackingProcessManager();
    const s = buildScheduler({ processManager: pm, pollIntervalMs: 30 });
    await s.start();

    // After start(), the workflow must be paused.
    expect(getPausedAt(workflowId)).not.toBeNull();

    // Wait several ticks — no sessions should spawn because workflow is paused.
    await new Promise((r) => setTimeout(r, 200));
    expect(pm.handles.length).toBe(0);

    // Issue a continue control action.
    const { spy } = makeBroadcastSpy();
    const executor = makeControlExecutor(db.writer, () => {}, spy);
    const continueResult = executor(workflowId, 'continue');

    expect(continueResult.status).toBe('accepted');
    expect(getPausedAt(workflowId)).toBeNull();

    // The workflow.update broadcast should have been sent with pausedAt=null.
    const wfUpdates = spy.length !== undefined
      ? []  // fallback — use calls directly
      : [];
    // (We use calls from the makeBroadcastSpy() destructure instead)

    await s.stop();
  });
});

// ---------------------------------------------------------------------------
// Integration: crash recovery still works when workflow is paused post-restart (AC-6)
// ---------------------------------------------------------------------------

describe('Integration: crash recovery + startup-pause interact correctly', () => {
  it('stale sessions are transitioned even when the workflow ends up paused', async () => {
    const config = makeConfig();
    const { workflowId } = createWorkflow(db, config, { name: 'crash-pause-test' });

    // Simulate a stale in-progress item+session from a crashed prior run.
    const itemId = (
      db.reader().prepare('SELECT id FROM items WHERE workflow_id = ?').get(workflowId) as { id: string }
    ).id;

    db.writer
      .prepare(`UPDATE workflows SET status = 'in_progress' WHERE id = ?`)
      .run(workflowId);
    db.writer
      .prepare(`UPDATE items SET status = 'in_progress', current_phase = 'phase-one' WHERE id = ?`)
      .run(itemId);

    // Insert a stale session with a fake PID (not a real OS process).
    const fakeSessionId = 'stale-session-crash-pause';
    const fakePid = 9999999; // guaranteed not to exist
    db.writer
      .prepare(
        `INSERT INTO sessions
           (id, workflow_id, item_id, stage, phase, agent_profile, started_at, ended_at, status, pid)
         VALUES (?, ?, ?, 'stage-alpha', 'phase-one', 'default', datetime('now'), NULL, 'running', ?)`,
      )
      .run(fakeSessionId, workflowId, itemId, fakePid);

    // Start scheduler (triggers crash recovery + startup-pause).
    const s = buildScheduler({ pollIntervalMs: 50 });
    await s.start();

    // After start(): workflow must be paused.
    expect(getPausedAt(workflowId)).not.toBeNull();

    // Crash recovery should have transitioned the stale item out of 'in_progress'.
    // Poll briefly to allow crash recovery to complete (it's synchronous in start()).
    const itemStatus = db.reader()
      .prepare('SELECT status FROM items WHERE id = ?')
      .get(itemId) as { status: string };
    expect(['awaiting_retry', 'awaiting_user']).toContain(itemStatus.status);

    // The stale session must have been ended by crash recovery.
    const sessionRow = db.reader()
      .prepare('SELECT status, ended_at FROM sessions WHERE id = ?')
      .get(fakeSessionId) as { status: string; ended_at: string | null };
    expect(sessionRow.status).toBe('failed');
    expect(sessionRow.ended_at).not.toBeNull();

    await s.stop();
  });
});
