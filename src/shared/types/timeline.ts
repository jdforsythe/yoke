/**
 * Shared item-timeline types — imported by both the API server and the web UI.
 *
 * ItemTimelineRow is the discriminated union returned by
 * GET /api/workflows/:workflowId/items/:itemId/timeline. Each row is either
 * a past agent session (including retry attempts) or a pre/post-command run
 * that was executed around an item's sessions. The dashboard renders the
 * merged timeline inline under each item row so the user can see retries and
 * post-command failures (including the action the harness took, e.g.
 * `goto implement`) without opening a separate history pane.
 *
 * The row shapes use camelCase — the server is responsible for mapping
 * snake_case columns before serialising.
 */

// ---------------------------------------------------------------------------
// Session row
// ---------------------------------------------------------------------------

/**
 * A single spawned agent session for the item. `attempt` is a 1-based index
 * computed by ordering sessions for the (item_id, phase) tuple by
 * started_at ascending; it is not stored as a column on the `sessions`
 * table.
 */
export interface ItemTimelineSessionRow {
  kind: 'session';
  id: string;
  phase: string;
  /**
   * Optional human-readable description of the phase, looked up from the
   * workflow's resolved config at serialisation time. `null` when the phase
   * has no description set, or when the phase is not present in the current
   * config (e.g. a legacy session row after a config change).
   */
  phaseDescription?: string | null;
  attempt: number;
  status: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  parentSessionId: string | null;
}

// ---------------------------------------------------------------------------
// Pre/post-command row
// ---------------------------------------------------------------------------

/**
 * `actionTaken` is the resolved action the Pre/Post Runner applied when the
 * command exited non-zero (e.g. `{ goto: 'implement' }`). It is `null` for
 * rows where no action was recorded (successful runs, or runs still in
 * flight). Deserialised from the `prepost_runs.action_taken` JSON column.
 */
export interface ItemTimelinePrepostRow {
  kind: 'prepost';
  id: string;
  whenPhase: 'pre' | 'post';
  commandName: string;
  phase: string;
  /**
   * Optional human-readable description of the phase this prepost run is
   * attached to. Looked up from the workflow's resolved config at
   * serialisation time. `null` when the phase has no description, or when
   * it is not present in the current config.
   */
  phaseDescription?: string | null;
  status: 'ok' | 'fail';
  exitCode: number | null;
  actionTaken: {
    goto?: string;
    retry?: boolean;
    fail?: boolean;
    continue?: boolean;
  } | null;
  startedAt: string;
  endedAt: string | null;
  stdoutPath: string | null;
  stderrPath: string | null;
}

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export type ItemTimelineRow = ItemTimelineSessionRow | ItemTimelinePrepostRow;

/** Response body for GET /api/workflows/:workflowId/items/:itemId/timeline. */
export interface ItemTimelineResponse {
  rows: ItemTimelineRow[];
}
