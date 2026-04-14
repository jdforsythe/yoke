/**
 * Push-before-PR guard — AC-3 + RC-1.
 *
 * Refuses PR creation if the local branch has commits that have not been
 * pushed to the remote.  This guard is ALWAYS enforced; it is not config-gated.
 *
 * Detection: `git log origin/<branch>..<branch> --oneline` produces one line
 * per unpushed commit.  An empty output means the branch is fully pushed.
 *
 * If the remote tracking branch does not exist yet (fresh branch never pushed)
 * the git command exits non-zero; we treat that as "not pushed" with a clear
 * message telling the caller to push first.
 *
 * All git I/O is injected via PushGuardDeps so tests can stub without a
 * real git repository.
 */

// ---------------------------------------------------------------------------
// Deps interface (injectable for tests)
// ---------------------------------------------------------------------------

export interface PushGuardDeps {
  /**
   * Run a git command and return trimmed stdout.
   * Should reject with an Error whose message includes the git stderr if the
   * command exits non-zero.
   */
  execGit(args: string[]): Promise<string>;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface PushGuardResult {
  /** true if the branch is fully pushed and PR creation may proceed. */
  ok: boolean;
  /** Present only when ok=false; human-readable explanation. */
  reason?: string;
  /** Number of unpushed commits detected (0 when ok=true or reason is
   *  an error rather than a count). */
  unpushedCount?: number;
}

// ---------------------------------------------------------------------------
// checkPushed
// ---------------------------------------------------------------------------

/**
 * AC-3: Verify that <branch> has no unpushed commits relative to origin/<branch>.
 *
 * Always enforced — callers must not skip this check based on config.
 */
export async function checkPushed(
  branch: string,
  deps: PushGuardDeps,
): Promise<PushGuardResult> {
  let stdout: string;
  try {
    stdout = await deps.execGit([
      'log',
      `origin/${branch}..${branch}`,
      '--oneline',
    ]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Remote tracking branch likely doesn't exist (branch never pushed).
    return {
      ok: false,
      reason: `remote tracking branch origin/${branch} not found or git error — push the branch first (${message})`,
    };
  }

  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    unpushedCount: lines.length,
    reason: `branch ${branch} has ${lines.length} unpushed commit(s); push before creating a PR`,
  };
}

// ---------------------------------------------------------------------------
// Production deps factory
// ---------------------------------------------------------------------------

/**
 * Returns production PushGuardDeps that run real git commands.
 * Kept separate so tests never import child_process.
 */
export function makeProductionPushGuardDeps(cwd: string): PushGuardDeps {
  return {
    async execGit(args: string[]): Promise<string> {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      try {
        const { stdout } = await execFileAsync('git', args, { cwd, timeout: 15_000 });
        return stdout.trim();
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException & { stderr?: string; code?: number | string };
        const detail = e.stderr?.trim() || e.message;
        throw new Error(`git ${args[0]} failed (${String(e.code ?? 'unknown')}): ${detail}`);
      }
    },
  };
}
