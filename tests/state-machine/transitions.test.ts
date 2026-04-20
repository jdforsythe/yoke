import { describe, it, expect } from 'vitest';
import {
  TRANSITIONS,
  transition,
  type TransitionResult,
  type DirectTransitionResult,
  type ConditionalTransitionResult,
} from '../../src/server/state-machine/transitions.js';
import type { State, Event } from '../../src/server/state-machine/states.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_STATES: readonly State[] = [
  'pending', 'ready', 'bootstrapping', 'bootstrap_failed',
  'in_progress', 'awaiting_retry', 'rate_limited',
  'awaiting_user', 'blocked', 'complete', 'abandoned',
];

const ALL_EVENTS: readonly Event[] = [
  'deps_satisfied', 'phase_start', 'phase_advance', 'stage_complete',
  'stage_approval_granted', 'pre_commands_ok', 'pre_command_failed',
  'session_spawned', 'session_ok', 'session_fail',
  'rate_limit_detected', 'rate_limit_window_elapsed',
  'post_command_ok', 'post_command_action',
  'validators_ok', 'validator_fail', 'diff_check_ok', 'diff_check_fail',
  'retry_budget_remaining', 'retries_exhausted', 'backoff_elapsed',
  'user_retry', 'user_block', 'user_unblock_with_notes', 'user_cancel',
  'bootstrap_ok', 'bootstrap_fail',
];

const TERMINAL_STATES = new Set<State>(['complete', 'abandoned', 'bootstrap_failed']);

// All non-terminal states that have a documented user_cancel row.
const STATES_WITH_USER_CANCEL = new Set<State>([
  'pending', 'ready', 'bootstrapping', 'in_progress', 'awaiting_retry',
  'rate_limited', 'awaiting_user', 'blocked', 'abandoned',
]);

/** Collect all `to` values reachable from a TransitionResult. */
function allTargets(result: TransitionResult): State[] {
  if (result.kind === 'direct') return [result.to];
  return result.outcomes.map(o => o.to);
}

// ---------------------------------------------------------------------------
// Structural completeness
// ---------------------------------------------------------------------------

describe('TRANSITIONS structural completeness', () => {
  it('has an entry for every State (compile-time and runtime)', () => {
    for (const s of ALL_STATES) {
      expect(TRANSITIONS).toHaveProperty(s);
    }
  });

  it('has exactly the 11 defined States as keys — no extras', () => {
    const keys = Object.keys(TRANSITIONS) as State[];
    expect(keys.sort()).toEqual([...ALL_STATES].sort());
  });

  it('every to-state in every result is a valid State', () => {
    const stateSet = new Set<string>(ALL_STATES);
    for (const s of ALL_STATES) {
      const row = TRANSITIONS[s];
      for (const e of ALL_EVENTS) {
        const result = row[e];
        if (result === undefined) continue;
        for (const target of allTargets(result)) {
          expect(stateSet).toContain(target);
        }
      }
    }
  });

  it('all transition outcomes have non-empty guard when kind=conditional', () => {
    for (const s of ALL_STATES) {
      const row = TRANSITIONS[s];
      for (const e of ALL_EVENTS) {
        const result = row[e];
        if (result?.kind !== 'conditional') continue;
        for (const outcome of result.outcomes) {
          expect(outcome.guard.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// transition() pure lookup contract
// ---------------------------------------------------------------------------

describe('transition() pure lookup', () => {
  it('returns undefined for a pair not listed in the table', () => {
    // pending + bootstrap_ok is not a valid pair
    expect(transition('pending', 'bootstrap_ok')).toBeUndefined();
    // pending + session_fail is not a valid pair
    expect(transition('pending', 'session_fail')).toBeUndefined();
    // complete + user_cancel is not listed
    expect(transition('complete', 'user_cancel')).toBeUndefined();
    // complete + session_ok is not listed
    expect(transition('complete', 'session_ok')).toBeUndefined();
  });

  it('returns the same reference on repeated calls (pure / no mutation)', () => {
    const r1 = transition('pending', 'deps_satisfied');
    const r2 = transition('pending', 'deps_satisfied');
    expect(r1).toBe(r2);
  });

  it('does not throw for any (state, event) combination', () => {
    for (const s of ALL_STATES) {
      for (const e of ALL_EVENTS) {
        expect(() => transition(s, e)).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Specific transition spot-checks
// ---------------------------------------------------------------------------

describe('pending transitions', () => {
  it('deps_satisfied → conditional with ready target', () => {
    const r = transition('pending', 'deps_satisfied') as ConditionalTransitionResult;
    expect(r.kind).toBe('conditional');
    const targets = r.outcomes.map(o => o.to);
    expect(targets).toContain('ready');
  });

  it('user_cancel → abandoned directly', () => {
    const r = transition('pending', 'user_cancel') as DirectTransitionResult;
    expect(r.kind).toBe('direct');
    expect(r.to).toBe('abandoned');
  });
});

describe('ready transitions', () => {
  it('phase_start → conditional with bootstrapping and in_progress options', () => {
    const r = transition('ready', 'phase_start') as ConditionalTransitionResult;
    expect(r.kind).toBe('conditional');
    const targets = r.outcomes.map(o => o.to);
    expect(targets).toContain('bootstrapping');
    expect(targets).toContain('in_progress');
  });

  it('user_cancel → abandoned', () => {
    const r = transition('ready', 'user_cancel') as DirectTransitionResult;
    expect(r.to).toBe('abandoned');
  });
});

describe('bootstrapping transitions', () => {
  it('bootstrap_ok → in_progress', () => {
    const r = transition('bootstrapping', 'bootstrap_ok') as DirectTransitionResult;
    expect(r.kind).toBe('direct');
    expect(r.to).toBe('in_progress');
  });

  it('bootstrap_fail → bootstrap_failed', () => {
    const r = transition('bootstrapping', 'bootstrap_fail') as DirectTransitionResult;
    expect(r.kind).toBe('direct');
    expect(r.to).toBe('bootstrap_failed');
  });

  it('user_cancel → abandoned (with teardown side effects)', () => {
    const r = transition('bootstrapping', 'user_cancel') as DirectTransitionResult;
    expect(r.kind).toBe('direct');
    expect(r.to).toBe('abandoned');
    expect(r.sideEffects).toContain('run teardown');
    expect(r.sideEffects).toContain('remove worktree');
  });
});

describe('bootstrap_failed transitions', () => {
  it('only user_retry and user_cancel are defined — no auto-transition', () => {
    // Every event except user_retry and user_cancel returns undefined
    const defined = new Set<Event>(['user_retry', 'user_cancel']);
    for (const e of ALL_EVENTS) {
      const r = transition('bootstrap_failed', e);
      if (defined.has(e)) {
        expect(r).toBeDefined();
      } else {
        expect(r, `bootstrap_failed + ${e} should be undefined`).toBeUndefined();
      }
    }
  });

  it('user_retry → bootstrapping', () => {
    const r = transition('bootstrap_failed', 'user_retry') as DirectTransitionResult;
    expect(r.to).toBe('bootstrapping');
  });

  it('user_cancel → abandoned', () => {
    const r = transition('bootstrap_failed', 'user_cancel') as DirectTransitionResult;
    expect(r.to).toBe('abandoned');
  });
});

describe('in_progress transitions', () => {
  it('session_fail → conditional with transient→awaiting_retry, permanent→awaiting_user, unknown→awaiting_user', () => {
    const r = transition('in_progress', 'session_fail') as ConditionalTransitionResult;
    expect(r.kind).toBe('conditional');

    const transient = r.outcomes.find(o => o.guard.includes('transient'));
    expect(transient).toBeDefined();
    expect(transient!.to).toBe('awaiting_retry');

    const permanent = r.outcomes.find(o => o.guard.includes('permanent'));
    expect(permanent).toBeDefined();
    expect(permanent!.to).toBe('awaiting_user');

    const unknown = r.outcomes.find(o => o.guard.includes('unknown'));
    expect(unknown).toBeDefined();
    expect(unknown!.to).toBe('awaiting_user');
  });

  it('unknown classification outcome always routes to awaiting_user (not awaiting_retry)', () => {
    const r = transition('in_progress', 'session_fail') as ConditionalTransitionResult;
    const unknownOutcomes = r.outcomes.filter(o => o.guard.includes('unknown'));
    for (const uo of unknownOutcomes) {
      expect(uo.to).toBe('awaiting_user');
    }
  });

  it('rate_limit_detected → rate_limited', () => {
    const r = transition('in_progress', 'rate_limit_detected') as DirectTransitionResult;
    expect(r.kind).toBe('direct');
    expect(r.to).toBe('rate_limited');
  });

  it('retries_exhausted → awaiting_user', () => {
    const r = transition('in_progress', 'retries_exhausted') as DirectTransitionResult;
    expect(r.to).toBe('awaiting_user');
  });

  it('user_cancel → abandoned', () => {
    const r = transition('in_progress', 'user_cancel') as DirectTransitionResult;
    expect(r.to).toBe('abandoned');
  });

  it('session_ok → conditional with in_progress (more phases) and complete (last phase) outcomes', () => {
    const r = transition('in_progress', 'session_ok') as ConditionalTransitionResult;
    expect(r.kind).toBe('conditional');
    const targets = r.outcomes.map(o => o.to);
    expect(targets).toContain('in_progress');
    expect(targets).toContain('complete');
  });

  it('post_command_action → conditional covering continue, goto, retry, stop-and-ask, stop, fail', () => {
    const r = transition('in_progress', 'post_command_action') as ConditionalTransitionResult;
    expect(r.kind).toBe('conditional');
    const targets = new Set(r.outcomes.map(o => o.to));
    expect(targets).toContain('in_progress');
    expect(targets).toContain('complete');
    expect(targets).toContain('awaiting_retry');
    expect(targets).toContain('awaiting_user');
    expect(targets).toContain('abandoned');
  });

  it('goto exceeding max_revisits → awaiting_user outcome', () => {
    const r = transition('in_progress', 'post_command_action') as ConditionalTransitionResult;
    // Guard text uses 'limit exceeded' to distinguish from 'within ... limit'
    const revisitOutcome = r.outcomes.find(o => o.guard.includes('max_revisits limit exceeded'));
    expect(revisitOutcome).toBeDefined();
    expect(revisitOutcome!.to).toBe('awaiting_user');
  });

  it('validator_fail → awaiting_retry (when budget > 0)', () => {
    const r = transition('in_progress', 'validator_fail') as ConditionalTransitionResult;
    expect(r.kind).toBe('conditional');
    expect(r.outcomes[0]!.to).toBe('awaiting_retry');
  });

  it('diff_check_fail → awaiting_retry (policy classifier)', () => {
    const r = transition('in_progress', 'diff_check_fail') as ConditionalTransitionResult;
    expect(r.kind).toBe('conditional');
    expect(r.outcomes[0]!.to).toBe('awaiting_retry');
    expect(r.outcomes[0]!.guard).toContain('policy');
  });

  it('pre_commands_ok → in_progress', () => {
    const r = transition('in_progress', 'pre_commands_ok') as DirectTransitionResult;
    expect(r.to).toBe('in_progress');
  });

  it('session_spawned → in_progress', () => {
    const r = transition('in_progress', 'session_spawned') as DirectTransitionResult;
    expect(r.to).toBe('in_progress');
  });
});

describe('awaiting_retry transitions', () => {
  it('backoff_elapsed → conditional with in_progress outcome', () => {
    const r = transition('awaiting_retry', 'backoff_elapsed') as ConditionalTransitionResult;
    expect(r.kind).toBe('conditional');
    const targets = r.outcomes.map(o => o.to);
    expect(targets).toContain('in_progress');
  });

  it('retries_exhausted → awaiting_user', () => {
    const r = transition('awaiting_retry', 'retries_exhausted') as DirectTransitionResult;
    expect(r.to).toBe('awaiting_user');
  });

  it('user_cancel → abandoned', () => {
    const r = transition('awaiting_retry', 'user_cancel') as DirectTransitionResult;
    expect(r.to).toBe('abandoned');
  });
});

describe('rate_limited transitions', () => {
  it('rate_limit_window_elapsed → in_progress', () => {
    const r = transition('rate_limited', 'rate_limit_window_elapsed') as DirectTransitionResult;
    expect(r.to).toBe('in_progress');
  });

  it('user_retry → in_progress', () => {
    const r = transition('rate_limited', 'user_retry') as DirectTransitionResult;
    expect(r.to).toBe('in_progress');
  });

  it('rate_limit_detected → rate_limited (idempotent)', () => {
    const r = transition('rate_limited', 'rate_limit_detected') as DirectTransitionResult;
    expect(r.to).toBe('rate_limited');
  });

  it('user_cancel → abandoned', () => {
    const r = transition('rate_limited', 'user_cancel') as DirectTransitionResult;
    expect(r.to).toBe('abandoned');
  });

  it('session_ok is NOT defined from rate_limited (no session to observe)', () => {
    expect(transition('rate_limited', 'session_ok')).toBeUndefined();
  });
});

describe('awaiting_user transitions', () => {
  it('user_retry → in_progress', () => {
    const r = transition('awaiting_user', 'user_retry') as DirectTransitionResult;
    expect(r.to).toBe('in_progress');
  });

  it('user_block → blocked', () => {
    const r = transition('awaiting_user', 'user_block') as DirectTransitionResult;
    expect(r.to).toBe('blocked');
  });

  it('user_cancel → abandoned', () => {
    const r = transition('awaiting_user', 'user_cancel') as DirectTransitionResult;
    expect(r.to).toBe('abandoned');
  });
});

describe('blocked transitions', () => {
  it('user_unblock_with_notes → in_progress', () => {
    const r = transition('blocked', 'user_unblock_with_notes') as DirectTransitionResult;
    expect(r.to).toBe('in_progress');
  });

  it('user_cancel → abandoned', () => {
    const r = transition('blocked', 'user_cancel') as DirectTransitionResult;
    expect(r.to).toBe('abandoned');
  });

  it('deps_satisfied → blocked (no-op: blocking is manual)', () => {
    const r = transition('blocked', 'deps_satisfied') as DirectTransitionResult;
    expect(r.to).toBe('blocked');
    expect(r.sideEffects).toHaveLength(0);
  });
});

describe('complete transitions', () => {
  it('deps_satisfied → complete (no-op)', () => {
    const r = transition('complete', 'deps_satisfied') as DirectTransitionResult;
    expect(r.to).toBe('complete');
    expect(r.sideEffects).toHaveLength(0);
  });

  it('all other events return undefined (complete is terminal)', () => {
    for (const e of ALL_EVENTS) {
      if (e === 'deps_satisfied') continue;
      expect(transition('complete', e), `complete + ${e}`).toBeUndefined();
    }
  });
});

describe('abandoned transitions', () => {
  it('every event returns a result with to=abandoned (no-op)', () => {
    for (const e of ALL_EVENTS) {
      const r = transition('abandoned', e);
      expect(r, `abandoned + ${e} should be defined`).toBeDefined();
      const targets = allTargets(r!);
      expect(targets.every(t => t === 'abandoned'), `abandoned + ${e} should target abandoned`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// user_cancel from all non-terminal states → abandoned
// ---------------------------------------------------------------------------

describe('user_cancel universally reachable', () => {
  it('user_cancel from every non-terminal state routes to abandoned', () => {
    for (const s of STATES_WITH_USER_CANCEL) {
      const r = transition(s, 'user_cancel');
      expect(r, `${s} + user_cancel should be defined`).toBeDefined();
      const targets = allTargets(r!);
      expect(
        targets.includes('abandoned'),
        `${s} + user_cancel should include abandoned, got ${targets}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// TRANSITIONS is const — verify it is not inadvertently mutable at runtime
// ---------------------------------------------------------------------------

describe('TRANSITIONS immutability', () => {
  it('TRANSITIONS object is frozen at the top level', () => {
    expect(Object.isFrozen(TRANSITIONS)).toBe(true);
  });

  it('each state row is frozen', () => {
    for (const s of ALL_STATES) {
      expect(Object.isFrozen(TRANSITIONS[s]), `TRANSITIONS.${s} should be frozen`).toBe(true);
    }
  });
});
