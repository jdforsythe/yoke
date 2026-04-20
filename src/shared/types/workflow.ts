/**
 * Shared workflow types — imported by both the API server and the web UI.
 *
 * WorkflowStatus is the single source of truth for the values stored in the
 * `workflows.status` column. Adding a new status here is the only change
 * required to expose it everywhere.
 *
 * WorkflowRow is the camelCase shape the API returns in JSON responses.
 * The API layer is responsible for mapping SQLite snake_case columns to this
 * shape before serialising; UI components must not snake_case-coerce fields.
 */

// ---------------------------------------------------------------------------
// WorkflowStatus
// ---------------------------------------------------------------------------

export type WorkflowStatus =
  | 'pending'
  | 'in_progress'
  | 'pending_stage_approval'
  | 'completed'
  | 'completed_with_blocked'
  | 'abandoned';

/**
 * Exhaustive array of every WorkflowStatus value.
 * Bound via `satisfies` so adding a new status to the union without updating
 * this array produces a TypeScript error.
 */
export const WORKFLOW_STATUS_VALUES = [
  'pending',
  'in_progress',
  'pending_stage_approval',
  'completed',
  'completed_with_blocked',
  'abandoned',
] as const satisfies readonly WorkflowStatus[];

/**
 * Human-readable display labels for each WorkflowStatus.
 * Internal key (e.g. 'in_progress') is kept separate from the displayed label
 * ('In progress') so the UI never duplicates string literals from the union.
 */
export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  pending_stage_approval: 'Pending approval',
  completed: 'Completed',
  completed_with_blocked: 'Completed (blocked)',
  abandoned: 'Abandoned',
};

// ---------------------------------------------------------------------------
// WorkflowRow
// ---------------------------------------------------------------------------

/**
 * A single row from GET /api/workflows (and related paginated queries).
 *
 * unreadEvents is populated by workflow.index.update WS frames, not by the
 * HTTP list endpoint. The API always returns 0; the WS layer is the source of
 * truth for the live count.
 */
export interface WorkflowRow {
  id: string;
  name: string;
  status: WorkflowStatus;
  currentStage: string | null;
  createdAt: string;
  updatedAt: string;
  activeSessions: number;
  unreadEvents: number;
}
