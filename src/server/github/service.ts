/**
 * GithubService — high-level PR creation orchestrator.
 *
 * Implements the full AC surface for feat-github:
 *
 *   AC-1  Octokit path: GITHUB_TOKEN present + valid → PR created, DB updated
 *         github_state: idle → creating → created with prNumber + prUrl.
 *   AC-2  Fallback path: GITHUB_TOKEN absent/invalid → gh CLI; gh auth failure
 *         → structured error (not a stack trace).
 *   AC-3  Push guard: branch must be fully pushed before createPr() proceeds.
 *   AC-4  Auth failure: structured error names every attempted source + reason.
 *   RC-4  github_state columns updated inside db.transaction() together with
 *         a matching events row.
 *
 * All external I/O (auth, git, octokit, gh CLI) is injected via GithubServiceDeps
 * so tests can exercise both the octokit and gh paths without live API calls (AC-5).
 */

import type { DbPool } from '../storage/db.js';
import type { GithubStatus, GithubError } from './types.js';
import type { AuthDeps } from './auth.js';
import { resolveAuth } from './auth.js';
import type { PushGuardDeps } from './push-guard.js';
import { checkPushed } from './push-guard.js';
import type { OctokitAdapter, GhCliAdapter, PrInput, PrResult } from './pr.js';
import { OctokitPrError } from './pr.js';

// ---------------------------------------------------------------------------
// Broadcast function type (injectable, no module-level import)
// ---------------------------------------------------------------------------

/**
 * Emits a WS frame scoped to a workflow.  Only 'workflow.update' is emitted
 * by the github service; sessionId is always null for these frames.
 */
export type GithubBroadcastFn = (
  workflowId: string,
  frameType: 'workflow.update',
  payload: unknown,
) => void;

// ---------------------------------------------------------------------------
// Deps interface (injectable for tests)
// ---------------------------------------------------------------------------

export interface GithubServiceDeps {
  db: DbPool;
  authDeps: AuthDeps;
  pushGuardDeps: PushGuardDeps;
  octokitAdapter: OctokitAdapter;
  ghCliAdapter: GhCliAdapter;
  /** Optional: if provided, a workflow.update frame is emitted after every DB commit. */
  broadcast?: GithubBroadcastFn;
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface CreatePrInput {
  workflowId: string;
  /** The branch that was pushed (head). */
  branchName: string;
  owner: string;
  repo: string;
  /** Target branch (base). */
  base: string;
  title: string;
  body?: string;
}

export type CreatePrResult =
  | { ok: true; prNumber: number; prUrl: string; usedPath: 'octokit' | 'gh_cli' }
  | { ok: false; error: GithubError };

// ---------------------------------------------------------------------------
// Internal: DB helpers
// ---------------------------------------------------------------------------

/**
 * Write github_state columns + an events row atomically (RC-4).
 * After the transaction commits, emits a workflow.update broadcast so WS
 * subscribers see the new state without polling (r2-12).  A thrown transaction
 * (rollback) re-throws before reaching the broadcast call, suppressing it.
 */
function _writeGithubState(
  db: DbPool,
  workflowId: string,
  state: GithubStatus,
  extra: {
    prNumber?: number;
    prUrl?: string;
    error?: GithubError;
  } = {},
  broadcast?: GithubBroadcastFn,
): void {
  const now = new Date().toISOString();
  db.transaction((writer) => {
    writer
      .prepare(
        `UPDATE workflows
         SET github_state           = ?,
             github_pr_number       = ?,
             github_pr_url          = ?,
             github_error           = ?,
             github_last_checked_at = ?,
             updated_at             = ?
         WHERE id = ?`,
      )
      .run(
        state,
        extra.prNumber ?? null,
        extra.prUrl ?? null,
        extra.error !== undefined ? JSON.stringify(extra.error) : null,
        now,
        now,
        workflowId,
      );

    writer
      .prepare(
        `INSERT INTO events (ts, workflow_id, event_type, level, message, extra)
         VALUES (?, ?, 'github.state', 'info', ?, ?)`,
      )
      .run(
        now,
        workflowId,
        `github_state → ${state}`,
        JSON.stringify({ state, prNumber: extra.prNumber, prUrl: extra.prUrl, error: extra.error }),
      );
  });

  // Broadcast AFTER transaction commits — rollback (throw above) skips this block.
  if (broadcast) {
    const githubState: Record<string, unknown> = { status: state, lastCheckedAt: now };
    if (extra.prNumber !== undefined) githubState.prNumber = extra.prNumber;
    if (extra.prUrl !== undefined) githubState.prUrl = extra.prUrl;
    if (extra.error !== undefined) {
      githubState.error =
        extra.error.kind === 'api_failed'
          ? extra.error.message
          : extra.error.attempts.map((a) => `${a.source}: ${a.reason}`).join('; ');
    }
    broadcast(workflowId, 'workflow.update', { githubState });
  }
}

// ---------------------------------------------------------------------------
// createPr
// ---------------------------------------------------------------------------

/**
 * Orchestrates auth resolution, push guard, and PR creation.
 *
 * Returns a CreatePrResult — never throws.  The caller (e.g. scheduler's
 * workflow-complete path) is responsible for broadcasting the new state.
 *
 * Transition sequence written to SQLite:
 *   idle → creating  (before the API call)
 *   creating → created  (on success)
 *   creating → failed   (on auth or API error)
 */
export async function createPr(
  input: CreatePrInput,
  deps: GithubServiceDeps,
): Promise<CreatePrResult> {
  const { db, authDeps, pushGuardDeps, octokitAdapter, ghCliAdapter, broadcast } = deps;

  // --- 1. Push guard (AC-3, RC-1): always enforced, not config-gated ---
  const guardResult = await checkPushed(input.branchName, pushGuardDeps);
  if (!guardResult.ok) {
    const error: GithubError = {
      kind: 'api_failed',
      message: guardResult.reason ?? 'branch has unpushed commits',
    };
    _writeGithubState(db, input.workflowId, 'failed', { error }, broadcast);
    return { ok: false, error };
  }

  // --- 2. Auth resolution ---
  const authResult = await resolveAuth(authDeps);
  if (!authResult.ok) {
    _writeGithubState(db, input.workflowId, 'failed', { error: authResult.failure }, broadcast);
    return { ok: false, error: authResult.failure };
  }

  // --- 3. Transition to 'creating' ---
  _writeGithubState(db, input.workflowId, 'creating', {}, broadcast);

  const prInput: PrInput = {
    owner: input.owner,
    repo: input.repo,
    head: input.branchName,
    base: input.base,
    title: input.title,
    body: input.body,
  };

  // --- 4a. Try Octokit (GITHUB_TOKEN path) ---
  if (authResult.value.source === 'GITHUB_TOKEN') {
    let octokitResult: PrResult | null = null;
    let octokitAuthFailed = false;

    try {
      octokitResult = await octokitAdapter.createPr(authResult.value.token, prInput);
    } catch (err: unknown) {
      if (err instanceof OctokitPrError && (err.statusCode === 401 || err.statusCode === 403)) {
        // Auth error → fall through to gh CLI
        octokitAuthFailed = true;
      } else {
        // Non-auth API error → fail immediately
        const apiErr: GithubError = {
          kind: 'api_failed',
          statusCode: err instanceof OctokitPrError ? err.statusCode : undefined,
          message: err instanceof Error ? err.message : String(err),
        };
        _writeGithubState(db, input.workflowId, 'failed', { error: apiErr }, broadcast);
        return { ok: false, error: apiErr };
      }
    }

    if (octokitResult !== null) {
      _writeGithubState(db, input.workflowId, 'created', {
        prNumber: octokitResult.prNumber,
        prUrl: octokitResult.prUrl,
      }, broadcast);
      return {
        ok: true,
        prNumber: octokitResult.prNumber,
        prUrl: octokitResult.prUrl,
        usedPath: 'octokit',
      };
    }

    // Octokit had auth failure — fall back to gh CLI
    if (!octokitAuthFailed) {
      // Should not reach here, but guard anyway
      const err: GithubError = { kind: 'api_failed', message: 'octokit returned no result' };
      _writeGithubState(db, input.workflowId, 'failed', { error: err }, broadcast);
      return { ok: false, error: err };
    }
  }

  // --- 4b. Try gh CLI (fallback or gh_auth source) ---
  try {
    const ghResult = await ghCliAdapter.createPr(prInput);
    _writeGithubState(db, input.workflowId, 'created', {
      prNumber: ghResult.prNumber,
      prUrl: ghResult.prUrl,
    }, broadcast);
    return {
      ok: true,
      prNumber: ghResult.prNumber,
      prUrl: ghResult.prUrl,
      usedPath: 'gh_cli',
    };
  } catch (err: unknown) {
    const apiErr: GithubError = {
      kind: 'api_failed',
      message: err instanceof Error ? err.message : String(err),
    };
    _writeGithubState(db, input.workflowId, 'failed', { error: apiErr }, broadcast);
    return { ok: false, error: apiErr };
  }
}

// ---------------------------------------------------------------------------
// initGithubState — set initial state for a new workflow
// ---------------------------------------------------------------------------

/**
 * Set the initial github_state for a workflow row based on config.
 *
 * Called during workflow ingest to stamp the github_state column so dashboard
 * consumers never see NULL.
 *
 *   - github.enabled === false (or github section absent)  → 'disabled'
 *   - github.enabled + missing owner/repo in context       → 'unconfigured'
 *   - github.enabled + auto_pr === true                    → 'idle'
 *   - github.auto_pr === false                             → 'disabled'
 */
export function initGithubState(
  db: DbPool,
  workflowId: string,
  opts: {
    enabled: boolean;
    autoPr: boolean;
    hasOwnerRepo: boolean;
  },
  broadcast?: GithubBroadcastFn,
): void {
  let state: GithubStatus;
  if (!opts.enabled || !opts.autoPr) {
    state = 'disabled';
  } else if (!opts.hasOwnerRepo) {
    state = 'unconfigured';
  } else {
    state = 'idle';
  }
  _writeGithubState(db, workflowId, state, {}, broadcast);
}
