/**
 * Item search predicate for the FeatureBoard search box.
 *
 * Matches an ItemProjection against a user query by case-insensitive
 * substring over:
 *
 *   - displayTitle
 *   - displaySubtitle
 *   - displayDescription
 *   - stableId
 *   - the owning stage id
 *   - phase names and ids in the item's timeline rows
 *   - prepost commandName for prepost rows
 *
 * "cached-only" trade-off: timeline-row matches only succeed for items
 * whose timeline has already been fetched into the module-level
 * timelineCache (i.e. the user expanded the row at some point in this
 * session, or a prior lookup primed it). Typing in the search box does
 * NOT trigger new network fetches for collapsed items — matches against
 * phase / session id / command name are only effective for cached
 * timelines. This keeps the search box purely client-side and avoids a
 * keystroke-fan-out of N fetches across every visible item. Log content
 * is deliberately NOT searched.
 *
 * Callers are expected to resolve stageId and cached rows up front
 * (typically inside a useMemo that also computes flatFiltered) rather
 * than re-deriving them here, so the filter stays O(items) per keystroke
 * rather than doing per-item Map lookups during the filter pass.
 */

import type { ItemProjection } from '../../ws/types';
import type { ItemTimelineRow } from '@shared/types/timeline';

/**
 * Returns true iff `query` is a case-insensitive substring of any of the
 * searchable fields for `item`. Empty/whitespace-only queries match
 * everything (no-op filter).
 *
 * @param item        The item being tested.
 * @param query       The (already-debounced) user query string.
 * @param stageId     The owning stage id, resolved by the caller.
 * @param cachedRows  Cached timeline rows for this item, or null/undefined
 *                    if the timeline has never been fetched / was fetched
 *                    but failed. Only arrays contribute matches.
 */
export function fuzzyMatch(
  item: ItemProjection,
  query: string,
  stageId: string,
  cachedRows: ItemTimelineRow[] | null | undefined,
): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if ((item.displayTitle ?? '').toLowerCase().includes(q)) return true;
  if ((item.displaySubtitle ?? '').toLowerCase().includes(q)) return true;
  if ((item.displayDescription ?? '').toLowerCase().includes(q)) return true;
  if ((item.stableId ?? '').toLowerCase().includes(q)) return true;
  if (stageId.toLowerCase().includes(q)) return true;
  if (cachedRows) {
    for (const row of cachedRows) {
      if (row.phase.toLowerCase().includes(q)) return true;
      if (row.id.toLowerCase().includes(q)) return true;
      if (row.kind === 'prepost' && row.commandName.toLowerCase().includes(q)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns true iff `query` matches ONLY via a cached timeline row — i.e.
 * none of the card-visible fields (title / subtitle / description /
 * stableId / stage id) contain the query but at least one cached row
 * does. Used by FeatureBoard to auto-expand items whose match is
 * otherwise hidden under a collapsed caret.
 *
 * Returns false if `fuzzyMatch` would also have returned false (no match
 * at all) or if the match was via a card-visible field (the hit is
 * already visible on the collapsed card).
 */
export function matchesOnlyViaTimeline(
  item: ItemProjection,
  query: string,
  stageId: string,
  cachedRows: ItemTimelineRow[] | null | undefined,
): boolean {
  if (!query) return false;
  const q = query.toLowerCase();
  if ((item.displayTitle ?? '').toLowerCase().includes(q)) return false;
  if ((item.displaySubtitle ?? '').toLowerCase().includes(q)) return false;
  if ((item.displayDescription ?? '').toLowerCase().includes(q)) return false;
  if ((item.stableId ?? '').toLowerCase().includes(q)) return false;
  if (stageId.toLowerCase().includes(q)) return false;
  if (!cachedRows) return false;
  for (const row of cachedRows) {
    if (row.phase.toLowerCase().includes(q)) return true;
    if (row.id.toLowerCase().includes(q)) return true;
    if (row.kind === 'prepost' && row.commandName.toLowerCase().includes(q)) {
      return true;
    }
  }
  return false;
}
