/**
 * Unit tests for the retry ladder (src/server/pipeline/retry-ladder.ts).
 *
 * All tests are pure: no I/O, no SQLite, no side effects.
 *
 * Coverage map — feat-pipeline-engine AC-3:
 *   "Retry ladder applies in order: attempt 1 = continue (-c),
 *    attempt 2 = fresh_with_failure_summary, attempt 3 = awaiting_user;
 *    configurable max_outer_retries per phase."
 */

import { describe, it, expect } from 'vitest';
import {
  computeRetryDecision,
  DEFAULT_RETRY_LADDER,
  DEFAULT_MAX_OUTER_RETRIES,
  type RetryMode,
} from '../../src/server/pipeline/retry-ladder.js';

// ---------------------------------------------------------------------------
// Default ladder
// ---------------------------------------------------------------------------

describe('computeRetryDecision — default ladder', () => {
  it('retry_count=0 → retry with continue (attempt 1)', () => {
    const result = computeRetryDecision({
      retryCount: 0,
      maxOuterRetries: DEFAULT_MAX_OUTER_RETRIES,
      retryLadder: DEFAULT_RETRY_LADDER,
    });
    expect(result).toEqual({ kind: 'retry', mode: 'continue', nextRetryCount: 1 });
  });

  it('retry_count=1 → retry with fresh_with_failure_summary (attempt 2)', () => {
    const result = computeRetryDecision({
      retryCount: 1,
      maxOuterRetries: DEFAULT_MAX_OUTER_RETRIES,
      retryLadder: DEFAULT_RETRY_LADDER,
    });
    expect(result).toEqual({
      kind: 'retry',
      mode: 'fresh_with_failure_summary',
      nextRetryCount: 2,
    });
  });

  it('retry_count=2 → exhausted (ladder entry is awaiting_user sentinel)', () => {
    const result = computeRetryDecision({
      retryCount: 2,
      maxOuterRetries: DEFAULT_MAX_OUTER_RETRIES,
      retryLadder: DEFAULT_RETRY_LADDER,
    });
    expect(result).toEqual({ kind: 'exhausted' });
  });

  it('retry_count=3 → exhausted (at cap)', () => {
    const result = computeRetryDecision({
      retryCount: 3,
      maxOuterRetries: DEFAULT_MAX_OUTER_RETRIES,
      retryLadder: DEFAULT_RETRY_LADDER,
    });
    expect(result).toEqual({ kind: 'exhausted' });
  });

  it('retry_count > maxOuterRetries → exhausted (over limit)', () => {
    const result = computeRetryDecision({
      retryCount: 10,
      maxOuterRetries: DEFAULT_MAX_OUTER_RETRIES,
      retryLadder: DEFAULT_RETRY_LADDER,
    });
    expect(result).toEqual({ kind: 'exhausted' });
  });
});

// ---------------------------------------------------------------------------
// maxOuterRetries = 0 (never retry)
// ---------------------------------------------------------------------------

describe('computeRetryDecision — max_outer_retries = 0', () => {
  it('always exhausted immediately', () => {
    const result = computeRetryDecision({
      retryCount: 0,
      maxOuterRetries: 0,
      retryLadder: DEFAULT_RETRY_LADDER,
    });
    expect(result).toEqual({ kind: 'exhausted' });
  });
});

// ---------------------------------------------------------------------------
// maxOuterRetries = 1 (one retry only)
// ---------------------------------------------------------------------------

describe('computeRetryDecision — max_outer_retries = 1', () => {
  it('retry_count=0 → retry with continue', () => {
    const result = computeRetryDecision({
      retryCount: 0,
      maxOuterRetries: 1,
      retryLadder: DEFAULT_RETRY_LADDER,
    });
    expect(result).toEqual({ kind: 'retry', mode: 'continue', nextRetryCount: 1 });
  });

  it('retry_count=1 → exhausted (cap reached)', () => {
    const result = computeRetryDecision({
      retryCount: 1,
      maxOuterRetries: 1,
      retryLadder: DEFAULT_RETRY_LADDER,
    });
    expect(result).toEqual({ kind: 'exhausted' });
  });
});

// ---------------------------------------------------------------------------
// Custom retry ladders
// ---------------------------------------------------------------------------

describe('computeRetryDecision — custom retry_ladder', () => {
  it('ladder with fresh_with_diff at slot 0', () => {
    const customLadder: readonly RetryMode[] = ['fresh_with_diff', 'fresh_with_failure_summary'];
    const result = computeRetryDecision({
      retryCount: 0,
      maxOuterRetries: 2,
      retryLadder: customLadder,
    });
    expect(result).toEqual({ kind: 'retry', mode: 'fresh_with_diff', nextRetryCount: 1 });
  });

  it('ladder with awaiting_user sentinel at slot 0 → immediately exhausted', () => {
    const customLadder: readonly RetryMode[] = ['awaiting_user', 'continue'];
    const result = computeRetryDecision({
      retryCount: 0,
      maxOuterRetries: 2,
      retryLadder: customLadder,
    });
    expect(result).toEqual({ kind: 'exhausted' });
  });

  it('awaiting_user sentinel mid-ladder → exhausted before cap', () => {
    const customLadder: readonly RetryMode[] = ['continue', 'awaiting_user', 'fresh_with_diff'];
    // retry_count=1 hits the sentinel before reaching cap=3
    const result = computeRetryDecision({
      retryCount: 1,
      maxOuterRetries: 3,
      retryLadder: customLadder,
    });
    expect(result).toEqual({ kind: 'exhausted' });
  });

  it('ladder shorter than maxOuterRetries → uses awaiting_user for out-of-bounds slots', () => {
    // ladder has 1 entry; retryCount=1 is past the end → treated as awaiting_user
    const customLadder: readonly RetryMode[] = ['continue'];
    const result = computeRetryDecision({
      retryCount: 1,
      maxOuterRetries: 5, // cap not reached
      retryLadder: customLadder,
    });
    // ladder[1] is undefined → sentinel → exhausted
    expect(result).toEqual({ kind: 'exhausted' });
  });

  it('fresh_with_diff at every slot', () => {
    const allDiff: readonly RetryMode[] = [
      'fresh_with_diff',
      'fresh_with_diff',
      'fresh_with_diff',
    ];
    for (let i = 0; i < 3; i++) {
      const result = computeRetryDecision({
        retryCount: i,
        maxOuterRetries: 3,
        retryLadder: allDiff,
      });
      expect(result).toEqual({ kind: 'retry', mode: 'fresh_with_diff', nextRetryCount: i + 1 });
    }
    // At cap
    const atCap = computeRetryDecision({
      retryCount: 3,
      maxOuterRetries: 3,
      retryLadder: allDiff,
    });
    expect(atCap).toEqual({ kind: 'exhausted' });
  });
});

// ---------------------------------------------------------------------------
// nextRetryCount is always retryCount + 1
// ---------------------------------------------------------------------------

describe('computeRetryDecision — nextRetryCount invariant', () => {
  it('nextRetryCount = retryCount + 1 for all retry slots', () => {
    const ladder: readonly RetryMode[] = ['continue', 'fresh_with_failure_summary'];
    for (let retryCount = 0; retryCount < 2; retryCount++) {
      const result = computeRetryDecision({ retryCount, maxOuterRetries: 2, retryLadder: ladder });
      if (result.kind === 'retry') {
        expect(result.nextRetryCount).toBe(retryCount + 1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_RETRY_LADDER and DEFAULT_MAX_OUTER_RETRIES constants
// ---------------------------------------------------------------------------

describe('DEFAULT constants', () => {
  it('DEFAULT_RETRY_LADDER has 3 entries', () => {
    expect(DEFAULT_RETRY_LADDER).toHaveLength(3);
  });

  it('DEFAULT_RETRY_LADDER follows the spec order', () => {
    expect(DEFAULT_RETRY_LADDER[0]).toBe('continue');
    expect(DEFAULT_RETRY_LADDER[1]).toBe('fresh_with_failure_summary');
    expect(DEFAULT_RETRY_LADDER[2]).toBe('awaiting_user');
  });

  it('DEFAULT_MAX_OUTER_RETRIES is 3', () => {
    expect(DEFAULT_MAX_OUTER_RETRIES).toBe(3);
  });

  it('DEFAULT_RETRY_LADDER length equals DEFAULT_MAX_OUTER_RETRIES', () => {
    expect(DEFAULT_RETRY_LADDER.length).toBe(DEFAULT_MAX_OUTER_RETRIES);
  });
});
