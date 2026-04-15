/**
 * Module-level render-model store.
 *
 * Wraps the pure (state, frame) => state reducer with a subscribe/dispatch API
 * so React components can connect via useSyncExternalStore without needing a
 * React context tree.
 *
 * Text delta batching:
 *   stream.text and stream.thinking frames are queued and flushed together
 *   in a single requestAnimationFrame callback (~16 ms intervals) to prevent
 *   per-character re-renders. All other frames dispatch immediately.
 *
 * Usage snapshot:
 *   A separate _usageSnapshot object is maintained that only changes its
 *   reference when token counts actually change. Components that only care
 *   about usage (e.g. UsageHUD) can subscribe with getUsageSnapshot as the
 *   selector so they do NOT re-render on non-usage frames (text deltas, tool
 *   calls, etc.).
 *
 * Reset semantics:
 *   Navigating away from a workflow calls reset(), which clears all session
 *   state and cancels any pending rAF flush.
 */

import {
  createInitialState,
  applyFrame,
  getTotalUsage,
  getSessionBlocks,
  getSessionUsage,
} from './reducer';
import type { RenderModelState, SessionUsage } from './types';
import type { ServerFrame } from '@/ws/types';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _state: RenderModelState = createInitialState();
const _listeners = new Set<() => void>();

// rAF text-delta queue
const _textQueue: ServerFrame[] = [];
let _rafHandle: number | null = null;

// Stable usage snapshot — reference only changes when totals change.
// useSyncExternalStore deduplicates via Object.is, so components that
// subscribe with getUsageSnapshot will NOT re-render on non-usage frames.
let _usageSnapshot: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _notify(): void {
  for (const l of _listeners) l();
}

/** Update _usageSnapshot only when totals have actually changed. */
function _updateUsageSnapshot(): void {
  const u = getTotalUsage(_state);
  if (
    u.inputTokens !== _usageSnapshot.inputTokens ||
    u.outputTokens !== _usageSnapshot.outputTokens ||
    u.cacheCreationInputTokens !== _usageSnapshot.cacheCreationInputTokens ||
    u.cacheReadInputTokens !== _usageSnapshot.cacheReadInputTokens
  ) {
    _usageSnapshot = u;
  }
}

function _flushTextQueue(): void {
  _rafHandle = null;
  if (_textQueue.length === 0) return;
  for (const f of _textQueue) {
    _state = applyFrame(_state, f);
  }
  _textQueue.length = 0;
  _updateUsageSnapshot();
  _notify();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Current snapshot — stable reference until next dispatch/reset. */
export function getSnapshot(): RenderModelState {
  return _state;
}

/**
 * Stable usage total snapshot.
 *
 * Returns the SAME object reference between frames unless token counts
 * change. Components that call useSyncExternalStore(subscribe, getUsageSnapshot)
 * will only re-render when usage actually changes — not on every text delta,
 * tool call, or other non-usage frame.
 */
export function getUsageSnapshot(): SessionUsage {
  return _usageSnapshot;
}

/**
 * Dispatch a non-text frame immediately.
 * Use this for session.started, session.ended, stream.tool_use, etc.
 */
export function dispatch(frame: ServerFrame): void {
  _state = applyFrame(_state, frame);
  _updateUsageSnapshot();
  _notify();
}

/**
 * Dispatch a stream.text or stream.thinking frame via rAF batching.
 * Multiple deltas arriving within one animation frame are flushed together.
 */
export function dispatchTextDelta(frame: ServerFrame): void {
  _textQueue.push(frame);
  if (_rafHandle === null) {
    _rafHandle = requestAnimationFrame(_flushTextQueue);
  }
}

/**
 * Clear all session state and cancel pending rAF.
 * Call when navigating away from a workflow.
 */
export function reset(): void {
  if (_rafHandle !== null) {
    cancelAnimationFrame(_rafHandle);
    _rafHandle = null;
  }
  _textQueue.length = 0;
  _state = createInitialState();
  _usageSnapshot = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  _notify();
}

/**
 * Subscribe to state changes. Returns an unsubscribe function.
 * Compatible with React.useSyncExternalStore.
 */
export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

// Re-export pure accessors so consumers don't need to import from reducer.
export { getTotalUsage, getSessionBlocks, getSessionUsage };
