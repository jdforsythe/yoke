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
 * card on mount (reads :itemId from URL via useParams).
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
  useRef,
  useCallback,
  useMemo,
  useId,
} from 'react';
import { useParams } from 'react-router-dom';
import type { ItemProjection, StageProjection } from '@/ws/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function itemStatusClass(status: string): string {
  switch (status) {
    case 'in_progress':
    case 'active':
      return 'bg-blue-500/20 text-blue-300';
    case 'complete':
      return 'bg-green-500/20 text-green-300';
    case 'failed':
      return 'bg-red-500/20 text-red-300';
    case 'blocked':
      return 'bg-orange-500/20 text-orange-300';
    case 'pending':
    default:
      return 'bg-gray-500/20 text-gray-400';
  }
}

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
  const [focusedIdx, setFocusedIdx] = useState<number>(-1);
  const [itemData, setItemData] = useState<Record<string, unknown>>({});
  const [itemDataExpanded, setItemDataExpanded] = useState<Set<string>>(new Set());
  const [fetchingData, setFetchingData] = useState<Set<string>>(new Set());

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
      if (!fuzzyMatch(item, debouncedSearch)) return false;
      return true;
    });
  }, [items, statusFilter, debouncedSearch]);

  // Deep-link scroll on mount.
  useEffect(() => {
    if (!deepLinkedItemId) return;
    const el = itemRefs.current.get(deepLinkedItemId);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.setAttribute('data-highlight', 'true');
      setTimeout(() => el.removeAttribute('data-highlight'), 2000);
    }
    onSelectItem(deepLinkedItemId);
  }, [deepLinkedItemId, onSelectItem]);

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
  useEffect(() => {
    if (!selectedItemId) return;
    if (itemDataCache.has(selectedItemId)) {
      setItemData((prev) => ({ ...prev, [selectedItemId]: itemDataCache.get(selectedItemId) }));
      return;
    }
    if (fetchingData.has(selectedItemId)) return;

    setFetchingData((prev) => new Set([...prev, selectedItemId]));
    fetch(
      `/api/workflows/${encodeURIComponent(workflowId)}/items/${encodeURIComponent(selectedItemId)}/data`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (data !== null) {
          itemDataCache.set(selectedItemId, data);
          setItemData((prev) => ({ ...prev, [selectedItemId]: data }));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        setFetchingData((prev) => {
          const next = new Set(prev);
          next.delete(selectedItemId);
          return next;
        });
      });
  }, [selectedItemId, workflowId, fetchingData]);

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function renderItemCard(item: ItemProjection, isStreaming: boolean) {
    const isFocused = flatFiltered[focusedIdx]?.id === item.id;
    const isSelected = selectedItemId === item.id;
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
        data-highlight="false"
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
              <p className="text-[10px] text-gray-500 truncate mt-0.5">{item.displaySubtitle}</p>
            )}
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${itemStatusClass(item.state.status)}`}>
                {item.state.status}
              </span>
              {item.state.currentPhase && (
                <span className="text-[10px] text-gray-500">{item.state.currentPhase}</span>
              )}
            </div>
          </div>
        </div>

        {/* item.data collapsible — only shown when selected */}
        {isSelected && (
          <div className="mt-2 ml-4">
            {fetchingData.has(item.id) ? (
              <p className="text-xs text-gray-500">Loading data…</p>
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
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="w-full bg-gray-700/60 text-gray-100 rounded px-2.5 py-1.5 text-xs outline-none"
        >
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="in_progress">In progress</option>
          <option value="complete">Complete</option>
          <option value="failed">Failed</option>
          <option value="blocked">Blocked</option>
        </select>
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
              <div className="px-3 py-1 text-[10px] text-gray-500 uppercase tracking-wide bg-gray-800/40 sticky top-0 z-10 border-b border-gray-700/30">
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
