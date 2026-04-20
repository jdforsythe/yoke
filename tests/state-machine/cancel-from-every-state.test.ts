/**
 * Cancel-from-every-state test — asserts that user_cancel from each
 * non-terminal state produces 'abandoned' with the documented side-effects.
 *
 * Iterates STATE_VALUES directly so that adding a new State to the union
 * (and to STATE_VALUES via satisfies) automatically includes it in this test.
 * If user_cancel is missing for the new state, the test fails immediately.
 *
 * Side-effect strings are asserted exactly as they appear in transitions.ts
 * (RC: "not paraphrased").
 *
 * No SQLite, no scheduler, no async.  Pure data-structure check.
 */

import { describe, it, expect } from 'vitest';
import { STATE_VALUES, type State } from '../../src/shared/types/states.js';
import {
  transition,
  type DirectTransitionResult,
} from '../../src/server/state-machine/transitions.js';

// ---------------------------------------------------------------------------
// Terminal states — user_cancel is not expected (or is a no-op) for these.
// 'abandoned' absorbs every event as a no-op (already terminal).
// 'complete' does not list user_cancel — it is fully terminal.
// ---------------------------------------------------------------------------

const TERMINAL_STATES = new Set<State>(['complete', 'abandoned']);

// ---------------------------------------------------------------------------
// Expected side-effects per non-terminal state.
// These must match the sideEffects arrays in transitions.ts exactly.
// ---------------------------------------------------------------------------

const EXPECTED_SIDE_EFFECTS: Record<string, readonly string[]> = {
  pending: ['cascade-cancel dependents'],
  ready: [],
  bootstrapping: ['run teardown', 'remove worktree'],
  bootstrap_failed: ['run teardown', 'remove worktree'],
  in_progress: ['SIGTERM process group'],
  awaiting_retry: [],
  rate_limited: [],
  awaiting_user: [],
  blocked: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('user_cancel from every non-terminal state → abandoned', () => {
  for (const state of STATE_VALUES) {
    if (TERMINAL_STATES.has(state)) continue;

    it(`${state} + user_cancel → abandoned`, () => {
      const result = transition(state, 'user_cancel');

      expect(
        result,
        `(${state}, user_cancel) is not defined in TRANSITIONS — add the transition`,
      ).toBeDefined();

      expect(result!.kind).toBe('direct');
      const direct = result as DirectTransitionResult;

      expect(
        direct.to,
        `(${state}, user_cancel) must target 'abandoned', got '${direct.to}'`,
      ).toBe('abandoned');

      const expected = EXPECTED_SIDE_EFFECTS[state];
      expect(
        expected,
        `EXPECTED_SIDE_EFFECTS is missing an entry for state '${state}' — add it to the test`,
      ).toBeDefined();

      expect(
        [...direct.sideEffects].sort(),
        `(${state}, user_cancel) side-effects must match transitions.ts exactly`,
      ).toEqual([...expected].sort());
    });
  }

  it('complete does not define user_cancel (terminal — no recovery path)', () => {
    expect(transition('complete', 'user_cancel')).toBeUndefined();
  });

  it('abandoned absorbs user_cancel as a no-op (already terminal)', () => {
    const result = transition('abandoned', 'user_cancel') as DirectTransitionResult;
    expect(result).toBeDefined();
    expect(result.to).toBe('abandoned');
    expect(result.sideEffects).toHaveLength(0);
  });
});
