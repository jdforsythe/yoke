/**
 * ControlMatrix — available manual-control actions derived from a declarative
 * rules object keyed on {workflowStatus, item?.status, session?}.
 *
 * Invalid actions are hidden (not disabled) per spec.
 * Destructive actions (cancel, skip) require a confirmation dialog.
 * Optimistic state: button shows spinner + disables until server acknowledges
 * via workflow.update or item.state frame.
 *
 * inject-context opens a text-input modal; the entered text is sent as `extra`.
 *
 * The component receives a sendControl callback (no direct WS import) and
 * uses crypto.randomUUID() for commandId generation.
 */

import { useState, useCallback } from 'react';
import type { ControlPayload, ItemProjection, StageProjection } from '@/ws/types';

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface ControlCtx {
  workflowStatus: string;
  selectedItem: ItemProjection | null;
  activeSessionId: string | null;
  activeStage: StageProjection | null;
}

type RuleFn = (ctx: ControlCtx) => boolean;

const RULES: Record<ControlPayload['action'], RuleFn> = {
  pause: (ctx) => ctx.workflowStatus === 'in_progress',
  resume: (ctx) => ctx.workflowStatus === 'paused',
  cancel: (ctx) => !['cancelled', 'complete'].includes(ctx.workflowStatus),
  skip: (ctx) =>
    !!ctx.selectedItem &&
    ['in_progress', 'blocked'].includes(ctx.selectedItem.state.status),
  retry: (ctx) =>
    !!ctx.selectedItem && ctx.selectedItem.state.status === 'failed',
  unblock: (ctx) =>
    !!ctx.selectedItem && ctx.selectedItem.state.status === 'blocked',
  'inject-context': (ctx) => !!ctx.activeSessionId,
  'rerun-phase': (ctx) =>
    !!ctx.selectedItem &&
    ['complete', 'failed'].includes(ctx.selectedItem.state.status),
  'approve-stage': (ctx) =>
    !!ctx.activeStage &&
    ctx.activeStage.needsApproval &&
    ctx.activeStage.status === 'complete',
};

// ---------------------------------------------------------------------------
// Button metadata
// ---------------------------------------------------------------------------

interface ActionMeta {
  label: string;
  destructive?: boolean;
  confirmMessage?: string;
  requiresItemId?: boolean;
  requiresStageId?: boolean;
}

const ACTION_META: Record<ControlPayload['action'], ActionMeta> = {
  pause: { label: 'Pause' },
  resume: { label: 'Resume' },
  cancel: {
    label: 'Cancel',
    destructive: true,
    confirmMessage: 'Cancel this workflow? This cannot be undone.',
  },
  skip: {
    label: 'Skip item',
    destructive: true,
    confirmMessage: 'Skip this item?',
    requiresItemId: true,
  },
  retry: { label: 'Retry', requiresItemId: true },
  unblock: { label: 'Unblock', requiresItemId: true },
  'inject-context': { label: 'Inject context' },
  'rerun-phase': { label: 'Rerun phase', requiresItemId: true },
  'approve-stage': { label: 'Approve stage', requiresStageId: true },
};

// ---------------------------------------------------------------------------
// ControlMatrix
// ---------------------------------------------------------------------------

interface Props {
  workflowId: string;
  workflowStatus: string;
  stages: StageProjection[];
  selectedItem: ItemProjection | null;
  activeSessionId: string | null;
  sendControl: (action: ControlPayload['action'], opts: Omit<ControlPayload, 'action'>) => string;
}

export function ControlMatrix({
  workflowId,
  workflowStatus,
  stages,
  selectedItem,
  activeSessionId,
  sendControl,
}: Props) {
  const [pendingActions, setPendingActions] = useState<Set<ControlPayload['action']>>(new Set());
  const [confirmAction, setConfirmAction] = useState<ControlPayload['action'] | null>(null);
  const [injectModalOpen, setInjectModalOpen] = useState(false);
  const [injectText, setInjectText] = useState('');

  const activeStage = stages.find((s) => s.status === 'in_progress' || s.status === 'complete') ?? null;

  const ctx: ControlCtx = {
    workflowStatus,
    selectedItem,
    activeSessionId,
    activeStage,
  };

  const visibleActions = (Object.entries(RULES) as [ControlPayload['action'], RuleFn][])
    .filter(([, rule]) => rule(ctx))
    .map(([action]) => action);

  const handleAction = useCallback(
    (action: ControlPayload['action'], extraText?: string) => {
      const meta = ACTION_META[action];

      // Destructive actions need confirmation.
      if (meta.destructive && !confirmAction) {
        setConfirmAction(action);
        return;
      }

      const opts: Omit<ControlPayload, 'action'> = { workflowId };
      if (meta.requiresItemId && selectedItem) opts.itemId = selectedItem.id;
      if (meta.requiresStageId && activeStage) opts.stageId = activeStage.id;
      if (extraText) opts.extra = extraText;

      sendControl(action, opts);
      // Track pending state by action name so each button independently shows
      // its spinner (not all buttons disabled when any action is in-flight).
      setPendingActions((prev) => new Set([...prev, action]));

      // Clear optimistic state after 10s regardless (server may not always ack).
      setTimeout(() => {
        setPendingActions((prev) => {
          const next = new Set(prev);
          next.delete(action);
          return next;
        });
      }, 10_000);

      setConfirmAction(null);
    },
    [workflowId, selectedItem, activeStage, sendControl, confirmAction],
  );

  if (visibleActions.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {visibleActions.map((action) => {
        const meta = ACTION_META[action];
        const isPending = pendingActions.has(action);

        if (action === 'inject-context') {
          return (
            <button
              key={action}
              onClick={() => setInjectModalOpen(true)}
              className="px-2.5 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700 transition-colors"
            >
              {meta.label}
            </button>
          );
        }

        return (
          <button
            key={action}
            onClick={() => handleAction(action)}
            disabled={isPending}
            className={[
              'px-2.5 py-1 text-xs rounded border transition-colors',
              meta.destructive
                ? 'border-red-700 text-red-300 hover:bg-red-900/40'
                : 'border-gray-600 text-gray-300 hover:bg-gray-700',
              isPending ? 'opacity-50 cursor-not-allowed' : '',
            ].join(' ')}
          >
            {isPending ? (
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />
                {meta.label}
              </span>
            ) : (
              meta.label
            )}
          </button>
        );
      })}

      {/* Confirmation dialog (for destructive actions) */}
      {confirmAction && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm action"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        >
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-5 max-w-sm w-full mx-4 shadow-xl">
            <p className="text-sm text-gray-100 mb-4">
              {ACTION_META[confirmAction].confirmMessage ?? 'Are you sure?'}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmAction(null)}
                className="px-3 py-1.5 text-xs text-gray-300 border border-gray-600 rounded hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={() => handleAction(confirmAction)}
                className="px-3 py-1.5 text-xs font-medium bg-red-700 hover:bg-red-600 text-white rounded"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Inject-context modal */}
      {injectModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Inject context"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        >
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-5 max-w-md w-full mx-4 shadow-xl">
            <h2 className="text-sm font-semibold text-gray-100 mb-2">Inject context</h2>
            <textarea
              autoFocus
              value={injectText}
              onChange={(e) => setInjectText(e.target.value)}
              placeholder="Enter context to inject into the active session…"
              rows={4}
              className="w-full bg-gray-700 text-gray-100 rounded px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            />
            <div className="flex gap-2 justify-end mt-3">
              <button
                onClick={() => {
                  setInjectModalOpen(false);
                  setInjectText('');
                }}
                className="px-3 py-1.5 text-xs text-gray-300 border border-gray-600 rounded hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (injectText.trim()) {
                    handleAction('inject-context', injectText.trim());
                    setInjectModalOpen(false);
                    setInjectText('');
                  }
                }}
                disabled={!injectText.trim()}
                className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50"
              >
                Inject
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
