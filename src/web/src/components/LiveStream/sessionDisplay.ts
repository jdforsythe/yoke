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

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Coarse "Xs/Xm/Xh/Xd ago" timestamp for display. */
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Format a startedAt/endedAt span; "running" when not yet ended. */
export function duration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return 'running';
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Pill background/foreground classes keyed off session status. */
export function sessionStatusClass(status: string): string {
  switch (status) {
    case 'complete': return 'bg-green-500/20 text-green-300';
    case 'in_progress': return 'bg-blue-500/20 text-blue-300';
    case 'abandoned': return 'bg-gray-500/20 text-gray-400';
    default: return 'bg-red-500/20 text-red-300';
  }
}

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
