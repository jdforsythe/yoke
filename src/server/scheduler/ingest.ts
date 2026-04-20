/**
 * Workflow ingestion — creates workflow + item rows from ResolvedConfig.
 *
 * Called by the Scheduler on startup (AC-1: ingests stage graph within 2 s).
 *
 * ## What gets seeded
 *
 *   run:once stages — one synthetic item per stage, current_phase set to the
 *   first phase in the stage.  Items are chained: stage N's item depends on
 *   stage N-1's item so that the dependency gate (`deps_satisfied`) enforces
 *   sequential stage execution.
 *
 *   run:per-item stages — items come from the manifest file (items_from path),
 *   which lives inside the worktree that doesn't exist yet at startup.  These
 *   items are seeded lazily when the stage becomes active (deferred to a later
 *   phase of the orchestration loop — see open-questions.md). Only the stage
 *   ordering dependency (depends on previous stage's item) is recorded at
 *   ingest time.
 *
 * ## Idempotency
 *
 *   If a live workflow (same project.name + configDir, non-terminal status)
 *   already exists, it is returned as-is (isResume: true). A new workflow
 *   is only created when no live match is found — allowing safe restart
 *   without creating duplicate runs.
 */

import crypto from 'node:crypto';
import type { DbPool } from '../storage/db.js';
import type { ResolvedConfig } from '../../shared/types/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestResult {
  workflowId: string;
  /** true when an existing live workflow was found (resume path). */
  isResume: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TERMINAL_WF_STATUSES = ['completed', 'abandoned', 'completed_with_blocked'];

// ---------------------------------------------------------------------------
// ingestWorkflow
// ---------------------------------------------------------------------------

/**
 * Ingest a workflow run from the given resolved config.
 *
 * If an existing live workflow matches (same project.name + configDir), it is
 * returned as-is (resume path). Otherwise a new workflow row is created with:
 *   - All run:once stage items seeded in `pending` status.
 *   - Stage ordering enforced via depends_on chaining.
 *   - Workflow status = 'pending', current_stage = first stage id.
 *
 * All writes are inside a single db.transaction() for atomicity.
 */
export function ingestWorkflow(db: DbPool, config: ResolvedConfig): IngestResult {
  // Check for an existing live workflow (read-only; outside transaction).
  const placeholders = TERMINAL_WF_STATUSES.map(() => '?').join(',');
  const existingRow = db.reader()
    .prepare(
      `SELECT id FROM workflows
        WHERE (name = ? OR name LIKE ?)
          AND json_extract(config, '$.configDir') = ?
          AND status NOT IN (${placeholders})
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(config.project.name, `${config.project.name}-%`, config.configDir, ...TERMINAL_WF_STATUSES) as
    | { id: string }
    | undefined;

  if (existingRow) {
    return { workflowId: existingRow.id, isResume: true };
  }

  // Create new workflow + items in one transaction.
  const workflowId = crypto.randomUUID();

  return db.transaction((writer) => {
    const now = new Date().toISOString();

    const firstStageId = config.pipeline.stages[0]?.id ?? null;

    writer
      .prepare(`
        INSERT INTO workflows
          (id, name, spec, pipeline, config, status, current_stage, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `)
      .run(
        workflowId,
        `${config.project.name}-${workflowId.slice(0, 8)}`,
        JSON.stringify({ stages: config.pipeline.stages.map((s) => s.id) }),
        JSON.stringify({ stages: config.pipeline.stages }),
        JSON.stringify({ configDir: config.configDir }),
        firstStageId,
        now,
        now,
      );

    // Seed items for run:once stages, chaining depends_on across stages.
    let prevItemId: string | null = null;
    for (const stage of config.pipeline.stages) {
      const itemId = crypto.randomUUID();
      const firstPhase = stage.phases[0] ?? null;
      const dependsOn = prevItemId ? JSON.stringify([prevItemId]) : null;

      writer
        .prepare(`
          INSERT INTO items
            (id, workflow_id, stage_id, data, status, current_phase,
             depends_on, retry_count, updated_at)
          VALUES (?, ?, ?, '{}', 'pending', ?, ?, 0, ?)
        `)
        .run(itemId, workflowId, stage.id, firstPhase, dependsOn, now);

      prevItemId = itemId;
    }

    return { workflowId, isResume: false };
  });
}
