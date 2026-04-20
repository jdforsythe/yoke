/**
 * State Machine — State and Event union types.
 *
 * Source of truth: docs/design/state-machine-transitions.md
 *
 * State: lifecycle position of an item within a pipeline stage.
 *   Canonical definition lives in src/shared/types/states.ts so the UI can
 *   import it without crossing the server boundary.
 * Event: named trigger raised by Process Manager, Pre/Post Runner,
 *        Worktree Manager, retry ladder, or HTTP control.
 *
 * Compile-time exhaustiveness: TRANSITIONS in transitions.ts is typed as
 * `{ [S in State]: ... }`, so adding a new State without updating that
 * record produces a TypeScript error.
 */

export type { State } from '../../shared/types/states.js';

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

/**
 * All Event values as a runtime array.
 * Typed with `satisfies` so adding a new Event member without updating this
 * array produces a compile-time error, which causes the exhaustiveness test
 * to iterate the new event and fail until TRANSITIONS or IGNORED_PAIRS covers it.
 */
export const EVENT_VALUES = [
  'deps_satisfied',
  'phase_start',
  'phase_advance',
  'stage_complete',
  'stage_approval_granted',
  'pre_commands_ok',
  'pre_command_failed',
  'session_spawned',
  'session_ok',
  'session_fail',
  'rate_limit_detected',
  'rate_limit_window_elapsed',
  'post_command_ok',
  'post_command_action',
  'validators_ok',
  'validator_fail',
  'diff_check_ok',
  'diff_check_fail',
  'retry_budget_remaining',
  'retries_exhausted',
  'backoff_elapsed',
  'user_retry',
  'user_block',
  'user_unblock_with_notes',
  'user_cancel',
  'bootstrap_ok',
  'bootstrap_fail',
] as const satisfies readonly Event[];
