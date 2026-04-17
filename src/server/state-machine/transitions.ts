/**
 * State Machine — TRANSITIONS const and transition() pure lookup function.
 *
 * Source of truth: docs/design/state-machine-transitions.md
 *
 * Every (State, Event) pair listed in that document has a row here.
 * An unknown pair — one not listed in the document — returns `undefined`
 * from `transition()`; it never throws.
 *
 * The Pipeline Engine is the sole consumer of this table.  It:
 *   1. Evaluates guards (using live SQLite / runtime context).
 *   2. Commits the SQLite transition inside db.transaction().
 *   3. Executes the side effects indicated by `sideEffects`.
 *
 * This module has NO side effects of its own.  It performs no SQLite
 * writes, no signal sends, no timer creation.  `transition()` is a
 * pure function: same inputs always produce the same TransitionResult.
 */

import type { State, Event } from './states.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * A single guarded outcome in a conditional transition.
 * The Pipeline Engine picks the first outcome whose guard passes.
 */
export interface TransitionOutcome {
  /** Target state when this outcome is selected. */
  to: State;
  /**
   * Human-readable guard condition; enforcement is the Pipeline Engine's
   * responsibility.  The table documents it; the Engine enforces it.
   */
  guard: string;
  /**
   * Symbolic labels for side effects the Pipeline Engine executes after
   * committing the SQLite transition.  These are declarative labels, not
   * code — the Engine maps labels to concrete actions.
   */
  sideEffects: readonly string[];
}

/**
 * Unconditional (single-outcome) transition result.
 */
export interface DirectTransitionResult {
  kind: 'direct';
  /** Target state. */
  to: State;
  /**
   * Guard condition if any; absent or empty means unconditional.
   * The Engine checks this before committing.
   */
  guard?: string;
  /** Symbolic side-effect labels. */
  sideEffects: readonly string[];
}

/**
 * Conditional (multi-outcome) transition result.
 * The Pipeline Engine evaluates `outcomes` in order and applies the
 * first one whose guard passes.
 */
export interface ConditionalTransitionResult {
  kind: 'conditional';
  outcomes: readonly TransitionOutcome[];
}

export type TransitionResult = DirectTransitionResult | ConditionalTransitionResult;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function direct(
  to: State,
  sideEffects: readonly string[],
  guard?: string,
): DirectTransitionResult {
  return { kind: 'direct', to, sideEffects, ...(guard !== undefined ? { guard } : {}) };
}

function conditional(outcomes: readonly TransitionOutcome[]): ConditionalTransitionResult {
  return { kind: 'conditional', outcomes };
}

function outcome(
  to: State,
  guard: string,
  sideEffects: readonly string[] = [],
): TransitionOutcome {
  return { to, guard, sideEffects };
}

// ---------------------------------------------------------------------------
// Shared result constants (reused across multiple rows)
// ---------------------------------------------------------------------------

const ABANDONED_NOOP = direct('abandoned', []);

// ---------------------------------------------------------------------------
// TRANSITIONS — the closed (State × Event) → TransitionResult map.
//
// Type { [S in State]: Partial<Record<Event, TransitionResult>> } enforces
// that every State is a key.  Adding a new State to the union type without
// adding the corresponding entry here produces a TypeScript compile error.
//
// Events absent from a state's row return `undefined` from transition();
// that is the correct "unknown pair" behaviour.
// ---------------------------------------------------------------------------

export const TRANSITIONS: { [S in State]: Partial<Record<Event, TransitionResult>> } = {

  // -------------------------------------------------------------------------
  // pending
  // -------------------------------------------------------------------------
  pending: {
    deps_satisfied: conditional([
      outcome(
        'ready',
        'all depends_on items have status in {complete}',
        ['enqueue item for scheduling'],
      ),
    ]),
    user_cancel: direct('abandoned', ['cascade-cancel dependents']),
  },

  // -------------------------------------------------------------------------
  // ready
  // -------------------------------------------------------------------------
  ready: {
    phase_start: conditional([
      outcome(
        'bootstrapping',
        'worktree_path null or absent',
        ['invoke Worktree Manager.create'],
      ),
      outcome(
        'in_progress',
        'worktree already exists',
        ['skip bootstrap, spawn agent'],
      ),
    ]),
    user_cancel: direct('abandoned', []),
  },

  // -------------------------------------------------------------------------
  // bootstrapping
  // -------------------------------------------------------------------------
  bootstrapping: {
    bootstrap_ok: direct(
      'in_progress',
      ['write worktree_path', 'write branch_name', 'emit phase_start'],
    ),
    bootstrap_fail: direct(
      'bootstrap_failed',
      ['insert pending_attention{kind=bootstrap_failed}'],
    ),
    // Worktree may be partially created; teardown cleans up the partial state.
    user_cancel: direct('abandoned', ['run teardown', 'remove worktree']),
  },

  // -------------------------------------------------------------------------
  // bootstrap_failed
  // Terminal until user_retry or user_cancel.
  // -------------------------------------------------------------------------
  bootstrap_failed: {
    user_retry: direct(
      'bootstrapping',
      ['re-run bootstrap'],
      'user action recorded',
    ),
    user_cancel: direct('abandoned', ['run teardown', 'remove worktree']),
  },

  // -------------------------------------------------------------------------
  // in_progress
  // All phase types (implement, review, user-defined) share this state.
  // current_phase distinguishes which phase is active.
  // -------------------------------------------------------------------------
  in_progress: {
    pre_command_failed: conditional([
      outcome(
        'awaiting_retry',
        'action=fail AND retry budget > 0',
        ['log to events', 'log to prepost_runs'],
      ),
      outcome(
        'awaiting_user',
        'action=fail AND retry budget exhausted',
        ['log to events', 'log to prepost_runs'],
      ),
      outcome(
        'awaiting_user',
        'action=stop-and-ask',
        ['insert pending_attention'],
      ),
    ]),

    pre_commands_ok: direct('in_progress', ['spawn agent session']),

    session_spawned: direct('in_progress', ['attach stream-json parser']),

    rate_limit_detected: direct(
      'rate_limited',
      ['suppress heartbeat', 'schedule resume timer'],
    ),

    // session_ok is a composite trigger: the Pipeline Engine accumulates
    // session_ok + validators_ok + diff_check_ok + all post_command_ok
    // before performing this lookup.  Non-continue post actions fire
    // post_command_action events (handled below) before session_ok.
    session_ok: conditional([
      outcome(
        'in_progress',
        'validators_ok AND diff_check_ok AND all_post_commands_ok AND more phases in stage',
        ['advance current_phase', 'emit phase_advance'],
      ),
      outcome(
        'complete',
        'validators_ok AND diff_check_ok AND all_post_commands_ok AND last phase in stage',
        ['check stage completion', 'emit deps_satisfied cascade'],
      ),
    ]),

    // post_command_action dispatch (plan-draft3 §Phase Pre/Post Commands).
    post_command_action: conditional([
      outcome(
        'in_progress',
        'action=continue AND more phases in stage',
        ['advance current_phase via phase_advance'],
      ),
      outcome(
        'complete',
        'action=continue AND last phase in stage',
        ['stage completion', 'emit deps_satisfied cascade'],
      ),
      outcome(
        'in_progress',
        'action={goto:X} AND within max_revisits limit AND target phase in same stage',
        ['increment revisit counter', 'set current_phase', 'emit phase_start'],
      ),
      outcome(
        'awaiting_user',
        'action={goto:X} AND max_revisits limit exceeded',
        ['insert pending_attention{kind=revisit_limit}'],
      ),
      outcome(
        'awaiting_retry',
        'action={retry:...} AND retry_count < max',
        ['set next retry_mode'],
      ),
      outcome(
        'awaiting_user',
        'action=stop-and-ask',
        ['insert pending_attention'],
      ),
      outcome(
        'abandoned',
        'action=stop',
        ['cleanup worktree per config'],
      ),
      outcome(
        'awaiting_retry',
        'action={fail:...} AND retry budget > 0',
        ['record reason in events'],
      ),
      outcome(
        'awaiting_user',
        'action={fail:...} AND retry budget exhausted',
        ['record reason in events'],
      ),
    ]),

    validator_fail: conditional([
      outcome(
        'awaiting_retry',
        'retry budget > 0',
        ['increment retry_count'],
      ),
      outcome(
        'awaiting_user',
        'retry budget exhausted',
        ['insert pending_attention'],
      ),
    ]),

    diff_check_fail: conditional([
      outcome(
        'awaiting_retry',
        'retry budget > 0, classifier=policy',
        ['log forbidden diff'],
      ),
      outcome(
        'awaiting_user',
        'retry budget exhausted',
        ['insert pending_attention'],
      ),
    ]),

    // session_fail outcomes are resolved by the failure classifier.
    // The Pipeline Engine calls classify(stderr, parseState) first, then
    // selects the matching outcome.  unknown always routes to awaiting_user.
    session_fail: conditional([
      outcome(
        'awaiting_retry',
        'classifier=transient AND retry budget > 0',
        ['record retry_history'],
      ),
      outcome(
        'awaiting_user',
        'classifier=permanent',
        ['insert pending_attention'],
      ),
      outcome(
        'awaiting_user',
        'classifier=unknown',
        [],
      ),
    ]),

    retries_exhausted: direct('awaiting_user', []),

    user_cancel: direct('abandoned', ['SIGTERM process group']),
  },

  // -------------------------------------------------------------------------
  // awaiting_retry
  // -------------------------------------------------------------------------
  awaiting_retry: {
    backoff_elapsed: conditional([
      outcome(
        'in_progress',
        'retry budget remaining',
        ['compute next retry_mode from ladder', 'assemble prompt'],
      ),
      outcome(
        'awaiting_user',
        'retry ladder exhausted',
        ['insert pending_attention'],
      ),
    ]),
    retries_exhausted: direct('awaiting_user', ['insert pending_attention']),
    user_cancel: direct('abandoned', []),
  },

  // -------------------------------------------------------------------------
  // rate_limited  (D61)
  // -------------------------------------------------------------------------
  rate_limited: {
    rate_limit_window_elapsed: direct(
      'in_progress',
      ['fresh session', 'seed handoff.json with last attempt'],
      'window reset_at ≤ now',
    ),
    user_retry: direct(
      'in_progress',
      ['fresh session'],
      'user forced early resume',
    ),
    user_cancel: direct('abandoned', []),
    rate_limit_detected: direct(
      'rate_limited',
      ['extend timer', 'refresh reset_at'],
      'idempotent — refresh reset_at',
    ),
  },

  // -------------------------------------------------------------------------
  // awaiting_user
  // -------------------------------------------------------------------------
  awaiting_user: {
    user_retry: direct(
      'in_progress',
      ['consume user_injected_context from handoff.json'],
    ),
    user_block: direct('blocked', ['record blocked_reason']),
    user_cancel: direct('abandoned', []),
  },

  // -------------------------------------------------------------------------
  // blocked
  // -------------------------------------------------------------------------
  blocked: {
    user_unblock_with_notes: direct(
      'in_progress',
      ['append handoff entry seeded with notes'],
    ),
    user_cancel: direct('abandoned', []),
    // no-op: blocking is manual, not dep-driven
    deps_satisfied: direct('blocked', []),
  },

  // -------------------------------------------------------------------------
  // complete — terminal; only deps_satisfied is a no-op acknowledgement
  // -------------------------------------------------------------------------
  complete: {
    deps_satisfied: direct('complete', []),
  },

  // -------------------------------------------------------------------------
  // abandoned — terminal; every event is a no-op (table: "abandoned | any")
  //
  // `Record<Event, TransitionResult>` here forces a compile error when a
  // new Event is added to the union without updating this row.
  // -------------------------------------------------------------------------
  abandoned: {
    deps_satisfied: ABANDONED_NOOP,
    phase_start: ABANDONED_NOOP,
    phase_advance: ABANDONED_NOOP,
    stage_complete: ABANDONED_NOOP,
    stage_approval_granted: ABANDONED_NOOP,
    pre_commands_ok: ABANDONED_NOOP,
    pre_command_failed: ABANDONED_NOOP,
    session_spawned: ABANDONED_NOOP,
    session_ok: ABANDONED_NOOP,
    session_fail: ABANDONED_NOOP,
    rate_limit_detected: ABANDONED_NOOP,
    rate_limit_window_elapsed: ABANDONED_NOOP,
    post_command_ok: ABANDONED_NOOP,
    post_command_action: ABANDONED_NOOP,
    validators_ok: ABANDONED_NOOP,
    validator_fail: ABANDONED_NOOP,
    diff_check_ok: ABANDONED_NOOP,
    diff_check_fail: ABANDONED_NOOP,
    retry_budget_remaining: ABANDONED_NOOP,
    retries_exhausted: ABANDONED_NOOP,
    backoff_elapsed: ABANDONED_NOOP,
    user_retry: ABANDONED_NOOP,
    user_block: ABANDONED_NOOP,
    user_unblock_with_notes: ABANDONED_NOOP,
    user_cancel: ABANDONED_NOOP,
    bootstrap_ok: ABANDONED_NOOP,
    bootstrap_fail: ABANDONED_NOOP,
  } satisfies Record<Event, TransitionResult>,
} as const;

// Enforce RC-2: TRANSITIONS must not be mutated at runtime.
// Freeze each row, then the outer map.
for (const row of Object.values(TRANSITIONS)) {
  Object.freeze(row);
}
Object.freeze(TRANSITIONS);

// ---------------------------------------------------------------------------
// transition() — pure lookup function
// ---------------------------------------------------------------------------

/**
 * Look up the TransitionResult for a (state, event) pair.
 *
 * Returns `undefined` for any pair not listed in state-machine-transitions.md.
 * Never throws.
 *
 * Pure function: no I/O, no SQLite writes, no timer creation, no signals.
 * Identical inputs always return the identical TransitionResult reference.
 */
export function transition(state: State, event: Event): TransitionResult | undefined {
  return TRANSITIONS[state][event];
}
