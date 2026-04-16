/**
 * User-retry handler factory.
 *
 * Implements the engine-layer side of POST /api/workflows/:id/retry:
 *
 *   1. Verifies the workflow exists.
 *   2. Reads all items currently in 'awaiting_user' for that workflow.
 *   3. Fires the 'user_retry' event on each via applyItemTransition, which
 *      atomically moves them to 'in_progress'.
 *   4. Calls broadcast(workflowId) so connected WS clients refresh their state.
 *
 * Design invariants:
 *   - The API layer (server.ts) performs NO SQLite writes (RC-3). All writes
 *     are performed here, in the pipeline engine layer.
 *   - applyItemTransition is idempotent: if an item is no longer 'awaiting_user'
 *     when the transition fires, the engine logs a no-op and returns the current
 *     state unchanged. Safe under scheduler concurrency.
 *   - broadcast() is called AFTER all transitions commit.
 */

import type { DbPool } from '../storage/db.js';
import { applyItemTransition } from './engine.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RetriedItem {
  itemId: string;
  stageId: string;
  phase: string | null;
}

export type RetryItemsResult =
  | { status: 'retried'; items: RetriedItem[] }
  | { status: 'workflow_not_found' }
  | { status: 'none_awaiting' };

/**
 * Callback invoked after a successful retry. Implementations should broadcast
 * a WS workflow.update frame so connected clients refresh their item states.
 */
export type RetryBroadcastFn = (workflowId: string) => void;

/**
 * Callable returned by makeRetryItemsFn.
 * Takes the workflow UUID and returns a structured result.
 */
export type RetryItemsFn = (workflowId: string) => RetryItemsResult;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns a production RetryItemsFn bound to the given DbPool and broadcast
 * callback. Inject into createServer(db, { retryItems: makeRetryItemsFn(...) }).
 */
export function makeRetryItemsFn(db: DbPool, broadcast: RetryBroadcastFn): RetryItemsFn {
  return (workflowId: string): RetryItemsResult => {
    // Verify workflow exists (uses reader — no write needed for existence check).
    const wf = db
      .reader()
      .prepare('SELECT id FROM workflows WHERE id = ?')
      .get(workflowId) as { id: string } | undefined;

    if (!wf) return { status: 'workflow_not_found' };

    // Collect all awaiting_user items for this workflow.
    const rows = db
      .reader()
      .prepare(
        `SELECT id, stage_id, current_phase, retry_count
           FROM items
          WHERE workflow_id = ? AND status = 'awaiting_user'`,
      )
      .all(workflowId) as Array<{
        id: string;
        stage_id: string;
        current_phase: string | null;
        retry_count: number;
      }>;

    if (rows.length === 0) return { status: 'none_awaiting' };

    const retried: RetriedItem[] = [];

    for (const item of rows) {
      // applyItemTransition re-reads the item inside its own transaction (RC-1).
      // If the scheduler has already moved the item out of awaiting_user, the
      // engine logs a no-op and returns the current state — safe to ignore.
      applyItemTransition({
        db,
        workflowId,
        itemId: item.id,
        sessionId: null,
        stage: item.stage_id,
        phase: item.current_phase ?? '',
        attempt: item.retry_count,
        event: 'user_retry',
      });

      retried.push({
        itemId: item.id,
        stageId: item.stage_id,
        phase: item.current_phase,
      });
    }

    // Notify WS clients after all transitions commit.
    broadcast(workflowId);

    return { status: 'retried', items: retried };
  };
}
