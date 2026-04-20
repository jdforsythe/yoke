/**
 * CreatePr executor factory.
 *
 * Implements the engine-layer side of POST /api/workflows/:id/github/create-pr:
 *
 *   1. Verifies the workflow exists.
 *   2. Verifies the workflow status is in the terminal set.
 *   3. Verifies github_state ∈ {idle, failed}.
 *   4. Calls the injected createPrFn (e.g. pushBranch + createPr from service.ts).
 *
 * Design invariants:
 *   - The API layer (server.ts) performs NO SQLite writes (RC-3). All writes
 *     happen inside createPrFn (which calls _writeGithubState).
 *   - commandId is passed through but not used here — idempotency is enforced
 *     by the API layer's IdempotencyStore before this fn is called.
 */

import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CreatePrExecutorResult =
  | { status: 'created'; prNumber: number; prUrl: string; usedPath: 'octokit' | 'gh_cli' }
  | { status: 'workflow_not_found' }
  | { status: 'non_terminal'; currentStatus: string }
  | { status: 'github_state_conflict'; currentGithubState: string };

/** Callable returned by makeCreatePrExecutorFn. */
export type CreatePrExecutorFn = (
  workflowId: string,
  commandId: string,
) => Promise<CreatePrExecutorResult>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_blocked', 'abandoned']);
const CREATEABLE_GITHUB_STATES = new Set(['idle', 'failed']);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns a production CreatePrExecutorFn bound to the given writer connection.
 * createPrFn encapsulates pushBranch + createPr — injected so tests can
 * exercise validation paths without live GitHub API calls.
 *
 * Uses writer (not db.reader()) for validation reads — WAL snapshot isolation
 * means reader() may not see rows committed by writer in the same test/request.
 */
export function makeCreatePrExecutorFn(
  writer: BetterSqlite3.Database,
  createPrFn: (
    workflowId: string,
  ) => Promise<{ prNumber: number; prUrl: string; usedPath: 'octokit' | 'gh_cli' }>,
): CreatePrExecutorFn {
  return async (workflowId: string, _commandId: string): Promise<CreatePrExecutorResult> => {
    const wf = writer
      .prepare('SELECT id, status, github_state FROM workflows WHERE id = ?')
      .get(workflowId) as
      | { id: string; status: string; github_state: string | null }
      | undefined;

    if (!wf) return { status: 'workflow_not_found' };

    if (!TERMINAL_STATUSES.has(wf.status)) {
      return { status: 'non_terminal', currentStatus: wf.status };
    }

    const githubState = wf.github_state ?? 'disabled';
    if (!CREATEABLE_GITHUB_STATES.has(githubState)) {
      return { status: 'github_state_conflict', currentGithubState: githubState };
    }

    const result = await createPrFn(workflowId);
    return { status: 'created', ...result };
  };
}
