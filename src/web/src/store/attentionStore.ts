/**
 * Module-level store for the pending-attention count.
 *
 * Updated by WorkflowDetailRoute when it receives workflow.snapshot or
 * workflow.update frames that contain a pendingAttention array.
 * Read by AppShell to derive the bell badge count.
 *
 * This ensures the badge count is ALWAYS derived from the server-side
 * pendingAttention array length — satisfying feat-attention-banner RC2:
 * "The bell badge count is derived from the attention items array length,
 * not a separate counter."
 *
 * Reset to 0 when WorkflowDetailRoute unmounts (workflow navigation), so the
 * badge accurately reflects the active workflow's attention count at all times.
 */

let _count = 0;
const _listeners = new Set<() => void>();

function _notify(): void {
  for (const l of _listeners) l();
}

/** Set the current pending-attention count. No-op if unchanged. */
export function setAttentionCount(n: number): void {
  if (_count === n) return;
  _count = n;
  _notify();
}

/** Stable snapshot for useSyncExternalStore. */
export function getAttentionCount(): number {
  return _count;
}

/** Subscribe for useSyncExternalStore compatibility. Returns unsubscribe fn. */
export function subscribeAttention(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}
