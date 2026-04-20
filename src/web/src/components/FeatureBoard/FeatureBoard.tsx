/**
 * FeatureBoard — grouped item cards with keyboard navigation and deep-link support.
 *
 * Groups items by stageId using a Map<string, ItemProjection[]> derived from
 * snapshot (rebuilt on items change, not on each render). item.state WS frames
 * are applied via the `items` prop (managed in WorkflowDetailRoute).
 *
 * Fuzzy search: client-side filter over displayTitle + displaySubtitle,
 * debounced 200 ms. Status and stage/category filters are also client-side.
 *
 * Keyboard navigation: j/k move a visible focus ring between items using
 * aria-activedescendant pattern. Enter opens the stream pane for the focused
 * item (calls onSelectItem). Escape clears selection.
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
import { itemStatusClass, ITEM_STATUS_OPTIONS } from './itemStatus';

function fuzzyMatch(item: ItemProjection, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    (item.displayTitle ?? '').toLowerCase().includes(q) ||
    (item.displaySubtitle ?? '').toLowerCase().includes(q)
  );
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
}

export function FeatureBoard({
  workflowId,
  stages,
  items,
  activeSessionId,
  selectedItemId,
  onSelectItem,
}: Props) {
  const { itemId: deepLinkedItemId } = useParams<{ itemId?: string }>();

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
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

  // Filtered flat list for keyboard navigation.
  const flatFiltered = useMemo(() => {
    return items.filter((item) => {
      if (statusFilter !== 'all' && item.state.status !== statusFilter) return false;
      if (categoryFilter !== 'all' && item.stageId !== categoryFilter) return false;
      if (!fuzzyMatch(item, debouncedSearch)) return false;
      return true;
    });
  }, [items, statusFilter, categoryFilter, debouncedSearch]);

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

  // Keyboard navigation.
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
      } else if (e.key === 'Escape') {
        onSelectItem(null);
        setFocusedIdx(-1);
      }
    },
    [flatFiltered, focusedIdx, onSelectItem],
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

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function renderItemCard(item: ItemProjection, isStreaming: boolean) {
    const isFocused = flatFiltered[focusedIdx]?.id === item.id;
    const isSelected = selectedItemId === item.id;
    const isHighlighted = highlightedItems.has(item.id);
    const data = itemData[item.id];
    const isExpanded = itemDataExpanded.has(item.id);

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
          'px-3 py-2 cursor-pointer border-b border-gray-700/30 transition-colors',
          isSelected ? 'bg-gray-700/60 ring-1 ring-inset ring-blue-500/40' : 'hover:bg-gray-700/20',
          isFocused ? 'outline outline-1 outline-blue-400' : '',
          'data-[highlight=true]:animate-pulse',
        ].join(' ')}
      >
        <div className="flex items-start gap-2">
          {isStreaming && (
            <span
              className="w-2 h-2 mt-0.5 rounded-full bg-blue-400 animate-pulse shrink-0"
              aria-label="Streaming"
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-gray-100 truncate">
                {item.displayTitle ?? item.id}
              </span>
              {(item.state.retryCount ?? 0) > 0 && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-orange-600/30 text-orange-300">
                  retry {item.state.retryCount}
                </span>
              )}
              {item.state.blockedReason && (
                <span
                  title={item.state.blockedReason}
                  className="text-[10px] text-orange-400 cursor-help"
                >
                  ⚠
                </span>
              )}
            </div>
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
          <div className="mt-2 ml-4">
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
                  {isExpanded ? '▼ Hide data' : '▶ Show data'}
                </button>
                {isExpanded && (
                  <pre className="mt-1 text-[10px] font-mono text-gray-400 bg-gray-800/50 rounded p-2 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre">
                    {JSON.stringify(data, null, 2)}
                  </pre>
                )}
              </div>
            ) : null}
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
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="flex-1 bg-gray-700/60 text-gray-100 rounded px-2.5 py-1.5 text-xs outline-none"
            aria-label="Filter by category"
          >
            <option value="all">All categories</option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.id}
              </option>
            ))}
          </select>
        </div>
      </div>

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
                {stage.id}
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
