import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getClient } from '@/ws/client';
import type { WorkflowIndexUpdatePayload, ServerFrame } from '@/ws/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkflowRow {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  createdAt: string;
  unreadEvents: number;
}

interface WorkflowsApiResponse {
  workflows: WorkflowRow[];
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_OPTIONS = [
  'all',
  'active',
  'paused',
  'complete',
  'failed',
  'cancelled',
] as const;

function statusChipClass(status: string): string {
  switch (status) {
    case 'active':
    case 'in_progress':
      return 'bg-blue-500/20 text-blue-300';
    case 'paused':
      return 'bg-yellow-500/20 text-yellow-300';
    case 'complete':
      return 'bg-green-500/20 text-green-300';
    case 'failed':
      return 'bg-red-500/20 text-red-300';
    case 'cancelled':
    default:
      return 'bg-gray-500/20 text-gray-400';
  }
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1_000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// WorkflowList
// ---------------------------------------------------------------------------

/**
 * Sidebar list of workflows.
 *
 * - Fetches via GET /api/workflows with keyset pagination (before=createdAt cursor).
 * - Real-time row updates via workflow.index.update WS frames.
 * - Filter bar with status dropdown and debounced (300 ms) text search.
 * - Filter/search params are reflected in the URL query string for deep-link.
 * - Infinite scroll: IntersectionObserver on a sentinel div at the list bottom.
 * - AbortController cancels in-flight fetches when filters change.
 * - Relative timestamps refresh every 60 s without re-fetching.
 */
export function WorkflowList() {
  const navigate = useNavigate();
  const { workflowId: activeId } = useParams<{ workflowId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [rows, setRows] = useState<WorkflowRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  // Controlled search input; debounced value drives the fetch.
  const [searchInput, setSearchInput] = useState(() => searchParams.get('q') ?? '');
  const [debouncedSearch, setDebouncedSearch] = useState(searchInput);
  const [statusFilter, setStatusFilter] = useState(() => searchParams.get('status') ?? 'all');
  const [showArchived, setShowArchived] = useState(() => searchParams.get('archived') === 'true');

  // Tick: forces relative-timestamp text to re-render every 60 s.
  const [tick, setTick] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);

  // Debounce search input → debouncedSearch (300 ms).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Relative-timestamp tick every 60 s.
  useEffect(() => {
    const iv = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(iv);
  }, []);

  // Core fetch function. append=true for pagination, false for fresh load.
  const fetchPage = useCallback(
    async (beforeCursor?: string, append = false) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setLoading(true);
      try {
        const qp = new URLSearchParams({ limit: '20' });
        if (statusFilter !== 'all') qp.set('status', statusFilter);
        if (debouncedSearch) qp.set('q', debouncedSearch);
        if (showArchived) qp.set('archived', 'true');
        if (beforeCursor) qp.set('before', beforeCursor);

        const res = await fetch(`/api/workflows?${qp.toString()}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as WorkflowsApiResponse;
        setRows((prev) => (append ? [...prev, ...data.workflows] : data.workflows));
        setHasMore(data.hasMore);
      } catch {
        // Aborted or network failure — silently ignore.
      } finally {
        setLoading(false);
      }
    },
    [statusFilter, debouncedSearch, showArchived],
  );

  // Re-fetch from scratch when filters change.
  useEffect(() => {
    setRows([]);
    void fetchPage();

    // Sync URL query string for deep-link support.
    const qp = new URLSearchParams();
    if (statusFilter !== 'all') qp.set('status', statusFilter);
    if (debouncedSearch) qp.set('q', debouncedSearch);
    if (showArchived) qp.set('archived', 'true');
    setSearchParams(qp, { replace: true });
  }, [statusFilter, debouncedSearch, showArchived, fetchPage, setSearchParams]);

  // WS: patch rows in-place on workflow.index.update.
  useEffect(() => {
    return getClient().on('workflow.index.update', (frame: ServerFrame) => {
      const p = frame.payload as WorkflowIndexUpdatePayload;
      setRows((prev) => {
        const idx = prev.findIndex((r) => r.id === p.id);
        if (idx < 0) {
          // New workflow — prepend.
          return [
            {
              id: p.id,
              name: p.name,
              status: p.status,
              updatedAt: p.updatedAt,
              createdAt: p.updatedAt,
              unreadEvents: p.unreadEvents,
            },
            ...prev,
          ];
        }
        const next = [...prev];
        next[idx] = {
          ...next[idx]!,
          status: p.status,
          updatedAt: p.updatedAt,
          unreadEvents: p.unreadEvents,
        };
        return next;
      });
    });
  }, []);

  // Infinite scroll: observe sentinel div at list bottom.
  useEffect(() => {
    const sentinel = bottomSentinelRef.current;
    if (!sentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loading) {
          const last = rows[rows.length - 1];
          if (last) void fetchPage(last.createdAt, true);
        }
      },
      { threshold: 0.1 },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [hasMore, loading, rows, fetchPage]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isEmpty = rows.length === 0 && !loading;
  const isFiltered = debouncedSearch !== '' || statusFilter !== 'all' || showArchived;

  return (
    <div className="flex flex-col h-full text-sm">
      {/* Filter bar */}
      <div className="p-2 space-y-1.5 border-b border-gray-700 shrink-0">
        <input
          type="search"
          placeholder="Search workflows…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="w-full bg-gray-700/60 text-gray-100 placeholder-gray-500 rounded px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-blue-500"
          aria-label="Search workflows"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="w-full bg-gray-700/60 text-gray-100 rounded px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-blue-500"
          aria-label="Filter by status"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="rounded accent-blue-500"
            aria-label="Show archived workflows"
          />
          Show archived
        </label>
      </div>

      {/* Row list */}
      <div className="flex-1 overflow-y-auto" role="list">
        {isEmpty && (
          <div className="px-4 py-8 text-center text-gray-500 text-xs">
            {isFiltered
              ? 'No workflows match the current filters.'
              : 'No workflows yet.'}
          </div>
        )}

        {rows.map((row) => (
          <button
            key={row.id}
            role="listitem"
            onClick={() => {
              getClient().subscribe(row.id);
              navigate(`/workflow/${row.id}`);
            }}
            className={[
              'w-full text-left px-3 py-2.5 border-b border-gray-700/40',
              'hover:bg-gray-700/40 transition-colors',
              activeId === row.id
                ? 'bg-gray-700/60 border-l-2 border-l-blue-500'
                : '',
            ].join(' ')}
            aria-current={activeId === row.id ? 'page' : undefined}
          >
            <div className="flex items-start justify-between gap-1.5">
              <span className="text-gray-100 text-xs font-medium truncate flex-1">
                {row.name}
              </span>
              {row.unreadEvents > 0 && (
                <span
                  className="shrink-0 bg-blue-500 text-white text-[10px] rounded-full px-1.5 min-w-[1.1rem] h-[1.1rem] flex items-center justify-center"
                  aria-label={`${row.unreadEvents} unread events`}
                >
                  {row.unreadEvents > 99 ? '99+' : row.unreadEvents}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${statusChipClass(row.status)}`}
              >
                {row.status}
              </span>
              {/* Re-renders every 60 s via tick, not on every WS frame */}
              <span key={tick} className="text-[10px] text-gray-500">
                {relativeTime(row.updatedAt)}
              </span>
            </div>
          </button>
        ))}

        {/* Infinite-scroll sentinel */}
        <div ref={bottomSentinelRef} className="h-px" aria-hidden />

        {loading && (
          <div className="px-3 py-2 text-center text-gray-500 text-xs">
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}
