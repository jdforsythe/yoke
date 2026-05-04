/**
 * WorkflowDetailRoute — renders the full workflow detail view.
 *
 * Subscribes to the workflow on mount, handles all incoming WS frames,
 * and composes the UI from child components:
 *   - CrashRecoveryBanner (when recoveryState is set)
 *   - AttentionBanner (pending attention items)
 *   - GithubButton + workflow header
 *   - FeatureBoard (item cards, grouped by stage)
 *   - LiveStreamPane (active session output, virtualized)
 *   - HistoryPane (past session logs for selected item)
 *   - ControlMatrix (available manual actions)
 *
 * r2-04: activeSessionId (global) has been replaced by itemActiveSession
 * Map<itemId, ActiveSession>.  The stream pane is scoped to selectedItemId so
 * parallel per-item sessions never bleed into each other.
 */

import { useEffect, useState, useCallback, useRef, useSyncExternalStore, lazy, Suspense } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { getClient } from '@/ws/client';
import { dispatch, dispatchTextDelta, reset, subscribe as subscribeRenderStore, getSessionBlocksSnapshot } from '@/store/renderStore';
import { setAttentionCount } from '@/store/attentionStore';
import { dispatchGraphFrame } from '@/store/graphStore';
import { buildFromSnapshot, upsert, removeBySessionId } from '@/store/itemSessionMap';
import type { ActiveSession } from '@/store/itemSessionMap';
import { shouldUseReviewPanel } from '@/store/reviewPanelDetection';
import type { RenderBlock } from '@/store/types';
import { CrashRecoveryBanner } from '@/components/CrashRecoveryBanner/CrashRecoveryBanner';
import { PausedBanner } from '@/components/PausedBanner/PausedBanner';
import { AttentionBanner } from '@/components/AttentionBanner/AttentionBanner';
import { GithubButton } from '@/components/GithubButton/GithubButton';
import { FeatureBoard, invalidateItemData, clearItemDataCache } from '@/components/FeatureBoard/FeatureBoard';
const GraphPane = lazy(() =>
  import('@/components/GraphPane').then((m) => ({ default: m.GraphPane })),
);
import { NodeSummaryPanel } from '@/components/GraphPane/NodeSummaryPanel';
import { useWorkflowGraph } from '@/store/graphStore';
import type { GraphNode, SessionGraphNode, PhaseGraphNode } from '../../../shared/types/graph';
import { fetchItemTimeline, invalidateItemTimeline } from '@/components/FeatureBoard/timelineCache';
import { LiveStreamPane } from '@/components/LiveStream/LiveStreamPane';
import { HistoryPane } from '@/components/LiveStream/HistoryPane';
import type { ItemTimelineSessionRow } from '@shared/types/timeline';
import { PrepostOutputPane } from '@/components/LiveStream/PrepostOutputPane';
import { ReviewPanel } from '@/components/ReviewPanel/ReviewPanel';
import { ControlMatrix } from '@/components/ControlMatrix/ControlMatrix';
import type {
  WorkflowSnapshotPayload,
  ItemStatePayload,
  ItemProjection,
  SessionStartedPayload,
  SessionEndedPayload,
  NoticePayload,
  PendingAttention,
  ServerFrame,
  ControlPayload,
} from '@/ws/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Stable empty blocks reference returned by the render-store subscription when
// no session is active. Object.freeze prevents accidental mutation.
const EMPTY_RENDER_BLOCKS: readonly RenderBlock[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkflowDetailState {
  snapshot: WorkflowSnapshotPayload | null;
  items: Map<string, ItemProjection>;
  /**
   * Per-item active sessions. Keyed by itemId (null-itemId sessions are
   * excluded — they are once-per-workflow and have no item to scope to).
   * Maintained via:
   *   workflow.snapshot → buildFromSnapshot
   *   session.started   → upsert
   *   session.ended     → removeBySessionId
   */
  itemActiveSession: Map<string, ActiveSession>;
  /**
   * Tracks the last ended sessionId per itemId so the pane can show "Session
   * ended" with the frozen render-model blocks instead of "No active session".
   * Cleared when a new session.started arrives for the same item.
   */
  itemEndedSession: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Route component
// ---------------------------------------------------------------------------

export function WorkflowDetailRoute() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Capture the attention deep-link ID at initial render.  The effect below
  // removes it from the visible URL once consumed so it does not persist
  // across refreshes or appear in the address bar.
  const initialAttentionIdRef = useRef(searchParams.get('attention'));

  // View tab — 'list' (default, FeatureBoard) or 'graph' (GraphPane).
  // Persisted in the URL query string as ?view=graph for link/refresh.
  const viewParam = searchParams.get('view');
  const activeView: 'list' | 'graph' = viewParam === 'graph' ? 'graph' : 'list';
  const setView = useCallback(
    (next: 'list' | 'graph') => {
      setSearchParams(
        (prev) => {
          const qp = new URLSearchParams(prev);
          if (next === 'graph') qp.set('view', 'graph');
          else qp.delete('view');
          return qp;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // RC-3: explicitly remove the consumed ?attention param from the URL so it
  // does not persist in the address bar or browser history.
  useEffect(() => {
    if (initialAttentionIdRef.current) {
      const url = new URL(window.location.href);
      url.searchParams.delete('attention');
      history.replaceState(null, '', url.toString());
    }
    // Run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [state, setState] = useState<WorkflowDetailState>({
    snapshot: null,
    items: new Map(),
    itemActiveSession: new Map(),
    itemEndedSession: new Map(),
  });

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  // Graph tab selection — when the user clicks a non-session node (or a
  // session node on the Graph tab), this holds the graph node payload so the
  // right pane can swap to NodeSummaryPanel. null = nothing selected from
  // the graph, which also collapses the right pane on empty-canvas clicks.
  const [selectedGraphNode, setSelectedGraphNode] = useState<GraphNode | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Phase 5: mirror FeatureBoard's expanded item set so the WS frame handlers
  // below can decide whether a session-lifecycle frame warrants invalidating
  // the timeline cache. Kept as a ref (not state) because every toggle would
  // otherwise re-fire the WS subscription effect below (which keys on
  // workflowId). A ref is correct: the frame handlers close over a stable
  // mutable box, and we do not need re-renders driven by expanded-set changes
  // in the route itself — FeatureBoard owns rendering.
  const expandedItemsRef = useRef<ReadonlySet<string>>(new Set());
  // Phase 5: ref snapshot of itemActiveSession for use inside WS frame
  // handlers. session.ended carries only sessionId, so we need to look up
  // the itemId; doing so inside a setState updater is fragile (strict mode
  // re-runs updaters), so we read from this ref which mirrors state
  // synchronously via the effect below.
  const itemActiveSessionRef = useRef<Map<string, ActiveSession>>(new Map());
  // Per-item timeline invalidation counter. When a session-lifecycle frame
  // arrives for an expanded item, we invalidate the module-level timeline
  // cache AND bump this counter. FeatureBoard watches the map and drops its
  // render-mirror for any itemId whose count increased, which re-fires the
  // existing lazy fetch effect. The setState identity change (new Map) is
  // what React uses to diff; individual count values are signals, not data.
  const [timelineInvalidations, setTimelineInvalidations] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const bumpTimelineInvalidation = useCallback((itemId: string) => {
    setTimelineInvalidations((prev) => {
      const next = new Map(prev);
      next.set(itemId, (prev.get(itemId) ?? 0) + 1);
      return next;
    });
  }, []);
  // Track whether the snapshot has arrived so the timeout ref can be cleared.
  const snapshotArrivedRef = useRef(false);

  // History tab state — tab and past sessions for the currently selected item.
  const [streamTab, setStreamTab] = useState<'live' | 'history' | 'prepost'>('live');
  const [itemSessions, setItemSessions] = useState<ItemTimelineSessionRow[]>([]);
  // When the user clicks a session row inside an item's inline timeline
  // (FeatureBoard), we switch the right pane to History and seed HistoryPane's
  // selection. Cleared when the user deselects or changes item.
  const [pendingHistorySessionId, setPendingHistorySessionId] = useState<string | null>(null);
  // F4: when the user clicks a prepost row with a captured output, the right
  // pane flips to a dedicated PrepostOutputPane for that row. Cleared on
  // item deselection / change.
  const [prepostSelection, setPrepostSelection] = useState<
    | {
        itemId: string;
        prepostId: string;
        stream: 'stdout' | 'stderr';
        commandName: string;
      }
    | null
  >(null);

  // Sync attention count whenever pendingAttention changes — covers snapshot,
  // workflow.update patches, and real-time notice frame additions.
  // This is the single call site for setAttentionCount (except cleanup on unmount).
  const pendingAttentionArr = state.snapshot?.pendingAttention;
  useEffect(() => {
    setAttentionCount(pendingAttentionArr?.length ?? 0);
  }, [pendingAttentionArr]);

  // Phase 5: keep the activeSession ref in sync with state for use inside
  // WS handlers. session.ended needs sessionId → itemId reverse lookup, and
  // doing it from a ref avoids tying the WS subscription effect to state.
  useEffect(() => {
    itemActiveSessionRef.current = state.itemActiveSession;
  }, [state.itemActiveSession]);

  // sendControl wrapper so ControlMatrix doesn't import the WS module directly.
  // 'retry' uses POST /api/workflows/:id/retry — the WS control executor only
  // handles 'cancel', so sending a WS frame for retry would get invalid_action.
  const sendControl = useCallback(
    (action: ControlPayload['action'], opts: Omit<ControlPayload, 'action'>): string => {
      if (action === 'retry') {
        void fetch(
          `/api/workflows/${encodeURIComponent(opts.workflowId)}/retry`,
          { method: 'POST' },
        ).catch(() => {});
        return '';
      }
      return getClient().sendControl(action, opts);
    },
    [],
  );

  // Graph store snapshot — consumed by the Graph tab and by the
  // session-node → item-id resolver below. Read even on the List tab; the
  // hook is cheap (no render unless the workflow's graph actually changes).
  const workflowGraph = useWorkflowGraph(workflowId);

  const handleGraphSelectSession = useCallback(
    (session: SessionGraphNode) => {
      const phase = workflowGraph?.nodes.find(
        (n): n is PhaseGraphNode => n.kind === 'phase' && n.id === session.phaseNodeId,
      );
      const itemId = phase?.itemId ?? null;
      if (itemId) setSelectedItemId(itemId);
      setSelectedGraphNode(session);
    },
    [workflowGraph],
  );

  const handleGraphSelectNode = useCallback((node: GraphNode | null) => {
    setSelectedGraphNode(node);
    if (!node) setSelectedItemId(null);
  }, []);

  // Subscribe to the render store so Task tool_use blocks can be detected within
  // one frame of arrival — no polling (RC-1, r3-03).
  // _activeSessionId is derived from current state before any early return so
  // this hook is always called unconditionally (React hooks rule).
  const _activeSessionId =
    selectedItemId && state.itemActiveSession.has(selectedItemId)
      ? state.itemActiveSession.get(selectedItemId)!.sessionId
      : null;
  const activeSessionBlocks = useSyncExternalStore(
    subscribeRenderStore,
    () =>
      _activeSessionId ? getSessionBlocksSnapshot(_activeSessionId) : EMPTY_RENDER_BLOCKS,
  );

  // If no snapshot arrives within 8 s, treat the workflow ID as invalid.
  useEffect(() => {
    if (!workflowId) return;
    snapshotArrivedRef.current = false;
    setNotFound(false);
    const t = setTimeout(() => {
      if (!snapshotArrivedRef.current) setNotFound(true);
    }, 8_000);
    return () => clearTimeout(t);
  }, [workflowId]);

  useEffect(() => {
    if (!workflowId) return;
    // Synchronously clear stale state before the new snapshot arrives.
    setState({
      snapshot: null,
      items: new Map(),
      itemActiveSession: new Map(),
      itemEndedSession: new Map(),
    });
    setSelectedItemId(null);
    setSelectedGraphNode(null);
    const client = getClient();
    client.subscribe(workflowId);

    const offs: Array<() => void> = [];

    offs.push(
      client.on('workflow.snapshot', (frame: ServerFrame) => {
        const p = frame.payload as WorkflowSnapshotPayload;
        if (p.workflow.id !== workflowId) return;
        snapshotArrivedRef.current = true;
        const items = new Map<string, ItemProjection>();
        for (const item of p.items) items.set(item.id, item);
        setState({
          snapshot: p,
          items,
          itemActiveSession: buildFromSnapshot(p.activeSessions),
          itemEndedSession: new Map(),
        });
        // Pick up the optional `graph` field into the graph store. Always call
        // — dispatchGraphFrame is a no-op when payload.graph is absent.
        dispatchGraphFrame(frame);
      }),
    );

    // Graph view live patches. Scoped to the currently subscribed workflow; the
    // store also keys on workflowId so cross-talk is impossible.
    offs.push(
      client.on('graph.update', (frame: ServerFrame) => {
        if (frame.workflowId !== workflowId) return;
        dispatchGraphFrame(frame);
      }),
    );

    offs.push(
      client.on('workflow.update', (frame: ServerFrame) => {
        if (frame.workflowId !== workflowId) return;
        const patch = frame.payload as Partial<WorkflowSnapshotPayload['workflow']> & {
          recoveryState?: WorkflowSnapshotPayload['workflow']['recoveryState'];
          githubState?: WorkflowSnapshotPayload['workflow']['githubState'];
          pendingAttention?: WorkflowSnapshotPayload['pendingAttention'];
          retried?: boolean;
          seeded?: boolean;
        };
        // After user_retry or per-item seeding the server broadcasts {retried:true}
        // or {seeded:true}. Cycle the subscription so the server re-sends a
        // workflow.snapshot with the updated item list (subscribe() deduplicates,
        // so unsubscribe first).
        if (patch.retried || patch.seeded) {
          client.unsubscribe(workflowId);
          client.subscribe(workflowId);
          return;
        }
        setState((prev) => {
          if (!prev.snapshot) return prev;
          return {
            ...prev,
            snapshot: {
              ...prev.snapshot,
              workflow: { ...prev.snapshot.workflow, ...patch },
              pendingAttention:
                patch.pendingAttention !== undefined
                  ? patch.pendingAttention
                  : prev.snapshot.pendingAttention,
            },
          };
        });
      }),
    );

    // notice frames with severity requires_attention and a persistedAttentionId
    // add items to the pending attention list in real-time (RC-4: no polling).
    offs.push(
      client.on('notice', (frame: ServerFrame) => {
        const p = frame.payload as NoticePayload;
        if (p.severity !== 'requires_attention' || !p.persistedAttentionId) return;
        const newItem: PendingAttention = {
          id: p.persistedAttentionId,
          kind: p.kind,
          payload: p.message,
          createdAt: frame.ts,
        };
        setState((prev) => {
          if (!prev.snapshot) return prev;
          const existingIdx = prev.snapshot.pendingAttention.findIndex((a) => a.id === newItem.id);
          if (existingIdx !== -1) {
            const updated = [...prev.snapshot.pendingAttention];
            updated[existingIdx] = { ...updated[existingIdx]!, payload: newItem.payload };
            return { ...prev, snapshot: { ...prev.snapshot, pendingAttention: updated } };
          }
          return {
            ...prev,
            snapshot: {
              ...prev.snapshot,
              pendingAttention: [...prev.snapshot.pendingAttention, newItem],
            },
          };
        });
      }),
    );

    offs.push(
      client.on('item.state', (frame: ServerFrame) => {
        const p = frame.payload as ItemStatePayload;
        invalidateItemData(p.itemId);
        setState((prev) => {
          const existing = prev.items.get(p.itemId);
          if (!existing) return prev;
          const next = new Map(prev.items);
          next.set(p.itemId, {
            ...existing,
            state: { ...existing.state, ...p.state },
          });
          return { ...prev, items: next };
        });
      }),
    );

    offs.push(
      client.on('session.started', (frame: ServerFrame) => {
        const p = frame.payload as SessionStartedPayload;
        if (p.itemId) {
          const session: ActiveSession = {
            sessionId: p.sessionId,
            phase: p.phase,
            startedAt: p.startedAt,
          };
          setState((prev) => {
            const endedMap = new Map(prev.itemEndedSession);
            endedMap.delete(p.itemId!);
            return {
              ...prev,
              itemActiveSession: upsert(prev.itemActiveSession, p.itemId!, session),
              itemEndedSession: endedMap,
            };
          });
          // Phase 5: if the item is currently expanded in the board, drop its
          // cached timeline entry so the inline list reflects the new session.
          // Collapsed items are untouched — we do not prefetch.
          if (expandedItemsRef.current.has(p.itemId)) {
            invalidateItemTimeline(workflowId, p.itemId);
            bumpTimelineInvalidation(p.itemId);
          }
        }
        dispatch(frame);
      }),
    );

    offs.push(
      client.on('session.ended', (frame: ServerFrame) => {
        const p = frame.payload as SessionEndedPayload;
        // Phase 5: session.ended carries only sessionId. We recover the
        // itemId from the live itemActiveSession map via the ref snapshot
        // BEFORE setState mutates it, so the invalidation sees the correct
        // item even if the updater runs twice under strict mode.
        const currentActive = itemActiveSessionRef.current;
        let endedItemId: string | null = null;
        for (const [itemId, sess] of currentActive) {
          if (sess.sessionId === p.sessionId) {
            endedItemId = itemId;
            break;
          }
        }
        setState((prev) => {
          const { map, clearedItemId } = removeBySessionId(prev.itemActiveSession, p.sessionId);
          const endedMap =
            clearedItemId !== null
              ? new Map([...prev.itemEndedSession, [clearedItemId, p.sessionId]])
              : prev.itemEndedSession;
          return { ...prev, itemActiveSession: map, itemEndedSession: endedMap };
        });
        if (endedItemId !== null && expandedItemsRef.current.has(endedItemId)) {
          invalidateItemTimeline(workflowId, endedItemId);
          bumpTimelineInvalidation(endedItemId);
        }
        dispatch(frame);
      }),
    );

    // Text/thinking deltas — rAF-batched to prevent per-character re-renders.
    offs.push(client.on('stream.text', dispatchTextDelta));
    offs.push(client.on('stream.thinking', dispatchTextDelta));

    // prepost.command.* frames share the rAF queue with stream.text so that
    // chronological order is preserved when a hook fires between text deltas
    // (AC-8 / RC-2). All three prepost types join the same flush batch.
    offs.push(client.on('prepost.command.started', dispatchTextDelta));
    offs.push(client.on('prepost.command.output', dispatchTextDelta));
    offs.push(client.on('prepost.command.ended', dispatchTextDelta));

    // All other stream frames — immediate dispatch.
    for (const t of [
      'stream.tool_use',
      'stream.tool_result',
      'stream.usage',
      'stream.system_notice',
      'stage.started',
      'stage.complete',
    ] as const) {
      offs.push(client.on(t, dispatch));
    }

    return () => {
      client.unsubscribe(workflowId);
      for (const off of offs) off();
      reset();
      clearItemDataCache();
      setAttentionCount(0);
    };
  }, [workflowId]);

  // Fetch past sessions for the selected item whenever it changes.
  // Reset to Live tab and clear sessions when item is deselected.
  // Auto-switch to History tab if the item has past sessions but no active session.
  useEffect(() => {
    if (!selectedItemId || !workflowId) {
      setItemSessions([]);
      setStreamTab('live');
      setPendingHistorySessionId(null);
      setPrepostSelection(null);
      return;
    }
    // Don't stomp a pending timeline-session-click that just set the tab to
    // history and provided an initialSessionId. If pendingHistorySessionId
    // is set for THIS item the flow is: FeatureBoard → setSelectedItemId +
    // setStreamTab('history') + setPendingHistorySessionId, all in one click.
    // Same exemption for a pending prepost selection on this item.
    const prepostActive =
      prepostSelection !== null && prepostSelection.itemId === selectedItemId;
    if (!pendingHistorySessionId && !prepostActive) setStreamTab('live');
    // Pull from the shared timelineCache so the inline list expansion and the
    // History tab share one fetch per item. The /timeline response carries
    // every field HistoryPane needs — filter to `kind === 'session'` and
    // reverse to preserve the legacy DESC (newest-first) list order.
    void fetchItemTimeline(workflowId, selectedItemId)
      .then((rows) => {
        const sessions = (rows ?? [])
          .filter((r): r is ItemTimelineSessionRow => r.kind === 'session')
          .slice()
          .reverse();
        setItemSessions(sessions);
        // Auto-switch to History when the item has past sessions but no active
        // or recently-ended session in view — unless the user just clicked a
        // prepost row (which sets streamTab='prepost' synchronously; stomping
        // it here loses the F4 captured-output view).
        setState((prev) => {
          const prepostOnThisItem =
            prepostSelection !== null && prepostSelection.itemId === selectedItemId;
          if (
            !prepostOnThisItem &&
            sessions.length > 0 &&
            !prev.itemActiveSession.has(selectedItemId) &&
            !prev.itemEndedSession.has(selectedItemId)
          ) {
            setStreamTab('history');
          }
          return prev;
        });
      })
      .catch(() => setItemSessions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItemId]);

  // Deep-link: /workflow/:id/item/:itemId pre-selects the item.
  // FeatureBoard's useLayoutEffect calls onSelectItem(deepLinkedItemId) after
  // the snapshot loads so selectedItemId is set automatically; no extra logic
  // needed here.

  const { snapshot, items, itemActiveSession, itemEndedSession } = state;

  if (!snapshot) {
    if (notFound) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 text-gray-400">
          <div className="text-lg font-semibold text-gray-300">Workflow not found</div>
          <div className="text-sm text-gray-500">
            The workflow ID <code className="font-mono text-gray-400">{workflowId}</code> does not
            exist or has been deleted.
          </div>
          <Link
            to="/"
            className="text-sm text-blue-400 hover:text-blue-300 underline underline-offset-2"
          >
            ← Back to workflow list
          </Link>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400">
        <div className="text-sm">Connecting to workflow…</div>
      </div>
    );
  }

  // Derive the active session for the currently selected item.
  const activeSession: ActiveSession | null =
    selectedItemId ? itemActiveSession.get(selectedItemId) ?? null : null;
  // If the selected item's session just ended, show frozen frames + "Session ended".
  const endedSessionId: string | null =
    selectedItemId ? itemEndedSession.get(selectedItemId) ?? null : null;

  // For workflow-level controls (cancel, pause, resume, inject-context) we need
  // a session ID even when no per-item session is selected.  The itemActiveSession
  // map only holds sessions that carry itemId; workflow-level sessions (no itemId)
  // fall through.  Fall back to the first session from the raw snapshot list so
  // ControlMatrix renders for workflow-scoped actions.
  const controlSession: { sessionId: string } | null =
    activeSession ??
    (snapshot.activeSessions[0]
      ? { sessionId: snapshot.activeSessions[0].sessionId }
      : null);

  // RC-2: explicit config override (phases[name].ui.renderer) takes precedence;
  // absent until the server projects it, so autodetection always runs for now.
  const useReviewPanel = shouldUseReviewPanel(activeSessionBlocks);
  // Show tab bar when an item is selected or any per-item session is active.
  const showTabBar = !!(selectedItemId || itemActiveSession.size > 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Banners — stack order: CrashRecovery → Paused → Attention */}
      {snapshot.workflow.recoveryState && (
        <CrashRecoveryBanner
          workflowId={workflowId!}
          recoveryState={snapshot.workflow.recoveryState}
          sendControl={sendControl}
        />
      )}
      {snapshot.workflow.pausedAt && (
        <PausedBanner
          workflowId={workflowId!}
          pausedAt={snapshot.workflow.pausedAt}
        />
      )}
      {snapshot.pendingAttention.length > 0 && (
        <AttentionBanner
          workflowId={workflowId!}
          items={snapshot.pendingAttention}
          deepLinkedAttentionId={initialAttentionIdRef.current}
        />
      )}

      {/* Workflow header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-700 shrink-0 bg-gray-850">
        <button
          onClick={() => navigate('/')}
          className="text-gray-500 hover:text-gray-300 text-xs"
          aria-label="Back to workflow list"
        >
          ←
        </button>
        <h1 className="text-sm font-semibold text-gray-100 truncate flex-1">
          {snapshot.workflow.name}
        </h1>
        <span
          className={`text-xs px-2 py-0.5 rounded font-medium ${workflowStatusClass(snapshot.workflow.status)}`}
        >
          {snapshot.workflow.status}
        </span>
        <GithubButton
          workflowId={workflowId!}
          workflowStatus={snapshot.workflow.status}
          githubState={snapshot.workflow.githubState ?? null}
        />
      </div>

      {/* List / Graph view tabs (URL-synced via ?view=graph) */}
      <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-gray-700 bg-gray-900">
        <button
          onClick={() => setView('list')}
          data-testid="view-tab-list"
          className={`text-xs px-3 py-1 rounded font-medium transition-colors ${
            activeView === 'list'
              ? 'bg-gray-700 text-gray-100'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          List
        </button>
        <button
          onClick={() => setView('graph')}
          data-testid="view-tab-graph"
          className={`text-xs px-3 py-1 rounded font-medium transition-colors ${
            activeView === 'graph'
              ? 'bg-gray-700 text-gray-100'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          Graph
        </button>
      </div>

      {/* Main body: either the existing list (board + stream) or the graph view. */}
      {activeView === 'graph' ? (
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-w-0">
            <Suspense fallback={<div className="p-4 text-sm text-zinc-400">Loading graph…</div>}>
              <GraphPane
                workflowId={workflowId!}
                onSelectSession={handleGraphSelectSession}
                onSelectGraphNode={handleGraphSelectNode}
                selectedGraphNodeId={selectedGraphNode?.id ?? null}
              />
            </Suspense>
          </div>
          {selectedGraphNode && workflowGraph && (
            <div className="w-96 shrink-0 border-l border-gray-700 overflow-hidden flex flex-col">
              {selectedGraphNode.kind === 'session' ? (
                <LiveStreamPane
                  sessionId={selectedGraphNode.sessionId}
                  workflowId={workflowId!}
                />
              ) : (
                <NodeSummaryPanel
                  node={selectedGraphNode}
                  graph={workflowGraph}
                  workflowId={workflowId!}
                />
              )}
            </div>
          )}
        </div>
      ) : (
      <div className="flex flex-1 min-h-0">
        {/* Feature board */}
        <div className="w-80 shrink-0 border-r border-gray-700 overflow-hidden flex flex-col">
          <FeatureBoard
            workflowId={workflowId!}
            stages={snapshot.stages}
            items={Array.from(items.values())}
            activeSessionId={activeSession?.sessionId ?? null}
            selectedItemId={selectedItemId}
            onSelectItem={(itemId) => {
              // Plain card click clears any pending timeline-session-click so
              // HistoryPane doesn't try to preselect a stale session from a
              // different item's inline timeline. Same for prepost selection.
              setPendingHistorySessionId(null);
              setPrepostSelection(null);
              setSelectedItemId(itemId);
            }}
            onSelectTimelineSession={(itemId, sessionId) => {
              // Sequence matters: set selection first so the sessions-fetch
              // effect runs for the right item, then flip to history and seed
              // the initial-session id HistoryPane will honour on mount.
              setSelectedItemId(itemId);
              setPendingHistorySessionId(sessionId);
              setPrepostSelection(null);
              setStreamTab('history');
            }}
            onSelectTimelinePrepost={(itemId, sel) => {
              // F4: user clicked a captured-output prepost row. Flip the
              // right pane to the PrepostOutputPane. The selection key is
              // { itemId, prepostId, stream } so re-clicking the same row
              // is a no-op (PrepostOutputPane caches by prepostId:stream).
              setSelectedItemId(itemId);
              setPendingHistorySessionId(null);
              setPrepostSelection({ itemId, ...sel });
              setStreamTab('prepost');
            }}
            timelineInvalidations={timelineInvalidations}
            onExpandedChange={(expanded) => {
              expandedItemsRef.current = expanded;
            }}
          />
        </div>

        {/* Stream pane */}
        <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
          {/* Live / History tab bar */}
          {showTabBar && (
            <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-gray-700 bg-gray-900">
              <button
                onClick={() => setStreamTab('live')}
                data-testid="tab-live"
                className={`text-xs px-3 py-1 rounded font-medium transition-colors ${
                  streamTab === 'live'
                    ? 'bg-gray-700 text-gray-100'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                Live
              </button>
              <button
                onClick={() => setStreamTab('history')}
                disabled={itemSessions.length === 0}
                data-testid="tab-history"
                className={`text-xs px-3 py-1 rounded font-medium transition-colors ${
                  streamTab === 'history'
                    ? 'bg-gray-700 text-gray-100'
                    : itemSessions.length === 0
                    ? 'text-gray-600 cursor-default'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                History{itemSessions.length > 0 ? ` (${itemSessions.length})` : ''}
              </button>
            </div>
          )}

          {streamTab === 'prepost' &&
          selectedItemId &&
          prepostSelection &&
          prepostSelection.itemId === selectedItemId ? (
            /* F4: captured prepost stdout/stderr viewer. */
            <div className="flex-1 min-h-0 overflow-hidden">
              <PrepostOutputPane
                workflowId={workflowId!}
                itemId={selectedItemId}
                prepostId={prepostSelection.prepostId}
                stream={prepostSelection.stream}
                commandName={prepostSelection.commandName}
              />
            </div>
          ) : streamTab === 'history' && selectedItemId ? (
            /* History pane — live WS subscription stays intact */
            <div className="flex-1 min-h-0 overflow-hidden">
              <HistoryPane
                itemId={selectedItemId}
                workflowId={workflowId!}
                sessions={itemSessions}
                initialSessionId={pendingHistorySessionId}
              />
            </div>
          ) : controlSession ? (
            <>
              {/* Control matrix toolbar */}
              <div className="shrink-0 border-b border-gray-700 px-3 py-1.5">
                <ControlMatrix
                  workflowId={workflowId!}
                  workflowStatus={snapshot.workflow.status}
                  stages={snapshot.stages}
                  items={Array.from(items.values())}
                  selectedItem={
                    selectedItemId ? items.get(selectedItemId) ?? null : null
                  }
                  activeSessionId={controlSession.sessionId}
                  sendControl={sendControl}
                />
              </div>

              {/* Stream output — scoped to the per-item session when one exists,
                  or to the workflow-level session when no item is selected */}
              <div className="flex-1 min-h-0">
                {activeSession ? (
                  useReviewPanel ? (
                    <ReviewPanel sessionId={activeSession.sessionId} phase={activeSession.phase} />
                  ) : (
                    <LiveStreamPane sessionId={activeSession.sessionId} workflowId={workflowId!} />
                  )
                ) : endedSessionId ? (
                  <div className="flex flex-col h-full">
                    <div
                      data-testid="session-ended-banner"
                      className="shrink-0 px-3 py-1.5 bg-amber-900/20 border-b border-amber-700/30 text-xs text-amber-300"
                    >
                      Session ended
                    </div>
                    <div className="flex-1 min-h-0">
                      <LiveStreamPane sessionId={endedSessionId} workflowId={workflowId!} />
                    </div>
                  </div>
                ) : !selectedItemId ? (
                  <LiveStreamPane sessionId={controlSession!.sessionId} workflowId={workflowId!} />
                ) : null}
              </div>
            </>
          ) : endedSessionId ? (
            /* Frozen pane: session ended, show last frames with a banner */
            <div className="flex flex-col flex-1 min-h-0">
              <div
                data-testid="session-ended-banner"
                className="shrink-0 px-3 py-1.5 bg-amber-900/20 border-b border-amber-700/30 text-xs text-amber-300"
              >
                Session ended
              </div>
              <div className="flex-1 min-h-0">
                <LiveStreamPane sessionId={endedSessionId} workflowId={workflowId!} />
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              {selectedItemId ? 'No active session' : 'Select an item to view its session'}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function workflowStatusClass(status: string): string {
  switch (status) {
    case 'in_progress':
    case 'active':
      return 'bg-blue-500/20 text-blue-300';
    case 'paused':
      return 'bg-yellow-500/20 text-yellow-300';
    case 'complete':
      return 'bg-green-500/20 text-green-300';
    case 'failed':
      return 'bg-red-500/20 text-red-300';
    default:
      return 'bg-gray-500/20 text-gray-400';
  }
}
