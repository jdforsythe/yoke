/**
 * AttentionBanner — stacked list of pending attention items.
 *
 * Items arrive via notice frames (handled in WorkflowDetailRoute) and are
 * cleared when the server sends a workflow.update removing them from
 * pendingAttention. Acknowledgement uses POST /api/workflows/:id/attention/:aid/ack.
 *
 * Optimistic removal: item is hidden immediately; if the POST fails it
 * reappears. Badge count in the AppShell bell is kept in sync by the
 * AppShell's own notice listener (separate concern).
 *
 * Renders below CrashRecoveryBanner via layout order (no z-index tricks).
 */

import { useState, useEffect } from 'react';
import type { PendingAttention } from '@/ws/types';
import { useSearchParams } from 'react-router-dom';

interface Props {
  workflowId: string;
  items: PendingAttention[];
}

export function AttentionBanner({ workflowId, items }: Props) {
  // optimisticHidden: IDs we've sent an ack for but server hasn't confirmed yet.
  const [optimisticHidden, setOptimisticHidden] = useState<Set<number>>(new Set());
  const [searchParams, setSearchParams] = useSearchParams();

  // Deep-link: ?attention=<id> highlights the specific item.
  const deepLinkedId = searchParams.get('attention');

  // Consume the attention query param after processing (use history.replaceState).
  useEffect(() => {
    if (!deepLinkedId) return;
    const el = document.getElementById(`attention-item-${deepLinkedId}`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('animate-pulse');
      setTimeout(() => el.classList.remove('animate-pulse'), 2000);
    }
    // Clear the param from the URL without navigation.
    const next = new URLSearchParams(searchParams);
    next.delete('attention');
    setSearchParams(next, { replace: true });
  }, [deepLinkedId, searchParams, setSearchParams]);

  const visible = items
    .filter((item) => !optimisticHidden.has(item.id))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (visible.length === 0) return null;

  async function acknowledge(item: PendingAttention) {
    // Optimistic removal.
    setOptimisticHidden((prev) => new Set([...prev, item.id]));
    try {
      const res = await fetch(
        `/api/workflows/${encodeURIComponent(workflowId)}/attention/${item.id}/ack`,
        { method: 'POST' },
      );
      if (!res.ok) {
        // Revert optimistic removal on failure.
        setOptimisticHidden((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
    } catch {
      // Network failure — revert.
      setOptimisticHidden((prev) => {
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
      {visible.map((item) => (
        <div
          key={item.id}
          id={`attention-item-${item.id}`}
          className="flex items-start gap-3 px-4 py-2.5 bg-amber-950/40 border-b border-amber-900/30 last:border-b-0"
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
            onClick={() => void acknowledge(item)}
            className="shrink-0 px-2.5 py-1 text-xs font-medium bg-amber-700 hover:bg-amber-600 text-white rounded transition-colors"
          >
            Acknowledge
          </button>
        </div>
      ))}
    </div>
  );
}
