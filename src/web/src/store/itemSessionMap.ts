/**
 * Pure helper functions for maintaining a Map<itemId, ActiveSession>.
 *
 * The map is the client-side state for per-item active sessions:
 *   - Built from workflow.snapshot.activeSessions[] (which carry itemId)
 *   - Upserted on session.started frames (O(1) Map.set)
 *   - Entries removed on session.ended frames (O(n) scan once per ended session)
 *
 * All functions return new Maps to preserve immutability.
 */

import type { SessionProjection } from '../ws/types';

export interface ActiveSession {
  readonly sessionId: string;
  readonly phase: string;
  readonly startedAt: string;
}

/**
 * Build Map<itemId, ActiveSession> from workflow.snapshot.activeSessions[].
 * Entries where itemId is null are skipped (once-per-workflow sessions have
 * no item; they are not shown in the item-scoped stream pane).
 */
export function buildFromSnapshot(activeSessions: SessionProjection[]): Map<string, ActiveSession> {
  const map = new Map<string, ActiveSession>();
  for (const s of activeSessions) {
    if (s.itemId) {
      map.set(s.itemId, { sessionId: s.sessionId, phase: s.phase, startedAt: s.startedAt });
    }
  }
  return map;
}

/**
 * Upsert an entry for itemId on session.started. Returns a new Map.
 * If the same itemId starts a new session (e.g. retry), the old entry is
 * replaced so the pane switches to the latest session automatically.
 */
export function upsert(
  prev: Map<string, ActiveSession>,
  itemId: string,
  session: ActiveSession,
): Map<string, ActiveSession> {
  const next = new Map(prev);
  next.set(itemId, session);
  return next;
}

/**
 * Remove an entry by sessionId on session.ended. Returns the new map and the
 * cleared itemId (null if sessionId was not found in the map — no-op case).
 *
 * O(n) scan: called at most once per session.ended frame; the map is bounded
 * by the number of concurrent items (typically < 20) so this is acceptable.
 */
export function removeBySessionId(
  prev: Map<string, ActiveSession>,
  sessionId: string,
): { map: Map<string, ActiveSession>; clearedItemId: string | null } {
  let clearedItemId: string | null = null;
  for (const [itemId, s] of prev) {
    if (s.sessionId === sessionId) {
      clearedItemId = itemId;
      break;
    }
  }
  if (clearedItemId === null) return { map: prev, clearedItemId: null };
  const next = new Map(prev);
  next.delete(clearedItemId);
  return { map: next, clearedItemId };
}
