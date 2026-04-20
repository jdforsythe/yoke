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
 *     - awaiting_retry    → fire backoff_elapsed after exponential backoff (15 s → 30 s → 1 m → 2 m → …)
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
import fs from 'node:fs';
import path from 'node:path';
import { JSONPath } from 'jsonpath-plus';
import type { DbPool } from '../storage/db.js';
import type { ResolvedConfig } from '../../shared/types/config.js';
import type { Stage, Phase } from '../../shared/types/config.js';
import type { PushResult } from '../github/push.js';
import type { CreatePrInput, CreatePrResult, GithubBroadcastFn } from '../github/service.js';
import { writeGithubState } from '../github/service.js';
import { buildPrBody } from '../github/pr-body.js';
import type { GithubError } from '../github/types.js';
import type { ProcessManager, SpawnHandle } from '../process/manager.js';
import type { WorktreeManager } from '../worktree/manager.js';
import type { RunCommandsOpts, RunCommandsResult, PrePostRunRecord } from '../prepost/runner.js';
import type { ValidateArtifactsResult } from '../artifacts/validator.js';
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
import { ingestWorkflow, makeProductionIngestDeps } from './ingest.js';
import { openSessionLog } from '../session-log/writer.js';
import { StreamJsonParser } from '../process/stream-json.js';
import type { RateLimitDetectedEvent, StreamUsageEvent } from '../process/stream-json.js';
import { classify } from '../state-machine/classifier.js';
import { FixtureWriter } from '../process/fixture-writer.js';
import { readRecordMarker, clearRecordMarker } from '../process/record-marker.js';
import { NoopFaultInjector, FaultInjectionError } from '../fault/injector.js';
import type { FaultInjector } from '../fault/injector.js';
import { takeSnapshot, checkDiff } from '../hook-contract/diff-checker.js';
import type { DiffSnapshot } from '../hook-contract/diff-checker.js';
import { captureGitHead, scanArtifactWrites } from '../hook-contract/artifact-writes.js';
import type { ArtifactWriteRecord } from '../pipeline/engine.js';
import { readLastCheckManifest } from '../hook-contract/manifest-reader.js';
import { seedPerItemStage } from './per-item-seeder.js';
import { injectHookFailure } from '../prepost/handoff-injector.js';

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
  stageItemsFrom?: string;
}) => Promise<string>;

/** Injectable pre/post runner function (maps to runCommands from prepost/runner.ts). */
export type PrePostRunnerFn = (opts: RunCommandsOpts) => Promise<RunCommandsResult>;

/**
 * Injectable artifact validator function.
 * In production: calls validateArtifacts() from artifacts/validator.ts.
 * In tests: returns a stub result.
 *
 * RC-4: called after session exit (exitCode === 0) and before post: commands.
 */
export type ArtifactValidatorFn = (
  artifacts: import('../../shared/types/config.js').OutputArtifact[],
  worktreePath: string,
) => Promise<ValidateArtifactsResult>;

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

/**
 * Injectable notification callback.
 * Called after applyItemTransition whenever a pending_attention row was
 * inserted (result.pendingAttentionRowId !== null). The caller is responsible
 * for reading the DB row and firing the appropriate native / console
 * notification (feat-notifications).
 */
export type NotifyFn = (opts: {
  workflowId: string;
  pendingAttentionRowId: number;
}) => void;

/**
 * Injectable dependencies for the auto-PR path (r2-10).
 *
 * All fields are optional — missing fields use production defaults (lazy
 * dynamic imports) so the Scheduler works without explicit injection.
 * Override in tests to substitute stubs and capture the async task promise.
 */
export interface AutoPrDeps {
  /**
   * Run the async push+PR task.
   * Production default: fire-and-forget (`void task()`).
   * Override in tests to capture the promise: `(t) => { taskPromise = t(); }`
   */
  asyncRunner?: (task: () => Promise<void>) => void;
  /**
   * Push the branch to origin.
   * Production default: calls `pushBranch` from `github/push.ts`.
   */
  push?: (branchName: string, worktreePath: string) => Promise<PushResult>;
  /**
   * Create the GitHub PR.
   * Production default: calls `createPr` from `github/service.ts` with
   * production auth/octokit/gh-cli deps.  Injectable so tests can stub
   * the full GitHub API surface.
   */
  createPr?: (input: CreatePrInput) => Promise<CreatePrResult>;
  /** Return up to 10 recent commit subjects from the worktree. */
  getRecentCommits?: (worktreePath: string) => Promise<string[]>;
  /** Return the note from the last non-harness-injected handoff entry, or null. */
  getLastHandoffNote?: (configDir: string) => Promise<string | null>;
  /** Parse owner + repo from the worktree's git remote origin. */
  getOwnerRepo?: (worktreePath: string) => Promise<{ owner: string; repo: string } | null>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_GRACE_PERIOD_MS = 10_000;
/** Initial backoff for the first transient-retry attempt (ms). */
const RETRY_BACKOFF_INITIAL_MS = 15_000;
/** Maximum backoff cap for transient retries (ms). */
const RETRY_BACKOFF_MAX_MS = 3_600_000; // 1 hour

/**
 * Compute exponential backoff delay for an awaiting_retry item.
 * Schedule: 15 s → 30 s → 1 m → 2 m → 4 m → … (capped at 1 h).
 *
 * @param retryCount  post-increment items.retry_count (1 for first retry).
 */
function computeRetryBackoffMs(retryCount: number): number {
  return Math.min(
    RETRY_BACKOFF_INITIAL_MS * Math.pow(2, Math.max(0, retryCount - 1)),
    RETRY_BACKOFF_MAX_MS,
  );
}
const TERMINAL_WF_STATUSES = ['completed', 'abandoned', 'completed_with_blocked'];

/**
 * Build a human-readable message for a pending_attention notice frame from the
 * kind and payload stored in the DB row.  Exported for unit testing.
 */
export function buildAttentionMessage(kind: string, payload: unknown): string {
  const p =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const stage = typeof p['stage'] === 'string' ? p['stage'] : null;
  switch (kind) {
    case 'bootstrap_failed':
      return stage ? `Bootstrap failed in stage "${stage}"` : 'Bootstrap failed';
    case 'awaiting_user_retry':
      return stage ? `Retries exhausted in stage "${stage}"` : 'Retries exhausted — user action required';
    case 'revisit_limit':
      return stage ? `Revisit limit reached in stage "${stage}"` : 'Revisit limit reached';
    case 'stage_needs_approval':
      return stage ? `Stage "${stage}" requires approval` : 'Stage requires approval';
    case 'seed_failed': {
      const msg = typeof p['message'] === 'string' ? p['message'] : null;
      return msg
        ? `Seeding failed${stage ? ` in stage "${stage}"` : ''}: ${msg}`
        : `Seeding failed${stage ? ` in stage "${stage}"` : ''}`;
    }
    default:
      return `Attention required: ${kind}`;
  }
}

/**
 * Extract the item's stable ID (the value identified by `items_id` JSONPath)
 * from its serialised data, for use in log labels.  Falls back to the raw
 * item UUID when the stage has no `items_id` or parsing fails.
 */
function itemLabel(itemId: string, data: string, stage: { items_id?: string }): string {
  if (!stage.items_id) return itemId;
  try {
    const parsed: unknown = JSON.parse(data);
    const result = JSONPath({ path: stage.items_id, json: parsed as object }) as unknown[];
    const val = result.length === 1 && Array.isArray(result[0]) ? (result[0] as unknown[])[0] : result[0];
    return typeof val === 'string' && val !== '' ? val : itemId;
  } catch {
    return itemId;
  }
}

// ---------------------------------------------------------------------------
// Production defaults for AutoPrDeps (lazy dynamic imports to avoid bloat)
// ---------------------------------------------------------------------------

async function _defaultGetOwnerRepo(worktreePath: string): Promise<{ owner: string; repo: string } | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(execFile);
    const { stdout } = await execAsync('git', ['-C', worktreePath, 'remote', 'get-url', 'origin'], { timeout: 10_000 });
    const { parseGitRemoteUrl } = await import('../github/remote-parse.js');
    return parseGitRemoteUrl(stdout.trim());
  } catch {
    return null;
  }
}

async function _defaultGetRecentCommits(worktreePath: string): Promise<string[]> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(execFile);
    const { stdout } = await execAsync('git', ['-C', worktreePath, 'log', '--format=%s', '-10'], { timeout: 10_000 });
    return stdout.trim().split('\n').filter(Boolean).slice(0, 10);
  } catch {
    return [];
  }
}

async function _defaultGetLastHandoffNote(configDir: string): Promise<string | null> {
  try {
    const handoffPath = path.join(configDir, 'handoff.json');
    if (!fs.existsSync(handoffPath)) return null;
    const raw = fs.readFileSync(handoffPath, 'utf8');
    const data = JSON.parse(raw) as { entries?: unknown[] };
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const last = [...entries].reverse().find((e: unknown) => {
      return typeof e === 'object' && e !== null && !(e as Record<string, unknown>)['harness_injected'];
    });
    if (!last) return null;
    const note = (last as Record<string, unknown>)['note'];
    return typeof note === 'string' ? note : null;
  } catch {
    return null;
  }
}

async function _defaultPush(branchName: string, worktreePath: string): Promise<PushResult> {
  const { pushBranch, makeProductionPushDeps } = await import('../github/push.js');
  return pushBranch(branchName, worktreePath, makeProductionPushDeps());
}

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
  /**
   * Injectable artifact validator. Defaults to the production validateArtifacts()
   * from artifacts/validator.ts. Override in tests to control validation results.
   */
  artifactValidator?: ArtifactValidatorFn;
  /** Poll interval in ms. Default: 500. */
  pollIntervalMs?: number;
  /** Grace period for graceful shutdown drain (ms). Default: 10 000. */
  gracePeriodMs?: number;
  /** Max concurrent sessions. Default: 4. */
  maxParallel?: number;
  /**
   * Fault injection seam for crash-recovery testing.
   * Defaults to NoopFaultInjector (zero overhead in production).
   * Pass an ActiveFaultInjector to trigger crash recovery paths in tests.
   * The caller (not this class) reads YOKE_FAULT_INJECT from the environment
   * and constructs the appropriate implementation (RC-4).
   */
  faultInjector?: FaultInjector;
  /**
   * Optional notification callback (feat-notifications).
   * Called after any applyItemTransition that inserts a pending_attention row.
   * If omitted, no notification dispatch occurs (safe for tests that don't need it).
   */
  notify?: NotifyFn;
  /**
   * Injectable clock function. Defaults to Date.now.
   * Override in tests to control retry timer expiry without real waits.
   */
  now?: () => number;
  /**
   * Injectable auto-PR dependencies (r2-10).
   * If omitted, production defaults are used (lazy dynamic imports).
   * Inject stubs in tests to control push/createPr behaviour.
   */
  autoPr?: AutoPrDeps;
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
  private readonly artifactValidatorFn: ArtifactValidatorFn;
  private readonly assemblePromptFn: PromptAssemblerFn;
  private readonly broadcastFn: BroadcastFn;
  private readonly faultInjector: FaultInjector;
  private readonly notifyFn?: NotifyFn;
  private readonly clockNow: () => number;
  private readonly autoPrDeps: AutoPrDeps | undefined;
  private readonly pollIntervalMs: number;
  private readonly gracePeriodMs: number;
  private readonly maxParallel: number;

  /** workflowId populated by start(). */
  workflowId: string | null = null;

  /** Items currently being managed (bootstrapping, spawning, or running). */
  private readonly inFlight = new Map<string, InFlightEntry>();

  /** itemId → timestamp(ms) when the item may next be retried. */
  private readonly retryAfterAt = new Map<string, number>();

  /**
   * itemId → retry mode to pass back to the engine when backoff_elapsed fires.
   * Set whenever an item enters awaiting_retry, so the engine can re-use the
   * mode that was chosen at transition time (important for transient retries
   * which always use 'fresh_with_failure_summary' regardless of the ladder).
   */
  private readonly retryModeFor = new Map<string, 'continue' | 'fresh_with_failure_summary' | 'fresh_with_diff'>();

  /** itemId → unix seconds when rate-limit window resets. */
  private readonly rateLimitResetAt = new Map<string, number>();

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /**
   * Per-workflow timers for coalesced workflow.index.update broadcasts.
   * Keyed by workflowId; replaced on each scheduleIndexUpdate call within
   * the 500 ms debounce window so rapid status/attention changes produce
   * a single frame rather than one per transition.
   */
  private readonly _indexUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: SchedulerOpts) {
    this.db = opts.db;
    this.config = opts.config;
    this.processManager = opts.processManager;
    this.worktreeManager = opts.worktreeManager;
    this.prepostRunner = opts.prepostRunner;
    // Default to the production validateArtifacts if no override is provided.
    if (opts.artifactValidator) {
      this.artifactValidatorFn = opts.artifactValidator;
    } else {
      // Lazy import so tests that supply a stub never load AJV.
      this.artifactValidatorFn = async (artifacts, worktreePath) => {
        const { validateArtifacts } = await import('../artifacts/validator.js');
        return validateArtifacts(artifacts, worktreePath);
      };
    }
    this.assemblePromptFn = opts.assemblePrompt;
    this.broadcastFn = opts.broadcast;
    this.faultInjector = opts.faultInjector ?? new NoopFaultInjector();
    this.notifyFn = opts.notify;
    this.clockNow = opts.now ?? (() => Date.now());
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
    this.maxParallel = opts.maxParallel ?? DEFAULT_MAX_PARALLEL;
    this.autoPrDeps = opts.autoPr;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Thin wrapper around applyItemTransition that:
   *   1. Broadcasts a notice frame whenever a pending_attention row was inserted
   *      (reads kind + payload from DB so call sites never hardcode them).
   *   2. Fires the optional OS-push notifyFn independently of the WS broadcast.
   *
   * All callers in this file use _applyTransition instead of applyItemTransition
   * directly so that notification dispatch is uniform and not scattered.
   *
   * Broadcast order per transition: DB commit → notice frame → item.state frame
   * (item.state is emitted by the caller via _broadcastItemState after this returns).
   */
  private _applyTransition(
    params: Parameters<typeof applyItemTransition>[0],
  ): ReturnType<typeof applyItemTransition> {
    const result = applyItemTransition(params);
    if (result.pendingAttentionRowId != null) {
      this._emitAttentionNotice(params.workflowId, result.pendingAttentionRowId);
      // A pending_attention row was inserted — schedule workflow.index.update so
      // the sidebar's unreadEvents badge increments without a page reload.
      this.scheduleIndexUpdate(params.workflowId);
    }
    return result;
  }

  /**
   * Reads the pending_attention row and broadcasts a notice frame to all
   * workflow subscribers.  Also fires the optional OS-push notifyFn.
   *
   * Separating this from _applyTransition makes it unit-testable in isolation
   * (RC: private method with injected broadcastFn).
   */
  private _emitAttentionNotice(workflowId: string, pendingAttentionRowId: number): void {
    const row = this.db
      .reader()
      .prepare('SELECT kind, payload FROM pending_attention WHERE id = ?')
      .get(pendingAttentionRowId) as { kind: string; payload: string } | undefined;
    if (!row) return;

    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }

    const message = buildAttentionMessage(row.kind, payload);

    this.broadcastFn(workflowId, null, 'notice', {
      severity: 'requires_attention',
      kind: row.kind,
      message,
      persistedAttentionId: pendingAttentionRowId,
    });

    if (this.notifyFn) {
      this.notifyFn({ workflowId, pendingAttentionRowId });
    }
  }

  /**
   * Arms the in-memory retry timer and mode for an item that just entered
   * awaiting_retry.  Centralises the retryAfterAt / retryModeFor bookkeeping
   * so every path into awaiting_retry (crash recovery, pre_command_failed,
   * validator_fail, diff_check_fail, post_command_action, session_fail) uses
   * the same logic.
   *
   * No-op when result.newState is not awaiting_retry.
   */
  private _armRetryTimer(
    itemId: string,
    retryCount: number,
    result: ApplyItemTransitionResult,
  ): void {
    if (result.newState !== 'awaiting_retry') return;
    this.retryAfterAt.set(itemId, this.clockNow() + computeRetryBackoffMs(retryCount));
    if (result.retryMode) this.retryModeFor.set(itemId, result.retryMode);
  }

  /**
   * Schedule a coalesced workflow.index.update broadcast for the given workflow.
   * Multiple calls within 500 ms produce a single frame — prevents flooding when
   * rapid transitions occur (e.g. a stage with many items all completing at once).
   *
   * Public so start.ts can share this emitter with the ackAttention and
   * controlExecutor callbacks, giving a single per-workflow debounce boundary
   * across all emission sites.
   */
  public scheduleIndexUpdate(workflowId: string): void {
    const existing = this._indexUpdateTimers.get(workflowId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this._indexUpdateTimers.delete(workflowId);
      this._emitIndexUpdate(workflowId);
    }, 500);
    this._indexUpdateTimers.set(workflowId, timer);
  }

  /**
   * Query the DB at emission time and broadcast workflow.index.update.
   * unreadEvents is always computed fresh from pending_attention — never cached.
   */
  private _emitIndexUpdate(workflowId: string): void {
    const wf = this.db.reader()
      .prepare('SELECT id, name, status, updated_at FROM workflows WHERE id = ?')
      .get(workflowId) as { id: string; name: string; status: string; updated_at: string } | undefined;
    if (!wf) return;
    const countRow = this.db.reader()
      .prepare(
        'SELECT COUNT(*) AS cnt FROM pending_attention WHERE workflow_id = ? AND acknowledged_at IS NULL',
      )
      .get(workflowId) as { cnt: number };
    this.broadcastFn(workflowId, null, 'workflow.index.update', {
      id: wf.id,
      name: wf.name,
      status: wf.status,
      updatedAt: wf.updated_at,
      unreadEvents: countRow.cnt,
    });
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
    const { workflowId, isResume } = ingestWorkflow(this.db, this.config, makeProductionIngestDeps());
    this.workflowId = workflowId;
    console.log(`[scheduler] ${isResume ? 'resumed' : 'started'} workflow ${workflowId}`);

    // Step 2: Ensure a worktree exists before the tick loop. This guarantees
    // per-item stages (which read items_from from the worktree) can seed on
    // the first tick, regardless of whether a preceding stage would have
    // bootstrapped one. On resume, an existing worktree is reused if the
    // directory still exists on disk; otherwise it is recreated.
    //
    // Bootstrap commands run iff we just created the worktree. If bootstrap
    // fails, start() throws — the caller surfaces the error to the user.
    await this._ensureWorktree(workflowId);

    // Step 3: Crash recovery — detect stale sessions from a previous run (RC-4).
    const recoveryInfos = buildCrashRecovery(this.db);
    for (const info of recoveryInfos) {
      // Transition stale in_progress items to awaiting_retry or awaiting_user
      // so they are not double-spawned (RC-4: stale sessions ≠ live sessions).
      for (const stale of info.staleSessions) {
        if (!stale.itemId) continue;
        const item = this._readItem(stale.itemId);
        if (!item || item.status !== 'in_progress') continue;
        console.log(`[scheduler] crash recovery: stale session ${stale.sessionId} for ${item.stage_id} → session_fail (transient)`);
        // Fire session_fail with transient classifier → awaiting_retry (auto-restarts).
        // A crashed/killed session is a transient failure, not a permanent one
        // requiring user intervention.
        const recoveryResult = this._applyTransition({
          db: this.db,
          workflowId: info.workflowId,
          itemId: stale.itemId,
          sessionId: stale.sessionId,
          stage: item.stage_id,
          phase: item.current_phase ?? '',
          attempt: item.retry_count + 1,
          event: 'session_fail',
          guardCtx: { classifierResult: 'transient' },
        });
        // End the stale session so it no longer counts against maxParallel.
        // Without this, stale sessions with status='running' inflate the
        // concurrency count and can prevent any new sessions from spawning.
        endSession(this.db, stale.sessionId, { exitCode: null });
        this._armRetryTimer(stale.itemId, item.retry_count + 1, recoveryResult);
        console.log(`[scheduler] crash recovery: ${item.stage_id} → ${recoveryResult.newState}`);
      }
    }

    // Step 3: Start the poll loop (AC-1: scheduling begins within 2 s).
    console.log(`[scheduler] poll loop starting (interval ${this.pollIntervalMs}ms)`);
    this._scheduleTick();
  }

  // -------------------------------------------------------------------------
  // stop — AC-8 (graceful drain)
  // -------------------------------------------------------------------------

  /**
   * Signal the process group for a single in-flight session (SIGTERM →
   * SIGKILL escalation via SpawnHandle.cancel()).
   *
   * Called by the control executor when a workflow is user-cancelled.  The
   * inFlight map is keyed by itemId, so we iterate to locate the entry with
   * a matching sessionId.  Entries in the 'pending' placeholder state have
   * no handle to signal — we skip them (the scheduler tick will drop the
   * placeholder once the pending write resolves and the DB shows the item
   * already in a terminal state).
   *
   * Fire-and-forget: we don't await cancel() so the caller (running inside
   * a synchronous engine transaction boundary) doesn't block on kernel I/O.
   * SpawnHandle.cancel() handles re-entrancy internally.
   */
  killSession(sessionId: string): void {
    for (const [, entry] of this.inFlight) {
      if (entry === 'pending') continue;
      if (entry.sessionId === sessionId) {
        void entry.handle.cancel();
        return;
      }
    }
    // sessionId not in inFlight → already exited or never started.  No-op.
  }

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
    // Clear any pending index-update debounce timers so they don't fire on a
    // closed DB after shutdown.
    for (const timer of this._indexUpdateTimers.values()) {
      clearTimeout(timer);
    }
    this._indexUpdateTimers.clear();

    // Collect session IDs for in-flight entries that have a live handle.
    const inFlightSessionIds: string[] = [];
    const drainPromises: Promise<void>[] = [];
    for (const [, entry] of this.inFlight) {
      if (entry !== 'pending' && entry.handle) {
        inFlightSessionIds.push(entry.sessionId);
        drainPromises.push(entry.handle.cancel());
      }
    }

    // Wait for all cancellations with overall timeout.
    await Promise.race([
      Promise.allSettled(drainPromises),
      new Promise<void>((resolve) => setTimeout(resolve, this.gracePeriodMs)),
    ]);
    console.log('[scheduler] stopped');
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
          const result = this._applyTransition({
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
            console.log(`[scheduler] ${item.stage_id} pending → ${result.newState}`);
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

          // ------------------------------------------------------------------
          // Per-item seeding: intercept before phase_start.
          // When a per-item stage's placeholder item is ready, seed real item
          // rows from the manifest instead of spawning a session.
          //
          // item.data === '{}' identifies the placeholder (created by ingest
          // with no manifest data). Real seeded items have actual manifest
          // data and must NOT be re-seeded — they fall through to phase_start.
          // ------------------------------------------------------------------
          if (stage.run === 'per-item' && item.data === '{}') {
            const worktreePath = wf.worktree_path;
            if (!worktreePath) {
              // Worktree not yet created — wait for the bootstrap phase of a
              // preceding stage to populate it.
              break;
            }
            const seedResult = seedPerItemStage({
              db: this.db,
              workflowId: wf.id,
              placeholderItemId: item.id,
              worktreePath,
              stage,
            });
            if (seedResult.kind === 'error') {
              // Truncate very long error messages to keep the payload human-readable.
              const truncated = seedResult.message.length > 500
                ? seedResult.message.slice(0, 500) + '…'
                : seedResult.message;
              console.error(
                `[scheduler] per-item seeding failed for stage '${stage.id}':`,
                truncated,
              );
              // Transition placeholder to awaiting_user and insert pending_attention
              // so the user is notified. The _applyTransition wrapper broadcasts the
              // notice frame and schedules a workflow.index.update debounce.
              const failResult = this._applyTransition({
                db: this.db,
                workflowId: wf.id,
                itemId: item.id,
                sessionId: null,
                stage: item.stage_id,
                phase: item.current_phase ?? '',
                attempt: item.retry_count + 1,
                event: 'seed_failed',
                guardCtx: {
                  customAttentionPayload: {
                    message: truncated,
                    stage: item.stage_id,
                    item_id: item.id,
                  },
                },
              });
              this._broadcastItemState(wf.id, item.id, item.stage_id, failResult);
            }
            // On success: placeholder deleted, real items pending — next tick
            // picks them up.  On seed_failed: placeholder now in awaiting_user —
            // no further seeding until user_retry fires (handled in in_progress).
            break;
          }

          const phaseIdx = stage.phases.indexOf(item.current_phase ?? '');
          const morePhases = phaseIdx >= 0 && phaseIdx < stage.phases.length - 1;
          const nextPhase = morePhases ? stage.phases[phaseIdx + 1] : undefined;

          const result = this._applyTransition({
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
            console.log(`[scheduler] ${item.stage_id}/${item.current_phase} → bootstrapping worktree`);
            this.inFlight.set(item.id, 'pending');
            effectiveRunning++;
            void this._doBootstrapThenSpawn(wf, item, stage);
          } else if (result.newState === 'in_progress') {
            console.log(`[scheduler] ${item.stage_id}/${item.current_phase} → in_progress (resume path)`);
            this.inFlight.set(item.id, 'pending');
            effectiveRunning++;
            void this._runSession(wf, this._readItem(item.id) ?? item, stage);
          }
          break;
        }

        // ------------------------------------------------------------------
        // in_progress without an active session → spawn (crash resume path)
        // or re-seed if this is a per-item placeholder after user_retry on
        // a seed_failed item.
        // ------------------------------------------------------------------
        case 'in_progress': {
          if (this.inFlight.has(item.id)) break;
          if (effectiveRunning >= this.maxParallel) break;

          const stage = this._findStage(item.stage_id);
          if (!stage) break;

          // Per-item placeholder: re-run seeding instead of spawning a session.
          // This handles the user_retry path after a seed_failed transition.
          if (stage.run === 'per-item' && item.data === '{}') {
            const worktreePath = wf.worktree_path;
            if (!worktreePath) break;

            // Transition placeholder back to ready so the seeder path runs on
            // the next tick (we avoid mutating state twice in a single tick).
            // Re-seed directly here and let the result guide the next state.
            const seedResult = seedPerItemStage({
              db: this.db,
              workflowId: wf.id,
              placeholderItemId: item.id,
              worktreePath,
              stage,
            });
            if (seedResult.kind === 'error') {
              const truncated = seedResult.message.length > 500
                ? seedResult.message.slice(0, 500) + '…'
                : seedResult.message;
              console.error(
                `[scheduler] per-item re-seeding failed for stage '${stage.id}':`,
                truncated,
              );
              // Re-fire seed_failed to insert a fresh pending_attention row and
              // notify the user again. The previous pending_attention row from the
              // first failure remains acknowledged (if the user acked it) or not;
              // either way a new row is created per retry.
              const failResult = this._applyTransition({
                db: this.db,
                workflowId: wf.id,
                itemId: item.id,
                sessionId: null,
                stage: item.stage_id,
                phase: item.current_phase ?? '',
                attempt: item.retry_count + 1,
                event: 'seed_failed',
                guardCtx: {
                  customAttentionPayload: {
                    message: truncated,
                    stage: item.stage_id,
                    item_id: item.id,
                  },
                },
              });
              this._broadcastItemState(wf.id, item.id, item.stage_id, failResult);
            }
            // On success: placeholder deleted, real items pending — next tick picks up.
            // On error: back to awaiting_user — user must retry again.
            break;
          }

          this.inFlight.set(item.id, 'pending');
          effectiveRunning++;
          void this._runSession(wf, item, stage);
          break;
        }

        // ------------------------------------------------------------------
        // awaiting_retry → fire backoff_elapsed after exponential backoff
        // ------------------------------------------------------------------
        case 'awaiting_retry': {
          // Arm a retry timer if not already set.
          if (!this.retryAfterAt.has(item.id)) {
            this.retryAfterAt.set(item.id, this.clockNow() + computeRetryBackoffMs(item.retry_count));
          }
          const retryAt = this.retryAfterAt.get(item.id)!;
          if (this.clockNow() < retryAt) break;

          const result = this._applyTransition({
            db: this.db,
            workflowId: wf.id,
            itemId: item.id,
            sessionId: null,
            stage: item.stage_id,
            phase: item.current_phase ?? '',
            attempt: item.retry_count + 1,
            event: 'backoff_elapsed',
            guardCtx: { currentRetryMode: this.retryModeFor.get(item.id) },
          });
          this._broadcastItemState(wf.id, item.id, item.stage_id, result);
          this.retryAfterAt.delete(item.id);
          this.retryModeFor.delete(item.id);
          break;
        }

        // ------------------------------------------------------------------
        // rate_limited → fire rate_limit_window_elapsed after reset_at
        // ------------------------------------------------------------------
        case 'rate_limited': {
          const resetAt = this.rateLimitResetAt.get(item.id);
          // If reset_at is unknown (scheduler restart), fire immediately.
          if (resetAt !== undefined && Date.now() < resetAt * 1000) break;

          const result = this._applyTransition({
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
          console.log(`[scheduler] creating worktree for ${wf.name} in ${baseDir}`);
          wtInfo = await this.worktreeManager.createWorktree({
            workflowId: wf.id,
            workflowName: wf.name,
            baseDir,
            branchPrefix: this.config.worktrees?.branch_prefix ?? 'yoke/',
          });
          console.log(`[scheduler] worktree created: ${wtInfo.worktreePath} (${wtInfo.branchName})`);
        } catch (err) {
          // Worktree creation failed → bootstrap_fail (triggers pending_attention).
          console.error(`[scheduler] worktree creation failed for ${item.stage_id}:`, err);
          const result = this._applyTransition({
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

      // Checkpoint: bootstrap_ok (AC-2).
      // Injecting a fault here simulates a crash between bootstrap succeeding
      // and the bootstrap_ok transition being committed to SQLite.  The catch
      // block below treats FaultInjectionError as bootstrap_fail so the item
      // enters the bootstrap_fail recovery path without a scheduler restart.
      if (bootstrapEvent.type === 'bootstrap_ok') {
        this.faultInjector.check('bootstrap_ok');
      }

      const result = this._applyTransition({
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
        console.log(`[scheduler] bootstrap ok for ${item.stage_id}, spawning session`);
        // Bootstrap succeeded — continue to session spawn without a tick delay.
        const freshItem = this._readItem(item.id);
        if (freshItem) {
          const freshWf = this._readWorkflow(wf.id);
          if (freshWf) {
            await this._runSession(freshWf, freshItem, stage);
            return;
          }
        }
      } else {
        console.error(`[scheduler] bootstrap failed for ${item.stage_id}: newState=${result.newState}`);
      }
    } catch (err) {
      if (err instanceof FaultInjectionError) {
        // Fault injection at bootstrap_ok: simulate a crash before the
        // bootstrap_ok transition is committed.  Fire bootstrap_fail so the
        // item enters the bootstrap_fail recovery path (AC-2).
        const result = this._applyTransition({
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
      } else {
        console.error(`[scheduler] bootstrap error for item ${item.id}:`, err);
      }
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
    // Early-bail stop guard: we haven't spawned or inserted a session yet, so
    // there's nothing to fail — just drop the inFlight reservation. The item
    // is already at status='in_progress' (from phase_start / resume); on the
    // next start the tick-loop's in_progress case will respawn. No retry-
    // ladder context was accrued because nothing ran, so a bare respawn is
    // the correct recovery. This path intentionally does NO DB writes: the
    // caller may have already closed the writer during shutdown.
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

    // --- feat-hook-contract: pre-session snapshots (RC-1, RC-2) ---
    // Both captures happen before insertSession so they strictly precede spawn.
    const itemsFromPath = stage.items_from;
    const diffSnapshot: DiffSnapshot = takeSnapshot(worktreePath, itemsFromPath);
    const preSessionHead: string | null = await captureGitHead(worktreePath);

    // Guard: if stop() was called while awaiting captureGitHead, bail before any
    // DB write. stop() skips 'pending' inFlight entries (no handle yet), so without
    // this check a dangling _runSession could call insertSession on a closed DB.
    // Same rationale as the early-bail guard above: nothing spawned, no session
    // row, no retry-ladder context to preserve. Item stays at in_progress; the
    // next start respawns via the tick-loop in_progress case. DO NOT write to
    // the DB here — it may already be closed during shutdown.
    if (this.stopped) {
      this.inFlight.delete(item.id);
      return;
    }

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
    // Collect runs for later persistence via the engine (AC-6, RC-4).
    let preRuns: PrePostRunRecord[] = [];
    if (phaseConfig.pre && phaseConfig.pre.length > 0) {
      const preResult = await this.prepostRunner({
        commands: phaseConfig.pre,
        worktreePath,
        logWriter,
        when: 'pre',
        env: correlationEnv,
      });
      preRuns = preResult.runs;

      if (preResult.kind !== 'complete') {
        // Pre-command blocked spawn.
        const preAction = preResult.kind === 'action'
          ? (preResult.action === 'stop-and-ask' ? 'stop-and-ask' as const : 'fail' as const)
          : 'fail' as const;

        const result = this._applyTransition({
          db: this.db,
          workflowId: wf.id,
          itemId: item.id,
          sessionId,
          stage: item.stage_id,
          phase: phaseKey,
          attempt,
          event: 'pre_command_failed',
          guardCtx: { preCommandAction: preAction, prepostRuns: preRuns },
        });
        this._armRetryTimer(item.id, attempt, result);
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
        stageItemsFrom: stage.items_from,
        itemId: item.id,
        itemData: item.data,
        itemStatus: item.status,
        itemCurrentPhase: item.current_phase,
        itemRetryCount: item.retry_count,
        itemBlockedReason: item.blocked_reason,
      });
    } catch (err) {
      console.error(`[scheduler] prompt assembly failed for item ${item.id}:`, err);
      // Route through _applyTransition so the centralized emitter broadcasts
      // a notice frame with persistedAttentionId (AC-4: no bare notice).
      const result = this._applyTransition({
        db: this.db,
        workflowId: wf.id,
        itemId: item.id,
        sessionId,
        stage: item.stage_id,
        phase: phaseKey,
        attempt,
        event: 'session_fail',
        // Use 'permanent' so applyPendingSideEffects inserts a pending_attention
        // row and _emitAttentionNotice broadcasts a notice with persistedAttentionId
        // (AC-4: prompt_assembly_failed must not emit a bare notice).
        guardCtx: { classifierResult: 'permanent' },
      });
      this._broadcastItemState(wf.id, item.id, item.stage_id, result);
      await logWriter.close();
      endSession(this.db, sessionId, { exitCode: null });
      this.inFlight.delete(item.id);
      return;
    }

    // --- Spawn session (RC-3: after in_progress transition is committed) ---
    console.log(`[scheduler] spawning ${item.stage_id}/${itemLabel(item.id, item.data, stage)}/${phaseKey} attempt=${attempt} cwd=${worktreePath}`);
    console.log(`[scheduler]   cmd: ${phaseConfig.command} ${phaseConfig.args.join(' ')}`);
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
      console.log(`[scheduler] spawned pid=${handle.pid} session=${sessionId}`);
    } catch (err) {
      console.error(`[scheduler] spawn failed for item ${item.id}:`, err);
      const result = this._applyTransition({
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

    // Guard: if stop() was called while we were spawning, cancel immediately
    // and transition the item to awaiting_retry via session_fail (transient)
    // so the retry ladder resumes cleanly on the next start. Without the
    // transition, the item is stuck at status='in_progress' and the session
    // row is orphaned at status='running' with pid IS NULL (so crash recovery
    // skips it). The tick loop would then fallback-respawn without retry
    // bookkeeping.
    if (this.stopped) {
      void handle.cancel();
      const result = this._applyTransition({
        db: this.db,
        workflowId: wf.id,
        itemId: item.id,
        sessionId,
        stage: item.stage_id,
        phase: phaseKey,
        attempt,
        event: 'session_fail',
        guardCtx: { classifierResult: 'transient' },
      });
      this._armRetryTimer(item.id, attempt, result);
      this._broadcastItemState(wf.id, item.id, item.stage_id, result);
      await logWriter.close();
      endSession(this.db, sessionId, { exitCode: null });
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

    // Broadcast session.started with itemId so the client can upsert itemActiveSession.
    this.broadcastFn(wf.id, sessionId, 'session.started', {
      sessionId,
      itemId: item.id,
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
      const result = this._applyTransition({
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
    console.log(`[scheduler] session exited pid=${handle.pid} exitCode=${exitCode} stage=${item.stage_id}/${phaseKey}`);
    if (stderr) {
      console.error(`[scheduler] stderr (${stderr.length}b): ${stderr.slice(0, 300)}`);
    }

    // Guard: if stop() was called while session ran, fire session_fail
    // (transient) so the item re-enters the retry ladder on the next start.
    // Without this event, the item is left at status='in_progress' in SQLite
    // AND the session row is marked 'failed' (so buildCrashRecovery skips it
    // on the next start). The tick loop's in_progress fallback would then
    // respawn a bare session with no retry_count bump, no failure-summary
    // injection, and no record that the prior attempt was interrupted.
    //
    // All DB writes in this block are wrapped: stop() may have been followed
    // by db.close() before this path executes (the drain only awaits
    // handle.cancel(), not _runSession). If the writer is closed, fall back
    // to buildCrashRecovery on the next start — it detects stale sessions
    // and fires session_fail the same way this block would.
    if (this.stopped) {
      try {
        const result = this._applyTransition({
          db: this.db,
          workflowId: wf.id,
          itemId: item.id,
          sessionId,
          stage: item.stage_id,
          phase: phaseKey,
          attempt,
          event: 'session_fail',
          guardCtx: { classifierResult: 'transient' },
        });
        this._armRetryTimer(item.id, attempt, result);
        this._broadcastItemState(wf.id, item.id, item.stage_id, result);
        fixtureWriter?.close(exitCode);
        if (fixtureWriter) clearRecordMarker(this.config.configDir);
        this.broadcastFn(wf.id, sessionId, 'session.ended', {
          sessionId,
          endedAt: new Date().toISOString(),
          exitCode,
          statusFlags: { parseErrors },
          reason: 'fail' as const,
        });
        await logWriter.close();
        endSession(this.db, sessionId, { exitCode, usage: inFlightEntry.usage });
      } catch (err) {
        // DB likely already closed during shutdown — crash recovery picks up
        // on next start. Item remains in_progress, session row stays 'running';
        // buildCrashRecovery transitions them correctly on the next start().
        console.warn('[scheduler] stopped-guard DB write failed (likely shutdown race):', err);
      }
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

    try {

    if (exitCode === 0) {
      // --- Artifact validators (RC-4: after session exit, before post commands) ---
      const artifacts = phaseConfig.output_artifacts ?? [];
      const validationResult = await this.artifactValidatorFn(artifacts, worktreePath);

      // Checkpoint: artifact_validators (AC-5).
      // Injecting here simulates a crash after validators pass but before
      // post commands run.  The session_ok catch path (below) handles the item.
      if (validationResult.kind !== 'validator_fail') {
        this.faultInjector.check('artifact_validators');
      }

      if (validationResult.kind === 'validator_fail') {
        // One or more artifacts failed validation — fire validator_fail event.
        // Post commands are skipped (they run only when all validators pass).
        const result = this._applyTransition({
          db: this.db,
          workflowId: wf.id,
          itemId: freshItem.id,
          sessionId,
          stage: freshItem.stage_id,
          phase: freshItem.current_phase ?? '',
          attempt,
          event: 'validator_fail',
          guardCtx: { prepostRuns: preRuns },
        });
        this._armRetryTimer(freshItem.id, attempt, result);
        this._broadcastItemState(wf.id, freshItem.id, freshItem.stage_id, result);
        fixtureWriter?.close(exitCode);
        if (fixtureWriter) clearRecordMarker(this.config.configDir);
        this.broadcastFn(wf.id, sessionId, 'session.ended', {
          sessionId,
          endedAt: new Date().toISOString(),
          exitCode,
          statusFlags: { parseErrors },
          reason: 'validator_fail' as const,
        });
        await logWriter.close();
        endSession(this.db, sessionId, { exitCode, usage: inFlightEntry.usage });
        this.inFlight.delete(item.id);
        return;
      }

      // --- feat-hook-contract: post-session surfaces ---

      // AC-3 / RC-2: scan worktree diff; sha256 via streaming hash.
      // Runs after artifact validators (ordering per hook-contract.md §2).
      const artifactWrites: ArtifactWriteRecord[] =
        await scanArtifactWrites(worktreePath, preSessionHead);

      // AC-4/AC-5/AC-6: read optional .yoke/last-check.json manifest.
      const manifestResult = readLastCheckManifest(worktreePath);
      if (manifestResult.kind === 'malformed') {
        // AC-5: malformed manifest → warn; MUST NOT affect phase acceptance (RC-3).
        this.broadcastFn(wf.id, sessionId, 'stream.system_notice', {
          source: 'hook',
          severity: 'warn',
          message: `Malformed .yoke/last-check.json: ${manifestResult.detail}`,
        });
      } else if (manifestResult.kind === 'unknown_version') {
        // AC-6: unknown hook_version → warning badge + raw JSON passthrough.
        this.broadcastFn(wf.id, sessionId, 'stream.system_notice', {
          source: 'hook',
          severity: 'warn',
          message: `Unknown hook_version "${String(manifestResult.hookVersion)}" in .yoke/last-check.json`,
          rawJson: manifestResult.rawJson,
        });
      }

      // AC-1/AC-2: items_from diff check (RC-1: pre-phase snapshot, not git history).
      const diffResult = checkDiff(diffSnapshot, worktreePath, itemsFromPath);
      if (diffResult.kind === 'fail') {
        // diff_check_fail: fire event and skip post commands.
        const result = this._applyTransition({
          db: this.db,
          workflowId: wf.id,
          itemId: freshItem.id,
          sessionId,
          stage: freshItem.stage_id,
          phase: freshItem.current_phase ?? '',
          attempt,
          event: 'diff_check_fail',
          guardCtx: { prepostRuns: preRuns, artifactWrites },
        });
        this._armRetryTimer(freshItem.id, attempt, result);
        this._broadcastItemState(wf.id, freshItem.id, freshItem.stage_id, result);
        fixtureWriter?.close(exitCode);
        if (fixtureWriter) clearRecordMarker(this.config.configDir);
        this.broadcastFn(wf.id, sessionId, 'session.ended', {
          sessionId,
          endedAt: new Date().toISOString(),
          exitCode,
          statusFlags: { parseErrors },
          reason: 'diff_check_fail' as const,
        });
        await logWriter.close();
        endSession(this.db, sessionId, { exitCode, usage: inFlightEntry.usage });
        this.inFlight.delete(item.id);
        return;
      }
      // diffResult.kind === 'ok' or 'skip' → continue to post commands.

      // --- Post: commands (AC-5) ---
      let postResult: RunCommandsResult = { kind: 'complete', runs: [] };
      if (phaseConfig.post && phaseConfig.post.length > 0) {
        console.log(`[scheduler] running ${phaseConfig.post.length} post-command(s) for ${item.stage_id}/${phaseKey}`);
        postResult = await this.prepostRunner({
          commands: phaseConfig.post,
          worktreePath,
          logWriter,
          when: 'post',
          env: correlationEnv,
        });
        console.log(`[scheduler] post-commands result: kind=${postResult.kind}${postResult.kind === 'action' ? ` action=${JSON.stringify(postResult.action)}` : ''}`);
      }

      // All runs (pre + post) are persisted together with the state transition.
      const allRuns: PrePostRunRecord[] = [...preRuns, ...postResult.runs];

      if (postResult.kind === 'complete') {
        // Checkpoint: post_commands_ok — all post commands passed (AC-5).
        // Injecting here simulates a crash between post commands completing
        // and the session_ok transition being committed to SQLite.
        this.faultInjector.check('post_commands_ok');

        // Checkpoint: session_ok — commit the successful session outcome (AC-3).
        // Injecting here simulates a crash immediately before session_ok is
        // written to SQLite, triggering the crash-recovery restart projection
        // path on the next scheduler start (stale PID in sessions table).
        this.faultInjector.check('session_ok');

        // session_ok → complete (last phase) or in_progress (advance phase).
        const result = this._applyTransition({
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
            prepostRuns: allRuns,
            artifactWrites,
          },
        });
        console.log(`[scheduler] ${freshItem.stage_id}/${freshItem.current_phase} session_ok → ${result.newState}${result.newPhase ? `/${result.newPhase}` : ''}`);
        this._broadcastItemState(wf.id, freshItem.id, freshItem.stage_id, result);

      } else if (postResult.kind === 'action') {
        // post_command_action — forward the resolved action to the engine.
        const actionValue = postResult.action;
        const resolvedAction = this._toResolvedAction(actionValue);
        const result = this._applyTransition({
          db: this.db,
          workflowId: wf.id,
          itemId: freshItem.id,
          sessionId,
          stage: freshItem.stage_id,
          phase: freshItem.current_phase ?? '',
          attempt,
          event: 'post_command_action',
          guardCtx: { postCommandAction: resolvedAction, morePhases, nextPhase, prepostRuns: allRuns, artifactWrites },
        });
        this._armRetryTimer(freshItem.id, attempt, result);
        console.log(`[scheduler] ${freshItem.stage_id}/${freshItem.current_phase} post_command_action=${JSON.stringify(resolvedAction)} → ${result.newState}${result.newPhase ? `/${result.newPhase}` : ''}`);

        // Inject the failed hook's output into handoff.json so the next agent
        // spawn sees it via {{handoff}} or a direct Read of handoff.json.
        // Covers two cases:
        //   1. retry:fresh_with_failure_summary → awaiting_retry: the failure
        //      context is in the file when the scheduler re-spawns after backoff.
        //   2. goto → in_progress: the re-entered phase (e.g. implement) gets the
        //      hook output (e.g. check-features JSON validation error) immediately.
        const failedRun = postResult.runs.at(-1);
        if (failedRun && failedRun.output) {
          const shouldInject =
            (result.newState === 'awaiting_retry' && result.retryMode === 'fresh_with_failure_summary') ||
            (resolvedAction.kind === 'goto' && result.newState === 'in_progress');
          if (shouldInject) {
            injectHookFailure(worktreePath, {
              phase: phaseKey,
              attempt,
              sessionId,
              command: failedRun.commandName,
              exitCode: failedRun.exitCode,
              output: failedRun.output,
            });
          }
        }

        if (result.newState === 'awaiting_user') {
          console.log(`[scheduler] ATTENTION NEEDED: ${freshItem.stage_id}/${freshItem.current_phase} requires user action (run: yoke ack ${wf.id})`);
        }
        this._broadcastItemState(wf.id, freshItem.id, freshItem.stage_id, result);

        // Explicit session.ended — the generic wrap-up below infers reason from
        // the agent's exitCode (0 ⇒ 'ok'), which would mislabel this session as
        // successful even though a post-command returned a non-continue action.
        fixtureWriter?.close(exitCode);
        if (fixtureWriter) clearRecordMarker(this.config.configDir);
        this.broadcastFn(wf.id, sessionId, 'session.ended', {
          sessionId,
          endedAt: new Date().toISOString(),
          exitCode,
          statusFlags: { parseErrors },
          reason: 'post_command_action' as const,
        });
        await logWriter.close();
        endSession(this.db, sessionId, { exitCode, usage: inFlightEntry.usage });
        this.inFlight.delete(item.id);
        return;

      } else {
        // timeout / spawn_failed / unhandled_exit → treat as session_fail.
        const classifierResult = classify(stderr, {
          parseErrors,
          lastEventType: 'none',
        });
        const result = this._applyTransition({
          db: this.db,
          workflowId: wf.id,
          itemId: freshItem.id,
          sessionId,
          stage: freshItem.stage_id,
          phase: freshItem.current_phase ?? '',
          attempt,
          event: 'session_fail',
          guardCtx: { classifierResult, prepostRuns: allRuns },
        });
        this._armRetryTimer(freshItem.id, attempt, result);
        // Inject partial output captured before the timeout/error.
        if (result.newState === 'awaiting_retry' && result.retryMode === 'fresh_with_failure_summary') {
          const failedRun = postResult.runs.at(-1);
          if (failedRun && failedRun.output) {
            injectHookFailure(worktreePath, {
              phase: phaseKey,
              attempt,
              sessionId,
              command: failedRun.commandName,
              exitCode: failedRun.exitCode,
              output: failedRun.output,
            });
          }
        }
        if (result.newState === 'awaiting_user') {
          console.log(`[scheduler] ATTENTION NEEDED: ${freshItem.stage_id}/${freshItem.current_phase} requires user action (run: yoke ack ${wf.id})`);
        }
        this._broadcastItemState(wf.id, freshItem.id, freshItem.stage_id, result);

        // Explicit session.ended — same reason as the action branch above: the
        // generic wrap-up would report reason: 'ok' because the agent exited 0,
        // which hides the post-command timeout / spawn failure from the UI.
        fixtureWriter?.close(exitCode);
        if (fixtureWriter) clearRecordMarker(this.config.configDir);
        this.broadcastFn(wf.id, sessionId, 'session.ended', {
          sessionId,
          endedAt: new Date().toISOString(),
          exitCode,
          statusFlags: { parseErrors },
          reason: 'post_command_fail' as const,
        });
        await logWriter.close();
        endSession(this.db, sessionId, { exitCode, usage: inFlightEntry.usage });
        this.inFlight.delete(item.id);
        return;
      }

    } else {
      // Non-zero exit → session_fail. Only pre runs (post commands are skipped
      // when the agent exits non-zero, per AC-3).
      const classifierResult = classify(stderr, { parseErrors, lastEventType: 'none' });
      console.log(`[scheduler] ${freshItem.stage_id}/${freshItem.current_phase} session_fail exitCode=${exitCode} classifier=${classifierResult}`);
      const result = this._applyTransition({
        db: this.db,
        workflowId: wf.id,
        itemId: freshItem.id,
        sessionId,
        stage: freshItem.stage_id,
        phase: freshItem.current_phase ?? '',
        attempt,
        event: 'session_fail',
        guardCtx: { classifierResult, prepostRuns: preRuns },
      });
      this._armRetryTimer(freshItem.id, attempt, result);
      // Inject agent stderr for fresh_with_failure_summary outer-ladder retries.
      if (result.newState === 'awaiting_retry' && result.retryMode === 'fresh_with_failure_summary') {
        const failureOutput = stderr.trim();
        if (failureOutput) {
          injectHookFailure(worktreePath, {
            phase: phaseKey,
            attempt,
            sessionId,
            command: `${phaseKey}-agent`,
            exitCode: exitCode ?? null,
            output: failureOutput,
          });
        }
      }
      console.log(`[scheduler] → ${result.newState}`);
      if (result.newState === 'awaiting_user') {
        console.log(`[scheduler] ATTENTION NEEDED: ${freshItem.stage_id}/${freshItem.current_phase} requires user action (run: yoke ack ${wf.id})`);
      }
      this._broadcastItemState(wf.id, freshItem.id, freshItem.stage_id, result);
    }

    } catch (err) {
      if (err instanceof FaultInjectionError) {
        // Simulated crash: clean up I/O but leave the session row as 'running'
        // with its PID intact.  On the next scheduler start, buildCrashRecovery
        // probes the stale PID (ESRCH) and fires session_fail via the normal
        // crash-recovery restart projection path (AC-3).
        fixtureWriter?.close(exitCode);
        if (fixtureWriter) clearRecordMarker(this.config.configDir);
        await logWriter.close();
        this.inFlight.delete(item.id);
        return;
      }
      throw err; // re-raise unexpected errors
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

  /**
   * Ensure a worktree exists for the given workflow before the tick loop
   * begins. Called from start() once, after ingestWorkflow.
   *
   *   - worktree_path null:    create worktree + run bootstrap commands.
   *   - worktree_path set and directory present on disk: reuse as-is.
   *   - worktree_path set but directory missing (user deleted .worktrees/,
   *     or a prior crash left the DB ahead of the filesystem): recreate +
   *     rebootstrap, persisting the new path via applyWorktreeCreated.
   *
   * Bootstrap commands run only when we create a worktree here — on reuse
   * they are assumed to have succeeded in the prior run (the state machine
   * sets worktree_path only after applyWorktreeCreated, which follows a
   * successful createWorktree; bootstrap failures do not overwrite it).
   *
   * Throws on createWorktree or bootstrap failure. Caller (start.ts)
   * surfaces the error to the user and exits non-zero.
   */
  private async _ensureWorktree(workflowId: string): Promise<void> {
    const wf = this._readWorkflow(workflowId);
    if (!wf) throw new Error(`Workflow not found after ingest: ${workflowId}`);

    // Reuse path — on-disk check guards against DB/filesystem divergence.
    if (wf.worktree_path && fs.existsSync(wf.worktree_path)) {
      console.log(`[scheduler] reusing existing worktree: ${wf.worktree_path}`);
      return;
    }

    const baseDir = this.config.worktrees?.base_dir
      ? path.resolve(this.config.configDir, this.config.worktrees.base_dir)
      : path.join(this.config.configDir, '.worktrees');

    console.log(`[scheduler] creating worktree for ${wf.name} in ${baseDir}`);
    const wtInfo = await this.worktreeManager.createWorktree({
      workflowId: wf.id,
      workflowName: wf.name,
      baseDir,
      branchPrefix: this.config.worktrees?.branch_prefix ?? 'yoke/',
    });
    console.log(`[scheduler] worktree created: ${wtInfo.worktreePath} (${wtInfo.branchName})`);

    // Persist via engine function (RC-2: no direct writer calls from scheduler).
    applyWorktreeCreated({
      db: this.db,
      workflowId,
      branchName: wtInfo.branchName,
      worktreePath: wtInfo.worktreePath,
    });

    const commands = this.config.worktrees?.bootstrap?.commands ?? [];
    if (commands.length > 0) {
      console.log(`[scheduler] running ${commands.length} bootstrap command(s)`);
      const event = await this.worktreeManager.runBootstrap({
        worktreePath: wtInfo.worktreePath,
        commands,
      });
      if (event.type === 'bootstrap_fail') {
        throw new Error(
          `Bootstrap failed for workflow ${workflowId}: command '${event.failedCommand}' ` +
          `exited ${event.exitCode}\n${event.stderr}`,
        );
      }
      console.log(`[scheduler] bootstrap ok`);
    }
  }

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

      // Coalesced index update — sidebar chip needs the new terminal status.
      this.scheduleIndexUpdate(workflowId);

      // Auto-PR: if github.enabled + auto_pr, push branch and create PR.
      // Runs on its own promise chain so the scheduler tick is not blocked.
      if (this.config.github?.enabled && this.config.github?.auto_pr) {
        this._triggerAutoPr(workflowId);
      }
    }
  }

  /**
   * Fire-and-forget auto-PR task: pushBranch → createPr.
   *
   * All errors are caught and written to github_state='failed' — never thrown
   * out of this method (RC: errors never throw out of _handleStageComplete).
   * The async task runs on its own promise chain via the injected asyncRunner
   * (default: fire-and-forget) so the scheduler tick is not blocked (RC-4).
   */
  private _triggerAutoPr(workflowId: string): void {
    const deps = this.autoPrDeps;
    const asyncRunner = deps?.asyncRunner ?? ((task) => { void task(); });

    asyncRunner(async () => {
      try {
        const wf = this._readWorkflow(workflowId);
        if (!wf?.branch_name || !wf?.worktree_path) {
          console.warn(`[scheduler] auto-PR: missing branch_name or worktree_path for ${workflowId}`);
          return;
        }

        // Resolve owner/repo from the remote URL.
        const getOwnerRepo = deps?.getOwnerRepo ?? _defaultGetOwnerRepo;
        const ownerRepo = await getOwnerRepo(wf.worktree_path);
        if (!ownerRepo) {
          console.warn(`[scheduler] auto-PR: could not resolve owner/repo for ${workflowId}`);
          return;
        }

        // Build PR body from recent commits + last handoff note.
        const getRecentCommits = deps?.getRecentCommits ?? _defaultGetRecentCommits;
        const getLastHandoffNote = deps?.getLastHandoffNote ?? _defaultGetLastHandoffNote;
        const recentCommits = await getRecentCommits(wf.worktree_path);
        const lastHandoffNote = await getLastHandoffNote(this.config.configDir);
        const body = buildPrBody({ workflowName: wf.name, recentCommits, lastHandoffNote });

        const ghBroadcast = this._makeGithubBroadcast();

        // Push branch first.
        const pushFn = deps?.push ?? _defaultPush;
        const pushResult = await pushFn(wf.branch_name, wf.worktree_path);
        if (!pushResult.ok) {
          const error: GithubError = {
            kind: 'api_failed',
            message: `git push failed (${pushResult.kind}): ${pushResult.rawStderr}`,
          };
          writeGithubState(this.db, workflowId, 'failed', { error }, ghBroadcast);
          return;
        }

        // Create PR — createPr writes its own state transitions internally.
        // When not injected, build the production createPr function inline so
        // we have access to this.db via the closure.
        const db = this.db;
        const createPrFn: (input: CreatePrInput) => Promise<CreatePrResult> = deps?.createPr ?? (async (inp) => {
          const { createPr } = await import('../github/service.js');
          const { makeProductionAuthDeps } = await import('../github/auth.js');
          const { makeProductionPushDeps } = await import('../github/push.js');
          const { makeOctokitAdapter, makeGhCliAdapter } = await import('../github/pr.js');
          const pushDeps = makeProductionPushDeps();
          return createPr(inp, {
            db,
            authDeps: makeProductionAuthDeps(),
            pushGuardDeps: { execGit: pushDeps.execGit },
            octokitAdapter: makeOctokitAdapter(),
            ghCliAdapter: makeGhCliAdapter(),
            broadcast: ghBroadcast,
          });
        });
        const base = this.config.github?.pr_target_branch ?? 'main';
        const prInput: CreatePrInput = {
          workflowId,
          branchName: wf.branch_name,
          owner: ownerRepo.owner,
          repo: ownerRepo.repo,
          base,
          title: wf.name,
          body,
        };
        await createPrFn(prInput);
      } catch (err) {
        console.error('[scheduler] auto-PR: unexpected error:', err);
        try {
          const error: GithubError = { kind: 'api_failed', message: String(err) };
          writeGithubState(this.db, workflowId, 'failed', { error });
        } catch {
          // DB may be closed during shutdown — ignore.
        }
      }
    });
  }

  /** Adapt the scheduler's 4-arg broadcastFn to the 3-arg GithubBroadcastFn shape. */
  private _makeGithubBroadcast(): GithubBroadcastFn {
    return (workflowId, frameType, payload) => {
      this.broadcastFn(workflowId, null, frameType, payload);
    };
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
