/**
 * Worktree Manager — creates, bootstraps, and cleans up git worktrees.
 *
 * Responsibilities (plan-draft3 §Worktree Management, D40):
 *   - Create a git branch + worktree under <baseDir>/<slug>-<shortid>/
 *   - Run bootstrap.commands as a state-machine phase, raising
 *     bootstrap_ok / bootstrap_fail events (consumed by Pipeline Engine).
 *   - Invoke .yoke/teardown.sh (if present) before git worktree remove.
 *   - Ordered cleanup: kill tracked pids → teardown → git worktree remove
 *     --force → branch retention decision.
 *   - Refuse auto-cleanup if branch has unpushed commits without a PR.
 *
 * Non-responsibilities:
 *   - Does NOT apply state-machine transitions (Pipeline Engine's job).
 *   - Does NOT parse NDJSON (StreamJsonParser's job).
 *   - Does NOT manage long-running agent sessions (ProcessManager's job).
 *
 * Review criteria compliance:
 *   RC-1  runBootstrap() returns a BootstrapEvent for the Pipeline Engine
 *         to apply via transition(); this module never calls transition().
 *   RC-2  Branch retention decision uses 'git log --not --remotes',
 *         reading the git remote state — not just local refs.
 *   RC-3  'git worktree remove --force' is called only after runTeardown().
 *   RC-4  Worktree path validated: must be absolute and strictly under baseDir.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { DbPool } from '../storage/db.js';
import { makeBranchName, makeWorktreeDirName } from './branch.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type WorktreeErrorKind =
  | 'invalid_path'    // computed path is not absolute
  | 'path_traversal'  // computed path escapes the configured baseDir
  | 'git_error'       // git command exited non-zero
  | 'spawn_failed';   // spawn itself failed (ENOENT, EACCES)

export class WorktreeError extends Error {
  constructor(
    public readonly kind: WorktreeErrorKind,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  /** Full git branch name, e.g. 'yoke/add-auth-abc12345'. */
  branchName: string;
  /** Absolute path to the worktree directory. */
  worktreePath: string;
}

/**
 * Event raised by runBootstrap(); consumed by the Pipeline Engine.
 * The Pipeline Engine applies the corresponding transition:
 *   bootstrap_ok   → (bootstrapping, bootstrap_ok)   → in_progress
 *   bootstrap_fail → (bootstrapping, bootstrap_fail) → bootstrap_failed
 */
export type BootstrapEvent =
  | { type: 'bootstrap_ok' }
  | {
      type: 'bootstrap_fail';
      /** The command string (from ResolvedConfig) that exited non-zero. */
      failedCommand: string;
      exitCode: number;
      stderr: string;
    };

export interface CreateWorktreeOpts {
  workflowId: string;
  workflowName: string;
  /** Absolute path to the base directory for worktrees (e.g. /repo/.worktrees). */
  baseDir: string;
  /** Git branch prefix. Defaults to 'yoke/'. */
  branchPrefix?: string;
}

export interface RunBootstrapOpts {
  workflowId: string;
  worktreePath: string;
  /** Shell command strings from ResolvedConfig.worktrees.bootstrap.commands. */
  commands: string[];
}

export interface CleanupOpts {
  workflowId: string;
  worktreePath: string;
  branchName: string;
  /** OS PIDs of child processes to kill before teardown. */
  trackedPids: number[];
  /**
   * Milliseconds to wait after SIGTERM before escalating to SIGKILL.
   * Defaults to 10 000 ms.
   */
  gracePeriodMs?: number;
}

export interface CleanupResult {
  worktreeRemoved: boolean;
  /**
   * True when the worktree was NOT removed because the branch has unpushed
   * commits and no corresponding PR was found (AC-5).
   */
  branchRetained: boolean;
  refusedReason?: 'unpushed_commits_no_pr';
}

/**
 * Testability seam for the GitHub PR existence check.
 * Production code uses the default implementation that runs 'gh pr list'.
 */
export type CheckPrFn = (branchName: string, repoRoot: string) => Promise<boolean>;

// ---------------------------------------------------------------------------
// WorktreeManager
// ---------------------------------------------------------------------------

export interface WorktreeManagerOpts {
  /** Absolute path to the git repository root. */
  repoRoot: string;
  /**
   * Optional override for the PR existence check.
   * Defaults to running 'gh pr list --head <branch> --json number'.
   * Pass a stub in tests to avoid requiring the gh CLI.
   */
  checkPr?: CheckPrFn;
}

export class WorktreeManager {
  private readonly repoRoot: string;
  private readonly checkPrFn: CheckPrFn;

  constructor(opts: WorktreeManagerOpts) {
    this.repoRoot = opts.repoRoot;
    this.checkPrFn = opts.checkPr ?? defaultCheckPr;
  }

  // -------------------------------------------------------------------------
  // createWorktree — AC-1, RC-4
  // -------------------------------------------------------------------------

  /**
   * Creates a git branch + worktree under baseDir.
   *
   * Branch name:    yoke/<slug>-<shortid>
   * Worktree path:  <baseDir>/<slug>-<shortid>  (absolute, validated)
   *
   * After the worktree is created, writes branch_name and worktree_path to
   * the workflows row inside a single database transaction (AC-1).
   *
   * @throws {WorktreeError} kind='path_traversal' if computed path escapes baseDir.
   * @throws {WorktreeError} kind='git_error' if git worktree add fails.
   */
  async createWorktree(opts: CreateWorktreeOpts, db: DbPool): Promise<WorktreeInfo> {
    const { workflowId, workflowName, baseDir, branchPrefix = 'yoke/' } = opts;

    const branchName = makeBranchName(workflowName, workflowId, branchPrefix);
    const dirName = makeWorktreeDirName(workflowName, workflowId);
    // path.resolve ensures the result is absolute even if baseDir is relative.
    const worktreePath = path.resolve(baseDir, dirName);

    // RC-4: validate path is absolute and strictly under baseDir.
    this._validateWorktreePath(worktreePath, baseDir);

    // Ensure the base directory exists before git worktree add creates the subdir.
    fs.mkdirSync(path.resolve(baseDir), { recursive: true });

    // 'git worktree add -b <branch> <path>' creates the branch at HEAD and
    // checks it out in the new worktree directory in one atomic git operation.
    try {
      await execFileAsync('git', [
        '-C', this.repoRoot,
        'worktree', 'add',
        '-b', branchName,
        worktreePath,
      ]);
    } catch (err) {
      throw new WorktreeError(
        'git_error',
        `Failed to create worktree '${worktreePath}' on branch '${branchName}': ${(err as Error).message}`,
        err,
      );
    }

    // Write branch_name and worktree_path inside a single transaction (AC-1).
    db.transaction((writer) => {
      writer
        .prepare(
          `UPDATE workflows
              SET branch_name   = ?,
                  worktree_path = ?,
                  updated_at    = ?
            WHERE id = ?`,
        )
        .run(branchName, worktreePath, new Date().toISOString(), workflowId);
    });

    return { branchName, worktreePath };
  }

  // -------------------------------------------------------------------------
  // runBootstrap — AC-2, AC-3, RC-1
  // -------------------------------------------------------------------------

  /**
   * Runs bootstrap.commands in declared order as a state-machine phase (RC-1).
   *
   * Returns a BootstrapEvent for the Pipeline Engine to consume:
   *   bootstrap_ok   — all commands exited 0.
   *   bootstrap_fail — a command exited non-zero; subsequent commands are skipped.
   *
   * On bootstrap_fail: inserts a pending_attention row (kind='bootstrap_failed')
   * so the dashboard banner fires (AC-2).
   *
   * The returned event type is what the Pipeline Engine passes to transition():
   *   transition('bootstrapping', event.type)
   * This module never calls transition() itself (RC-1).
   *
   * AC-3 (bootstrap_failed never auto-cleans) is enforced by the state machine:
   * the Pipeline Engine only calls cleanup() on transitions that lead to
   * cleanup side effects; bootstrap_failed has no such transition.
   */
  async runBootstrap(opts: RunBootstrapOpts, db: DbPool): Promise<BootstrapEvent> {
    const { workflowId, worktreePath, commands } = opts;

    for (const cmd of commands) {
      const result = await this._runShellCommand(cmd, worktreePath);

      if (result.exitCode !== 0) {
        const event: BootstrapEvent = {
          type: 'bootstrap_fail',
          failedCommand: cmd,
          exitCode: result.exitCode ?? 1,
          stderr: result.stderr,
        };

        // Insert pending_attention so the dashboard banner fires (AC-2).
        db.transaction((writer) => {
          writer
            .prepare(
              `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
               VALUES (?, 'bootstrap_failed', ?, ?)`,
            )
            .run(
              workflowId,
              JSON.stringify({
                failedCommand: cmd,
                exitCode: result.exitCode,
                stderr: result.stderr,
              }),
              new Date().toISOString(),
            );
        });

        return event;
      }
    }

    return { type: 'bootstrap_ok' };
  }

  // -------------------------------------------------------------------------
  // runTeardown — AC-4
  // -------------------------------------------------------------------------

  /**
   * Invokes .yoke/teardown.sh in the worktree directory, if it exists.
   *
   * Absence of the script is NOT an error (AC-4). A non-zero exit is
   * treated as non-fatal: a warning is logged and cleanup continues.
   * This mirrors the semantics described in plan-draft3 §Worktree Management:
   * teardown stops containers and closes sockets — failure should not prevent
   * the worktree from being removed.
   */
  async runTeardown(worktreePath: string): Promise<void> {
    const teardownScript = path.join(worktreePath, '.yoke', 'teardown.sh');

    if (!fs.existsSync(teardownScript)) {
      return; // Absence is not an error (AC-4).
    }

    try {
      await execFileAsync('sh', [teardownScript], { cwd: worktreePath });
    } catch {
      // Non-zero exit from teardown.sh is non-fatal — log a warning and
      // continue cleanup so the worktree is still removed.
      console.warn(
        `[worktree] .yoke/teardown.sh exited non-zero in '${worktreePath}'; continuing cleanup`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // cleanup — AC-4, AC-5, AC-6, RC-2, RC-3
  // -------------------------------------------------------------------------

  /**
   * Performs ordered worktree cleanup:
   *
   *   Pre-check — refuse cleanup if branch has unpushed commits without a PR
   *               (AC-5). Logs a warning and returns without destructive action.
   *
   *   Step 1    — kill tracked pids (SIGTERM → gracePeriodMs → SIGKILL).
   *   Step 2    — run .yoke/teardown.sh if present (AC-4).
   *   Step 3    — git worktree remove --force (RC-3: only after teardown).
   *   Step 4    — branch retention decision (v1: keep branch by default).
   *
   * @throws {WorktreeError} kind='git_error' if git worktree remove fails.
   */
  async cleanup(opts: CleanupOpts): Promise<CleanupResult> {
    const { worktreePath, branchName, trackedPids, gracePeriodMs = 10_000 } = opts;

    // Pre-check: branch retention guard (AC-5, RC-2).
    // _hasUnpushedCommits reads the git remote state (not just local refs).
    const hasUnpushed = await this._hasUnpushedCommits(branchName);
    if (hasUnpushed) {
      const prExists = await this.checkPrFn(branchName, this.repoRoot);
      if (!prExists) {
        console.warn(
          `[worktree] auto-cleanup refused for branch '${branchName}': ` +
            'branch has unpushed commits and no open PR was found. ' +
            "Push the branch or create a PR before cleanup, or use 'yoke cancel' to force.",
        );
        return { worktreeRemoved: false, branchRetained: true, refusedReason: 'unpushed_commits_no_pr' };
      }
    }

    // Step 1: Kill tracked pids (SIGTERM → SIGKILL escalation).
    for (const pid of trackedPids) {
      await killProcessGroup(pid, gracePeriodMs);
    }

    // Step 2: Teardown hook (AC-4); must complete before git worktree remove (RC-3).
    await this.runTeardown(worktreePath);

    // Step 3: git worktree remove --force.
    // '--force' is used only here — AFTER teardown has run (RC-3).
    try {
      await execFileAsync('git', [
        '-C', this.repoRoot,
        'worktree', 'remove', '--force', worktreePath,
      ]);
    } catch (err) {
      throw new WorktreeError(
        'git_error',
        `Failed to remove worktree '${worktreePath}': ${(err as Error).message}`,
        err,
      );
    }

    // Step 4: Branch retention decision.
    // v1: retain the branch after worktree removal. The branch is still
    // accessible via 'git checkout yoke/<name>-<shortid>' for inspection.
    // Branch deletion (e.g. after merge) is out of v1 scope per plan-draft3
    // §Worktree Management (D40 §Rules).

    return { worktreeRemoved: true, branchRetained: false };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Validates that worktreePath:
   *   1. Is an absolute path.
   *   2. Is strictly under baseDir (no '..' traversal escapes).
   *
   * RC-4: every worktree is confined to the user-configured baseDir.
   */
  private _validateWorktreePath(worktreePath: string, baseDir: string): void {
    if (!path.isAbsolute(worktreePath)) {
      throw new WorktreeError(
        'invalid_path',
        `Worktree path must be absolute; got: '${worktreePath}'`,
      );
    }

    const canonicalBase = path.resolve(baseDir);
    const canonicalWorktree = path.resolve(worktreePath);

    // The resolved path must START with baseDir + sep to prevent:
    //   - A path that equals baseDir itself (not a subdirectory).
    //   - A path that starts with baseDir but then has a different continuation
    //     after a symlink (not a concern here since we use resolve).
    if (!canonicalWorktree.startsWith(canonicalBase + path.sep)) {
      throw new WorktreeError(
        'path_traversal',
        `Worktree path '${worktreePath}' is not under base directory '${baseDir}'`,
      );
    }
  }

  /**
   * Runs a single shell command string (from bootstrap.commands or teardown).
   *
   * Uses 'sh -c <cmd>' so commands like 'pnpm install' or 'docker compose up -d'
   * work without needing argv-splitting. The .yoke.yml is user-authored and
   * trusted per the architecture threat model.
   *
   * Captures stderr (capped at 4 KB). Returns exit code and stderr string.
   * Never throws — spawn failures are represented as { exitCode: 1 }.
   */
  private async _runShellCommand(
    cmd: string,
    cwd: string,
  ): Promise<{ exitCode: number | null; stderr: string }> {
    try {
      await execFileAsync('sh', ['-c', cmd], {
        cwd,
        env: { ...process.env },
        maxBuffer: 4 * 1024 * 1024, // 4 MB stdout/stderr buffer
      });
      return { exitCode: 0, stderr: '' };
    } catch (err: unknown) {
      // execFileAsync rejects with an error that carries .code (exit code)
      // and .stderr (captured stderr string) when the command exits non-zero.
      // When sh itself cannot be spawned, .code is a string like 'ENOENT'.
      const e = err as { code?: unknown; stderr?: unknown };
      const exitCode = typeof e.code === 'number' ? e.code : 1;
      const rawStderr = typeof e.stderr === 'string' ? e.stderr : '';
      return { exitCode, stderr: rawStderr.slice(0, 4096) };
    }
  }

  /**
   * Checks whether the branch has commits not present on any remote tracking
   * branch (RC-2: reads git remote state, not just local refs).
   *
   * Uses 'git log <branch> --not --remotes --oneline':
   *   - Empty output → all commits are on a remote → false.
   *   - Non-empty output → unpushed commits exist → true.
   *
   * If no remote is configured, '--remotes' is empty so '--not --remotes'
   * filters nothing: all commits appear as "unpushed." This is the
   * conservative direction — refuse cleanup unless a PR exists.
   *
   * Returns false on git command failure (e.g. branch does not yet exist)
   * so cleanup of invalid/pre-push branches is not blocked.
   */
  private async _hasUnpushedCommits(branchName: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', [
        '-C', this.repoRoot,
        'log', branchName,
        '--not', '--remotes',
        '--oneline',
      ]);
      return stdout.trim().length > 0;
    } catch {
      // Branch may not exist yet or git is not available — treat as no
      // unpushed commits so cleanup of non-existent branches is not blocked.
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Default PR existence check (production implementation)
// ---------------------------------------------------------------------------

/**
 * Checks whether a PR exists for the given branch using the 'gh' CLI.
 *
 * 'gh pr list --head <branch> --json number' returns a JSON array:
 *   Non-empty → PR exists → cleanup is allowed even with unpushed commits.
 *   Empty []  → no PR → refuse cleanup if unpushed commits are present.
 *
 * If 'gh' is not installed, not authenticated, or the remote is not GitHub,
 * returns false — the conservative direction (refuse cleanup).
 */
const defaultCheckPr: CheckPrFn = async (
  branchName: string,
  repoRoot: string,
): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'list', '--head', branchName, '--json', 'number'],
      { cwd: repoRoot },
    );
    const parsed = JSON.parse(stdout.trim());
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    // gh not installed, not authenticated, or non-GitHub remote.
    // Safe direction: treat as no PR.
    return false;
  }
};

// ---------------------------------------------------------------------------
// killProcessGroup — SIGTERM → SIGKILL escalation
// ---------------------------------------------------------------------------

/**
 * Sends SIGTERM to the process group of `pid`, waits up to `gracePeriodMs`,
 * then sends SIGKILL if the process group is still alive.
 *
 * Used in cleanup step 1 to kill tracked child pids before teardown runs.
 *
 * SIGTERM is sent to -pid (the entire process group), matching the shutdown
 * contract in plan-draft3 §Process Management §Shutdown.
 */
async function killProcessGroup(pid: number, gracePeriodMs: number): Promise<void> {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // ESRCH: process group already gone — not an error.
    return;
  }

  return new Promise<void>((resolve) => {
    // Poll at 50 ms intervals to detect natural death.
    const poll = setInterval(() => {
      try {
        process.kill(pid, 0); // liveness probe
      } catch {
        // ESRCH: process died naturally before the grace period expired.
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }
    }, 50);

    // Escalate to SIGKILL after the grace period.
    const timer = setTimeout(() => {
      clearInterval(poll);
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Process group gone between SIGTERM and SIGKILL — fine.
      }
      resolve();
    }, gracePeriodMs);
  });
}
