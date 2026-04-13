/**
 * Pipeline Engine — core atomic state-machine operations over SQLite.
 *
 * Source: plan-draft3.md §State Machine, §Retry, §Crash Recovery;
 * docs/design/state-machine-transitions.md; feat-pipeline-engine spec.
 *
 * ## Guarantees
 *
 *   AC-5  Pipeline Engine is the ONLY component that mutates SQLite
 *         workflow/item/session state.  No other module calls db.writer
 *         directly.
 *   AC-6  Every transition is committed inside db.transaction() before any
 *         observable external side effect (process spawn, WS frame emission).
 *   RC-1  No long-lived in-memory workflow state.  Every public function
 *         re-reads SQLite at the start of each call; none caches item/
 *         workflow rows between calls.
 *
 * ## Exported functions
 *
 *   applyItemTransition   — atomically apply a state-machine event to an item
 *   checkStageComplete    — probe whether all items in a stage are terminal
 *   buildCrashRecovery    — rebuild projection from SQLite on startup
 *
 * ## Non-responsibilities
 *
 *   - Does NOT spawn processes (ProcessManager's job).
 *   - Does NOT create worktrees (WorktreeManager's job).
 *   - Does NOT assemble prompts (Prompt Assembler's job).
 *   - Does NOT parse NDJSON (StreamJsonParser's job).
 *   - Does NOT run the scheduling event loop (higher-level concern).
 */

import type { DbPool } from '../storage/db.js';
import type { State, Event } from '../state-machine/states.js';
import { transition } from '../state-machine/transitions.js';
import type { TransitionResult } from '../state-machine/transitions.js';
import type { FailureClass } from '../state-machine/classifier.js';
import {
  computeRetryDecision,
  DEFAULT_RETRY_LADDER,
  DEFAULT_MAX_OUTER_RETRIES,
} from './retry-ladder.js';
import type { RetryMode } from './retry-ladder.js';

// ---------------------------------------------------------------------------
// Public types — action grammar (subset consumed by the engine)
// ---------------------------------------------------------------------------

/** Resolved action from a pre/post command's exit-code map. */
export interface ResolvedAction {
  kind: 'continue' | 'goto' | 'retry' | 'stop-and-ask' | 'stop' | 'fail';
  /** Target phase name for 'goto' actions. */
  goto?: string;
  /** Max goto loops to this destination (default 3). */
  maxRevisits?: number;
  /** Retry configuration for 'retry' actions (not used by outer ladder). */
  retry?: { mode: Exclude<RetryMode, 'awaiting_user'>; max: number };
  /** Failure reason for 'fail' actions. */
  failReason?: string;
}

// ---------------------------------------------------------------------------
// Public types — guard context
// ---------------------------------------------------------------------------

/**
 * Caller-supplied context for guard evaluation.
 *
 * The engine reads state-dependent guards (retry_count, depends_on,
 * worktree_path) directly from SQLite.  Guards that come from external
 * events or config are provided here.
 */
export interface GuardContext {
  /** For session_fail: failure classifier result. */
  classifierResult?: FailureClass;
  /** For session_ok / post_command_action=continue: are there more phases? */
  morePhases?: boolean;
  /** For session_ok: all post commands resolved to continue. */
  allPostCommandsOk?: boolean;
  /** For session_ok: artifact validators passed. */
  validatorsOk?: boolean;
  /** For session_ok: items_from diff check passed. */
  diffCheckOk?: boolean;
  /** For post_command_action: the resolved action from the post command. */
  postCommandAction?: ResolvedAction;
  /** For pre_command_failed: which action kind fired. */
  preCommandAction?: 'fail' | 'stop-and-ask';
  /**
   * Per-phase retry configuration.  Defaults to DEFAULT_MAX_OUTER_RETRIES /
   * DEFAULT_RETRY_LADDER when not supplied.
   */
  maxOuterRetries?: number;
  retryLadder?: readonly RetryMode[];
  /**
   * For awaiting_retry → backoff_elapsed: the retry mode chosen when we
   * entered awaiting_retry.  The caller must pass this back so the engine
   * can return it (used by the orchestration loop to assemble the prompt).
   * If absent, the engine derives it from ladder[retry_count - 1].
   */
  currentRetryMode?: Exclude<RetryMode, 'awaiting_user'>;
  /** For phase advance: the name of the next phase in the stage. */
  nextPhase?: string;
}

// ---------------------------------------------------------------------------
// Public types — input / output
// ---------------------------------------------------------------------------

export interface ApplyItemTransitionParams {
  db: DbPool;
  workflowId: string;
  itemId: string;
  sessionId: string | null;
  /** Stage ID the item is executing within. */
  stage: string;
  /** Current phase name (free-text label). */
  phase: string;
  /** Attempt number for correlation in the events table. */
  attempt: number;
  event: Event;
  guardCtx?: GuardContext;
  /**
   * RC-4: whether the *next* stage (or this stage, for a re-entry gate) has
   * `needs_approval: true` in the pipeline config.
   *
   * When this is true AND `stageComplete` becomes true inside the transaction,
   * the engine:
   *   1. Inserts `pending_attention{kind='stage_needs_approval'}`.
   *   2. Sets `workflows.status = 'pending_stage_approval'`.
   *
   * The workflow resumes when the orchestration loop receives a
   * `stage_approval_granted` event and resets `workflows.status`.
   */
  needsApproval?: boolean;
}

export interface ApplyItemTransitionResult {
  /** New state after the transition (same as old if no-op). */
  newState: State;
  /** New current_phase after the transition. */
  newPhase: string | null;
  /** Declarative side-effect labels for the caller to execute. */
  sideEffects: readonly string[];
  /**
   * Retry mode to use for the next session when newState = 'awaiting_retry'.
   * Absent for all other newState values.
   */
  retryMode?: Exclude<RetryMode, 'awaiting_user'>;
  /** True if dependents were cascade-blocked within the same transaction. */
  cascadeBlocked: boolean;
  /** True if all items in the stage reached terminal states this transition. */
  stageComplete: boolean;
}

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface ItemRow {
  id: string;
  workflow_id: string;
  stage_id: string;
  status: string;
  current_phase: string | null;
  depends_on: string | null;
  retry_count: number;
  blocked_reason: string | null;
  updated_at: string;
}

interface WorkflowRow {
  id: string;
  status: string;
  current_stage: string | null;
  worktree_path: string | null;
  pipeline: string;
}

interface SessionRunRow {
  id: string;
  item_id: string | null;
  phase: string;
  pid: number | null;
  pgid: number | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Internal: SQLite helpers (all take a raw Database connection — within txn)
// ---------------------------------------------------------------------------

interface WriteEventParams {
  ts: string;
  workflowId: string;
  itemId: string | null;
  sessionId: string | null;
  stage: string | null;
  phase: string | null;
  attempt: number | null;
  eventType: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  extra?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDb = { prepare(sql: string): any };

function writeEvent(db: SqliteDb, p: WriteEventParams): void {
  db.prepare(`
    INSERT INTO events
      (ts, workflow_id, item_id, session_id, stage, phase, attempt,
       event_type, level, message, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.ts,
    p.workflowId,
    p.itemId,
    p.sessionId,
    p.stage,
    p.phase,
    p.attempt,
    p.eventType,
    p.level,
    p.message,
    p.extra ?? null,
  );
}

function writePendingAttention(
  db: SqliteDb,
  workflowId: string,
  kind: string,
  payload: Record<string, unknown>,
  now: string,
): void {
  db.prepare(`
    INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
    VALUES (?, ?, ?, ?)
  `).run(workflowId, kind, JSON.stringify(payload), now);
}

// ---------------------------------------------------------------------------
// Internal: derive pending_attention kind from side-effect labels
// ---------------------------------------------------------------------------

const PENDING_ATTENTION_LABELS: Record<string, string> = {
  'insert pending_attention{kind=bootstrap_failed}': 'bootstrap_failed',
  'insert pending_attention': 'awaiting_user_retry',
  'insert pending_attention{kind=revisit_limit}': 'revisit_limit',
  'insert pending_attention{kind=stage_needs_approval}': 'stage_needs_approval',
};

function pendingAttentionKindFromEffects(
  sideEffects: readonly string[],
): string | null {
  for (const effect of sideEffects) {
    const kind = PENDING_ATTENTION_LABELS[effect];
    if (kind) return kind;
    // Fuzzy match for labels containing 'pending_attention'
    if (effect.includes('pending_attention') && effect.includes('insert')) {
      const m = /kind=([^}]+)/.exec(effect);
      return m ? m[1] : 'awaiting_user_retry';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal: revisit counter (RC-3: per item_id + destination_phase pair)
// ---------------------------------------------------------------------------

function countRevisitEvents(
  db: SqliteDb,
  itemId: string,
  destination: string,
): number {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS cnt FROM events
       WHERE item_id = ?
         AND event_type = 'prepost.revisit'
         AND json_extract(extra, '$.destination') = ?
    `)
    .get(itemId, destination) as { cnt: number };
  return row.cnt;
}

function insertRevisitEvent(
  db: SqliteDb,
  p: { workflowId: string; itemId: string; sessionId: string | null; stage: string; phase: string; attempt: number },
  destination: string,
  now: string,
): void {
  writeEvent(db, {
    ts: now,
    workflowId: p.workflowId,
    itemId: p.itemId,
    sessionId: p.sessionId,
    stage: p.stage,
    phase: p.phase,
    attempt: p.attempt,
    eventType: 'prepost.revisit',
    level: 'info',
    message: `goto to phase "${destination}"`,
    extra: JSON.stringify({ destination }),
  });
}

// ---------------------------------------------------------------------------
// Internal: check all depends_on are complete
// ---------------------------------------------------------------------------

function checkAllDepsComplete(db: SqliteDb, item: ItemRow): boolean {
  if (!item.depends_on) return true;
  let deps: string[];
  try {
    deps = JSON.parse(item.depends_on) as string[];
  } catch {
    return false;
  }
  if (deps.length === 0) return true;
  const placeholders = deps.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT status FROM items WHERE id IN (${placeholders})`)
    .all(...deps) as { status: string }[];
  return rows.length === deps.length && rows.every(r => r.status === 'complete');
}

// ---------------------------------------------------------------------------
// Internal: compute retry decision from item + ctx
// ---------------------------------------------------------------------------

type RetryOutcome =
  | { kind: 'retry'; mode: Exclude<RetryMode, 'awaiting_user'>; nextRetryCount: number }
  | { kind: 'exhausted' };

function computeRetry(item: ItemRow, ctx: GuardContext): RetryOutcome {
  return computeRetryDecision({
    retryCount: item.retry_count,
    maxOuterRetries: ctx.maxOuterRetries ?? DEFAULT_MAX_OUTER_RETRIES,
    retryLadder: ctx.retryLadder ?? DEFAULT_RETRY_LADDER,
  });
}

// ---------------------------------------------------------------------------
// Internal: select the concrete outcome for a conditional transition
// ---------------------------------------------------------------------------

/** States that trigger cascade-blocking of dependents (AC-2). */
const CASCADE_TRIGGER_STATES = new Set<State>(['awaiting_user', 'blocked', 'abandoned']);

/** States where an item is terminal for stage-completion purposes (AC-1). */
const STAGE_TERMINAL_STATES = new Set<string>(['complete', 'blocked', 'abandoned']);

interface OutcomeSelection {
  to: State;
  sideEffects: readonly string[];
  newRetryCount?: number;
  retryMode?: Exclude<RetryMode, 'awaiting_user'>;
  newPhase?: string;
}

/**
 * Evaluate guards for a conditional TransitionResult and return the
 * concrete outcome.
 *
 * This function is the authoritative guard implementation for every
 * conditional (State × Event) pair.  The TRANSITIONS table provides the
 * documented outcomes; this function implements the guards that select one.
 *
 * Called only from within a db.transaction() callback, so the db parameter
 * is the raw writer connection (safe to read from).
 */
function selectConditionalOutcome(
  result: { outcomes: readonly { to: State; guard: string; sideEffects: readonly string[] }[] },
  currentState: State,
  event: Event,
  item: ItemRow,
  workflow: WorkflowRow,
  db: SqliteDb,
  ctx: GuardContext,
  now: string,
  correlationParams: {
    workflowId: string;
    itemId: string;
    sessionId: string | null;
    stage: string;
    phase: string;
    attempt: number;
  },
): OutcomeSelection {
  const o = result.outcomes;

  switch (`${currentState}:${event}`) {
    // -----------------------------------------------------------------------
    // pending → deps_satisfied
    // Guard: all depends_on items have status = 'complete'
    // -----------------------------------------------------------------------
    case 'pending:deps_satisfied': {
      if (checkAllDepsComplete(db, item)) {
        // o[0]: all deps complete → ready
        return { to: o[0].to, sideEffects: o[0].sideEffects };
      }
      // Guard failed: deps not yet complete → no-op (return current state)
      return { to: currentState, sideEffects: [] };
    }

    // -----------------------------------------------------------------------
    // ready → phase_start
    // Guard: worktree_path null → bootstrapping; else → in_progress
    // -----------------------------------------------------------------------
    case 'ready:phase_start': {
      const idx = workflow.worktree_path == null ? 0 : 1;
      return { to: o[idx].to, sideEffects: o[idx].sideEffects };
    }

    // -----------------------------------------------------------------------
    // in_progress → pre_command_failed
    // Guard: action kind + retry budget
    // -----------------------------------------------------------------------
    case 'in_progress:pre_command_failed': {
      const action = ctx.preCommandAction ?? 'fail';
      if (action === 'stop-and-ask') {
        // o[2]: stop-and-ask → awaiting_user
        return { to: o[2].to, sideEffects: o[2].sideEffects };
      }
      // action = 'fail' — check retry budget
      const decision = computeRetry(item, ctx);
      if (decision.kind === 'retry') {
        // o[0]: fail + budget > 0 → awaiting_retry
        return {
          to: o[0].to,
          sideEffects: o[0].sideEffects,
          newRetryCount: decision.nextRetryCount,
          retryMode: decision.mode,
        };
      }
      // o[1]: fail + exhausted → awaiting_user
      return { to: o[1].to, sideEffects: o[1].sideEffects };
    }

    // -----------------------------------------------------------------------
    // in_progress → session_ok
    // Guard: validatorsOk ∧ diffCheckOk ∧ allPostCommandsOk ∧ morePhases?
    // -----------------------------------------------------------------------
    case 'in_progress:session_ok': {
      const morePhases = ctx.morePhases ?? false;
      const idx = morePhases ? 0 : 1;
      // o[0]: more phases → in_progress (advance current_phase)
      // o[1]: last phase  → complete
      const newPhase = morePhases ? (ctx.nextPhase ?? item.current_phase ?? undefined) : undefined;
      return { to: o[idx].to, sideEffects: o[idx].sideEffects, newPhase };
    }

    // -----------------------------------------------------------------------
    // in_progress → post_command_action
    // Guard: action kind, morePhases, revisit count
    //   o[0]: continue + more phases  → in_progress
    //   o[1]: continue + last phase   → complete
    //   o[2]: goto + within limit     → in_progress
    //   o[3]: goto + limit exceeded   → awaiting_user
    //   o[4]: retry                   → awaiting_retry
    //   o[5]: stop-and-ask            → awaiting_user
    //   o[6]: stop                    → abandoned
    //   o[7]: fail + budget > 0       → awaiting_retry
    //   o[8]: fail + exhausted        → awaiting_user
    // -----------------------------------------------------------------------
    case 'in_progress:post_command_action': {
      const action = ctx.postCommandAction;
      if (!action) {
        throw new Error(
          'post_command_action event requires guardCtx.postCommandAction',
        );
      }
      const morePhases = ctx.morePhases ?? false;

      if (action.kind === 'continue') {
        const idx = morePhases ? 0 : 1;
        const newPhase =
          morePhases ? (ctx.nextPhase ?? item.current_phase ?? undefined) : undefined;
        return { to: o[idx].to, sideEffects: o[idx].sideEffects, newPhase };
      }

      if (action.kind === 'goto' && action.goto) {
        const destination = action.goto;
        const maxRevisits = action.maxRevisits ?? 3;
        const existingCount = countRevisitEvents(db, correlationParams.itemId, destination);
        if (existingCount + 1 > maxRevisits) {
          // o[3]: limit exceeded → awaiting_user (RC-3)
          return { to: o[3].to, sideEffects: o[3].sideEffects };
        }
        // Insert revisit tracking event inside same transaction
        insertRevisitEvent(db, correlationParams, destination, now);
        // o[2]: within limit → in_progress
        return { to: o[2].to, sideEffects: o[2].sideEffects, newPhase: destination };
      }

      if (action.kind === 'retry') {
        const decision = computeRetry(item, ctx);
        if (decision.kind === 'retry') {
          // o[4]: retry + budget → awaiting_retry
          return {
            to: o[4].to,
            sideEffects: o[4].sideEffects,
            newRetryCount: decision.nextRetryCount,
            retryMode: decision.mode,
          };
        }
        // Exhausted: use awaiting_user (o[5] is stop-and-ask, so fall through)
        return { to: 'awaiting_user', sideEffects: [] };
      }

      if (action.kind === 'stop-and-ask') {
        // o[5]: stop-and-ask → awaiting_user
        return { to: o[5].to, sideEffects: o[5].sideEffects };
      }

      if (action.kind === 'stop') {
        // o[6]: stop → abandoned
        return { to: o[6].to, sideEffects: o[6].sideEffects };
      }

      if (action.kind === 'fail') {
        const decision = computeRetry(item, ctx);
        if (decision.kind === 'retry') {
          // o[7]: fail + budget → awaiting_retry
          return {
            to: o[7].to,
            sideEffects: o[7].sideEffects,
            newRetryCount: decision.nextRetryCount,
            retryMode: decision.mode,
          };
        }
        // o[8]: fail + exhausted → awaiting_user
        return { to: o[8].to, sideEffects: o[8].sideEffects };
      }

      throw new Error(`Unhandled post_command_action kind: ${action.kind}`);
    }

    // -----------------------------------------------------------------------
    // in_progress → validator_fail
    // Guard: retry budget > 0
    // -----------------------------------------------------------------------
    case 'in_progress:validator_fail': {
      const decision = computeRetry(item, ctx);
      if (decision.kind === 'retry') {
        // o[0]: budget > 0 → awaiting_retry
        return {
          to: o[0].to,
          sideEffects: o[0].sideEffects,
          newRetryCount: decision.nextRetryCount,
          retryMode: decision.mode,
        };
      }
      return { to: 'awaiting_user', sideEffects: [] };
    }

    // -----------------------------------------------------------------------
    // in_progress → diff_check_fail
    // Guard: retry budget > 0 (classifier = policy implicit)
    // -----------------------------------------------------------------------
    case 'in_progress:diff_check_fail': {
      const decision = computeRetry(item, ctx);
      if (decision.kind === 'retry') {
        // o[0]: budget > 0 → awaiting_retry
        return {
          to: o[0].to,
          sideEffects: o[0].sideEffects,
          newRetryCount: decision.nextRetryCount,
          retryMode: decision.mode,
        };
      }
      return { to: 'awaiting_user', sideEffects: [] };
    }

    // -----------------------------------------------------------------------
    // in_progress → session_fail
    // Guard: classifier result + retry budget
    //   o[0]: transient + budget > 0 → awaiting_retry
    //   o[1]: permanent              → awaiting_user
    //   o[2]: unknown                → awaiting_user
    // -----------------------------------------------------------------------
    case 'in_progress:session_fail': {
      const classifier = ctx.classifierResult ?? 'unknown';
      if (classifier === 'transient') {
        const decision = computeRetry(item, ctx);
        if (decision.kind === 'retry') {
          return {
            to: o[0].to,
            sideEffects: o[0].sideEffects,
            newRetryCount: decision.nextRetryCount,
            retryMode: decision.mode,
          };
        }
        // Budget exhausted even though transient — treat as retries_exhausted
        return { to: 'awaiting_user', sideEffects: [] };
      }
      if (classifier === 'permanent') {
        return { to: o[1].to, sideEffects: o[1].sideEffects };
      }
      // unknown / policy → awaiting_user (safe default, D07)
      return { to: o[2].to, sideEffects: o[2].sideEffects };
    }

    // -----------------------------------------------------------------------
    // awaiting_retry → backoff_elapsed
    // Guard: retry budget remaining
    // -----------------------------------------------------------------------
    case 'awaiting_retry:backoff_elapsed': {
      const maxOuter = ctx.maxOuterRetries ?? DEFAULT_MAX_OUTER_RETRIES;
      const ladder = ctx.retryLadder ?? DEFAULT_RETRY_LADDER;
      // retry_count was already incremented when we entered awaiting_retry.
      // The mode for the upcoming session is the one that was chosen then.
      // If the caller stored it in guardCtx.currentRetryMode, use that;
      // otherwise re-derive from ladder[retry_count - 1].
      if (item.retry_count <= 0 || item.retry_count > maxOuter) {
        return { to: 'awaiting_user', sideEffects: [] };
      }
      const retryMode: RetryMode =
        ctx.currentRetryMode ??
        (ladder[item.retry_count - 1] ?? 'awaiting_user');
      if (retryMode === 'awaiting_user') {
        return { to: 'awaiting_user', sideEffects: [] };
      }
      return {
        to: o[0].to,
        sideEffects: o[0].sideEffects,
        retryMode: retryMode as Exclude<RetryMode, 'awaiting_user'>,
      };
    }

    default:
      throw new Error(
        `Unhandled conditional transition guard for (${currentState}, ${event})`,
      );
  }
}

// ---------------------------------------------------------------------------
// Internal: cascade-block dependents (BFS, within an existing transaction)
// ---------------------------------------------------------------------------

/**
 * Cascade-blocks all transitive dependents of the given item (AC-2).
 *
 * Must be called from within a db.transaction() callback.  Takes the raw
 * writer connection so it participates in the same SQLite transaction.
 *
 * Items already in terminal states (complete, blocked, abandoned) are
 * skipped silently.
 */
function cascadeBlockDependents(
  db: SqliteDb,
  workflowId: string,
  originItemId: string,
  blockedReason: string,
  now: string,
): void {
  const visited = new Set<string>([originItemId]);
  const queue: string[] = [originItemId];

  while (queue.length > 0) {
    const parentId = queue.shift()!;

    // Find items in this workflow whose depends_on includes parentId
    const directDependents = db
      .prepare(`
        SELECT id, status FROM items
         WHERE workflow_id = ?
           AND depends_on IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM json_each(depends_on) je WHERE je.value = ?
           )
      `)
      .all(workflowId, parentId) as { id: string; status: string }[];

    for (const dep of directDependents) {
      if (visited.has(dep.id)) continue;
      visited.add(dep.id);

      // Skip items already in a terminal state
      if (STAGE_TERMINAL_STATES.has(dep.status)) continue;

      // Block this dependent
      db.prepare(`
        UPDATE items
           SET status = 'blocked',
               blocked_reason = ?,
               updated_at = ?
         WHERE id = ?
      `).run(blockedReason, now, dep.id);

      writeEvent(db, {
        ts: now,
        workflowId,
        itemId: dep.id,
        sessionId: null,
        stage: null,
        phase: null,
        attempt: null,
        eventType: 'cascade_block',
        level: 'info',
        message: `Cascade-blocked by ${originItemId}: ${blockedReason}`,
        extra: JSON.stringify({ origin: originItemId, reason: blockedReason }),
      });

      // Continue BFS for this newly-blocked item's own dependents
      queue.push(dep.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: apply side effects that are pure SQLite operations
// ---------------------------------------------------------------------------

function applyPendingSideEffects(
  db: SqliteDb,
  sideEffects: readonly string[],
  workflowId: string,
  itemId: string,
  stage: string,
  phase: string,
  now: string,
): void {
  const kind = pendingAttentionKindFromEffects(sideEffects);
  if (kind) {
    writePendingAttention(db, workflowId, kind, { item_id: itemId, stage, phase }, now);
  }
}

// ---------------------------------------------------------------------------
// applyItemTransition — public
// ---------------------------------------------------------------------------

/**
 * Atomically apply a state-machine event to an item.
 *
 * All SQLite mutations (item status, events row, optional pending_attention,
 * optional cascade-block) are committed in a single db.transaction() before
 * any result is returned to the caller.
 *
 * The caller is responsible for executing any non-SQLite side effects
 * (process spawning, signal sending, WS frame emission) AFTER this function
 * returns, using the `sideEffects` labels in the result.
 *
 * @throws if the item or workflow row is not found.
 * @throws if a required guard-context field is missing for a conditional.
 */
export function applyItemTransition(
  params: ApplyItemTransitionParams,
): ApplyItemTransitionResult {
  return params.db.transaction((db) => {
    const now = new Date().toISOString();

    // Read current item state — re-read from SQLite every call (RC-1).
    const item = db
      .prepare('SELECT * FROM items WHERE id = ?')
      .get(params.itemId) as ItemRow | undefined;
    if (!item) throw new Error(`Item not found: ${params.itemId}`);

    // Read workflow for worktree_path guard.
    const workflow = db
      .prepare(
        'SELECT id, status, current_stage, worktree_path, pipeline FROM workflows WHERE id = ?',
      )
      .get(params.workflowId) as WorkflowRow | undefined;
    if (!workflow) throw new Error(`Workflow not found: ${params.workflowId}`);

    const currentState = item.status as State;
    const ctx = params.guardCtx ?? {};

    // Look up transition result.
    const transitionResult: TransitionResult | undefined = transition(
      currentState,
      params.event,
    );

    // Unknown (state, event) pair → log and return no-op.
    if (!transitionResult) {
      writeEvent(db, {
        ts: now,
        workflowId: params.workflowId,
        itemId: params.itemId,
        sessionId: params.sessionId,
        stage: params.stage,
        phase: params.phase,
        attempt: params.attempt,
        eventType: `noop:${params.event}`,
        level: 'warn',
        message: `No transition for (${currentState}, ${params.event})`,
      });
      return {
        newState: currentState,
        newPhase: item.current_phase,
        sideEffects: [],
        cascadeBlocked: false,
        stageComplete: false,
      };
    }

    // Resolve concrete outcome.
    let selection: OutcomeSelection;
    if (transitionResult.kind === 'direct') {
      selection = {
        to: transitionResult.to,
        sideEffects: transitionResult.sideEffects,
        newPhase:
          transitionResult.sideEffects.includes('advance current_phase')
            ? (ctx.nextPhase ?? item.current_phase ?? undefined)
            : undefined,
      };
    } else {
      selection = selectConditionalOutcome(
        transitionResult,
        currentState,
        params.event,
        item,
        workflow,
        db,
        ctx,
        now,
        {
          workflowId: params.workflowId,
          itemId: params.itemId,
          sessionId: params.sessionId,
          stage: params.stage,
          phase: params.phase,
          attempt: params.attempt,
        },
      );
    }

    const newState = selection.to;
    const newRetryCount =
      selection.newRetryCount !== undefined
        ? selection.newRetryCount
        : item.retry_count;

    // Determine new phase.
    let newPhase: string | null;
    if (selection.newPhase !== undefined) {
      newPhase = selection.newPhase;
    } else if (newState === 'in_progress' && item.current_phase !== null) {
      // Keep current phase unless explicitly advanced.
      newPhase = item.current_phase;
    } else {
      newPhase = item.current_phase;
    }

    // Blocked reason: set on entering blocked state, preserve on other states.
    const newBlockedReason =
      newState === 'blocked'
        ? (`dependency ${params.itemId} ${currentState}`)
        : item.blocked_reason;

    // Persist item changes.
    db.prepare(`
      UPDATE items
         SET status         = ?,
             current_phase  = ?,
             retry_count    = ?,
             blocked_reason = ?,
             updated_at     = ?
       WHERE id = ?
    `).run(newState, newPhase, newRetryCount, newBlockedReason, now, params.itemId);

    // Write events row for EVERY transition (RC-5, AC-6).
    writeEvent(db, {
      ts: now,
      workflowId: params.workflowId,
      itemId: params.itemId,
      sessionId: params.sessionId,
      stage: params.stage,
      phase: params.phase,
      attempt: params.attempt,
      eventType: params.event,
      level: 'info',
      message: `${currentState} → ${newState}`,
      extra:
        selection.retryMode
          ? JSON.stringify({ retryMode: selection.retryMode })
          : null,
    });

    // Apply pure-SQLite side effects (pending_attention rows).
    applyPendingSideEffects(
      db,
      selection.sideEffects,
      params.workflowId,
      params.itemId,
      params.stage,
      params.phase,
      now,
    );

    // Cascade-block dependents in the same transaction (AC-2).
    let cascadeBlocked = false;
    const wasNotCascade = !CASCADE_TRIGGER_STATES.has(currentState);
    const isNowCascade = CASCADE_TRIGGER_STATES.has(newState);
    if (wasNotCascade && isNowCascade) {
      cascadeBlockDependents(
        db,
        params.workflowId,
        params.itemId,
        `dependency ${params.itemId} ${newState}`,
        now,
      );
      cascadeBlocked = true;
    }

    // Check stage completion (AC-1): fires when all items are terminal.
    // Use STAGE_TERMINAL_STATES so that blocked/abandoned transitions (e.g.
    // awaiting_user → blocked via user_block, or awaiting_user → abandoned via
    // user_cancel) also trigger the stage-complete probe.
    let stageComplete = false;
    if (STAGE_TERMINAL_STATES.has(newState) || cascadeBlocked) {
      stageComplete = checkStageCompleteInTxn(db, params.workflowId, params.stage);
    }

    // RC-4: if the next stage requires approval and this transition completed
    // the stage, insert a pending_attention row and pause the workflow.
    // Both mutations are inside the same db.transaction() (AC-6).
    if (stageComplete && params.needsApproval) {
      writePendingAttention(
        db,
        params.workflowId,
        'stage_needs_approval',
        { stage: params.stage },
        now,
      );
      db.prepare(
        `UPDATE workflows SET status = 'pending_stage_approval', updated_at = ? WHERE id = ?`,
      ).run(now, params.workflowId);
    }

    return {
      newState,
      newPhase,
      sideEffects: selection.sideEffects,
      retryMode: selection.retryMode,
      cascadeBlocked,
      stageComplete,
    };
  });
}

// ---------------------------------------------------------------------------
// checkStageComplete — public
// ---------------------------------------------------------------------------

/** Terminal states for stage-completion purposes (AC-1). */
const TERMINAL_FOR_STAGE = ['complete', 'blocked', 'abandoned'];

/**
 * Check whether all items in a stage have reached a terminal state.
 *
 * A stage is complete when every item's status ∈ {complete, blocked,
 * abandoned} (AC-1). A single non-terminal item prevents advancement.
 *
 * Re-reads SQLite on every call (RC-1: no caching).
 *
 * @returns true if ALL items in the stage are terminal, false otherwise.
 *          Returns false if there are no items in the stage.
 */
export function checkStageComplete(
  db: DbPool,
  workflowId: string,
  stageId: string,
): boolean {
  return checkStageCompleteInTxn(db.reader(), workflowId, stageId);
}

/** Same as checkStageComplete but takes a raw connection (for use within txn). */
function checkStageCompleteInTxn(
  db: SqliteDb,
  workflowId: string,
  stageId: string,
): boolean {
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('complete','blocked','abandoned') THEN 1 ELSE 0 END) AS terminal
      FROM items
      WHERE workflow_id = ? AND stage_id = ?
    `)
    .get(workflowId, stageId) as { total: number; terminal: number | null };

  const { total, terminal } = row;
  return total > 0 && (terminal ?? 0) >= total;
}

// ---------------------------------------------------------------------------
// buildCrashRecovery — public
// ---------------------------------------------------------------------------

export interface StaleSession {
  sessionId: string;
  itemId: string | null;
  phase: string;
  pid: number;
  pgid: number | null;
}

/** @deprecated Use StaleSession — kept for one release to avoid breaking callers. */
export type StaleSesssion = StaleSession;

export interface WorkflowRecoveryInfo {
  workflowId: string;
  staleSessions: StaleSession[];
  detectedAt: string;
}

/**
 * Rebuild the crash-recovery projection from SQLite on startup (AC-4).
 *
 * For each non-terminal workflow, finds sessions with status='running' and
 * a non-null PID.  Probes each PID with kill(pid, 0): ESRCH means the
 * process is gone (stale).
 *
 * For workflows with stale sessions, sets recovery_state JSON on the
 * workflows row.  Does NOT apply any item-state transitions (AC-4 /RC-2:
 * "no auto-transition; user_retry or auto_resume fires the normal row").
 *
 * @returns list of workflows affected (recovery_state written).
 */
export function buildCrashRecovery(db: DbPool): WorkflowRecoveryInfo[] {
  const now = new Date().toISOString();

  // Non-terminal workflow statuses: anything not in the three terminal labels.
  const TERMINAL_WF_STATUSES = ['completed', 'abandoned', 'completed_with_blocked'];
  const placeholders = TERMINAL_WF_STATUSES.map(() => '?').join(',');

  const workflows = db.writer
    .prepare(
      `SELECT id FROM workflows WHERE status NOT IN (${placeholders})`,
    )
    .all(...TERMINAL_WF_STATUSES) as { id: string }[];

  // --- Phase 1: probe PIDs outside SQLite (system calls, no DB state) -------
  // Collect WorkflowRecoveryInfo for every workflow that has stale sessions.
  // PID probes are intentionally outside the transaction so that a long probe
  // loop does not hold a write lock on the DB.
  const toWrite: WorkflowRecoveryInfo[] = [];

  for (const wf of workflows) {
    const runningSessions = db.writer
      .prepare(`
        SELECT id, item_id, phase, pid, pgid
          FROM sessions
         WHERE workflow_id = ?
           AND status = 'running'
           AND pid IS NOT NULL
      `)
      .all(wf.id) as SessionRunRow[];

    const stale: StaleSession[] = [];

    for (const sess of runningSessions) {
      if (sess.pid == null) continue;
      if (!probeProcess(sess.pid)) {
        stale.push({
          sessionId: sess.id,
          itemId: sess.item_id,
          phase: sess.phase,
          pid: sess.pid,
          pgid: sess.pgid,
        });
      }
    }

    if (stale.length > 0) {
      toWrite.push({ workflowId: wf.id, staleSessions: stale, detectedAt: now });
    }
  }

  if (toWrite.length === 0) return [];

  // --- Phase 2: commit all recovery_state writes in ONE transaction ---------
  // All-or-nothing: a crash mid-loop no longer leaves some workflows with
  // recovery_state written and others not (non-blocking review feedback).
  db.transaction((writer) => {
    const stmt = writer.prepare(
      `UPDATE workflows SET recovery_state = ?, updated_at = ? WHERE id = ?`,
    );
    for (const info of toWrite) {
      stmt.run(JSON.stringify(info), now, info.workflowId);
    }
  });

  return toWrite;
}

// ---------------------------------------------------------------------------
// applyWorktreeCreated — public
// ---------------------------------------------------------------------------

export interface ApplyWorktreeCreatedParams {
  db: DbPool;
  workflowId: string;
  /** Full git branch name, e.g. 'yoke/add-auth-abc12345'. */
  branchName: string;
  /** Absolute path to the worktree directory. */
  worktreePath: string;
}

/**
 * Persists the result of WorktreeManager.createWorktree() to SQLite (AC-5).
 *
 * Writes `branch_name` and `worktree_path` to the workflows row, and appends
 * a 'worktree_created' row to the events table — both inside a single
 * db.transaction() (AC-6).
 *
 * The orchestration loop calls this immediately after
 * WorktreeManager.createWorktree() returns, before applying bootstrap_ok or
 * bootstrap_fail via applyItemTransition().
 */
export function applyWorktreeCreated(params: ApplyWorktreeCreatedParams): void {
  params.db.transaction((writer) => {
    const now = new Date().toISOString();

    writer
      .prepare(
        `UPDATE workflows
            SET branch_name   = ?,
                worktree_path = ?,
                updated_at    = ?
          WHERE id = ?`,
      )
      .run(params.branchName, params.worktreePath, now, params.workflowId);

    writeEvent(writer, {
      ts: now,
      workflowId: params.workflowId,
      itemId: null,
      sessionId: null,
      stage: null,
      phase: null,
      attempt: null,
      eventType: 'worktree_created',
      level: 'info',
      message: `Worktree created: ${params.worktreePath} on branch ${params.branchName}`,
      extra: JSON.stringify({ branchName: params.branchName, worktreePath: params.worktreePath }),
    });
  });
}

// ---------------------------------------------------------------------------
// insertSession — create a sessions row at spawn time
// ---------------------------------------------------------------------------

export interface InsertSessionParams {
  sessionId: string;
  workflowId: string;
  itemId: string | null;
  stage: string;
  phase: string;
  /** null until spawn returns the real PID. */
  pid: number | null;
  /** null until spawn returns the real PGID. */
  pgid: number | null;
  /** Agent profile label. Default 'default'. */
  agentProfile?: string;
}

/**
 * Creates a sessions row with status='running'.
 *
 * Called by the orchestration layer immediately before spawning the agent
 * so that SQLite concurrency counts are accurate before the spawn is
 * attempted. pid/pgid are null at this point and updated via
 * updateSessionPid() once the process is live.
 *
 * Uses db.writer directly — this is an engine-layer function, not the
 * scheduler itself (RC-2: no direct db.writer calls in scheduler.ts).
 */
export function insertSession(db: DbPool, params: InsertSessionParams): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(`
      INSERT INTO sessions
        (id, workflow_id, item_id, stage, phase, agent_profile,
         pid, pgid, started_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')
    `)
    .run(
      params.sessionId,
      params.workflowId,
      params.itemId,
      params.stage,
      params.phase,
      params.agentProfile ?? 'default',
      params.pid,
      params.pgid,
      now,
    );
}

// ---------------------------------------------------------------------------
// updateSessionPid — fill in PID/PGID after spawn
// ---------------------------------------------------------------------------

/**
 * Updates pid and pgid on the sessions row after the child process is live.
 *
 * Separate from insertSession because PID is only known after spawn() returns.
 * The session row is inserted with null PID first so the concurrency count
 * in SQLite stays accurate while the spawn is in progress.
 */
export function updateSessionPid(
  db: DbPool,
  sessionId: string,
  pid: number,
  pgid: number,
): void {
  db.writer
    .prepare('UPDATE sessions SET pid = ?, pgid = ? WHERE id = ?')
    .run(pid, pgid, sessionId);
}

// ---------------------------------------------------------------------------
// endSession — mark a session as completed or failed
// ---------------------------------------------------------------------------

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * Marks a sessions row as ended, recording exit code and token usage.
 *
 * Called by the orchestration layer after the agent process exits and all
 * post-phase work (post: commands, validators) completes.
 */
export function endSession(
  db: DbPool,
  sessionId: string,
  opts: {
    exitCode: number | null;
    usage?: SessionUsage;
  },
): void {
  const now = new Date().toISOString();
  const status = opts.exitCode === 0 ? 'completed' : 'failed';
  db.writer
    .prepare(`
      UPDATE sessions
         SET ended_at = ?,
             exit_code = ?,
             status = ?,
             input_tokens = ?,
             output_tokens = ?,
             cache_creation_input_tokens = ?,
             cache_read_input_tokens = ?
       WHERE id = ?
    `)
    .run(
      now,
      opts.exitCode,
      status,
      opts.usage?.inputTokens ?? 0,
      opts.usage?.outputTokens ?? 0,
      opts.usage?.cacheCreationInputTokens ?? 0,
      opts.usage?.cacheReadInputTokens ?? 0,
      sessionId,
    );
}

// ---------------------------------------------------------------------------
// applyStageAdvance — advance workflow to the next stage
// ---------------------------------------------------------------------------

/**
 * Advances workflows.current_stage to `nextStageId` inside a single
 * db.transaction().
 *
 * Called by the orchestration layer when checkStageComplete() returns true
 * and there is a next stage to move to. RC-2: only the engine layer may write
 * to the workflows table; no direct db.writer calls in the scheduler.
 */
export function applyStageAdvance(
  db: DbPool,
  workflowId: string,
  nextStageId: string,
): void {
  const now = new Date().toISOString();
  db.transaction((writer) => {
    writer
      .prepare('UPDATE workflows SET current_stage = ?, updated_at = ? WHERE id = ?')
      .run(nextStageId, now, workflowId);
  });
}

// ---------------------------------------------------------------------------
// applyWorkflowComplete — mark a workflow as terminal
// ---------------------------------------------------------------------------

/**
 * Marks a workflow as `completed` or `completed_with_blocked` inside a
 * single db.transaction(), nulling out current_stage.
 *
 * Called by the orchestration layer when the last stage completes.
 * RC-2: only the engine layer may write to the workflows table.
 */
export function applyWorkflowComplete(
  db: DbPool,
  workflowId: string,
  finalStatus: 'completed' | 'completed_with_blocked',
): void {
  const now = new Date().toISOString();
  db.transaction((writer) => {
    writer
      .prepare(
        'UPDATE workflows SET status = ?, current_stage = NULL, updated_at = ? WHERE id = ?',
      )
      .run(finalStatus, now, workflowId);
  });
}

// ---------------------------------------------------------------------------
// Internal: PID liveness probe (kill(pid, 0))
// ---------------------------------------------------------------------------

/**
 * Probe whether a PID is alive using signal 0.
 *
 * `process.kill(pid, 0)` throws ESRCH if the process does not exist.
 * On macOS/Linux, EPERM means the process exists but we lack permission
 * to signal it (still alive from our perspective).
 *
 * @returns true if the process appears alive, false if it is gone.
 */
function probeProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    // EPERM: process exists but we can't signal it → alive
    if (e.code === 'EPERM') return true;
    // ESRCH: no such process → stale
    return false;
  }
}
