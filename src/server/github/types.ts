/**
 * GitHub integration types — D48 GithubState enum and related structures.
 *
 * Source: docs/idea/change-log.md D48, feat-github spec.
 *
 * GithubStatus mirrors the full button-state enum from the dashboard spec:
 *   disabled       — github.enabled is false (or section absent) in config
 *   unconfigured   — enabled but required fields missing (no owner/repo)
 *   idle           — configured, no PR initiated yet
 *   creating       — PR creation in flight
 *   created        — PR successfully created; prNumber and prUrl are populated
 *   failed         — PR creation failed; error field is populated
 */

// ---------------------------------------------------------------------------
// GithubStatus enum
// ---------------------------------------------------------------------------

export type GithubStatus =
  | 'disabled'
  | 'unconfigured'
  | 'idle'
  | 'creating'
  | 'created'
  | 'failed';

// ---------------------------------------------------------------------------
// Auth error — emitted when both GITHUB_TOKEN and gh auth fail
// ---------------------------------------------------------------------------

export interface AuthAttempt {
  /** Which auth source was tried. */
  source: 'GITHUB_TOKEN' | 'gh_auth';
  /** Human-readable reason it failed. */
  reason: string;
}

export interface GithubAuthError {
  kind: 'auth_failed';
  /** Ordered list of attempts, each naming the source and failure reason. */
  attempts: AuthAttempt[];
}

// ---------------------------------------------------------------------------
// API error — emitted when the Octokit or gh CLI call itself fails
// ---------------------------------------------------------------------------

export interface GithubApiError {
  kind: 'api_failed';
  /** HTTP status (from Octokit) or exit code (from gh CLI), if available. */
  statusCode?: number;
  message: string;
}

export type GithubError = GithubAuthError | GithubApiError;

// ---------------------------------------------------------------------------
// DB row shape (mirrors workflows columns added by 0002_github_state.sql)
// ---------------------------------------------------------------------------

export interface GithubStateRow {
  github_state: GithubStatus | null;
  github_pr_number: number | null;
  github_pr_url: string | null;
  /** 'open' | 'closed' | 'merged' — filled by PR polling, not creation */
  github_pr_state: string | null;
  /** JSON-serialised GithubError, or null */
  github_error: string | null;
  github_last_checked_at: string | null;
}
