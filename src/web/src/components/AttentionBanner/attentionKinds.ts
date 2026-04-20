/**
 * Attention kind classification — extracted from AttentionBanner.tsx so
 * the unit test (tests/web/) can import without JSX support in the root tsc.
 *
 * AttentionBanner.tsx re-exports RETRYABLE_KINDS from here so the public API
 * is unchanged (AC: "AttentionBanner.tsx exports a RETRYABLE_KINDS set").
 */

/**
 * Kinds that require a retry call after ack to unblock the workflow.
 * Round 3 adds stage_needs_approval with a dedicated approval flow —
 * it must NOT appear here (it will never trigger a blind retry).
 * seed_failed is included to accept r2-06 without a UI change.
 */
export const RETRYABLE_KINDS: ReadonlySet<string> = new Set([
  'bootstrap_failed',
  'awaiting_user_retry',
  'revisit_limit',
  'seed_failed',
]);
