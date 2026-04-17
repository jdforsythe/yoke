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
