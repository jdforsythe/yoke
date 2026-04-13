/**
 * Scheduler — orchestration loop that drives the Yoke pipeline.
 *
 * The Scheduler is the glue layer that wires all existing building blocks into
 * a real workflow execution engine.  On start() it:
 *
 *   1. Calls ingestWorkflow() to seed workflow + item rows into SQLite.
 *   2. Calls buildCrashRecovery() to detect stale sessions from a previous run.
 *   3. Transitions stale in_progress items → session_fail so they don't get
 *      double-spawned.
 *   4. Enters a poll/event loop (default 500 ms tick).
 *
 * ## Tick loop
 *
 *   Each tick re-reads all non-terminal workflows from SQLite (RC-1: no
 *   in-memory cache).  For every item:
 *     - pending           → fire deps_satisfied (moves to ready when deps met)
 *     - ready             → fire phase_start → bootstrapping | in_progress
 *     - bootstrapping     → createWorktree + runBootstrap → bootstrap_ok | fail
 *     - in_progress (not  → spawn agent session (full async lifecycle)
 *       in inFlight)
 *     - awaiting_retry    → fire backoff_elapsed after RETRY_BACKOFF_MS
 *     - rate_limited      → fire rate_limit_window_elapsed after reset_at
 *
 * ## Concurrency
 *
 *   Max parallel sessions read from SQLite on every tick (RC-5). Items being
 *   managed in the inFlight map count against the limit.
 *
 * ## Guarantees
 *
 *   RC-1  Every scheduling decision re-reads SQLite — no in-memory workflow
 *         cache between loop ticks.
 *   RC-2  All SQLite mutations go through engine functions (applyItemTransition,
 *         applyWorktreeCreated, insertSession, updateSessionPid, endSession).
 *         No direct db.writer calls in this file.
 *   RC-3  Process spawn happens only after the in_progress transition is
 *         committed (applyItemTransition returns before spawn).
 *   RC-4  buildCrashRecovery() is called before any new items are scheduled.
 *   RC-5  Concurrency limit enforced by counting running sessions in SQLite
 *         plus items currently being processed (not yet in SQLite).
 *   RC-6  ProcessManager, WorktreeManager, PromptAssemblerFn, and
 *         PrePostRunnerFn are all injectable for integration testing.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import type { DbPool } from '../storage/db.js';
import type { ResolvedConfig } from '../../shared/types/config.js';
import type { Stage, Phase } from '../../shared/types/config.js';
import type { ProcessManager, SpawnHandle } from '../process/manager.js';
import type { WorktreeManager } from '../worktree/manager.js';
import type { RunCommandsOpts, RunCommandsResult } from '../prepost/runner.js';
import type { ServerFrameType } from '../api/frames.js';
import type { ItemStatePayload } from '../api/frames.js';
import {
  applyItemTransition,
  applyWorktreeCreated,
  buildCrashRecovery,
  insertSession,
  updateSessionPid,
  endSession,
  applyStageAdvance,
  applyWorkflowComplete,
} from '../pipeline/engine.js';
import type { ApplyItemTransitionResult } from '../pipeline/engine.js';
import type { SessionUsage } from '../pipeline/engine.js';
import { ingestWorkflow } from './ingest.js';
import { openSessionLog } from '../session-log/writer.js';
import { StreamJsonParser } from '../process/stream-json.js';
import type { RateLimitDetectedEvent, StreamUsageEvent } from '../process/stream-json.js';
import { classify } from '../state-machine/classifier.js';
import { FixtureWriter } from '../process/fixture-writer.js';
import { readRecordMarker, clearRecordMarker } from '../process/record-marker.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable prompt assembler function.
 * In production: calls buildPromptContext() + assemblePrompt().
 * In tests: returns a fixed stub string.
 */
export type PromptAssemblerFn = (opts: {
  worktreePath: string;
  phaseConfig: Phase;
  workflowId: string;
  workflowName: string;
  stageId: string;
  stageRun: 'once' | 'per-item';
  itemId: string | null;
  itemData: string | null;
  itemStatus: string | null;
  itemCurrentPhase: string | null;
  itemRetryCount: number;
  itemBlockedReason: string | null;
}) => Promise<string>;

/** Injectable pre/post runner function (maps to runCommands from prepost/runner.ts). */
export type PrePostRunnerFn = (opts: RunCommandsOpts) => Promise<RunCommandsResult>;

/**
 * Broadcast function injected from the server layer.
 * Maps to WsClientRegistry.broadcast().
 */
export type BroadcastFn = (
  workflowId: string,
  sessionId: string | null,
  frameType: ServerFrameType,
  payload: unknown,
) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_GRACE_PERIOD_MS = 10_000;
/** Backoff before re-spawning an awaiting_retry item (ms). */
const RETRY_BACKOFF_MS = 5_000;
const TERMINAL_WF_STATUSES = ['completed', 'abandoned', 'completed_with_blocked'];

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ItemRow {
  id: string;
  workflow_id: string;
  stage_id: string;
  data: string;
  status: string;
  current_phase: string | null;
  depends_on: string | null;
  retry_count: number;
  blocked_reason: string | null;
}

interface WorkflowDbRow {
  id: string;
  name: string;
  status: string;
  current_stage: string | null;
  worktree_path: string | null;
  branch_name: string | null;
}

interface InFlightSession {
  sessionId: string;
  handle: SpawnHandle;
  usage: SessionUsage;
}

type InFlightEntry = InFlightSession | 'pending';

// ---------------------------------------------------------------------------
// SchedulerOpts
// ---------------------------------------------------------------------------

export interface SchedulerOpts {
  db: DbPool;
  config: ResolvedConfig;
  processManager: ProcessManager;
  worktreeManager: WorktreeManager;
  prepostRunner: PrePostRunnerFn;
  assemblePrompt: PromptAssemblerFn;
  broadcast: BroadcastFn;
  /** Poll interval in ms. Default: 500. */
  pollIntervalMs?: number;
  /** Grace period for graceful shutdown drain (ms). Default: 10 000. */
  gracePeriodMs?: number;
  /** Max concurrent sessions. Default: 4. */
  maxParallel?: number;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  private readonly db: DbPool;
  private readonly config: ResolvedConfig;
  private readonly processManager: ProcessManager;
  private readonly worktreeManager: WorktreeManager;
  private readonly prepostRunner: PrePostRunnerFn;
  private readonly assemblePromptFn: PromptAssemblerFn;
  private readonly broadcastFn: BroadcastFn;
  private readonly pollIntervalMs: number;
  private readonly gracePeriodMs: number;
  private readonly maxParallel: number;

  /** workflowId populated by start(). */
  workflowId: string | null = null;

  /** Items currently being managed (bootstrapping, spawning, or running). */
  private readonly inFlight = new Map<string, InFlightEntry>();

  /** itemId → timestamp(ms) when the item may next be retried. */
  private readonly retryAfterAt = new Map<string, number>();

  /** itemId → unix seconds when rate-limit window resets. */
  private readonly rateLimitResetAt = new Map<string, number>();

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: SchedulerOpts) {
    this.db = opts.db;
    this.config = opts.config;
    this.processManager = opts.processManager;
    this.worktreeManager = opts.worktreeManager;
    this.prepostRunner = opts.prepostRunner;
    this.assemblePromptFn = opts.assemblePrompt;
    this.broadcastFn = opts.broadcast;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
    this.maxParallel = opts.maxParallel ?? DEFAULT_MAX_PARALLEL;
  }

  // -------------------------------------------------------------------------
  // start — AC-1
  // -------------------------------------------------------------------------

  /**
   * Ingests the workflow, runs crash recovery, and starts the scheduling loop.
   * Returns once the first tick has been queued (not waited for).
   */
  async start(): Promise<void> {
    if (this.stopped) throw new Error('Scheduler already stopped');

    // Step 1: Ingest workflow + items from config (AC-1).
    const { workflowId } = ingestWorkflow(this.db, this.config);
    this.workflowId = workflowId;

    // Step 2: Crash recovery — detect stale sessions from a previous run (RC-4).
    const recoveryInfos = buildCrashRecovery(this.db);
    for (const info of recoveryInfos) {
      // Transition stale in_progress items to awaiting_retry or awaiting_user
      // so they are not double-spawned (RC-4: stale sessions ≠ live sessions).
      for (const stale of info.staleSessions) {
        if (!stale.itemId) continue;
        const item = this._readItem(stale.itemId);
        if (!item || item.status !== 'in_progress') continue;
        // Fire session_fail with unknown classifier → awaiting_user or awaiting_retry
        // (budget-dependent). The user or auto-resume will restart the item.
        applyItemTransition({
          db: this.db,
          workflowId: info.workflowId,
          itemId: stale.itemId,
          sessionId: stale.sessionId,
          stage: item.stage_id,
          phase: item.current_phase ?? '',
          attempt: item.retry_count + 1,
          event: 'session_fail',
          guardCtx: { classifierResult: 'unknown' },
        });
      }
    }

    // Step 3: Start the poll loop (AC-1: scheduling begins within 2 s).
    this._scheduleTick();
  }

  // -------------------------------------------------------------------------
  // stop — AC-8 (graceful drain)
  // -------------------------------------------------------------------------

  /**
   * Stops the poll loop and cancels all in-flight sessions.
   *
   * Sends SIGTERM to each session's process group, waits up to gracePeriodMs
   * for natural exit, then forces SIGKILL via cancel(). Returns after all
   * in-flight sessions are cancelled (or the grace period expires).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Cancel all in-flight sessions and collect their exit promises.
    const drainPromises: Promise<void>[] = [];
    for (const [, entry] of this.inFlight) {
      if (entry !== 'pending' && entry.handle) {
        drainPromises.push(entry.handle.cancel());
      }
    }

    // Wait for all cancellations with overall timeout.
    await Promise.race([
      Promise.allSettled(drainPromises),
      new Promise<void>((resolve) => setTimeout(resolve, this.gracePeriodMs)),
    ]);
  }

  // -------------------------------------------------------------------------
  // Tick loop
  // -------------------------------------------------------------------------

  private _scheduleTick(): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => {
      void this._tick();
    }, this.pollIntervalMs);
  }

  private async _tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this._processWorkflows();
    } catch (err) {
      // Tick errors must not crash the loop.
      console.error('[scheduler] tick error:', err);
    } finally {
      if (!this.stopped) this._scheduleTick();
    }
  }

  // -------------------------------------------------------------------------
  // _processWorkflows — RC-1: re-read SQLite on every tick
  // -------------------------------------------------------------------------

  private async _processWorkflows(): Promise<void> {
    const placeholders = TERMINAL_WF_STATUSES.map(() => '?').join(',');
    const workflows = this.db.reader()
      .prepare(
        `SELECT id, name, status, current_stage, worktree_path, branch_name
           FROM workflows
          WHERE status NOT IN (${placeholders})`,
      )
      .all(...TERMINAL_WF_STATUSES) as WorkflowDbRow[];

    for (const wf of workflows) {
      await this._processWorkflow(wf);
    }
  }

  private async _processWorkflow(wf: WorkflowDbRow): Promise<void> {
    // RC-5: count running sessions from SQLite + pending spawns in inFlight.
    const runningSql = this.db.reader()
      .prepare(
        `SELECT COUNT(*) AS cnt FROM sessions
          WHERE workflow_id = ? AND status = 'running'`,
      )
      .get(wf.id) as { cnt: number };

    // Items currently in inFlight count as running even if insertSession hasn't
    // been called yet — prevents over-scheduling within a single tick.
    const pendingInFlight = [...this.inFlight.keys()].filter((id) => {
      const item = this._readItem(id);
      return item?.workflow_id === wf.id;
    }).length;

    let effectiveRunning = runningSql.cnt + pendingInFlight;

    const items = this._readWorkflowItems(wf.id);

    for (const item of items) {
      switch (item.status) {
        // ------------------------------------------------------------------
        // pending → try deps_satisfied
        // ------------------------------------------------------------------
        case 'pending': {
          const result = applyItemTransition({
            db: this.db,
            workflowId: wf.id,
            itemId: item.id,
            sessionId: null,
            stage: item.stage_id,
            phase: item.current_phase ?? '',
            attempt: item.retry_count + 1,
            event: 'deps_satisfied',
          });
          // Only broadcast if the state actually changed.
          if (result.newState !== 'pending') {
            this._broadcastItemState(wf.id, item.id, item.stage_id, result);
          }
          break;
        }

        // ------------------------------------------------------------------
        // ready → phase_start → bootstrapping | in_progress
        // ------------------------------------------------------------------
        case 'ready': {
          if (effectiveRunning >= this.maxParallel) break;
          if (this.inFlight.has(item.id)) break;

          const stage = this._findStage(item.stage_id);
          if (!stage) break;

          const phaseIdx = stage.phases.indexOf(item.current_phase ?? '');
          const morePhases = phaseIdx >= 0 && phaseIdx < stage.phases.length - 1;
          const nextPhase = morePhases ? stage.phases[phaseIdx + 1] : undefined;

          const result = applyItemTransition({
            db: this.db,
            workflowId: wf.id,
            itemId: item.id,
            sessionId: null,
            stage: item.stage_id,
            phase: item.current_phase ?? '',
            attempt: item.retry_count + 1,
            event: 'phase_start',
            guardCtx: { morePhases, nextPhase },
          });
          this._broadcastItemState(wf.id, item.id, item.stage_id, result);

          if (result.newState === 'bootstrapping') {
            this.inFlight.set(item.id, 'pending');
            effectiveRunning++;
            void this._doBootstrapThenSpawn(wf, item, stage);
          } else if (result.newState === 'in_progress') {
            this.inFlight.set(item.id, 'pending');
            effectiveRunning++;
            void this._runSession(wf, this._readItem(item.id) ?? item, stage);
          }
          break;
        }

        // ------------------------------------------------------------------
        // in_progress without an active session → spawn (crash resume path)
        // ------------------------------------------------------------------
        case 'in_progress': {
          if (this.inFlight.has(item.id)) break;
          if (effectiveRunning >= this.maxParallel) break;

          const stage = this._findStage(item.stage_id);
          if (!stage) break;

          this.inFlight.set(item.id, 'pending');
          effectiveRunning++;
          void this._runSession(wf, item, stage);
          break;
        }

        // ------------------------------------------------------------------
        // awaiting_retry → fire backoff_elapsed after RETRY_BACKOFF_MS
        // ------------------------------------------------------------------
        case 'awaiting_retry': {
          // Arm a retry timer if not already set.
          if (!this.retryAfterAt.has(item.id)) {
            this.retryAfterAt.set(item.id, Date.now() + RETRY_BACKOFF_MS);
          }
          const retryAt = this.retryAfterAt.get(item.id)!;
          if (Date.now() < retryAt) break;

          const result = applyItemTransition({
            db: this.db,
            workflowId: wf.id,
            itemId: item.id,
            sessionId: null,
            stage: item.stage_id,
            phase: item.current_phase ?? '',
            attempt: item.retry_count + 1,
            event: 'backoff_elapsed',
          });
          this._broadcastItemState(wf.id, item.id, item.stage_id, result);
          this.retryAfterAt.delete(item.id);
          break;
        }

        // ------------------------------------------------------------------
        // rate_limited → fire rate_limit_window_elapsed after reset_at
        // ------------------------------------------------------------------
        case 'rate_limited': {
          const resetAt = this.rateLimitResetAt.get(item.id);
          // If reset_at is unknown (scheduler restart), fire immediately.
          if (resetAt !== undefined && Date.now() < resetAt * 1000) break;

          const result = applyItemTransition({
            db: this.db,
            workflowId: wf.id,
            itemId: item.id,
            sessionId: null,
            stage: item.stage_id,
            phase: item.current_phase ?? '',
            attempt: item.retry_count + 1,
            event: 'rate_limit_window_elapsed',
          });
          this._broadcastItemState(wf.id, item.id, item.stage_id, result);
          this.rateLimitResetAt.delete(item.id);
          break;
        }

        default:
          // blocked, abandoned, complete, bootstrap_failed, awaiting_user:
          // terminal or requires user action — skip silently.
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // _doBootstrapThenSpawn — worktree creation + bootstrap commands
  // -------------------------------------------------------------------------

  private async _doBootstrapThenSpawn(
    wf: WorkflowDbRow,
    item: ItemRow,
    stage: Stage,
  ): Promise<void> {
    if (this.stopped) {
      this.inFlight.delete(item.id);
      return;
    }
    try {
      // --- Create worktree if not already present (first phase of first stage).
      let worktreePath = wf.worktree_path;
      if (!worktreePath) {
        const baseDir = this.config.worktrees?.base_dir
          ? path.resolve(this.config.configDir, this.config.worktrees.base_dir)
          : path.join(this.config.configDir, '.worktrees');

        let wtInfo: { branchName: string; worktreePath: string };
        try {
          wtInfo = await this.worktreeManager.createWorktree({
            workflowId: wf.id,
            workflowName: wf.name,
            baseDir,
            branchPrefix: this.config.worktrees?.branch_prefix ?? 'yoke/',
          });
        } catch {
          // Worktree creation failed → bootstrap_fail (triggers pending_attention).
          const result = applyItemTransition({
            db: this.db,
            workflowId: wf.id,
            itemId: item.id,
            sessionId: null,
            stage: item.stage_id,
            phase: item.current_phase ?? '',
            attempt: item.retry_count + 1,
            event: 'bootstrap_fail',
          });
          this._broadcastItemState(wf.id, item.id, item.stage_id, result);
          this.inFlight.delete(item.id);
          return;
        }

        // Persist worktree info into SQLite (RC-2: through engine function).
        applyWorktreeCreated({
          db: this.db,
          workflowId: wf.id,
          branchName: wtInfo.branchName,
          worktreePath: wtInfo.worktreePath,
        });
        worktreePath = wtInfo.worktreePath;
      }

      // --- Run bootstrap commands.
      const commands = this.config.worktrees?.bootstrap?.commands ?? [];
      const bootstrapEvent = await this.worktreeManager.runBootstrap({
        worktreePath,
        commands,
      });

      const result = applyItemTransition({
        db: this.db,
        workflowId: wf.id,
        itemId: item.id,
        sessionId: null,
        stage: item.stage_id,
        phase: item.current_phase ?? '',
        attempt: item.retry_count + 1,
        event: bootstrapEvent.type,
      });
      this._broadcastItemState(wf.id, item.id, item.stage_id, result);

      if (result.newState === 'in_progress') {
        // Bootstrap succeeded — continue to session spawn without a tick delay.
        const freshItem = this._readItem(item.id);
        if (freshItem) {
          const freshWf = this._readWorkflow(wf.id);
          if (freshWf) {
            await this._runSession(freshWf, freshItem, stage);
            return;
          }
        }
      }
    } catch (err) {
      console.error(`[scheduler] bootstrap error for item ${item.id}:`, err);
    }
    this.inFlight.delete(item.id);
  }

  // -------------------------------------------------------------------------
  // _runSession — full async session lifecycle for one item phase
  // -------------------------------------------------------------------------

  private async _runSession(
    wf: WorkflowDbRow,
    item: ItemRow,
    stage: Stage,
  ): Promise<void> {
    if (this.stopped) {
      this.inFlight.delete(item.id);
      return;
    }

    const phaseKey = item.current_phase ?? stage.phases[0] ?? '';
    const phaseConfig = this.config.phases[phaseKey];

    if (!phaseConfig) {
      console.error(
        `[scheduler] phase config not found for '${phaseKey}' in item ${item.id}`,
      );
      this.inFlight.delete(item.id);
      return;
    }

    const sessionId = crypto.randomUUID();
    const attempt = item.retry_count + 1;

    // Correlation env injected into all child processes.
    const correlationEnv: Record<string, string> = {
      YOKE_WORKFLOW_ID: wf.id,
      YOKE_ITEM_ID: item.id,
      YOKE_STAGE: item.stage_id,
      YOKE_PHASE: phaseKey,
      YOKE_SESSION_ID: sessionId,
      YOKE_ATTEMPT: String(attempt),
    };

    const worktreePath = wf.worktree_path ?? this.config.configDir;

    // RC-2: insertSession via engine helper (not db.writer directly).
    // Inserted BEFORE spawn so SQLite concurrency count is immediately accurate.
    insertSession(this.db, {
      sessionId,
      workflowId: wf.id,
      itemId: item.id,
      stage: item.stage_id,
      phase: phaseKey,
      pid: null,
      pgid: null,
    });

    // Open session log — writes session_log_path to SQLite then opens the file.
    const { writer: logWriter } = await openSessionLog(this.db, {
      configDir: this.config.configDir,
      workflowId: wf.id,
      sessionId,
    });

    // --- Pre: commands (AC-4) ---
    if (phaseConfig.pre && phaseConfig.pre.length > 0) {
      const preResult = await this.prepostRunner({
        commands: phaseConfig.pre,
        worktreePath,
        logWriter,
        when: 'pre',
        env: correlationEnv,
      });

      if (preResult.kind !== 'complete') {
        // Pre-command blocked spawn.
        const preAction = preResult.kind === 'action'
          ? (preResult.action === 'stop-and-ask' ? 'stop-and-ask' as const : 'fail' as const)
          : 'fail' as const;

        const result = applyItemTransition({
          db: this.db,
          workflowId: wf.id,
          itemId: item.id,
          sessionId,
          stage: item.stage_id,
          phase: phaseKey,
          attempt,
          event: 'pre_command_failed',
          guardCtx: { preCommandAction: preAction },
        });
        this._broadcastItemState(wf.id, item.id, item.stage_id, result);
        await logWriter.close();
        endSession(this.db, sessionId, { exitCode: null });
        this.inFlight.delete(item.id);
        return;
      }
    }

    // --- Assemble prompt (AC-3) ---
    let promptText: string;
    try {
      promptText = await this.assemblePromptFn({
        worktreePath,
        phaseConfig,
        workflowId: wf.id,
        workflowName: wf.name,
        stageId: item.stage_id,
        stageRun: stage.run,
        itemId: item.id,
        itemData: item.data,
        itemStatus: item.status,
        itemCurrentPhase: item.current_phase,
        itemRetryCount: item.retry_count,
        itemBlockedReason: item.blocked_reason,
      });
    } catch (err) {
      console.error(`[scheduler] prompt assembly failed for item ${item.id}:`, err);
      const result = applyItemTransition({
        db: this.db,
        workflowId: wf.id,
        itemId: item.id,
        sessionId,
        stage: item.stage_id,
        phase: phaseKey,
        attempt,
        event: 'session_fail',
        guardCtx: { classifierResult: 'unknown' },
      });
      this._broadcastItemState(wf.id, item.id, item.stage_id, result);
      await logWriter.close();
      endSession(this.db, sessionId, { exitCode: null });
      this.inFlight.delete(item.id);
      return;
    }

    // --- Spawn session (RC-3: after in_progress transition is committed) ---
    let handle: SpawnHandle;
    try {
      handle = await this.processManager.spawn({
        command: phaseConfig.command,
        args: phaseConfig.args,
        cwd: worktreePath,
        env: { ...(phaseConfig.env ?? {}), ...correlationEnv },
        promptBuffer: promptText,
        logWriter,
      });
    } catch (err) {
      console.error(`[scheduler] spawn failed for item ${item.id}:`, err);
      const result = applyItemTransition({
        db: this.db,
        workflowId: wf.id,
        itemId: item.id,
        sessionId,
        stage: item.stage_id,
        phase: phaseKey,
        attempt,
        event: 'session_fail',
        guardCtx: { classifierResult: 'unknown' },
      });
      this._broadcastItemState(wf.id, item.id, item.stage_id, result);
      await logWriter.close();
      endSession(this.db, sessionId, { exitCode: null });
      this.inFlight.delete(item.id);
      return;
    }

    // Guard: if stop() was called while we were spawning, cancel immediately.
    if (this.stopped) {
      void handle.cancel();
      await logWriter.close();
      this.inFlight.delete(item.id);
      return;
    }

    // Update PID/PGID now that we have the real process (RC-2: engine helper).
    updateSessionPid(this.db, sessionId, handle.pid, handle.pgid);

    // Register as an active in-flight session.
    const inFlightEntry: InFlightSession = {
      sessionId,
      handle,
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    };
    this.inFlight.set(item.id, inFlightEntry);

    // Broadcast session.started.
    this.broadcastFn(wf.id, sessionId, 'session.started', {
      sessionId,
      phase: phaseKey,
      attempt,
      startedAt: new Date().toISOString(),
    });

    // --- Capture mode: open FixtureWriter if .yoke/record.json is present (AC-2) ---
    const captureMarker = readRecordMarker(this.config.configDir);
    let fixtureWriter: FixtureWriter | null = null;
    if (captureMarker) {
      fixtureWriter = new FixtureWriter({ capturePath: captureMarker.capturePath });
      try {
        fixtureWriter.open();
      } catch (err) {
        console.error('[scheduler] capture: failed to open fixture writer:', err);
        fixtureWriter = null;
      }
    }

    // --- Wire up NDJSON parser (AC-3) ---
    const parser = new StreamJsonParser();
    let stderr = '';
    let parseErrors = 0;

    // Accumulate usage for endSession.
    parser.on('stream.usage', (ev: StreamUsageEvent) => {
      inFlightEntry.usage = {
        inputTokens: ev.inputTokens,
        outputTokens: ev.outputTokens,
        cacheCreationInputTokens: ev.cacheCreationInputTokens,
        cacheReadInputTokens: ev.cacheReadInputTokens,
      };
    });

    // Rate limit detection (AC-6).
    parser.on('rate_limit_detected', (ev: RateLimitDetectedEvent) => {
      this.rateLimitResetAt.set(item.id, ev.resetAt ?? (Date.now() / 1000 + 3600));
      const result = applyItemTransition({
        db: this.db,
        workflowId: wf.id,
        itemId: item.id,
        sessionId,
        stage: item.stage_id,
        phase: phaseKey,
        attempt,
        event: 'rate_limit_detected',
      });
      this._broadcastItemState(wf.id, item.id, item.stage_id, result);
      // Cancel the session — it will be re-scheduled when the window elapses.
      void handle.cancel();
    });

    // Parse errors — track for classifier.
    parser.on('parse_error', () => { parseErrors++; });

    // Forward stream events as WS frames (AC-7).
    parser.on('stream.text',         (ev) => this.broadcastFn(wf.id, sessionId, 'stream.text',         ev));
    parser.on('stream.thinking',     (ev) => this.broadcastFn(wf.id, sessionId, 'stream.thinking',     ev));
    parser.on('stream.tool_use',     (ev) => this.broadcastFn(wf.id, sessionId, 'stream.tool_use',     ev));
    parser.on('stream.tool_result',  (ev) => this.broadcastFn(wf.id, sessionId, 'stream.tool_result',  ev));
    parser.on('stream.usage',        (ev) => this.broadcastFn(wf.id, sessionId, 'stream.usage',        ev));
    parser.on('stream.system_notice',(ev) => this.broadcastFn(wf.id, sessionId, 'stream.system_notice',ev));

    // Feed stdout lines to parser; tee to fixture writer in capture mode.
    handle.on('stdout_line', (line: string) => {
      parser.feed(line);
      fixtureWriter?.appendStdout(line);
    });

    // Accumulate stderr for the failure classifier; tee to fixture writer.
    handle.on('stderr_data', (chunk: string) => {
      if (stderr.length < 65_536) {
        stderr += chunk;
      }
      fixtureWriter?.appendStderr(chunk);
    });

    // --- Wait for process exit ---
    const { exitCode } = await new Promise<{ exitCode: number | null }>(
      (resolve) => {
        handle.once(
          'exit',
          (code: number | null) => resolve({ exitCode: code }),
        );
        handle.once('error', () => resolve({ exitCode: null }));
      },
    );

    parser.flush();

    // Guard: if stop() was called while session ran, skip all post-session work.
    if (this.stopped) {
      fixtureWriter?.close(exitCode);
      if (fixtureWriter) clearRecordMarker(this.config.configDir);
      await logWriter.close();
      this.inFlight.delete(item.id);
      return;
    }

    // Re-read item — state may have changed during the session (e.g. rate_limited).
    const freshItem = this._readItem(item.id);
    if (!freshItem || freshItem.status === 'rate_limited') {
      // Session was cancelled due to rate limit or item no longer exists.
      fixtureWriter?.close(exitCode);
      if (fixtureWriter) clearRecordMarker(this.config.configDir);
      this.broadcastFn(wf.id, sessionId, 'session.ended', {
        sessionId,
        endedAt: new Date().toISOString(),
        exitCode,
        statusFlags: {},
        reason: 'rate_limited' as const,
      });
      await logWriter.close();
      endSession(this.db, sessionId, { exitCode, usage: inFlightEntry.usage });
      this.inFlight.delete(item.id);
      return;
    }

    const phaseIdx = stage.phases.indexOf(freshItem.current_phase ?? '');
    const morePhases = phaseIdx >= 0 && phaseIdx < stage.phases.length - 1;
    const nextPhase = morePhases ? stage.phases[phaseIdx + 1] : undefined;

    if (exitCode === 0) {
      // --- Post: commands (AC-5) ---
      let postResult: RunCommandsResult = { kind: 'complete' };
      if (phaseConfig.post && phaseConfig.post.length > 0) {
        postResult = await this.prepostRunner({
          commands: phaseConfig.post,
          worktreePath,
          logWriter,
          when: 'post',
          env: correlationEnv,
        });
      }

      if (postResult.kind === 'complete') {
        // session_ok → complete (last phase) or in_progress (advance phase).
        const result = applyItemTransition({
          db: this.db,
          workflowId: wf.id,
          itemId: freshItem.id,
          sessionId,
          stage: freshItem.stage_id,
          phase: freshItem.current_phase ?? '',
          attempt,
          event: 'session_ok',
          guardCtx: {
            morePhases,
            nextPhase,
            allPostCommandsOk: true,
            validatorsOk: true,
            diffCheckOk: true,
          },
        });
        this._broadcastItemState(wf.id, freshItem.id, freshItem.stage_id, result);

      } else if (postResult.kind === 'action') {
        // post_command_action — forward the resolved action to the engine.
        const actionValue = postResult.action;
        const resolvedAction = this._toResolvedAction(actionValue);
        const result = applyItemTransition({
          db: this.db,
          workflowId: wf.id,
          itemId: freshItem.id,
          sessionId,
          stage: freshItem.stage_id,
          phase: freshItem.current_phase ?? '',
          attempt,
          event: 'post_command_action',
          guardCtx: { postCommandAction: resolvedAction, morePhases, nextPhase },
        });
        this._broadcastItemState(wf.id, freshItem.id, freshItem.stage_id, result);

      } else {
        // timeout / spawn_failed / unhandled_exit → treat as session_fail.
        const classifierResult = classify(stderr, {
          parseErrors,
          lastEventType: 'none',
        });
        const result = applyItemTransition({
          db: this.db,
          workflowId: wf.id,
          itemId: freshItem.id,
          sessionId,
          stage: freshItem.stage_id,
          phase: freshItem.current_phase ?? '',
          attempt,
          event: 'session_fail',
          guardCtx: { classifierResult },
        });
        this._broadcastItemState(wf.id, freshItem.id, freshItem.stage_id, result);
      }

    } else {
      // Non-zero exit → session_fail.
      const classifierResult = classify(stderr, { parseErrors, lastEventType: 'none' });
      const result = applyItemTransition({
        db: this.db,
        workflowId: wf.id,
        itemId: freshItem.id,
        sessionId,
        stage: freshItem.stage_id,
        phase: freshItem.current_phase ?? '',
        attempt,
        event: 'session_fail',
        guardCtx: { classifierResult },
      });
      // Arm retry timer if item entered awaiting_retry.
      if (result.newState === 'awaiting_retry') {
        this.retryAfterAt.set(freshItem.id, Date.now() + RETRY_BACKOFF_MS);
      }
      this._broadcastItemState(wf.id, freshItem.id, freshItem.stage_id, result);
    }

    // --- Wrap up session ---
    fixtureWriter?.close(exitCode);
    if (fixtureWriter) clearRecordMarker(this.config.configDir);
    this.broadcastFn(wf.id, sessionId, 'session.ended', {
      sessionId,
      endedAt: new Date().toISOString(),
      exitCode,
      statusFlags: { parseErrors },
      reason: exitCode === 0 ? 'ok' as const : 'fail' as const,
    });
    await logWriter.close();
    endSession(this.db, sessionId, { exitCode, usage: inFlightEntry.usage });
    this.inFlight.delete(item.id);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _readWorkflow(workflowId: string): WorkflowDbRow | null {
    return (this.db.reader()
      .prepare(
        'SELECT id, name, status, current_stage, worktree_path, branch_name FROM workflows WHERE id = ?',
      )
      .get(workflowId) as WorkflowDbRow | undefined) ?? null;
  }

  private _readItem(itemId: string): ItemRow | null {
    return (this.db.reader()
      .prepare('SELECT * FROM items WHERE id = ?')
      .get(itemId) as ItemRow | undefined) ?? null;
  }

  private _readWorkflowItems(workflowId: string): ItemRow[] {
    return this.db.reader()
      .prepare('SELECT * FROM items WHERE workflow_id = ? ORDER BY rowid')
      .all(workflowId) as ItemRow[];
  }

  private _findStage(stageId: string): Stage | undefined {
    return this.config.pipeline.stages.find((s) => s.id === stageId);
  }

  /** Broadcast an item.state frame for each transition. */
  private _broadcastItemState(
    workflowId: string,
    itemId: string,
    stageId: string,
    result: ApplyItemTransitionResult,
  ): void {
    const payload: ItemStatePayload = {
      itemId,
      stageId,
      state: {
        status: result.newState,
        currentPhase: result.newPhase,
        // Read fresh retry/blocked values from SQLite.
        retryCount: (() => {
          const r = this._readItem(itemId);
          return r?.retry_count ?? 0;
        })(),
        blockedReason: (() => {
          const r = this._readItem(itemId);
          return r?.blocked_reason ?? null;
        })(),
      },
    };
    this.broadcastFn(workflowId, null, 'item.state', payload);

    // If the stage just completed, advance the workflow (last stage → terminal status).
    if (result.stageComplete) {
      this._handleStageComplete(workflowId, stageId);
    }
  }

  /**
   * Called when applyItemTransition reports stageComplete=true.
   * Advances workflows.current_stage to the next stage or marks the workflow
   * as completed / completed_with_blocked when the last stage is done.
   *
   * RC-2: all SQLite mutations go through engine functions — no direct
   * db.writer calls here.
   */
  private _handleStageComplete(workflowId: string, completedStageId: string): void {
    const stages = this.config.pipeline.stages;
    const idx = stages.findIndex((s) => s.id === completedStageId);

    if (idx < 0) return; // unknown stage — shouldn't happen

    if (idx < stages.length - 1) {
      // Not the last stage — advance current_stage pointer via engine function.
      const nextStage = stages[idx + 1];
      applyStageAdvance(this.db, workflowId, nextStage.id);
    } else {
      // Last stage completed — determine final workflow status.
      const BLOCKED_STATUSES = ['blocked', 'abandoned'];
      const allItems = this._readWorkflowItems(workflowId);
      const hasBlocked = allItems.some((item) => BLOCKED_STATUSES.includes(item.status));
      const finalStatus: 'completed' | 'completed_with_blocked' = hasBlocked
        ? 'completed_with_blocked'
        : 'completed';

      applyWorkflowComplete(this.db, workflowId, finalStatus);

      this.broadcastFn(workflowId, null, 'workflow.update', {
        workflowId,
        status: finalStatus,
        completedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Converts ActionValue from the prepost grammar into a ResolvedAction
   * understood by the engine's applyItemTransition.
   */
  private _toResolvedAction(
    action: import('../../shared/types/config.js').ActionValue,
  ): import('../pipeline/engine.js').ResolvedAction {
    if (action === 'continue') return { kind: 'continue' };
    if (action === 'stop-and-ask') return { kind: 'stop-and-ask' };
    if (action === 'stop') return { kind: 'stop' };
    if (typeof action === 'object' && 'goto' in action) {
      return { kind: 'goto', goto: action.goto, maxRevisits: action.max_revisits };
    }
    if (typeof action === 'object' && 'retry' in action) {
      return {
        kind: 'retry',
        retry: { mode: action.retry.mode, max: action.retry.max },
      };
    }
    if (typeof action === 'object' && 'fail' in action) {
      return { kind: 'fail', failReason: action.fail.reason };
    }
    return { kind: 'fail' };
  }
}
