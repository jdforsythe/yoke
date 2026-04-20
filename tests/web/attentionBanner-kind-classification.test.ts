/**
 * Exhaustiveness guard: every kind in engine.ts KIND_MAP must be classified
 * as either retryable (in RETRYABLE_KINDS) or explicitly non-retryable.
 *
 * Adding a new kind to KIND_MAP without updating the UI classification causes
 * this test to fail, preventing silent regressions on the button label/action.
 */

import { describe, it, expect } from 'vitest';
import { KIND_MAP } from '../../src/server/pipeline/engine.js';
// Import from the plain .ts module (not the .tsx component) to satisfy root tsc
// which has no JSX support. AttentionBanner.tsx re-exports RETRYABLE_KINDS from here.
import { RETRYABLE_KINDS } from '../../src/web/src/components/AttentionBanner/attentionKinds.js';

// Kinds that are intentionally NOT retryable. Round 3 adds stage_needs_approval
// with a dedicated approval flow — it must never trigger a blind retry.
const NON_RETRYABLE_KINDS: ReadonlySet<string> = new Set(['stage_needs_approval']);

describe('AttentionBanner kind classification', () => {
  it('every kind in engine KIND_MAP is classified as retryable or non-retryable', () => {
    const unclassified: string[] = [];
    for (const kind of KIND_MAP) {
      if (!RETRYABLE_KINDS.has(kind) && !NON_RETRYABLE_KINDS.has(kind)) {
        unclassified.push(kind);
      }
    }
    expect(unclassified).toEqual([]);
  });

  it('retryable kinds are correctly classified', () => {
    for (const kind of ['bootstrap_failed', 'awaiting_user_retry', 'revisit_limit', 'seed_failed']) {
      expect(RETRYABLE_KINDS.has(kind)).toBe(true);
    }
  });

  it('stage_needs_approval is not retryable', () => {
    expect(RETRYABLE_KINDS.has('stage_needs_approval')).toBe(false);
  });

  it('RETRYABLE_KINDS and NON_RETRYABLE_KINDS are disjoint', () => {
    for (const kind of RETRYABLE_KINDS) {
      expect(NON_RETRYABLE_KINDS.has(kind)).toBe(false);
    }
  });

  it('KIND_MAP contains all expected engine-emitted kinds', () => {
    for (const kind of ['bootstrap_failed', 'awaiting_user_retry', 'revisit_limit', 'stage_needs_approval', 'seed_failed']) {
      expect(KIND_MAP.has(kind)).toBe(true);
    }
  });
});
