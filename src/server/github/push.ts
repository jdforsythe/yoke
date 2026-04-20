/**
 * pushBranch — runs `git -C <worktreePath> push -u origin <branchName>`
 * and classifies any failure by stderr substring before surfacing it as a
 * structured PushResult.
 *
 * Design notes:
 *   • All git I/O is injected via PushDeps so tests never need a real repo.
 *   • --force and --no-verify are never passed (RC: respects push hooks).
 *   • rawStderr is captured for debugging but must never appear in
 *     user-facing messages.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PushDeps {
  /**
   * Execute a git command with the given args.  Returns trimmed stdout on
   * success; throws an Error whose message is the stderr text on failure.
   */
  execGit(args: string[]): Promise<string>;
}

export type PushErrorKind =
  | 'auth_failed'
  | 'non_fast_forward'
  | 'network_failed'
  | 'other';

export type PushResult =
  | { ok: true }
  | { ok: false; kind: PushErrorKind; message: string; rawStderr: string };

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const AUTH_MARKERS = [
  'authentication',
  'permission denied',
  'could not read username',
  'could not read password',
];
const FAST_FORWARD_MARKERS = [
  'non-fast-forward',
  'updates were rejected',
  'fetch first',
];
const NETWORK_MARKERS = [
  'could not resolve',
  'network is unreachable',
  'timeout',
  'connection refused',
];

function classifyStderr(raw: string): PushErrorKind {
  const lower = raw.toLowerCase();
  if (AUTH_MARKERS.some((m) => lower.includes(m))) return 'auth_failed';
  if (FAST_FORWARD_MARKERS.some((m) => lower.includes(m))) return 'non_fast_forward';
  if (NETWORK_MARKERS.some((m) => lower.includes(m))) return 'network_failed';
  return 'other';
}

// ---------------------------------------------------------------------------
// pushBranch
// ---------------------------------------------------------------------------

export async function pushBranch(
  branchName: string,
  worktreePath: string,
  deps: PushDeps,
): Promise<PushResult> {
  try {
    await deps.execGit(['-C', worktreePath, 'push', '-u', 'origin', branchName]);
    return { ok: true };
  } catch (err: unknown) {
    const rawStderr = err instanceof Error ? err.message : String(err);
    const kind = classifyStderr(rawStderr);
    return { ok: false, kind, message: `git push failed: ${kind}`, rawStderr };
  }
}

// ---------------------------------------------------------------------------
// Production deps factory
// ---------------------------------------------------------------------------

/**
 * Returns production PushDeps that run real git commands.
 * Kept separate so tests never import child_process.
 */
export function makeProductionPushDeps(): PushDeps {
  return {
    async execGit(args: string[]): Promise<string> {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      try {
        const { stdout } = await execFileAsync('git', args, { timeout: 60_000 });
        return stdout.trim();
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException & { stderr?: string; code?: number | string };
        const detail = e.stderr?.trim() || e.message;
        throw new Error(detail);
      }
    },
  };
}
