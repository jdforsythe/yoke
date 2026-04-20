/**
 * AttentionBanner — stacked list of pending attention items.
 *
 * Items arrive via notice frames (handled in WorkflowDetailRoute) and are
 * cleared when the server sends a workflow.update removing them from
 * pendingAttention. Acknowledgement uses POST /api/workflows/:id/attention/:aid/ack.
 *
 * For retryable kinds the button is labelled 'Resume': ack fires first,
 * then a fire-and-forget POST /api/workflows/:id/retry unblocks the item.
 * For non-retryable kinds the button is labelled 'Dismiss'.
 *
 * Optimistic removal: item is hidden on ack success (not retry success).
 * Retry returning none_awaiting is silently ignored.
 *
 * Renders below CrashRecoveryBanner via layout order (no z-index tricks).
 */

import { useState, useEffect, useRef } from 'react';
import type { PendingAttention } from '@/ws/types';
export { RETRYABLE_KINDS } from './attentionKinds.js';
import { RETRYABLE_KINDS } from './attentionKinds.js';

interface Props {
  workflowId: string;
  items: PendingAttention[];
  /** Attention ID from ?attention=<id> deep link, captured by WorkflowDetailRoute
   *  before WorkflowList's setSearchParams effect clears the URL param. */
  deepLinkedAttentionId?: string | null;
}

export function AttentionBanner({ workflowId, items, deepLinkedAttentionId }: Props) {
  // optimisticHidden: IDs removed from display after POST succeeded.
  const [optimisticHidden, setOptimisticHidden] = useState<Set<number>>(new Set());
  // pendingAck: IDs where ack POST is in-flight — shows spinner + disables button.
  const [pendingAck, setPendingAck] = useState<Set<number>>(new Set());
  // highlightedIds: IDs currently showing the 2s pulse animation (React-controlled).
  const [highlightedIds, setHighlightedIds] = useState<Set<number>>(new Set());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Deep-link: ?attention=<id> highlights the specific item on mount.
  // The ID is passed as a prop from WorkflowDetailRoute (captured there before
  // WorkflowList's setSearchParams clears it from the URL).
  const deepLinkRef = useRef(deepLinkedAttentionId ?? null);
  const deepLinkProcessed = useRef(false);

  useEffect(() => {
    const rawId = deepLinkRef.current;
    if (!rawId || deepLinkProcessed.current) return;
    deepLinkProcessed.current = true;

    const numId = Number(rawId);

    const el = document.getElementById(`attention-item-${numId}`);
    if (!el) return;

    el.scrollIntoView({ block: 'center' });
    setHighlightedIds((prev) => new Set([...prev, numId]));

    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedIds((prev) => {
        const n = new Set(prev);
        n.delete(numId);
        return n;
      });
      highlightTimerRef.current = null;
    }, 2000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = items
    .filter((item) => !optimisticHidden.has(item.id))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (visible.length === 0) return null;

  async function handleClick(item: PendingAttention) {
    const isRetryable = RETRYABLE_KINDS.has(item.kind);
    setPendingAck((prev) => new Set([...prev, item.id]));
    try {
      const ackRes = await fetch(
        `/api/workflows/${encodeURIComponent(workflowId)}/attention/${item.id}/ack`,
        { method: 'POST' },
      );
      if (!ackRes.ok) return; // ack failed — skip retry, item stays visible

      // Optimistic removal on ack success (not retry success).
      setOptimisticHidden((prev) => new Set([...prev, item.id]));

      if (isRetryable) {
        // Fire-and-forget: none_awaiting and other non-2xx responses are ignored.
        void fetch(`/api/workflows/${encodeURIComponent(workflowId)}/retry`, {
          method: 'POST',
        });
      }
    } catch {
      // Network failure — spinner removed, item stays visible.
    } finally {
      setPendingAck((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  }

  return (
    <div
      role="region"
      aria-label="Attention required"
      className="shrink-0 border-b border-amber-800/50"
    >
      {visible.map((item) => {
        const isRetryable = RETRYABLE_KINDS.has(item.kind);
        const isPending = pendingAck.has(item.id);
        const label = isPending
          ? isRetryable ? 'Resuming…' : 'Dismissing…'
          : isRetryable ? 'Resume' : 'Dismiss';
        return (
          <div
            key={item.id}
            id={`attention-item-${item.id}`}
            data-highlight={highlightedIds.has(item.id) ? 'true' : 'false'}
            className="flex items-start gap-3 px-4 py-2.5 bg-amber-950/40 border-b border-amber-900/30 last:border-b-0 data-[highlight=true]:animate-pulse"
          >
            <span className="text-amber-400 shrink-0" aria-hidden>
              🔔
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-amber-200">{item.kind}</p>
              {item.payload !== null && item.payload !== undefined && (
                <p className="text-xs text-amber-300/70 mt-0.5 truncate">
                  {typeof item.payload === 'string'
                    ? item.payload
                    : JSON.stringify(item.payload)}
                </p>
              )}
              <p className="text-[10px] text-amber-500 mt-0.5">
                {new Date(item.createdAt).toLocaleString()}
              </p>
            </div>
            <button
              onClick={() => void handleClick(item)}
              disabled={isPending}
              className="shrink-0 px-2.5 py-1 text-xs font-medium bg-amber-700 hover:bg-amber-600 disabled:opacity-60 disabled:cursor-not-allowed text-white rounded transition-colors"
            >
              {label}
            </button>
          </div>
        );
      })}
    </div>
  );
}
