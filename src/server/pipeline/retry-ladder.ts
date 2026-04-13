/**
 * Retry Ladder — determines the retry mode and budget for a failed phase.
 *
 * Source: plan-draft3.md §Retry (D24–D27); feat-pipeline-engine AC-3:
 *   "Retry ladder applies in order: attempt 1 = continue (-c),
 *    attempt 2 = fresh_with_failure_summary, attempt 3 = awaiting_user;
 *    configurable max_outer_retries per phase."
 *
 * This module is PURE: no side effects, no I/O, no SQLite access.
 * All decisions are driven by `items.retry_count` and per-phase config
 * (max_outer_retries, retry_ladder).
 *
 * Vocabulary:
 *   retry_count       — value stored in items.retry_count; incremented each
 *                       time the engine decides to retry (not on the original
 *                       attempt).
 *   maxOuterRetries   — the cap on retry_count after which budget is gone.
 *   retryLadder       — ordered list of modes indexed by retry_count.
 *                       ladder[0] = mode for first retry,
 *                       ladder[1] = mode for second retry, …
 *                       'awaiting_user' in the ladder is a sentinel meaning
 *                       "stop retrying here".
 */

/** Retry mode used for the next session attempt. */
export type RetryMode =
  | 'continue'
  | 'fresh_with_failure_summary'
  | 'fresh_with_diff'
  | 'awaiting_user';

/**
 * Default retry ladder when no per-phase override is configured.
 *   Index 0 (retry_count=0): attempt 1 uses 'continue' (-c flag).
 *   Index 1 (retry_count=1): attempt 2 uses 'fresh_with_failure_summary'.
 *   Index 2 (retry_count=2): 'awaiting_user' sentinel → exhausted.
 */
export const DEFAULT_RETRY_LADDER: readonly RetryMode[] = [
  'continue',
  'fresh_with_failure_summary',
  'awaiting_user',
];

/**
 * Default maximum outer retries (matches the length of DEFAULT_RETRY_LADDER).
 * With the default ladder this allows 2 real retry sessions before exhaustion.
 */
export const DEFAULT_MAX_OUTER_RETRIES = 3;

/** Result of computing the next retry decision. */
export type RetryDecision =
  | {
      kind: 'retry';
      /** Mode for the next session attempt. Never 'awaiting_user'. */
      mode: Exclude<RetryMode, 'awaiting_user'>;
      /**
       * Value to write to items.retry_count after committing the
       * awaiting_retry transition. Equal to params.retryCount + 1.
       */
      nextRetryCount: number;
    }
  | { kind: 'exhausted' };

/**
 * Compute the next retry decision for a failed phase.
 *
 * Call this when the engine receives a failure event (session_fail,
 * validator_fail, diff_check_fail, pre_command_failed, post_command_action=fail)
 * and needs to decide between awaiting_retry and awaiting_user.
 *
 * @param retryCount      Current items.retry_count (0 before any retry).
 * @param maxOuterRetries Phase-level cap (default DEFAULT_MAX_OUTER_RETRIES).
 * @param retryLadder     Ordered modes (default DEFAULT_RETRY_LADDER).
 *
 * @returns
 *   { kind: 'retry', mode, nextRetryCount } — retry using `mode`; the caller
 *     must write nextRetryCount to items.retry_count inside the transition
 *     transaction.
 *   { kind: 'exhausted' } — budget exhausted; transition to awaiting_user.
 */
export function computeRetryDecision(params: {
  retryCount: number;
  maxOuterRetries: number;
  retryLadder: readonly RetryMode[];
}): RetryDecision {
  const { retryCount, maxOuterRetries, retryLadder } = params;

  // Hard cap: retry_count has already hit the maximum.
  if (retryCount >= maxOuterRetries) {
    return { kind: 'exhausted' };
  }

  // Look up the mode for this retry slot.
  const mode: RetryMode = retryLadder[retryCount] ?? 'awaiting_user';

  // 'awaiting_user' acts as an in-ladder sentinel for early exhaustion.
  if (mode === 'awaiting_user') {
    return { kind: 'exhausted' };
  }

  return { kind: 'retry', mode, nextRetryCount: retryCount + 1 };
}
