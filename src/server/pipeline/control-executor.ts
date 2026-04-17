/**
 * Workflow control executor — implements workflow-level manual cancel.
 *
 * Called by both transports:
 *   - HTTP: POST /api/workflows/:id/control  (server.ts)
 *   - WS:   control frame with action='cancel'  (ws.ts)
 *
 * For the current iteration only action='cancel' is implemented; pause/resume
 * and other actions return invalid_action so the API layer can surface a
 * clear 400 to the caller (future work).
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
 *   - broadcast() runs last so connected clients see the final (abandoned)
 *     workflow status.
 */

import type Database from 'better-sqlite3';
import type { DbPool } from '../storage/db.js';
import { applyItemTransition } from './engine.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ControlExecutorResult =
  | { status: 'accepted'; cancelledItems: number }
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
 * Emits a workflow-scope WS frame.  The wiring in start.ts forwards this to
 * WsClientRegistry.broadcast(workflowId, null, frameType, payload).
 */
export type ControlBroadcastFn = (
  workflowId: string,
  frameType: 'workflow.update',
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
    if (action !== 'cancel') {
      return { status: 'invalid_action', action };
    }

    // ---- Look up workflow -------------------------------------------------
    const wf = writer
      .prepare('SELECT id, status FROM workflows WHERE id = ?')
      .get(workflowId) as WorkflowRow | undefined;

    if (!wf) return { status: 'workflow_not_found' };

    if (WORKFLOW_TERMINAL_STATUSES.has(wf.status)) {
      return { status: 'already_terminal' };
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
    let cancelledCount = 0;
    for (const item of items) {
      applyItemTransition({
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

    return { status: 'accepted', cancelledItems: cancelledCount };
  };
}
