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
import type { SessionRenderState } from './types';
import type { RenderModelState, SessionUsage, RenderBlock } from './types';
import type { ServerFrame } from '@/ws/types';
import type { BlockRing } from './blockRing';

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

// Stable empty array returned when a session has no blocks.
const EMPTY_BLOCKS: readonly RenderBlock[] = Object.freeze([]);

// Per-session blocks cache: keyed by sessionId, stores the last ring reference
// AND prependedBlocks reference. When BOTH are unchanged (no push/update
// since last call), the SAME blocks array reference is returned so
// useSyncExternalStore skips re-renders for that session.
interface SessionBlocksEntry {
  ring: BlockRing;
  prependedBlocks: readonly RenderBlock[];
  blocks: readonly RenderBlock[];
}
const _sessionBlocksCache = new Map<string, SessionBlocksEntry>();

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
  _sessionBlocksCache.clear();
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

/**
 * Stable blocks snapshot for a specific session.
 *
 * Returns the SAME array reference when the session's ring hasn't changed
 * since the last call (ring identity check — every push/update creates a new
 * ring via clone()), so useSyncExternalStore will NOT re-render components
 * that subscribe with this as their getSnapshot when unrelated sessions change.
 *
 * Usage:
 *   const blocks = useSyncExternalStore(subscribe, () => getSessionBlocksSnapshot(sessionId));
 */
export function getSessionBlocksSnapshot(sessionId: string): readonly RenderBlock[] {
  const session = _state.sessions.get(sessionId);
  if (!session) return EMPTY_BLOCKS;

  const cached = _sessionBlocksCache.get(sessionId);
  // Both the ring AND prependedBlocks must be unchanged for the cached array
  // to be valid.  prependedBlocks changes when loadEarlierFrames is called.
  if (
    cached &&
    cached.ring === session._ring &&
    cached.prependedBlocks === session._prependedBlocks
  ) {
    return cached.blocks;
  }

  const blocks = getSessionBlocks(_state, sessionId);
  _sessionBlocksCache.set(sessionId, {
    ring: session._ring,
    prependedBlocks: session._prependedBlocks,
    blocks,
  });
  return blocks;
}

/**
 * Prepend a list of already-materialised blocks before the ring content for
 * the given session.  Used by LiveStreamPane.loadEarlierFrames so that
 * HTTP-fetched older blocks appear above current content (sentinel → prepended
 * → ring) without moving the user's scroll position.
 */
export function prependSessionBlocks(sessionId: string, blocks: readonly RenderBlock[]): void {
  const session = _state.sessions.get(sessionId);
  if (!session || blocks.length === 0) return;
  const updated: SessionRenderState = {
    ...session,
    _prependedBlocks: [...blocks, ...session._prependedBlocks],
  };
  const sessions = new Map(_state.sessions);
  sessions.set(sessionId, updated);
  _state = { sessions };
  _updateUsageSnapshot();
  _notify();
}

/**
 * Process a list of raw ServerFrames fetched from the HTTP log endpoint,
 * convert them to RenderBlocks via applyFrame, and prepend the resulting
 * blocks to the session's _prependedBlocks list.
 *
 * Uses a temporary state so the frames don't mutate the live ring or
 * trigger delta-accumulation side effects in the real session.
 */
export function loadEarlierFrames(sessionId: string, frames: ServerFrame[]): void {
  if (frames.length === 0) return;
  let tempState = createInitialState();
  for (const frame of frames) {
    tempState = applyFrame(tempState, frame);
  }
  const newBlocks = getSessionBlocks(tempState, sessionId).filter(
    (b) => b.type !== 'truncated_sentinel',
  );
  prependSessionBlocks(sessionId, newBlocks);
}

/**
 * Load all frames for a historical (completed) session into the store in one
 * atomic operation.  Uses a temporary state to avoid mutating live sessions,
 * then copies just the target session into the live store and notifies once.
 *
 * Safe to call multiple times for the same sessionId: subsequent calls
 * replace the earlier snapshot (the frames are deterministic).
 */
export function loadHistoricalSession(sessionId: string, frames: ServerFrame[]): void {
  if (frames.length === 0) return;
  let tempState = createInitialState();
  for (const frame of frames) {
    tempState = applyFrame(tempState, frame);
  }
  const session = tempState.sessions.get(sessionId);
  if (!session) return;
  const sessions = new Map(_state.sessions);
  sessions.set(sessionId, session);
  _state = { sessions };
  _updateUsageSnapshot();
  _sessionBlocksCache.delete(sessionId);
  _notify();
}

// Re-export pure accessors so consumers don't need to import from reducer.
export { getTotalUsage, getSessionBlocks, getSessionUsage };
