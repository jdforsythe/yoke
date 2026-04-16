/**
 * Failure classifier — categorises a session failure as one of:
 *   transient  — rate-limit, network glitch; retry with backoff
 *   permanent  — authentication/credential failure; requires user action
 *   policy     — content-policy or diff-check violation; requires user review
 *   unknown    — pattern not recognised; always routes to awaiting_user (D07)
 *
 * Source of truth: docs/design/state-machine-transitions.md §Guard mechanics
 *
 * This function has NO side effects.  It performs no SQLite writes,
 * no I/O, no timer creation.  Same inputs always produce the same result.
 *
 * Inputs:
 *   stderr     — captured stderr text from the failed session
 *   parseState — stream-json parse counters from the session (RC-3)
 *
 * The Pipeline Engine calls classify() before performing a transition
 * lookup on a session_fail event.
 */

export type FailureClass = 'transient' | 'permanent' | 'policy' | 'unknown';

/**
 * Stream-json parse state captured during the session.
 * Provides additional context beyond stderr alone (RC-3).
 */
export interface ParseState {
  /**
   * Number of lines that failed JSON.parse() during the session.
   * A non-zero value indicates a partially tainted stream.
   */
  parseErrors: number;
  /**
   * `type` field from the last successfully parsed stream-json event,
   * or null if the session produced no parseable output.
   */
  lastEventType: string | null;
}

// ---------------------------------------------------------------------------
// Pattern tables
// ---------------------------------------------------------------------------

/** Patterns that indicate a transient (retryable) failure. */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /rate_limit_error/i,
  /overloaded_error/i,
  /rate\s+limit/i,
  /too many requests/i,
  /overloaded/i,
  /\b529\b/,          // Anthropic overload HTTP status
  /\b503\b/,          // service unavailable
  /\b502\b/,          // bad gateway
  /\b500\b/,          // internal server error
  /\b504\b/,          // gateway timeout
  /ECONNRESET/,
  /ETIMEDOUT/,
  /connection\s+reset/i,
  /network\s+timeout/i,
  /request\s+timeout/i,
];

/** Patterns that indicate a permanent (non-retryable) failure. */
const PERMANENT_PATTERNS: readonly RegExp[] = [
  /authentication_error/i,
  /invalid_api_key/i,
  /permission_error/i,
  /authentication\s+failed/i,
  /\bunauthorized\b/i,
  /not\s+authorized/i,
  /invalid\s+api\s+key/i,
  /\bunauthenticated\b/i,
  /\b401\b/,           // HTTP 401 Unauthorized
  /\b403\b/,           // HTTP 403 Forbidden (permission)
];

/** Patterns that indicate a policy (content/diff) failure. */
const POLICY_PATTERNS: readonly RegExp[] = [
  /content_policy_violation/i,
  /content\s+policy/i,
  /policy\s+violation/i,
  /content\s+filter/i,
  /safety\s+filter/i,
];

// ---------------------------------------------------------------------------
// classify()
// ---------------------------------------------------------------------------

/**
 * Classify a session failure.
 *
 * Inspection order: transient → permanent → policy → unknown.
 * If the stderr string matches a pattern in one class, that class is
 * returned immediately without checking further classes.
 *
 * Parse-state influence (RC-3):
 *   - If no stderr pattern matches AND the session produced zero parseable
 *     events (lastEventType === null) AND the stream had parse errors, the
 *     failure likely represents a corrupted or wholly unparseable stream;
 *     this is classified as 'policy' to prevent automatic retry on a
 *     session whose output was never interpretable.
 *   - In all other unmatched cases 'unknown' is returned.
 *
 * 'unknown' always routes to awaiting_user (D07, state-machine-transitions.md
 * §Guard mechanics); there is no code path where 'unknown' enables a retry.
 */
export function classify(stderr: string, parseState: ParseState): FailureClass {
  if (matches(stderr, TRANSIENT_PATTERNS)) {
    return 'transient';
  }

  if (matches(stderr, PERMANENT_PATTERNS)) {
    return 'permanent';
  }

  if (matches(stderr, POLICY_PATTERNS)) {
    return 'policy';
  }

  // Parse-state tiebreaker: a session that produced no parseable events at
  // all AND had stream parse errors is structurally corrupted.  Classify as
  // policy to avoid retrying an uninterpretable stream.
  if (parseState.parseErrors > 0 && parseState.lastEventType === null) {
    return 'policy';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function matches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}
