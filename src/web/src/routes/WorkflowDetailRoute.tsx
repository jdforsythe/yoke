/**
 * WorkflowDetailRoute — renders the full workflow detail view.
 *
 * Subscribes to the workflow on mount, handles all incoming WS frames,
 * and composes the UI from child components:
 *   - CrashRecoveryBanner (when recoveryState is set)
 *   - AttentionBanner (pending attention items)
 *   - GithubButton + workflow header
 *   - FeatureBoard (item cards, grouped by category)
 *   - LiveStreamPane (active session output, virtualized)
 *   - HistoryPane (past session logs for selected item)
 *   - ControlMatrix (available manual actions)
 *
 * r2-04: activeSessionId (global) has been replaced by itemActiveSession
 * Map<itemId, ActiveSession>.  The stream pane is scoped to selectedItemId so
 * parallel per-item sessions never bleed into each other.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { getClient } from '@/ws/client';
import { dispatch, dispatchTextDelta, reset } from '@/store/renderStore';
import { setAttentionCount } from '@/store/attentionStore';
import { buildFromSnapshot, upsert, removeBySessionId } from '@/store/itemSessionMap';
import type { ActiveSession } from '@/store/itemSessionMap';
import { CrashRecoveryBanner } from '@/components/CrashRecoveryBanner/CrashRecoveryBanner';
import { AttentionBanner } from '@/components/AttentionBanner/AttentionBanner';
import { GithubButton } from '@/components/GithubButton/GithubButton';
import { FeatureBoard, invalidateItemData, clearItemDataCache } from '@/components/FeatureBoard/FeatureBoard';
import { LiveStreamPane } from '@/components/LiveStream/LiveStreamPane';
import { HistoryPane, type ItemSession } from '@/components/LiveStream/HistoryPane';
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
  const [searchParams] = useSearchParams();
  // Capture the attention deep-link ID at initial render, before WorkflowList's
  // setSearchParams effect clears it (WorkflowList runs its effect on mount and
  // replaces all URL params with its own filter state, dropping ?attention).
  const initialAttentionIdRef = useRef(searchParams.get('attention'));

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
  const [notFound, setNotFound] = useState(false);
  // Track whether the snapshot has arrived so the timeout ref can be cleared.
  const snapshotArrivedRef = useRef(false);

  // History tab state — tab and past sessions for the currently selected item.
  const [streamTab, setStreamTab] = useState<'live' | 'history'>('live');
  const [itemSessions, setItemSessions] = useState<ItemSession[]>([]);

  // Sync attention count whenever pendingAttention changes — covers snapshot,
  // workflow.update patches, and real-time notice frame additions.
  // This is the single call site for setAttentionCount (except cleanup on unmount).
  const pendingAttentionArr = state.snapshot?.pendingAttention;
  useEffect(() => {
    setAttentionCount(pendingAttentionArr?.length ?? 0);
  }, [pendingAttentionArr]);

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
        };
        // After user_retry the server broadcasts {retried:true}. Cycle the
        // subscription so the server re-sends a workflow.snapshot with updated
        // item states (subscribe() deduplicates, so unsubscribe first).
        if (patch.retried) {
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
          if (prev.snapshot.pendingAttention.some((a) => a.id === newItem.id)) return prev;
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
        }
        dispatch(frame);
      }),
    );

    offs.push(
      client.on('session.ended', (frame: ServerFrame) => {
        const p = frame.payload as SessionEndedPayload;
        setState((prev) => {
          const { map, clearedItemId } = removeBySessionId(prev.itemActiveSession, p.sessionId);
          const endedMap =
            clearedItemId !== null
              ? new Map([...prev.itemEndedSession, [clearedItemId, p.sessionId]])
              : prev.itemEndedSession;
          return { ...prev, itemActiveSession: map, itemEndedSession: endedMap };
        });
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
    if (!selectedItemId) {
      setItemSessions([]);
      setStreamTab('live');
      return;
    }
    setStreamTab('live');
    void fetch(`/api/items/${encodeURIComponent(selectedItemId)}/sessions`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { sessions?: ItemSession[] }) => {
        const sessions = d.sessions ?? [];
        setItemSessions(sessions);
        // Auto-switch to History when the item has past sessions but no active
        // or recently-ended session in view.
        setState((prev) => {
          if (
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

  const isReviewPhase =
    activeSession?.phase === 'review' || activeSession?.phase === 'pre_review';
  // Show tab bar when an item is selected or any per-item session is active.
  const showTabBar = !!(selectedItemId || itemActiveSession.size > 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Banners */}
      {snapshot.workflow.recoveryState && (
        <CrashRecoveryBanner
          workflowId={workflowId!}
          recoveryState={snapshot.workflow.recoveryState}
          sendControl={sendControl}
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

      {/* Main body: board + stream pane side-by-side */}
      <div className="flex flex-1 min-h-0">
        {/* Feature board */}
        <div className="w-80 shrink-0 border-r border-gray-700 overflow-hidden flex flex-col">
          <FeatureBoard
            workflowId={workflowId!}
            stages={snapshot.stages}
            items={Array.from(items.values())}
            activeSessionId={activeSession?.sessionId ?? null}
            selectedItemId={selectedItemId}
            onSelectItem={setSelectedItemId}
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

          {streamTab === 'history' && selectedItemId ? (
            /* History pane — live WS subscription stays intact */
            <div className="flex-1 min-h-0 overflow-hidden">
              <HistoryPane
                itemId={selectedItemId}
                workflowId={workflowId!}
                sessions={itemSessions}
              />
            </div>
          ) : activeSession ? (
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
                  activeSessionId={activeSession.sessionId}
                  sendControl={sendControl}
                />
              </div>

              {/* Stream output */}
              <div className="flex-1 min-h-0">
                {isReviewPhase ? (
                  <ReviewPanel sessionId={activeSession.sessionId} phase={activeSession.phase} />
                ) : (
                  <LiveStreamPane sessionId={activeSession.sessionId} workflowId={workflowId!} />
                )}
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
              {selectedItemId ? 'Select an item to view its session' : 'No active session'}
            </div>
          )}
        </div>
      </div>
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
