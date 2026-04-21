/**
 * Workflow control executor — implements workflow-level manual controls.
 *
 * Called by both transports:
 *   - HTTP: POST /api/workflows/:id/control  (server.ts)
 *   - WS:   control frame with action='cancel'|'pause'|'continue'  (ws.ts)
 *
 * Implemented actions:
 *   - cancel: transitions all non-terminal items to abandoned, SIGTERMs
 *             running sessions, and sets workflow status to abandoned.
 *   - pause:  sets workflows.paused_at = now(); scheduler tick skips
 *             workflows with paused_at IS NOT NULL. Idempotent.
 *   - continue: clears workflows.paused_at = NULL; scheduler resumes
 *               normal ticking for this workflow. Idempotent.
 *
 * Design invariants:
 *   - The API layer (server.ts, ws.ts) performs NO SQLite writes (RC-3). All
 *     state changes happen inside this module's engine-layer transaction.
 *   - For every non-terminal item in the workflow we fire user_cancel through
 *     applyItemTransition, keeping cascade-block / event logging consistent
 *     with every other item transition.
 *   - Running sessions are SIGTERMed through the injected killSession callback
 *     AFTER the cancel transitions commit, so WS broadcasts and SQLite state
 *     reflect the cancelled workflow before any process teardown noise.
 *   - broadcast() runs last so connected clients see the final workflow status.
 */

import type Database from 'better-sqlite3';
import type { DbPool } from '../storage/db.js';
import { applyItemTransition } from './engine.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ControlExecutorResult =
  | { status: 'accepted'; cancelledItems: number }
  | { status: 'accepted'; pausedAt: string | null }
  | { status: 'workflow_not_found' }
  | { status: 'invalid_action'; action: string }
  | { status: 'already_terminal' };

export type ControlExecutorFn = (
  workflowId: string,
  action: string,
) => ControlExecutorResult;

/**
 * Sends SIGTERM to the session's process group.  Safe to call with a session
 * that has already exited: implementations should no-op silently in that
 * case (e.g. Scheduler.killSession only touches sessions still in inFlight).
 */
export type KillSessionFn = (sessionId: string) => void;

/**
 * Emits a WS frame scoped to a workflow.  Used for both per-item item.state
 * frames (one per cancelled item, before the terminal workflow.update) and the
 * final workflow.update frame.  The wiring in start.ts forwards this to
 * WsClientRegistry.broadcast(workflowId, null, frameType, payload).
 */
export type ControlBroadcastFn = (
  workflowId: string,
  frameType: 'workflow.update' | 'item.state',
  payload: unknown,
) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Workflow-level statuses that mean "nothing left to cancel". */
const WORKFLOW_TERMINAL_STATUSES = new Set<string>([
  'completed',
  'completed_with_blocked',
  'abandoned',
  // Keep 'cancelled' for forward-compat if the status column is ever widened;
  // today the engine uses 'abandoned' as the cancelled-terminal label.
  'cancelled',
]);

/** Item statuses that are already terminal — we skip these during cancel. */
const ITEM_TERMINAL_STATUSES = ['complete', 'abandoned'];

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface WorkflowRow {
  id: string;
  status: string;
  paused_at: string | null;
}

interface ItemRow {
  id: string;
  stage_id: string;
  status: string;
  current_phase: string | null;
  retry_count: number;
}

interface SessionRow {
  id: string;
  item_id: string | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns a production ControlExecutorFn bound to the given writer, kill
 * callback, and broadcast callback.
 *
 * Inject into createServer(db, { controlExecutor: makeControlExecutor(...) }).
 */
export function makeControlExecutor(
  writer: Database.Database,
  killSession: KillSessionFn,
  broadcast: ControlBroadcastFn,
  scheduleIndexUpdate?: (workflowId: string) => void,
): ControlExecutorFn {
  // Minimal DbPool-shaped adapter so applyItemTransition can reuse the writer
  // inside its own db.transaction() wrapper. BEGIN/COMMIT nest safely: each
  // applyItemTransition call opens its own sub-transaction on `writer`.
  const dbAdapter: DbPool = {
    writer,
    reader: () => writer,
    transaction: (fn) => writer.transaction(fn)(writer),
    close: () => {
      // No-op: lifecycle is owned by the caller that created the pool.
    },
  };

  return (workflowId: string, action: string): ControlExecutorResult => {
    // ---- Validate action --------------------------------------------------
    if (action !== 'cancel' && action !== 'pause' && action !== 'continue') {
      return { status: 'invalid_action', action };
    }

    // ---- Look up workflow -------------------------------------------------
    const wf = writer
      .prepare('SELECT id, status, paused_at FROM workflows WHERE id = ?')
      .get(workflowId) as WorkflowRow | undefined;

    if (!wf) return { status: 'workflow_not_found' };

    if (WORKFLOW_TERMINAL_STATUSES.has(wf.status)) {
      return { status: 'already_terminal' };
    }

    // ---- Pause action -------------------------------------------------------
    // Sets paused_at = now(). The scheduler tick loop skips workflows with
    // paused_at IS NOT NULL (added in t-05 migration 0005). Idempotent:
    // pausing an already-paused workflow is a no-op success that re-broadcasts
    // the existing paused_at timestamp.
    if (action === 'pause') {
      if (!wf.paused_at) {
        writer
          .prepare(
            `UPDATE workflows
                SET paused_at  = datetime('now'),
                    updated_at = datetime('now')
              WHERE id = ?`,
          )
          .run(workflowId);
      }
      const row = writer
        .prepare('SELECT paused_at FROM workflows WHERE id = ?')
        .get(workflowId) as { paused_at: string };
      broadcast(workflowId, 'workflow.update', { pausedAt: row.paused_at });
      scheduleIndexUpdate?.(workflowId);
      return { status: 'accepted', pausedAt: row.paused_at };
    }

    // ---- Continue action ----------------------------------------------------
    // Clears paused_at = NULL so the scheduler tick loop resumes normal
    // scheduling for this workflow. Idempotent: clearing an already-unpaused
    // workflow is a no-op success.
    if (action === 'continue') {
      writer
        .prepare(
          `UPDATE workflows
              SET paused_at  = NULL,
                  updated_at = datetime('now')
            WHERE id = ?`,
        )
        .run(workflowId);
      broadcast(workflowId, 'workflow.update', { pausedAt: null });
      scheduleIndexUpdate?.(workflowId);
      return { status: 'accepted', pausedAt: null };
    }

    // ---- Collect non-terminal items and live sessions --------------------
    const terminalPlaceholders = ITEM_TERMINAL_STATUSES.map(() => '?').join(',');
    const items = writer
      .prepare(
        `SELECT id, stage_id, status, current_phase, retry_count
           FROM items
          WHERE workflow_id = ?
            AND status NOT IN (${terminalPlaceholders})`,
      )
      .all(workflowId, ...ITEM_TERMINAL_STATUSES) as ItemRow[];

    // Running sessions = any session for this workflow that hasn't ended yet.
    const liveSessions = writer
      .prepare(
        `SELECT id, item_id
           FROM sessions
          WHERE workflow_id = ? AND ended_at IS NULL`,
      )
      .all(workflowId) as SessionRow[];

    // ---- Fire user_cancel for each non-terminal item ---------------------
    // applyItemTransition opens its own db.transaction() internally (RC-1).
    // We call it once per item so cascade-block / event emission follow the
    // same path every other transition uses. Idempotent: an item that has
    // raced to a terminal state simply logs a no-op.
    //
    // Each per-item item.state broadcast fires immediately after the transition
    // commits (after applyItemTransition returns), so FeatureBoard can update
    // item chips without a reload. All item.state frames are emitted before the
    // terminal workflow.update broadcast below (ordering guarantee).
    let cancelledCount = 0;
    for (const item of items) {
      const result = applyItemTransition({
        db: dbAdapter,
        workflowId,
        itemId: item.id,
        // No sessionId here — user_cancel is user-driven, not session-driven.
        // Individual session rows are ended below; the engine records the
        // per-item transition as a workflow-scope event.
        sessionId: null,
        stage: item.stage_id,
        phase: item.current_phase ?? '',
        attempt: item.retry_count,
        event: 'user_cancel',
      });
      cancelledCount++;

      // Emit item.state after the transaction commits — not inside it.
      // Only emit when the item actually transitioned to abandoned; if the item
      // raced to a terminal state between the SELECT and applyItemTransition,
      // newState will equal the existing terminal status and we skip the frame.
      if (result.newState === 'abandoned') {
        broadcast(workflowId, 'item.state', {
          itemId: item.id,
          stageId: item.stage_id,
          state: {
            status: 'abandoned',
            currentPhase: result.newPhase,
            retryCount: item.retry_count,
            blockedReason: null,
          },
        });
      }
    }

    // ---- Update workflow status ------------------------------------------
    // Terminal label for cancelled workflows is 'abandoned' — the State union
    // has no 'cancelled' status and TERMINAL_WF_STATUSES (scheduler.ts,
    // engine.ts) treats 'abandoned' as terminal.
    writer
      .prepare(
        `UPDATE workflows
            SET status     = 'abandoned',
                updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(workflowId);

    // ---- Kill running sessions (after SQLite commits) --------------------
    // Processes live outside SQLite so we signal them after the transitions
    // are durable. killSession is a no-op for sessions already exited.
    for (const s of liveSessions) {
      killSession(s.id);
    }

    // ---- Broadcast workflow.update ---------------------------------------
    // Fires last so subscribers see the final status.
    broadcast(workflowId, 'workflow.update', {
      status: 'abandoned',
      cancelled: true,
    });

    // ---- Schedule workflow.index.update (coalesced) ----------------------
    // Sidebar chip needs the new 'abandoned' status; debounce handled by caller.
    scheduleIndexUpdate?.(workflowId);

    return { status: 'accepted', cancelledItems: cancelledCount };
  };
}
