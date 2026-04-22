/**
 * Read and write the serialized WorkflowGraph stored in workflows.graph_state.
 *
 * Whole-document JSON writes — graphs stay in the hundreds of nodes so the
 * cost of rewriting on every patch is acceptable for the cache use case.
 */

import type { DbPool } from '../storage/db.js';
import type { WorkflowGraph } from '../../shared/types/graph.js';

export function readGraph(db: DbPool, workflowId: string): WorkflowGraph | null {
  const row = db
    .reader()
    .prepare('SELECT graph_state FROM workflows WHERE id = ?')
    .get(workflowId) as { graph_state: string | null } | undefined;
  if (!row || !row.graph_state) return null;
  try {
    return JSON.parse(row.graph_state) as WorkflowGraph;
  } catch {
    return null;
  }
}

export function writeGraph(db: DbPool, workflowId: string, graph: WorkflowGraph): void {
  db.writer
    .prepare('UPDATE workflows SET graph_state = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(graph), new Date().toISOString(), workflowId);
}
