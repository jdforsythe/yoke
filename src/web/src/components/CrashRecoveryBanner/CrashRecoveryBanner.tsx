/**
 * CrashRecoveryBanner — rendered when workflow.recoveryState is non-null.
 *
 * Persists until the server clears recoveryState via workflow.update.
 * Cannot be dismissed by the user; only server state clears it.
 *
 * Actions:
 *   - "Acknowledge & Resume": sends control frame with action=resume
 *   - "Cancel Workflow": opens confirmation dialog, then sends action=cancel
 */

import { useState } from 'react';
import type { RecoveryState, ControlPayload } from '@/ws/types';

interface Props {
  workflowId: string;
  recoveryState: RecoveryState;
  sendControl: (action: ControlPayload['action'], opts: Omit<ControlPayload, 'action'>) => string;
}

export function CrashRecoveryBanner({ workflowId, recoveryState, sendControl }: Props) {
  const [resumePending, setResumePending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  function handleResume() {
    setResumePending(true);
    sendControl('resume', {
      workflowId,
      extra: { resumeMethod: recoveryState.resumeMethod },
    });
    // Optimistic spinner — clears when server sends workflow.update with recoveryState: null
  }

  function handleCancel() {
    setCancelPending(true);
    setShowCancelConfirm(false);
    sendControl('cancel', { workflowId });
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="bg-amber-900/60 border-b border-amber-700 px-4 py-3 shrink-0"
    >
      <div className="flex items-start gap-3">
        <span className="text-amber-400 text-lg shrink-0" aria-hidden>⚠</span>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-amber-200">
            Workflow recovered from crash
          </p>
          <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-amber-300/80">
            <dt className="text-amber-500">Crashed at</dt>
            <dd>{new Date(recoveryState.recoveredAt).toLocaleString()}</dd>
            <dt className="text-amber-500">Prior status</dt>
            <dd>{recoveryState.priorStatus}</dd>
            <dt className="text-amber-500">Resume method</dt>
            <dd>{recoveryState.resumeMethod}</dd>
            {recoveryState.lastKnownSessionId && (
              <>
                <dt className="text-amber-500">Session</dt>
                <dd className="font-mono truncate">{recoveryState.lastKnownSessionId.slice(0, 16)}…</dd>
              </>
            )}
          </dl>
          {recoveryState.uncommittedChanges && (
            <p className="mt-1.5 text-xs text-amber-300 bg-amber-950/40 rounded px-2 py-1">
              ⚠ There are stashed uncommitted changes that may be restored on continue.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5 shrink-0">
          <button
            onClick={handleResume}
            disabled={resumePending || cancelPending}
            className="px-3 py-1.5 text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {resumePending ? 'Resuming…' : 'Acknowledge & Resume'}
          </button>
          <button
            onClick={() => setShowCancelConfirm(true)}
            disabled={resumePending || cancelPending}
            className="px-3 py-1.5 text-xs font-medium bg-red-700 hover:bg-red-600 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {cancelPending ? 'Cancelling…' : 'Cancel Workflow'}
          </button>
        </div>
      </div>

      {/* Confirmation dialog */}
      {showCancelConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm cancellation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        >
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-5 max-w-sm w-full mx-4 shadow-xl">
            <h2 className="text-sm font-semibold text-gray-100 mb-2">
              Cancel this workflow?
            </h2>
            <p className="text-xs text-gray-400 mb-4">
              This will cancel the workflow permanently. This action cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowCancelConfirm(false)}
                className="px-3 py-1.5 text-xs text-gray-300 hover:text-white border border-gray-600 rounded"
              >
                Keep workflow
              </button>
              <button
                onClick={handleCancel}
                className="px-3 py-1.5 text-xs font-medium bg-red-700 hover:bg-red-600 text-white rounded"
              >
                Yes, cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
