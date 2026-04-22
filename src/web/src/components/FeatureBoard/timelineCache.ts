/**
 * Lazy per-item timeline cache.
 *
 * Mirrors the itemDataCache pattern in FeatureBoard.tsx: entries survive
 * across renders (module-level Map) so expanding the same item twice
 * within a session does not re-issue the network request, and a failed
 * fetch is cached as `null` so we do not loop on a 404.
 *
 * Phase 5 will invalidate specific entries from WS handlers; the
 * invalidation helper is exported now so the hook-up is a one-liner.
 */

import type { ItemTimelineRow, ItemTimelineResponse } from '@shared/types/timeline';

/** Cache key is `${workflowId}::${itemId}` — workflowId is included so
 *  navigating between workflows can't surface another workflow's data. */
function cacheKey(workflowId: string, itemId: string): string {
  return `${workflowId}::${itemId}`;
}

const timelineCache = new Map<string, ItemTimelineRow[] | null>();

/**
 * Fetch the timeline for (workflowId, itemId), caching the result.
 * Returns null on any non-ok response (or parse failure) so callers
 * can render a "No history yet" / error state without re-fetching.
 */
export async function fetchItemTimeline(
  workflowId: string,
  itemId: string,
): Promise<ItemTimelineRow[] | null> {
  const key = cacheKey(workflowId, itemId);
  if (timelineCache.has(key)) {
    return timelineCache.get(key) ?? null;
  }

  try {
    const res = await fetch(
      `/api/workflows/${encodeURIComponent(workflowId)}/items/${encodeURIComponent(itemId)}/timeline`,
    );
    if (!res.ok) {
      // Cache the miss so a 404 doesn't drive a refetch loop.
      timelineCache.set(key, null);
      return null;
    }
    const data = (await res.json()) as ItemTimelineResponse;
    const rows = data.rows ?? [];
    timelineCache.set(key, rows);
    return rows;
  } catch {
    timelineCache.set(key, null);
    return null;
  }
}

/**
 * Synchronous cache read.
 *
 * - `undefined` → never fetched
 * - `null`      → fetched and failed/missing (or empty-body)
 * - array       → loaded (possibly an empty array for items with no history)
 */
export function getCachedTimeline(
  workflowId: string,
  itemId: string,
): ItemTimelineRow[] | null | undefined {
  const key = cacheKey(workflowId, itemId);
  if (!timelineCache.has(key)) return undefined;
  return timelineCache.get(key) ?? null;
}

/**
 * Drop a single cached entry so the next expand re-fetches.
 * Phase 5 will call this from WS handlers (item.state, session.ended,
 * prepost.command.ended).
 */
export function invalidateItemTimeline(workflowId: string, itemId: string): void {
  timelineCache.delete(cacheKey(workflowId, itemId));
}

/** Clear the entire cache (on workflow unmount). */
export function clearItemTimelineCache(): void {
  timelineCache.clear();
}
