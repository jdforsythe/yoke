/**
 * Workflow archive/unarchive handler factory.
 *
 * Implements the engine-layer side of:
 *   POST /api/workflows/:id/archive   — sets archived_at = datetime('now')
 *   POST /api/workflows/:id/unarchive — clears archived_at = NULL
 *
 * Design invariants:
 *   - The API layer (server.ts) performs NO SQLite writes (RC-3). All writes
 *     are performed here, in the pipeline engine layer.
 *   - Archiving an in_progress workflow returns { status: 'conflict' } so the
 *     API layer can respond 409 with the current workflow status.
 *   - The write is synchronous (better-sqlite3 is sync) and safe under
 *     scheduler concurrency because the status check + update are atomic
 *     within the same writer connection.
 */

import type Database from 'better-sqlite3';
import type { WorkflowStatus } from '../../shared/types/workflow.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ArchiveWorkflowResult =
  | { status: 'archived'; workflowId: string }
  | { status: 'unarchived'; workflowId: string }
  | { status: 'workflow_not_found' }
  | { status: 'conflict'; currentStatus: WorkflowStatus };

/**
 * Broadcast callback invoked after a successful archive/unarchive.
 * Implementations should emit a WS workflow.update frame so connected clients
 * refresh their workflow list.
 */
export type ArchiveBroadcastFn = (workflowId: string) => void;

/** Callable returned by makeArchiveWorkflowFn. */
export type ArchiveWorkflowFn = (
  workflowId: string,
  action: 'archive' | 'unarchive',
) => ArchiveWorkflowResult;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns a production ArchiveWorkflowFn bound to the given writer connection
 * and broadcast callback.
 *
 * Inject into createServer(db, { archiveWorkflow: makeArchiveWorkflowFn(...) }).
 */
export function makeArchiveWorkflowFn(
  writer: Database.Database,
  broadcast: ArchiveBroadcastFn,
): ArchiveWorkflowFn {
  const selectStatus = writer.prepare<[string]>(
    'SELECT status FROM workflows WHERE id = ?',
  );
  const setArchived = writer.prepare<[string]>(
    "UPDATE workflows SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
  );
  const clearArchived = writer.prepare<[string]>(
    'UPDATE workflows SET archived_at = NULL, updated_at = datetime(\'now\') WHERE id = ?',
  );

  return (workflowId: string, action: 'archive' | 'unarchive'): ArchiveWorkflowResult => {
    const row = selectStatus.get(workflowId) as { status: string } | undefined;
    if (!row) return { status: 'workflow_not_found' };

    if (action === 'archive' && row.status === 'in_progress') {
      return { status: 'conflict', currentStatus: row.status as WorkflowStatus };
    }

    if (action === 'archive') {
      setArchived.run(workflowId);
    } else {
      clearArchived.run(workflowId);
    }

    broadcast(workflowId);

    return action === 'archive'
      ? { status: 'archived', workflowId }
      : { status: 'unarchived', workflowId };
  };
}
