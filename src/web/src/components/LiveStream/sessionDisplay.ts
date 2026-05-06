/**
 * Shared display helpers for rendering session rows — used by both
 * HistoryPane (the right-pane list) and FeatureBoard's inline timeline
 * rows so the two surfaces format sessions identically.
 *
 * Also owns the fetch-and-load flow that pulls every page of a session
 * log and commits the parsed frames to the render store in a single
 * atomic dispatch. HistoryPane and FeatureBoard both import
 * `loadSessionIntoStore` so clicking a session row in either surface
 * drives the same render-store state.
 */

import { loadHistoricalSession } from '@/store/renderStore';
import type { ServerFrame } from '@/ws/types';

// Pure formatters live in formatters.ts so tests can import them without
// pulling in the render store (which depends on browser globals).
export { relativeTime, duration, sessionStatusClass } from './formatters';

// ---------------------------------------------------------------------------
// Fetch + load
// ---------------------------------------------------------------------------

/**
 * Fetch every page of /api/sessions/:id/log and collect the parsed
 * ServerFrames. Caps at 20 pages × 100 frames = 2000 frames per session
 * to bound memory on pathological logs.
 */
export async function fetchAllLogFrames(sessionId: string): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  let sinceSeq = 0;
  let hasMore = true;
  const limit = 100;
  let pageCount = 0;
  const maxPages = 20;

  while (hasMore && pageCount < maxPages) {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/log?sinceSeq=${sinceSeq}&limit=${limit}`,
    );
    if (!res.ok) break;
    const data = (await res.json()) as { entries?: string[]; nextSeq?: number; hasMore?: boolean };
    for (const raw of data.entries ?? []) {
      try {
        frames.push(JSON.parse(raw) as ServerFrame);
      } catch {
        // skip malformed entry
      }
    }
    hasMore = data.hasMore ?? false;
    sinceSeq = data.nextSeq ?? sinceSeq + limit;
    pageCount++;
  }

  return frames;
}

/**
 * Fetch the log for `sessionId` and commit it to the render store via
 * loadHistoricalSession. A tiny in-memory `loaded` set (owned by the
 * caller) prevents refetching when a session is re-selected within the
 * same mount.
 */
export async function loadSessionIntoStore(
  sessionId: string,
  loaded: Set<string>,
): Promise<void> {
  if (loaded.has(sessionId)) return;
  const frames = await fetchAllLogFrames(sessionId);
  loadHistoricalSession(sessionId, frames);
  loaded.add(sessionId);
}
