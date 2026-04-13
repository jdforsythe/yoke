/**
 * GitHub auth resolution — AC-4 + AC-2.
 *
 * Resolution order (mirrors github.auth_order config default):
 *   1. GITHUB_TOKEN env var — used directly if non-empty.
 *   2. gh auth token        — shell command; token is read from stdout.
 *
 * If both fail, returns a structured AuthResult with kind='auth_failed' that
 * names each attempted source and the specific failure reason.  Never throws;
 * never produces a stack trace as the user-visible error.
 *
 * All external I/O is injected via AuthDeps so tests can stub without live
 * env vars or a real gh installation.
 */

import type { AuthAttempt, GithubAuthError } from './types.js';

// ---------------------------------------------------------------------------
// Deps interface (injectable for tests)
// ---------------------------------------------------------------------------

export interface AuthDeps {
  /** Read a process environment variable. Default: process.env[key]. */
  getEnv(key: string): string | undefined;
  /**
   * Execute `gh auth token` and return the trimmed stdout.
   * Reject with an Error whose message describes the failure
   * (e.g. "exit code 1: not logged in").
   */
  execGhAuthToken(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface AuthSuccess {
  token: string;
  source: 'GITHUB_TOKEN' | 'gh_auth';
}

export type AuthResult =
  | { ok: true; value: AuthSuccess }
  | { ok: false; failure: GithubAuthError };

// ---------------------------------------------------------------------------
// resolveAuth
// ---------------------------------------------------------------------------

/**
 * Resolve a GitHub auth token using the configured resolution order.
 *
 * AC-4: On failure the returned GithubAuthError lists every attempted source
 * and the reason each was rejected — never a raw exception stack trace.
 */
export async function resolveAuth(deps: AuthDeps): Promise<AuthResult> {
  const attempts: AuthAttempt[] = [];

  // --- Step 1: GITHUB_TOKEN ---
  const envToken = deps.getEnv('GITHUB_TOKEN');
  if (envToken && envToken.trim().length > 0) {
    return { ok: true, value: { token: envToken.trim(), source: 'GITHUB_TOKEN' } };
  }
  attempts.push({
    source: 'GITHUB_TOKEN',
    reason: envToken === undefined ? 'environment variable not set' : 'environment variable is empty',
  });

  // --- Step 2: gh auth token ---
  try {
    const ghToken = await deps.execGhAuthToken();
    if (ghToken && ghToken.trim().length > 0) {
      return { ok: true, value: { token: ghToken.trim(), source: 'gh_auth' } };
    }
    attempts.push({
      source: 'gh_auth',
      reason: 'gh auth token returned empty output',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    attempts.push({ source: 'gh_auth', reason: message });
  }

  return {
    ok: false,
    failure: { kind: 'auth_failed', attempts },
  };
}

// ---------------------------------------------------------------------------
// Production deps factory
// ---------------------------------------------------------------------------

/**
 * Returns production AuthDeps that read from real process.env and run the
 * real `gh auth token` command.
 *
 * Kept separate so tests never import child_process.
 */
export function makeProductionAuthDeps(): AuthDeps {
  return {
    getEnv(key: string): string | undefined {
      return process.env[key];
    },
    async execGhAuthToken(): Promise<string> {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      try {
        const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 10_000 });
        return stdout.trim();
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException & { stderr?: string; code?: number | string };
        const detail = e.stderr?.trim() || e.message;
        throw new Error(`gh auth token failed (${String(e.code ?? 'unknown')}): ${detail}`);
      }
    },
  };
}
