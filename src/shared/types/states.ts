/** Lifecycle states an item can occupy within a pipeline stage. */
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
 * All State values as a runtime array.
 * Typed with `satisfies` so adding a new State member without updating this
 * array produces a compile-time error.
 */
export const STATE_VALUES = [
  'pending',
  'ready',
  'bootstrapping',
  'bootstrap_failed',
  'in_progress',
  'awaiting_retry',
  'rate_limited',
  'awaiting_user',
  'blocked',
  'complete',
  'abandoned',
] as const satisfies readonly State[];
