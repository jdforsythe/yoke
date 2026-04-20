import type { State } from '../../../../shared/types/states';

/**
 * Tailwind chip classes keyed on every State value.
 * Record<State, string> ensures a compile-time error when a new State is added
 * without updating this map.
 */
const STATUS_CLASSES: Record<State, string> = {
  pending: 'bg-gray-500/20 text-gray-400',
  ready: 'bg-sky-500/20 text-sky-300',
  bootstrapping: 'bg-blue-500/20 text-blue-300',
  bootstrap_failed: 'bg-red-500/20 text-red-300',
  in_progress: 'bg-blue-500/20 text-blue-300',
  awaiting_retry: 'bg-amber-500/20 text-amber-300',
  rate_limited: 'bg-amber-500/20 text-amber-300',
  awaiting_user: 'bg-yellow-500/20 text-yellow-300',
  blocked: 'bg-orange-500/20 text-orange-300',
  complete: 'bg-green-500/20 text-green-300',
  abandoned: 'bg-red-900/30 text-red-400',
};

/** Human-readable labels keyed on every State value. */
const STATUS_LABELS: Record<State, string> = {
  pending: 'Pending',
  ready: 'Ready',
  bootstrapping: 'Bootstrapping',
  bootstrap_failed: 'Bootstrap failed',
  in_progress: 'In progress',
  awaiting_retry: 'Awaiting retry',
  rate_limited: 'Rate limited',
  awaiting_user: 'Awaiting user',
  blocked: 'Blocked',
  complete: 'Complete',
  abandoned: 'Abandoned',
};

export interface StatusOption {
  value: State | 'all';
  label: string;
}

/** Dropdown options for the FeatureBoard status filter, covering every State. */
export const ITEM_STATUS_OPTIONS: StatusOption[] = [
  { value: 'all', label: 'All statuses' },
  ...(Object.entries(STATUS_LABELS) as Array<[State, string]>).map(([value, label]) => ({
    value,
    label,
  })),
];

/**
 * Returns the Tailwind chip class string for a given item status.
 * Falls back to the pending palette for unknown values (future-proof against
 * protocol additions not yet reflected in STATUS_CLASSES).
 */
export function itemStatusClass(status: string): string {
  return STATUS_CLASSES[status as State] ?? 'bg-gray-500/20 text-gray-400';
}

/** Export for tests so the union can be walked at runtime. */
export { STATUS_CLASSES, STATUS_LABELS };
