/**
 * PausedBanner — rendered when workflow.pausedAt is non-null.
 *
 * The scheduler pauses all in-flight workflows on server restart (t-06:
 * startup-pause). This banner is the primary affordance for resuming them.
 *
 * Stack order (top of WorkflowDetailRoute):
 *   1. CrashRecoveryBanner  (crash detected)
 *   2. PausedBanner         (paused — either startup-pause or explicit user pause)
 *   3. AttentionBanner      (item-level attention items)
 *
 * Optimistic hide: on POST success the banner hides immediately. The
 * authoritative clear arrives via workflow.update { pausedAt: null } from the
 * WS broadcast the control executor fires synchronously before responding.
 *
 * Double-click deduplication: the Continue button is disabled while a request
 * is in-flight. commandId is generated once per click so retries on network
 * failure use a fresh ID (the prior request may or may not have reached the
 * server — a new id is safe because idempotency is per-commandId).
 *
 * The parent passes pausedAt as a prop. When it changes (workflow paused again
 * after a continue), useEffect resets the dismissed state so the banner
 * reappears with the new pause timestamp.
 */

import { useState, useEffect } from 'react';

interface Props {
  workflowId: string;
  /** Non-null ISO timestamp from workflows.paused_at. */
  pausedAt: string;
}

export function PausedBanner({ workflowId, pausedAt }: Props) {
  const [dismissed, setDismissed] = useState(false);
  const [pending, setPending] = useState(false);

  // If pausedAt changes (workflow paused again with a new timestamp after a
  // prior continue), reset dismissed so the new pause is visible.
  useEffect(() => {
    setDismissed(false);
  }, [pausedAt]);

  if (dismissed) return null;

  async function handleContinue() {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch(
        `/api/workflows/${encodeURIComponent(workflowId)}/control`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commandId: crypto.randomUUID(),
            action: 'continue',
          }),
        },
      );
      if (res.ok) {
        setDismissed(true);
      }
    } catch {
      // Network failure — button re-enables so the user can try again.
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      data-testid="paused-banner"
      role="alert"
      aria-live="polite"
      className="bg-yellow-900/60 border-b border-yellow-700 px-4 py-3 shrink-0"
    >
      <div className="flex items-center gap-3">
        <span className="text-yellow-400 text-lg shrink-0" aria-hidden>
          ⏸
        </span>
        <p className="flex-1 text-sm font-semibold text-yellow-200">
          This workflow is paused. Click Continue to resume.
        </p>
        <button
          data-testid="paused-banner-continue"
          onClick={() => void handleContinue()}
          disabled={pending}
          className="shrink-0 px-3 py-1.5 text-xs font-medium bg-yellow-600 hover:bg-yellow-500 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? 'Continuing…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
