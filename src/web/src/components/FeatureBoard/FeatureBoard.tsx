/**
 * FeatureBoard — grouped item cards with keyboard navigation and deep-link support.
 *
 * Groups items by stageId using a Map<string, ItemProjection[]> derived from
 * snapshot (rebuilt on items change, not on each render). item.state WS frames
 * are applied via the `items` prop (managed in WorkflowDetailRoute).
 *
 * Fuzzy search: client-side filter over displayTitle, displaySubtitle,
 * the owning stage id, and any already-cached timeline rows (phase,
 * session id, prepost commandName). Debounced 200 ms. Typing does NOT
 * fetch timelines — phase/id/command matches only land for items whose
 * timeline is already in the module-level cache. Items whose only match
 * is via a cached row are auto-expanded so the hit is visible. Status
 * and stage filters are also client-side.
 *
 * Keyboard navigation: j/k move a visible focus ring between items using
 * aria-activedescendant pattern. Enter opens the stream pane for the focused
 * item (calls onSelectItem). Escape clears selection. j/k stay at the item
 * level and do NOT descend into inline timeline rows under an expanded card.
 * Space on the focused item toggles its inline timeline (expand/collapse).
 *
 * Deep-link: /workflow/:id/item/:itemId scrolls to and highlights the target
 * card on mount (reads :itemId from URL via useParams). Highlight is managed
 * via React state (Set<string>) so re-renders triggered by WS frames do not
 * clobber the attribute before the 2 s pulse expires.
 *
 * Streaming item: the item whose session is active is pinned to the top of
 * its stage group with a pulsing indicator.
 *
 * item.data: fetched once per selection via GET /api/workflows/:id/items/:itemId/data
 * and cached client-side. Cache is invalidated on new item.state frames.
 *
 * Inline timeline (Phase 4): each card carries a disclosure caret. Expanding
 * lazily fetches GET /api/workflows/:id/items/:itemId/timeline (cached via
 * timelineCache.ts) and renders the merged session + prepost-command history
 * inline via <TimelineList>. Clicking a session row loads the log into the
 * render store (loadSessionIntoStore) and asks the parent to switch to the
 * History tab preselected to that session.
 */

import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  useId,
} from 'react';
import { useParams } from 'react-router-dom';
import type { ItemProjection, StageProjection } from '@/ws/types';
import type { ItemTimelineRow, ItemTimelinePrepostRow } from '@shared/types/timeline';
import { itemStatusClass, ITEM_STATUS_OPTIONS } from './itemStatus';
import { resolveItemDisplayName } from './displayName';
import { TimelineList } from './TimelineList';
import {
  fetchItemTimeline,
  getCachedTimeline,
} from './timelineCache';
import { fuzzyMatch, matchesOnlyViaTimeline } from './fuzzyMatch';
import { loadSessionIntoStore } from '@/components/LiveStream/sessionDisplay';

export { fuzzyMatch } from './fuzzyMatch';

/**
 * If blockedReason is of the form "dependency <rowUuid> <state>", rewrite
 * it to use the referenced item's stable ID. Falls back to the raw string
 * when the lookup misses. Keeps the `⚠` tooltip readable.
 */
function translateBlockedReason(
  raw: string | null,
  rowIdToStableId: Map<string, string>,
): string | null {
  if (!raw) return raw;
  const m = /^dependency (\S+) (\S+)$/.exec(raw);
  if (!m) return raw;
  const stable = rowIdToStableId.get(m[1]);
  return stable ? `dependency ${stable} ${m[2]}` : raw;
}

// ---------------------------------------------------------------------------
// Item data cache
// ---------------------------------------------------------------------------

const itemDataCache = new Map<string, unknown>();
const itemDataCacheVersion = new Map<string, number>(); // itemId → stateVersion

/**
 * Invalidate cached item.data for a single item.
 * Called by WorkflowDetailRoute when an item.state frame arrives,
 * ensuring a fresh fetch on next selection.
 */
export function invalidateItemData(itemId: string): void {
  itemDataCache.delete(itemId);
  itemDataCacheVersion.delete(itemId);
}

/**
 * Clear the entire item.data cache.
 * Called by WorkflowDetailRoute on unmount (workflow navigation) so that
 * navigating from workflow A → B → A does not show stale item data.
 */
export function clearItemDataCache(): void {
  itemDataCache.clear();
  itemDataCacheVersion.clear();
}

// ---------------------------------------------------------------------------
// FeatureBoard
// ---------------------------------------------------------------------------

interface Props {
  workflowId: string;
  stages: StageProjection[];
  items: ItemProjection[];
  activeSessionId: string | null;
  selectedItemId: string | null;
  onSelectItem: (itemId: string | null) => void;
  /**
   * Fires when the user clicks a session row in an expanded item's inline
   * timeline. The parent is expected to select the item, switch to the
   * History tab, and point the right pane at the given sessionId. The log
   * has already been prefetched into the render store by FeatureBoard.
   */
  onSelectTimelineSession?: (itemId: string, sessionId: string) => void;
  /**
   * Fires when the user clicks a prepost row that has at least one captured
   * output path. The parent is expected to select the item and switch the
   * right pane to the PrepostOutputPane for the given row. `stream` is
   * whichever of stdout/stderr has a non-null path (stdout wins when both
   * are set, as it is the more common case for post-command diagnostics).
   */
  onSelectTimelinePrepost?: (
    itemId: string,
    selection: {
      prepostId: string;
      stream: 'stdout' | 'stderr';
      commandName: string;
    },
  ) => void;
  /**
   * Phase 5: per-item timeline refetch signals. The parent route owns the
   * counter and bumps it (keyed by itemId) when a session lifecycle frame
   * arrives for an item currently in `expanded`. When the count for an
   * itemId increases, FeatureBoard drops its cached timelineByItem entry
   * for that item so the existing fetch effect re-fires and re-populates
   * it from the (now invalidated) module-level timelineCache.
   *
   * Only read for items in `expanded`; signals for collapsed items are
   * ignored because their timeline has never been fetched in the first
   * place. Provided so the route-layer can decide whether to invalidate
   * without needing a ref into FeatureBoard (Option A of the phase plan).
   */
  timelineInvalidations?: ReadonlyMap<string, number>;
  /**
   * Phase 5: externally-observable expanded set. When provided, the route
   * can read this to decide whether an incoming session-lifecycle frame
   * warrants invalidating the timeline. If omitted, FeatureBoard manages
   * expand/collapse state internally as before.
   */
  onExpandedChange?: (expanded: ReadonlySet<string>) => void;
}

export function FeatureBoard({
  workflowId,
  stages,
  items,
  activeSessionId,
  selectedItemId,
  onSelectItem,
  onSelectTimelineSession,
  onSelectTimelinePrepost,
  timelineInvalidations,
  onExpandedChange,
}: Props) {
  const { itemId: deepLinkedItemId } = useParams<{ itemId?: string }>();

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [stageFilter, setStageFilter] = useState('all');
  const [focusedIdx, setFocusedIdx] = useState<number>(-1);
  const [itemData, setItemData] = useState<Record<string, unknown>>({});
  const [itemDataExpanded, setItemDataExpanded] = useState<Set<string>>(new Set());
  // fetchingData is a ref, not state: mutating a Set creates a new reference that
  // would re-fire the fetch effect (and since a 404 leaves itemDataCache empty,
  // the effect would refetch forever). Refs don't trigger re-renders or act as
  // effect dependencies. Render still reads it because selection/itemData state
  // changes around the fetch already trigger the re-renders we need.
  const fetchingData = useRef<Set<string>>(new Set());
  // Highlight set tracks which itemIds are pulsing from a deep-link. React state
  // prevents the data-highlight attribute being overwritten by re-renders during
  // the 2 s animation window (the prior DOM-mutation approach was fragile).
  const [highlightedItems, setHighlightedItems] = useState<Set<string>>(new Set());

  // Inline timeline expand/collapse state.
  // - `expanded` is the set of itemIds currently expanded (card caret open).
  // - `timelineByItem` mirrors the module-level timelineCache by value so a
  //   fetch settling triggers a re-render. We keep the cache authoritative —
  //   this state is only for re-render propagation.
  // - `fetchingTimeline` is a ref (not state) for the same reason as
  //   fetchingData above: mutating a Set to kick a new render would re-fire
  //   the effect and 404-loop. See fetchingData comment.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [timelineByItem, setTimelineByItem] = useState<
    Record<string, ItemTimelineRow[] | null>
  >({});
  const fetchingTimeline = useRef<Set<string>>(new Set());

  // Phase 5: notify the parent route whenever `expanded` changes so it can
  // gate session-lifecycle invalidation without needing a ref into this
  // component. Intentionally omits onExpandedChange from the dep list — the
  // callback is expected to be stable; re-running on every parent render
  // would re-notify spuriously.
  useEffect(() => {
    onExpandedChange?.(expanded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const listboxId = useId();

  // Debounce search 200 ms.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 200);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Group items by stageId.
  const grouped = useMemo(() => {
    const map = new Map<string, ItemProjection[]>();
    for (const item of items) {
      const list = map.get(item.stageId) ?? [];
      list.push(item);
      map.set(item.stageId, list);
    }
    return map;
  }, [items]);

  // stableId → item and rowId → stableId lookups for resolving dependsOn
  // entries and translating "dependency <uuid> <state>" blockedReason
  // strings. Built once per items change (not per render).
  const { stableIdToItem, rowIdToStableId } = useMemo(() => {
    const byStable = new Map<string, ItemProjection>();
    const rowToStable = new Map<string, string>();
    for (const item of items) {
      if (item.stableId) {
        byStable.set(item.stableId, item);
        rowToStable.set(item.id, item.stableId);
      }
    }
    return { stableIdToItem: byStable, rowIdToStableId: rowToStable };
  }, [items]);

  // Filtered flat list for keyboard navigation.
  //
  // fuzzyMatch consults `item.displayTitle/displaySubtitle`, the owning
  // stage id, and any already-cached timeline rows (via getCachedTimeline,
  // which is a cheap module-level Map lookup). `matchesViaTimeline`
  // records the subset of matches that are only reachable via cached
  // timeline rows — FeatureBoard auto-expands those items below so the
  // hit is visible to the user. The memo is keyed on `timelineByItem` so
  // a newly-settled fetch re-runs the filter (and the auto-expand effect)
  // once the rows for a previously-expanded item land.
  const { flatFiltered, matchesViaTimeline } = useMemo(() => {
    const matched: ItemProjection[] = [];
    const viaTimeline = new Set<string>();
    for (const item of items) {
      if (statusFilter !== 'all' && item.state.status !== statusFilter) continue;
      if (stageFilter !== 'all' && item.stageId !== stageFilter) continue;
      const cachedRows = getCachedTimeline(workflowId, item.id);
      if (!fuzzyMatch(item, debouncedSearch, item.stageId, cachedRows)) continue;
      matched.push(item);
      if (
        debouncedSearch &&
        matchesOnlyViaTimeline(item, debouncedSearch, item.stageId, cachedRows)
      ) {
        viaTimeline.add(item.id);
      }
    }
    return { flatFiltered: matched, matchesViaTimeline: viaTimeline };
    // `timelineByItem` is listed so the filter re-runs when a previously-
    // fetched timeline settles (the module cache is the source of truth;
    // timelineByItem is the render-mirror that tells us when it changed).
  }, [items, statusFilter, stageFilter, debouncedSearch, workflowId, timelineByItem]);

  // Auto-expand items whose only match is via a cached timeline row, so the
  // user can see the hit without having to manually open the caret. We only
  // ever GROW `expanded` — clearing the query must not contract it, because
  // the user may have opened rows manually (and because contracting here
  // would fight against the toggleExpanded callback).
  useEffect(() => {
    if (matchesViaTimeline.size === 0) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of matchesViaTimeline) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [matchesViaTimeline]);

  // Deep-link scroll: useLayoutEffect fires after DOM mutations but before
  // the browser paints, preventing any visible flash before the card is
  // centred. Re-runs when items changes so it works even when the snapshot
  // (and thus item DOM elements) arrives after the initial mount.
  useLayoutEffect(() => {
    if (!deepLinkedItemId) return;
    const el = itemRefs.current.get(deepLinkedItemId);
    if (!el) return; // items not rendered yet; re-runs on next items change
    el.scrollIntoView({ block: 'center' });
    setHighlightedItems((prev) => new Set([...prev, deepLinkedItemId]));
    onSelectItem(deepLinkedItemId);
    const t = setTimeout(() => {
      setHighlightedItems((prev) => {
        const next = new Set(prev);
        next.delete(deepLinkedItemId);
        return next;
      });
    }, 2000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkedItemId, items]); // items triggers re-check after snapshot loads; onSelectItem intentionally omitted (stable ref)

  // Declared here (pre-handleKeyDown) so Space handling in the keyboard
  // callback can close over it without a forward reference.
  const toggleExpanded = useCallback((itemId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);

  // Keyboard navigation.
  // j/k move between items only; they do NOT descend into the inline timeline
  // rows of an expanded card. Space on the focused item toggles the inline
  // timeline. Enter selects the item (unchanged).
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'j') {
        e.preventDefault();
        setFocusedIdx((i) => Math.min(i + 1, flatFiltered.length - 1));
      } else if (e.key === 'k') {
        e.preventDefault();
        setFocusedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        const item = flatFiltered[focusedIdx];
        if (item) onSelectItem(item.id);
      } else if (e.key === ' ' || e.code === 'Space') {
        const item = flatFiltered[focusedIdx];
        if (item) {
          e.preventDefault();
          toggleExpanded(item.id);
        }
      } else if (e.key === 'Escape') {
        onSelectItem(null);
        setFocusedIdx(-1);
      }
    },
    [flatFiltered, focusedIdx, onSelectItem, toggleExpanded],
  );

  // Scroll focused item into view.
  useEffect(() => {
    const item = flatFiltered[focusedIdx];
    if (!item) return;
    const el = itemRefs.current.get(item.id);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [focusedIdx, flatFiltered]);

  // Fetch item.data on selection (once per selection, cached).
  // A null entry in itemDataCache means "we tried and got a non-ok response";
  // we still cache it so we don't refetch (and 404-loop) on the next render.
  useEffect(() => {
    if (!selectedItemId) return;
    if (itemDataCache.has(selectedItemId)) {
      const cached = itemDataCache.get(selectedItemId);
      if (cached !== null) {
        setItemData((prev) => ({ ...prev, [selectedItemId]: cached }));
      }
      return;
    }
    if (fetchingData.current.has(selectedItemId)) return;

    fetchingData.current.add(selectedItemId);
    // Force a re-render so the "Loading data…" message appears. We reuse
    // itemData state (no-op spread) since fetchingData is a ref now.
    setItemData((prev) => ({ ...prev }));

    fetch(
      `/api/workflows/${encodeURIComponent(workflowId)}/items/${encodeURIComponent(selectedItemId)}/data`,
    )
      .then(async (r) => (r.ok ? ((await r.json()) as unknown) : null))
      .then((data: unknown) => {
        itemDataCache.set(selectedItemId, data);
        if (data !== null) {
          setItemData((prev) => ({ ...prev, [selectedItemId]: data }));
        } else {
          // Trigger a re-render so the "No data available." state replaces
          // the loading indicator.
          setItemData((prev) => ({ ...prev }));
        }
      })
      .catch(() => {
        // Treat network errors like a non-ok response so we don't loop.
        itemDataCache.set(selectedItemId, null);
        setItemData((prev) => ({ ...prev }));
      })
      .finally(() => {
        fetchingData.current.delete(selectedItemId);
      });
  }, [selectedItemId, workflowId]);

  // Lazy-fetch the timeline for any newly-expanded item. Seeds state from the
  // module-level cache on first read so flipping expand off/on doesn't refetch.
  useEffect(() => {
    for (const itemId of expanded) {
      if (timelineByItem[itemId] !== undefined) continue;
      const cached = getCachedTimeline(workflowId, itemId);
      if (cached !== undefined) {
        setTimelineByItem((prev) => ({ ...prev, [itemId]: cached }));
        continue;
      }
      if (fetchingTimeline.current.has(itemId)) continue;
      fetchingTimeline.current.add(itemId);
      void fetchItemTimeline(workflowId, itemId)
        .then((rows) => {
          setTimelineByItem((prev) => ({ ...prev, [itemId]: rows }));
        })
        .finally(() => {
          fetchingTimeline.current.delete(itemId);
        });
    }
    // timelineByItem intentionally omitted — it is a render-mirror of the
    // module cache and including it would re-fire the effect on every settle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, workflowId]);

  // Phase 5: react to parent-driven timeline invalidations. The route bumps
  // the per-item counter when a session-lifecycle frame (session.started /
  // session.ended) arrives for an expanded item; the module-level cache has
  // already been cleared by the route, so we just need to drop our mirror so
  // the fetch effect above re-fires.
  //
  // seenInvalidationsRef stores the last count we acted on per itemId. The
  // ref is necessary (not state) because including it in deps would cause the
  // effect to re-run on every update and potentially loop.
  const seenInvalidationsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!timelineInvalidations) return;
    const seen = seenInvalidationsRef.current;
    const itemsToDrop: string[] = [];
    for (const [itemId, count] of timelineInvalidations) {
      const lastSeen = seen.get(itemId) ?? 0;
      if (count > lastSeen) {
        seen.set(itemId, count);
        // Only drop state for items we've already rendered. Collapsed items
        // have no state entry, so there's nothing to drop; and we don't want
        // to prefetch collapsed-item timelines.
        if (timelineByItem[itemId] !== undefined) itemsToDrop.push(itemId);
      }
    }
    if (itemsToDrop.length > 0) {
      setTimelineByItem((prev) => {
        const next = { ...prev };
        for (const id of itemsToDrop) delete next[id];
        return next;
      });
    }
    // timelineByItem is intentionally read inside the effect body (via the
    // closure) rather than listed as a dep — including it would re-run the
    // effect after every fetch settle, re-dropping and looping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineInvalidations]);

  // Click-through from a timeline-session row → prefetch log into the store
  // and ask the parent to select the right-pane session.
  // loadedSessions is module-scoped to this component via a ref so clicks on
  // the same session don't duplicate fetches within the mount.
  const timelineLoadedSessionsRef = useRef<Set<string>>(new Set());
  const handleSelectTimelineSession = useCallback(
    async (itemId: string, sessionId: string) => {
      await loadSessionIntoStore(sessionId, timelineLoadedSessionsRef.current);
      onSelectTimelineSession?.(itemId, sessionId);
    },
    [onSelectTimelineSession],
  );

  // Prepost click → either route the request up to the parent so it can show
  // the real artifact in the right pane (new in F4), or — for legacy rows
  // from before F3 where both stdout_path and stderr_path are NULL — show a
  // permanent static notice. The previous 3-second transient placeholder
  // and its `prepost-output-notice` testid were removed in F4.
  const [legacyPrepostNotice, setLegacyPrepostNotice] = useState(false);
  const handleOpenPrepostOutput = useCallback(
    (row: ItemTimelinePrepostRow) => {
      const hasStdout = !!row.stdoutPath;
      const hasStderr = !!row.stderrPath;
      if (!hasStdout && !hasStderr) {
        // Legacy row (pre-F3): nothing to serve. Show a permanent notice so
        // the user understands why nothing is rendered.
        setLegacyPrepostNotice(true);
        return;
      }
      setLegacyPrepostNotice(false);
      // Which row does this belong to? Find the owning itemId by scanning
      // the fetched timelines — each row's id is unique across items only
      // for session rows, but prepost row ids are globally unique integers
      // (SQLite rowid), so any mapping across item scopes is safe.
      let owningItemId: string | null = null;
      for (const [itemId, rows] of Object.entries(timelineByItem)) {
        if (rows?.some((r) => r.kind === 'prepost' && r.id === row.id)) {
          owningItemId = itemId;
          break;
        }
      }
      if (!owningItemId) return;
      // stdout wins when both are present — more common for post-command
      // diagnostics — matching the behaviour documented on the prop.
      const stream: 'stdout' | 'stderr' = hasStdout ? 'stdout' : 'stderr';
      onSelectTimelinePrepost?.(owningItemId, {
        prepostId: row.id,
        stream,
        commandName: row.commandName,
      });
    },
    [onSelectTimelinePrepost, timelineByItem],
  );

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function renderItemCard(item: ItemProjection, isStreaming: boolean) {
    const isFocused = flatFiltered[focusedIdx]?.id === item.id;
    const isSelected = selectedItemId === item.id;
    const isHighlighted = highlightedItems.has(item.id);
    const data = itemData[item.id];
    const isDataExpanded = itemDataExpanded.has(item.id);
    const isTimelineExpanded = expanded.has(item.id);
    const timelineRows = timelineByItem[item.id];
    const stage = stages.find((s) => s.id === item.stageId);
    const displayName = resolveItemDisplayName(item, stage?.run);

    // "Waiting on" line: only shown for pending/blocked items whose
    // dependency list contains at least one item that hasn't completed.
    // This is the user-facing answer to "why is this idle?" on a workflow
    // that still has concurrency budget.
    const showWaitingOn =
      (item.state.status === 'pending' || item.state.status === 'blocked') &&
      (item.dependsOn?.length ?? 0) > 0;
    const unmetDepLabels: string[] = showWaitingOn
      ? (item.dependsOn ?? []).filter((depLabel) => {
          const depItem = stableIdToItem.get(depLabel);
          // Unknown deps (cross-workflow, pruned, or UUID fallbacks with no
          // stable-id match) are shown as-is — the user still gets a label.
          if (!depItem) return true;
          return depItem.state.status !== 'complete';
        })
      : [];

    const blockedTooltip = translateBlockedReason(
      item.state.blockedReason,
      rowIdToStableId,
    );

    return (
      <div
        key={item.id}
        id={`item-${item.id}`}
        ref={(el) => {
          if (el) itemRefs.current.set(item.id, el);
          else itemRefs.current.delete(item.id);
        }}
        role="option"
        aria-selected={isSelected}
        data-highlight={isHighlighted ? 'true' : 'false'}
        onClick={() => {
          onSelectItem(item.id);
          setFocusedIdx(flatFiltered.findIndex((i) => i.id === item.id));
        }}
        className={[
          'cursor-pointer border-b border-gray-700/30 transition-colors',
          isSelected ? 'bg-gray-700/60 ring-1 ring-inset ring-blue-500/40' : 'hover:bg-gray-700/20',
          isFocused ? 'outline outline-1 outline-blue-400' : '',
          'data-[highlight=true]:animate-pulse',
        ].join(' ')}
      >
        <div className="flex items-start gap-2 px-3 py-2">
          {/* Disclosure caret — must not propagate to the card's select handler. */}
          <button
            type="button"
            aria-label={isTimelineExpanded ? 'Collapse item timeline' : 'Expand item timeline'}
            aria-expanded={isTimelineExpanded}
            data-testid={`item-caret-${item.id}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleExpanded(item.id);
            }}
            className="mt-0.5 w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-200 shrink-0 leading-none"
          >
            <span aria-hidden="true">{isTimelineExpanded ? '▾' : '▸'}</span>
          </button>
          {isStreaming && (
            <span
              className="w-2 h-2 mt-0.5 rounded-full bg-blue-400 animate-pulse shrink-0"
              aria-label="Streaming"
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-gray-100 truncate">
                {displayName}
              </span>
              {(item.state.retryCount ?? 0) > 0 && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-orange-600/30 text-orange-300">
                  retry {item.state.retryCount}
                </span>
              )}
              {blockedTooltip && (
                <span
                  title={blockedTooltip}
                  className="text-[10px] text-orange-400 cursor-help"
                  data-testid="item-blocked-badge"
                >
                  ⚠
                </span>
              )}
            </div>
            {item.displayDescription && (
              <p
                className="text-[10px] text-gray-400 truncate mt-0.5"
                data-testid="item-description"
              >
                {item.displayDescription}
              </p>
            )}
            {unmetDepLabels.length > 0 && (
              <p
                className="text-[10px] text-orange-300 truncate mt-0.5"
                data-testid="item-waiting-on"
                title={`Waiting on: ${unmetDepLabels.join(', ')}`}
              >
                Waiting on: {unmetDepLabels.join(', ')}
              </p>
            )}
            {item.displaySubtitle && (
              <p className="text-[10px] text-gray-500 truncate mt-0.5" data-testid="item-subtitle">
                {item.displaySubtitle}
              </p>
            )}
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${itemStatusClass(item.state.status)}`}>
                {item.state.status}
              </span>
              {item.state.currentPhase && (
                <span className="text-[10px] text-gray-500" data-testid="item-phase">
                  {item.state.currentPhase}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* item.data collapsible — only shown when selected.
            Three states:
              1. fetching in-flight  → "Loading data…"
              2. cache has null (fetch completed with non-ok response or error)
                                      → "No data available."
              3. data present        → JSON viewer */}
        {isSelected && (
          <div className="px-3 pb-2 ml-4">
            {fetchingData.current.has(item.id) ? (
              <p className="text-xs text-gray-500">Loading data…</p>
            ) : itemDataCache.has(item.id) && itemDataCache.get(item.id) === null ? (
              <p className="text-xs text-gray-500">No data available.</p>
            ) : data !== undefined ? (
              <div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setItemDataExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(item.id)) next.delete(item.id);
                      else next.add(item.id);
                      return next;
                    });
                  }}
                  className="text-[10px] text-blue-400 hover:text-blue-300"
                >
                  {isDataExpanded ? '▼ Hide data' : '▶ Show data'}
                </button>
                {isDataExpanded && (
                  <pre className="mt-1 text-[10px] font-mono text-gray-400 bg-gray-800/50 rounded p-2 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre">
                    {JSON.stringify(data, null, 2)}
                  </pre>
                )}
              </div>
            ) : null}
          </div>
        )}

        {/* Inline timeline — rendered under the card body when expanded.
            The TimelineList button-row clicks already stopPropagation so
            they don't bubble into the card's select-on-click handler. */}
        {isTimelineExpanded && (
          <div onClick={(e) => e.stopPropagation()}>
            <TimelineList
              rows={timelineRows}
              onSelectSession={(sessionId) => {
                void handleSelectTimelineSession(item.id, sessionId);
              }}
              onOpenPrepostOutput={handleOpenPrepostOutput}
            />
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Determine which item is currently streaming (active session → itemId).
  // We approximate by finding the first in_progress item.
  const streamingItemId = items.find((i) => i.state.status === 'in_progress')?.id;

  return (
    <div className="flex flex-col h-full">
      {/* Search + filter bar */}
      <div className="p-2 space-y-1.5 border-b border-gray-700 shrink-0">
        <input
          type="search"
          placeholder="Search items…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="w-full bg-gray-700/60 text-gray-100 placeholder-gray-500 rounded px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-blue-500"
        />
        <div className="flex gap-1.5">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="flex-1 bg-gray-700/60 text-gray-100 rounded px-2.5 py-1.5 text-xs outline-none"
            aria-label="Filter items by status"
          >
            {ITEM_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="flex-1 bg-gray-700/60 text-gray-100 rounded px-2.5 py-1.5 text-xs outline-none"
            aria-label="Filter by stage"
          >
            <option value="all">All stages</option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.id}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Permanent notice shown when the user clicks a legacy prepost row
          (both stdout_path and stderr_path NULL — e.g. rows written before
          F3 started capturing output). Dismissed by clicking any other
          row — no auto-dismiss timer. */}
      {legacyPrepostNotice && (
        <div
          data-testid="prepost-no-output-notice"
          className="shrink-0 px-3 py-1.5 text-[10px] text-gray-400 bg-gray-800/60 border-b border-gray-700"
        >
          No output captured for this run
        </div>
      )}

      {/* Item list with keyboard nav */}
      <div
        ref={listRef}
        role="listbox"
        id={listboxId}
        aria-label="Items"
        aria-activedescendant={
          focusedIdx >= 0 && flatFiltered[focusedIdx]
            ? `item-${flatFiltered[focusedIdx].id}`
            : undefined
        }
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="flex-1 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
      >
        {flatFiltered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-gray-500">No items match.</div>
        )}

        {/* Render grouped by stage */}
        {stages.map((stage) => {
          const stageItems = (grouped.get(stage.id) ?? []).filter((item) =>
            flatFiltered.some((f) => f.id === item.id),
          );

          // Pin streaming item to top of its group.
          const sorted = [...stageItems].sort((a, b) => {
            if (a.id === streamingItemId) return -1;
            if (b.id === streamingItemId) return 1;
            return 0;
          });

          if (sorted.length === 0) return null;

          return (
            <div key={stage.id}>
              <div
                data-testid="stage-header"
                className="px-3 py-1 text-[10px] text-gray-500 uppercase tracking-wide bg-gray-800/40 sticky top-0 z-10 border-b border-gray-700/30"
              >
                <div>
                  <span className="inline-block px-1 mr-1.5 rounded bg-gray-700/60 text-gray-400 font-semibold tracking-wider">
                    STAGE
                  </span>
                  <span>{stage.id}</span>
                </div>
                {stage.description !== null && (
                  <div
                    data-testid="stage-description"
                    className="mt-0.5 text-[10px] text-gray-500 normal-case tracking-normal font-normal"
                  >
                    {stage.description}
                  </div>
                )}
              </div>
              {sorted.map((item) =>
                renderItemCard(item, item.id === streamingItemId),
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
