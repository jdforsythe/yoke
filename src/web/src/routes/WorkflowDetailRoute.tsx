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
 *   - ControlMatrix (available manual actions)
 */

import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getClient } from '@/ws/client';
import { dispatch, dispatchTextDelta, reset } from '@/store/renderStore';
import { CrashRecoveryBanner } from '@/components/CrashRecoveryBanner/CrashRecoveryBanner';
import { AttentionBanner } from '@/components/AttentionBanner/AttentionBanner';
import { GithubButton } from '@/components/GithubButton/GithubButton';
import { FeatureBoard, invalidateItemData, clearItemDataCache } from '@/components/FeatureBoard/FeatureBoard';
import { LiveStreamPane } from '@/components/LiveStream/LiveStreamPane';
import { ReviewPanel } from '@/components/ReviewPanel/ReviewPanel';
import { ControlMatrix } from '@/components/ControlMatrix/ControlMatrix';
import type {
  WorkflowSnapshotPayload,
  ItemStatePayload,
  ItemProjection,
  SessionStartedPayload,
  ServerFrame,
  ControlPayload,
} from '@/ws/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkflowDetailState {
  snapshot: WorkflowSnapshotPayload | null;
  items: Map<string, ItemProjection>;
  activeSessionId: string | null;
  activeSessionPhase: string | null;
}

// ---------------------------------------------------------------------------
// Route component
// ---------------------------------------------------------------------------

export function WorkflowDetailRoute() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const navigate = useNavigate();

  const [state, setState] = useState<WorkflowDetailState>({
    snapshot: null,
    items: new Map(),
    activeSessionId: null,
    activeSessionPhase: null,
  });

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  // sendControl wrapper so ControlMatrix doesn't import the WS module directly.
  const sendControl = useCallback(
    (action: ControlPayload['action'], opts: Omit<ControlPayload, 'action'>) =>
      getClient().sendControl(action, opts),
    [],
  );

  useEffect(() => {
    if (!workflowId) return;
    const client = getClient();
    client.subscribe(workflowId);

    const offs: Array<() => void> = [];

    offs.push(
      client.on('workflow.snapshot', (frame: ServerFrame) => {
        const p = frame.payload as WorkflowSnapshotPayload;
        if (p.workflow.id !== workflowId) return;
        const items = new Map<string, ItemProjection>();
        for (const item of p.items) items.set(item.id, item);
        const lastSession =
          p.activeSessions.length > 0
            ? p.activeSessions[p.activeSessions.length - 1]!
            : null;
        setState({
          snapshot: p,
          items,
          activeSessionId: lastSession?.sessionId ?? null,
          activeSessionPhase: lastSession?.phase ?? null,
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
        };
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

    offs.push(
      client.on('item.state', (frame: ServerFrame) => {
        const p = frame.payload as ItemStatePayload;
        // Invalidate item.data cache so re-selecting the item fetches fresh data.
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
        setState((prev) => ({
          ...prev,
          activeSessionId: p.sessionId,
          activeSessionPhase: p.phase,
        }));
        dispatch(frame);
      }),
    );

    offs.push(
      client.on('session.ended', (frame: ServerFrame) => {
        dispatch(frame);
      }),
    );

    // Text/thinking deltas — rAF-batched to prevent per-character re-renders.
    offs.push(client.on('stream.text', dispatchTextDelta));
    offs.push(client.on('stream.thinking', dispatchTextDelta));

    // prepost.command.output chunks are rAF-batched (same 16ms flush as text
    // deltas) to prevent per-chunk re-renders — satisfies feat-prepost RC-2 / AC-5.
    offs.push(client.on('prepost.command.output', dispatchTextDelta));

    // All other stream frames — immediate dispatch.
    for (const t of [
      'stream.tool_use',
      'stream.tool_result',
      'stream.usage',
      'stream.system_notice',
      'prepost.command.started',
      'prepost.command.ended',
      'stage.started',
      'stage.complete',
    ] as const) {
      offs.push(client.on(t, dispatch));
    }

    return () => {
      client.unsubscribe(workflowId);
      for (const off of offs) off();
      reset();
      // Clear item.data cache on navigation so stale data never shows if the
      // user returns to this workflow before any item.state frames arrive.
      clearItemDataCache();
    };
  }, [workflowId]);

  // Deep-link: ?attention=<id> → scroll to attention banner (handled by
  // AttentionBanner on mount via URL search param reading).

  const { snapshot, items, activeSessionId, activeSessionPhase } = state;

  if (!snapshot) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400">
        <div className="text-sm">Connecting to workflow…</div>
      </div>
    );
  }

  const isReviewPhase =
    activeSessionPhase === 'review' || activeSessionPhase === 'pre_review';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Banners (layout order guarantees top-of-content placement) */}
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
        <GithubButton githubState={snapshot.workflow.githubState ?? null} />
      </div>

      {/* Main body: board + stream pane side-by-side */}
      <div className="flex flex-1 min-h-0">
        {/* Feature board */}
        <div className="w-80 shrink-0 border-r border-gray-700 overflow-hidden flex flex-col">
          <FeatureBoard
            workflowId={workflowId!}
            stages={snapshot.stages}
            items={Array.from(items.values())}
            activeSessionId={activeSessionId}
            selectedItemId={selectedItemId}
            onSelectItem={setSelectedItemId}
          />
        </div>

        {/* Stream pane */}
        <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
          {activeSessionId ? (
            <>
              {/* Control matrix toolbar */}
              <div className="shrink-0 border-b border-gray-700 px-3 py-1.5">
                <ControlMatrix
                  workflowId={workflowId!}
                  workflowStatus={snapshot.workflow.status}
                  stages={snapshot.stages}
                  selectedItem={
                    selectedItemId ? items.get(selectedItemId) ?? null : null
                  }
                  activeSessionId={activeSessionId}
                  sendControl={sendControl}
                />
              </div>

              {/* Stream output */}
              <div className="flex-1 min-h-0">
                {isReviewPhase ? (
                  <ReviewPanel sessionId={activeSessionId} phase={activeSessionPhase!} />
                ) : (
                  <LiveStreamPane sessionId={activeSessionId} workflowId={workflowId!} />
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              No active session
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
