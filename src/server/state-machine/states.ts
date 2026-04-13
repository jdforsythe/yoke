/**
 * State Machine — State and Event union types.
 *
 * Source of truth: docs/design/state-machine-transitions.md
 *
 * State: lifecycle position of an item within a pipeline stage.
 * Event: named trigger raised by Process Manager, Pre/Post Runner,
 *        Worktree Manager, retry ladder, or HTTP control.
 *
 * Compile-time exhaustiveness: TRANSITIONS in transitions.ts is typed as
 * `{ [S in State]: ... }`, so adding a new State without updating that
 * record produces a TypeScript error.
 */

/** Lifecycle states an item can occupy within a stage. */
export type State =
  | 'pending'
  | 'ready'
  | 'bootstrapping'
  | 'bootstrap_failed'
  | 'in_progress'
  | 'awaiting_retry'
  | 'rate_limited'
  | 'awaiting_user'
  | 'blocked'
  | 'complete'
  | 'abandoned';

/**
 * Events the Pipeline Engine recognises. Raised by concrete modules;
 * this is the closed set — the Engine ignores anything not listed here.
 */
export type Event =
  | 'deps_satisfied'
  | 'phase_start'
  | 'phase_advance'
  | 'stage_complete'
  | 'stage_approval_granted'
  | 'pre_commands_ok'
  | 'pre_command_failed'
  | 'session_spawned'
  | 'session_ok'
  | 'session_fail'
  | 'rate_limit_detected'
  | 'rate_limit_window_elapsed'
  | 'post_command_ok'
  | 'post_command_action'
  | 'validators_ok'
  | 'validator_fail'
  | 'diff_check_ok'
  | 'diff_check_fail'
  | 'retry_budget_remaining'
  | 'retries_exhausted'
  | 'backoff_elapsed'
  | 'user_retry'
  | 'user_block'
  | 'user_unblock_with_notes'
  | 'user_cancel'
  | 'bootstrap_ok'
  | 'bootstrap_fail';
