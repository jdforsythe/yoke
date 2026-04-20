/**
 * Exhaustiveness test — asserts every (State, Event) pair in the cartesian
 * product is either a defined transition in TRANSITIONS or listed in
 * IGNORED_PAIRS below.
 *
 * The test iterates STATE_VALUES × EVENT_VALUES, both of which are bound to
 * their respective union types via `satisfies`.  Adding a new State or Event
 * to the union without updating the runtime array produces a compile-time
 * error.  Once the array is updated, this test will fail for every new
 * (State, Event) pair until the developer either:
 *   (a) adds a TransitionResult in transitions.ts, or
 *   (b) adds the pair to IGNORED_PAIRS with a comment explaining why.
 *
 * No SQLite, no scheduler, no async.  Pure data-structure check.
 */

import { describe, it, expect } from 'vitest';
import { STATE_VALUES } from '../../src/shared/types/states.js';
import { EVENT_VALUES } from '../../src/server/state-machine/states.js';
import { transition } from '../../src/server/state-machine/transitions.js';

// ---------------------------------------------------------------------------
// IGNORED_PAIRS — explicit registry of (State, Event) pairs that are
// intentionally not handled by the state machine.
//
// When you add a new Event to the Event union:
//   1. Update EVENT_VALUES in src/server/state-machine/states.ts (satisfies catches it).
//   2. Run this test — it will fail for every (state, newEvent) not covered.
//   3. For each failing pair: add a TransitionResult in transitions.ts, or
//      add the pair here with a comment.
//
// Pairs are grouped by state for readability.
// ---------------------------------------------------------------------------

const IGNORED_PAIRS = new Set<string>([
  // pending: only deps_satisfied and user_cancel are meaningful
  'pending:phase_start',
  'pending:phase_advance',
  'pending:stage_complete',
  'pending:stage_approval_granted',
  'pending:pre_commands_ok',
  'pending:pre_command_failed',
  'pending:session_spawned',
  'pending:session_ok',
  'pending:session_fail',
  'pending:rate_limit_detected',
  'pending:rate_limit_window_elapsed',
  'pending:post_command_ok',
  'pending:post_command_action',
  'pending:validators_ok',
  'pending:validator_fail',
  'pending:diff_check_ok',
  'pending:diff_check_fail',
  'pending:retry_budget_remaining',
  'pending:retries_exhausted',
  'pending:backoff_elapsed',
  'pending:user_retry',
  'pending:user_block',
  'pending:user_unblock_with_notes',
  'pending:bootstrap_ok',
  'pending:bootstrap_fail',

  // ready: waiting for phase_start; no session or retry events apply
  'ready:deps_satisfied',
  'ready:phase_advance',
  'ready:stage_complete',
  'ready:stage_approval_granted',
  'ready:pre_commands_ok',
  'ready:pre_command_failed',
  'ready:session_spawned',
  'ready:session_ok',
  'ready:session_fail',
  'ready:rate_limit_detected',
  'ready:rate_limit_window_elapsed',
  'ready:post_command_ok',
  'ready:post_command_action',
  'ready:validators_ok',
  'ready:validator_fail',
  'ready:diff_check_ok',
  'ready:diff_check_fail',
  'ready:retry_budget_remaining',
  'ready:retries_exhausted',
  'ready:backoff_elapsed',
  'ready:user_retry',
  'ready:user_block',
  'ready:user_unblock_with_notes',
  'ready:bootstrap_ok',
  'ready:bootstrap_fail',

  // bootstrapping: only bootstrap_ok, bootstrap_fail, and user_cancel apply
  'bootstrapping:deps_satisfied',
  'bootstrapping:phase_start',
  'bootstrapping:phase_advance',
  'bootstrapping:stage_complete',
  'bootstrapping:stage_approval_granted',
  'bootstrapping:pre_commands_ok',
  'bootstrapping:pre_command_failed',
  'bootstrapping:session_spawned',
  'bootstrapping:session_ok',
  'bootstrapping:session_fail',
  'bootstrapping:rate_limit_detected',
  'bootstrapping:rate_limit_window_elapsed',
  'bootstrapping:post_command_ok',
  'bootstrapping:post_command_action',
  'bootstrapping:validators_ok',
  'bootstrapping:validator_fail',
  'bootstrapping:diff_check_ok',
  'bootstrapping:diff_check_fail',
  'bootstrapping:retry_budget_remaining',
  'bootstrapping:retries_exhausted',
  'bootstrapping:backoff_elapsed',
  'bootstrapping:user_retry',
  'bootstrapping:user_block',
  'bootstrapping:user_unblock_with_notes',

  // bootstrap_failed: stuck until user acts; only user_retry and user_cancel apply
  'bootstrap_failed:deps_satisfied',
  'bootstrap_failed:phase_start',
  'bootstrap_failed:phase_advance',
  'bootstrap_failed:stage_complete',
  'bootstrap_failed:stage_approval_granted',
  'bootstrap_failed:pre_commands_ok',
  'bootstrap_failed:pre_command_failed',
  'bootstrap_failed:session_spawned',
  'bootstrap_failed:session_ok',
  'bootstrap_failed:session_fail',
  'bootstrap_failed:rate_limit_detected',
  'bootstrap_failed:rate_limit_window_elapsed',
  'bootstrap_failed:post_command_ok',
  'bootstrap_failed:post_command_action',
  'bootstrap_failed:validators_ok',
  'bootstrap_failed:validator_fail',
  'bootstrap_failed:diff_check_ok',
  'bootstrap_failed:diff_check_fail',
  'bootstrap_failed:retry_budget_remaining',
  'bootstrap_failed:retries_exhausted',
  'bootstrap_failed:backoff_elapsed',
  'bootstrap_failed:user_block',
  'bootstrap_failed:user_unblock_with_notes',
  'bootstrap_failed:bootstrap_ok',
  'bootstrap_failed:bootstrap_fail',

  // in_progress: events fired before/during/after the session are handled;
  // dependency, approval, and bootstrap events are not applicable mid-session
  'in_progress:deps_satisfied',
  'in_progress:phase_start',
  'in_progress:phase_advance',
  'in_progress:stage_complete',
  'in_progress:stage_approval_granted',
  'in_progress:rate_limit_window_elapsed',
  'in_progress:post_command_ok',
  'in_progress:validators_ok',
  'in_progress:diff_check_ok',
  'in_progress:retry_budget_remaining',
  'in_progress:backoff_elapsed',
  'in_progress:user_retry',
  'in_progress:user_block',
  'in_progress:user_unblock_with_notes',
  'in_progress:bootstrap_ok',
  'in_progress:bootstrap_fail',

  // awaiting_retry: waiting for backoff timer; only backoff, exhaustion, and cancel apply
  'awaiting_retry:deps_satisfied',
  'awaiting_retry:phase_start',
  'awaiting_retry:phase_advance',
  'awaiting_retry:stage_complete',
  'awaiting_retry:stage_approval_granted',
  'awaiting_retry:pre_commands_ok',
  'awaiting_retry:pre_command_failed',
  'awaiting_retry:session_spawned',
  'awaiting_retry:session_ok',
  'awaiting_retry:session_fail',
  'awaiting_retry:rate_limit_detected',
  'awaiting_retry:rate_limit_window_elapsed',
  'awaiting_retry:post_command_ok',
  'awaiting_retry:post_command_action',
  'awaiting_retry:validators_ok',
  'awaiting_retry:validator_fail',
  'awaiting_retry:diff_check_ok',
  'awaiting_retry:diff_check_fail',
  'awaiting_retry:retry_budget_remaining',
  'awaiting_retry:user_retry',
  'awaiting_retry:user_block',
  'awaiting_retry:user_unblock_with_notes',
  'awaiting_retry:bootstrap_ok',
  'awaiting_retry:bootstrap_fail',

  // rate_limited: paused for rate-limit window; only window-elapsed, forced retry,
  // idempotent re-entry, and cancel apply
  'rate_limited:deps_satisfied',
  'rate_limited:phase_start',
  'rate_limited:phase_advance',
  'rate_limited:stage_complete',
  'rate_limited:stage_approval_granted',
  'rate_limited:pre_commands_ok',
  'rate_limited:pre_command_failed',
  'rate_limited:session_spawned',
  'rate_limited:session_ok',
  'rate_limited:session_fail',
  'rate_limited:post_command_ok',
  'rate_limited:post_command_action',
  'rate_limited:validators_ok',
  'rate_limited:validator_fail',
  'rate_limited:diff_check_ok',
  'rate_limited:diff_check_fail',
  'rate_limited:retry_budget_remaining',
  'rate_limited:retries_exhausted',
  'rate_limited:backoff_elapsed',
  'rate_limited:user_block',
  'rate_limited:user_unblock_with_notes',
  'rate_limited:bootstrap_ok',
  'rate_limited:bootstrap_fail',

  // awaiting_user: blocked on human action; only retry, block, and cancel apply
  'awaiting_user:deps_satisfied',
  'awaiting_user:phase_start',
  'awaiting_user:phase_advance',
  'awaiting_user:stage_complete',
  'awaiting_user:stage_approval_granted',
  'awaiting_user:pre_commands_ok',
  'awaiting_user:pre_command_failed',
  'awaiting_user:session_spawned',
  'awaiting_user:session_ok',
  'awaiting_user:session_fail',
  'awaiting_user:rate_limit_detected',
  'awaiting_user:rate_limit_window_elapsed',
  'awaiting_user:post_command_ok',
  'awaiting_user:post_command_action',
  'awaiting_user:validators_ok',
  'awaiting_user:validator_fail',
  'awaiting_user:diff_check_ok',
  'awaiting_user:diff_check_fail',
  'awaiting_user:retry_budget_remaining',
  'awaiting_user:retries_exhausted',
  'awaiting_user:backoff_elapsed',
  'awaiting_user:user_unblock_with_notes',
  'awaiting_user:bootstrap_ok',
  'awaiting_user:bootstrap_fail',

  // blocked: manually blocked; only unblock, cancel, and deps_satisfied (no-op) apply
  'blocked:phase_start',
  'blocked:phase_advance',
  'blocked:stage_complete',
  'blocked:stage_approval_granted',
  'blocked:pre_commands_ok',
  'blocked:pre_command_failed',
  'blocked:session_spawned',
  'blocked:session_ok',
  'blocked:session_fail',
  'blocked:rate_limit_detected',
  'blocked:rate_limit_window_elapsed',
  'blocked:post_command_ok',
  'blocked:post_command_action',
  'blocked:validators_ok',
  'blocked:validator_fail',
  'blocked:diff_check_ok',
  'blocked:diff_check_fail',
  'blocked:retry_budget_remaining',
  'blocked:retries_exhausted',
  'blocked:backoff_elapsed',
  'blocked:user_retry',
  'blocked:user_block',
  'blocked:bootstrap_ok',
  'blocked:bootstrap_fail',

  // complete: terminal; only deps_satisfied (no-op cascade acknowledgement) applies
  'complete:phase_start',
  'complete:phase_advance',
  'complete:stage_complete',
  'complete:stage_approval_granted',
  'complete:pre_commands_ok',
  'complete:pre_command_failed',
  'complete:session_spawned',
  'complete:session_ok',
  'complete:session_fail',
  'complete:rate_limit_detected',
  'complete:rate_limit_window_elapsed',
  'complete:post_command_ok',
  'complete:post_command_action',
  'complete:validators_ok',
  'complete:validator_fail',
  'complete:diff_check_ok',
  'complete:diff_check_fail',
  'complete:retry_budget_remaining',
  'complete:retries_exhausted',
  'complete:backoff_elapsed',
  'complete:user_retry',
  'complete:user_block',
  'complete:user_unblock_with_notes',
  'complete:user_cancel',
  'complete:bootstrap_ok',
  'complete:bootstrap_fail',

  // abandoned: fully terminal; all events absorbed as no-ops (handled by TRANSITIONS)
  // — no entries needed here; abandoned's row covers every event
]);

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('state-machine exhaustiveness', () => {
  it('every (State, Event) pair is either a defined transition or listed in IGNORED_PAIRS', () => {
    const uncovered: string[] = [];

    for (const state of STATE_VALUES) {
      for (const event of EVENT_VALUES) {
        const key = `${state}:${event}`;
        const isDefined = transition(state, event) !== undefined;
        const isIgnored = IGNORED_PAIRS.has(key);

        if (!isDefined && !isIgnored) {
          uncovered.push(key);
        }
      }
    }

    expect(
      uncovered,
      `The following (State, Event) pairs are neither defined in TRANSITIONS nor listed in IGNORED_PAIRS:\n` +
        uncovered.map(p => `  ${p}`).join('\n') +
        `\n\nFor each pair: add a TransitionResult in transitions.ts, or add it to IGNORED_PAIRS in this test file.`,
    ).toHaveLength(0);
  });

  it('IGNORED_PAIRS contains no pair that is actually defined in TRANSITIONS (no stale entries)', () => {
    const stale: string[] = [];

    for (const entry of IGNORED_PAIRS) {
      const [state, event] = entry.split(':') as [string, string];
      if (transition(state as never, event as never) !== undefined) {
        stale.push(entry);
      }
    }

    expect(
      stale,
      `The following IGNORED_PAIRS entries are now defined in TRANSITIONS and should be removed:\n` +
        stale.map(p => `  ${p}`).join('\n'),
    ).toHaveLength(0);
  });

  it('abandoned absorbs every event (complete cartesian coverage, zero IGNORED needed)', () => {
    for (const event of EVENT_VALUES) {
      expect(
        transition('abandoned', event),
        `(abandoned, ${event}) must be defined — abandoned is the absorbing terminal state`,
      ).toBeDefined();
    }
  });
});
