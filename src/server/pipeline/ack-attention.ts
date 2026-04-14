/**
 * Attention acknowledgement handler factory.
 *
 * Implements the engine-layer side of
 * POST /api/workflows/:id/attention/:attentionId/ack:
 *
 *   1. Reads the pending_attention row by id + workflow_id (cross-workflow
 *      isolation — a row that belongs to a different workflow returns not_found).
 *   2. Returns already_acknowledged if acknowledged_at is already set
 *      (idempotent).
 *   3. Sets acknowledged_at = datetime('now') on the writer connection.
 *   4. Calls broadcast(workflowId) so connected WS clients refresh their
 *      attention banner.
 *
 * Design invariants:
 *   - The API layer (server.ts) performs NO SQLite writes (RC-3).  All writes
 *     are performed here, in the pipeline engine layer.
 *   - The returned AckAttentionFn is synchronous; better-sqlite3 statements
 *     are synchronous and WsClientRegistry.broadcast is synchronous.
 *   - broadcast() is called AFTER the write commits (ordered because
 *     better-sqlite3 prepare().run() is synchronous and returns before
 *     broadcast() is called).
 */

import type Database from 'better-sqlite3';
import type { AckAttentionFn, AckAttentionResult } from '../api/server.js';

/**
 * Callback invoked after a successful acknowledgement.  Implementations
 * should broadcast a WS workflow.update frame so connected clients know the
 * attention banner state has changed.
 *
 * Receives the workflowId of the acknowledged item so the broadcast can be
 * scoped to the correct workflow's subscribers.
 */
export type AckBroadcastFn = (workflowId: string) => void;

/**
 * Returns a production AckAttentionFn bound to the given SQLite writer and
 * broadcast callback.
 *
 * Inject into createServer(db, { ackAttention: makeAckAttentionFn(...) }).
 */
export function makeAckAttentionFn(
  writer: Database.Database,
  broadcast: AckBroadcastFn,
): AckAttentionFn {
  return (workflowId: string, attentionId: number): AckAttentionResult => {
    const row = writer
      .prepare(
        'SELECT id, acknowledged_at FROM pending_attention WHERE id = ? AND workflow_id = ?',
      )
      .get(attentionId, workflowId) as
      | { id: number; acknowledged_at: string | null }
      | undefined;

    if (!row) return { status: 'not_found' };
    if (row.acknowledged_at) return { status: 'already_acknowledged', id: attentionId };

    writer
      .prepare("UPDATE pending_attention SET acknowledged_at = datetime('now') WHERE id = ?")
      .run(attentionId);

    // Broadcast AFTER write so clients receive the current acked state.
    broadcast(workflowId);

    return { status: 'acknowledged', id: attentionId };
  };
}
