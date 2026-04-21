/**
 * Workflow creation — seeds a brand-new workflow + item rows from ResolvedConfig.
 *
 * createWorkflow always inserts a new row; there is no dedup / resume check.
 * With user-supplied instance names, concurrent workflows from the same template
 * are expected. The caller (API handler, t-07) is responsible for choosing a
 * unique or descriptive name.
 *
 * ## What gets seeded
 *
 *   run:once stages — one synthetic item per stage, current_phase set to the
 *   first phase in the stage.  Items are chained: stage N's item depends on
 *   stage N-1's item so that the dependency gate (`deps_satisfied`) enforces
 *   sequential stage execution.
 *
 *   run:per-item stages — items come from the manifest file (items_from path),
 *   which lives inside the worktree that doesn't exist yet at creation time.
 *   These items are seeded lazily when the stage becomes active.  Only the stage
 *   ordering dependency (depends on previous stage's item) is recorded here.
 *
 * ## GitHub state initialisation
 *
 *   initGithubState is called inside the same transaction as the workflow INSERT
 *   so every new workflow row has a non-null github_state from the moment it is
 *   committed.
 *
 *   The git remote URL is resolved via injected IngestDeps before the transaction
 *   begins (it may block on a local filesystem read).  This keeps the transaction
 *   itself synchronous.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { DbPool } from '../storage/db.js';
import type { ResolvedConfig } from '../../shared/types/config.js';
import { parseGitRemoteUrl } from '../github/remote-parse.js';
import { initGithubState } from '../github/service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable git helper for resolving the remote origin URL.
 * Using an injected dep keeps the git invocation testable in isolation and
 * satisfies the "injected git helper pattern" review criterion.
 */
export interface IngestDeps {
  /**
   * Returns the trimmed stdout of `git -C configDir remote get-url origin`,
   * or null if the command fails (not a git repo, no remote, etc.).
   *
   * MUST NOT contact the network — this command only reads local git config.
   */
  getRemoteOriginUrl(configDir: string): string | null;
}

// ---------------------------------------------------------------------------
// createWorkflow
// ---------------------------------------------------------------------------

/**
 * Create a new workflow run from the given resolved config and user-supplied name.
 *
 * Always inserts a new workflow row — no dedup check against live workflows.
 * Two calls with the same template + name produce two distinct workflow rows
 * with distinct UUIDs. The caller decides whether to warn about name collisions.
 *
 * All writes are inside a single db.transaction() for atomicity.
 */
export function createWorkflow(
  db: DbPool,
  config: ResolvedConfig,
  opts: { name: string },
  deps?: IngestDeps,
): { workflowId: string } {
  // Resolve github state BEFORE entering the transaction.
  // getRemoteOriginUrl may perform a local filesystem read (execFileSync).
  const githubEnabled = config.github?.enabled ?? false;
  const githubAutoPr = config.github?.auto_pr ?? false;
  let hasOwnerRepo = false;

  if (githubEnabled && deps) {
    const remoteUrl = deps.getRemoteOriginUrl(config.configDir);
    if (remoteUrl !== null) {
      hasOwnerRepo = parseGitRemoteUrl(remoteUrl) !== null;
    }
  }

  const workflowId = crypto.randomUUID();

  return db.transaction((writer) => {
    const now = new Date().toISOString();
    const firstStageId = config.pipeline.stages[0]?.id ?? null;

    writer
      .prepare(`
        INSERT INTO workflows
          (id, name, template_name, spec, pipeline, config, status, current_stage, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `)
      .run(
        workflowId,
        opts.name,
        config.template.name,
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

    // Initialise github_state for the new workflow inside the same transaction.
    // initGithubState calls db.transaction() internally; better-sqlite3 handles
    // this as a SAVEPOINT within the outer BEGIN, keeping everything atomic.
    initGithubState(db, workflowId, {
      enabled: githubEnabled,
      autoPr: githubAutoPr,
      hasOwnerRepo,
    });

    return { workflowId };
  });
}

// ---------------------------------------------------------------------------
// Production deps factory
// ---------------------------------------------------------------------------

/**
 * Returns production IngestDeps that run the real git command synchronously.
 * Reads local git config only — never contacts the network.
 * Kept in a factory so the execFileSync call can be stubbed in tests.
 */
export function makeProductionIngestDeps(): IngestDeps {
  return {
    getRemoteOriginUrl(configDir: string): string | null {
      try {
        const stdout = execFileSync('git', ['-C', configDir, 'remote', 'get-url', 'origin'], {
          encoding: 'utf8',
          timeout: 5_000,
        });
        return stdout.trim() || null;
      } catch {
        return null;
      }
    },
  };
}
