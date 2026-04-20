/**
 * GithubButton — reflects GithubState from the workflow snapshot.
 *
 * All six status values are handled exhaustively:
 *   disabled    → hidden (returns null)
 *   unconfigured → greyed out with setup hint tooltip
 *   idle        → "GitHub" indicator; "Create PR" button when workflow is terminal
 *   creating    → spinner ("Creating PR…")
 *   created     → clickable PR link with state badge
 *   failed      → error text; "Create PR" retry button when workflow is terminal
 *
 * State updates arrive via workflow.update frames; the button POST triggers
 * the executor which writes github_state='creating' and broadcasts the update.
 *
 * Re-exports shouldShowCreatePrButton for unit tests (pure function of
 * {workflowStatus, githubState.status} with no React dependency).
 */

import { useState } from 'react';
import type { GithubState } from '@/ws/types';
import { shouldShowCreatePrButton } from './githubButtonRules';

// Re-export so callers and tests can import from a single place.
export { shouldShowCreatePrButton } from './githubButtonRules';

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

interface Props {
  /** Workflow UUID — needed to POST create-pr. */
  workflowId: string;
  /** Current workflow status — gates 'Create PR' button visibility. */
  workflowStatus: string;
  githubState: GithubState | null;
}

function prStateChip(prState: GithubState['prState']) {
  switch (prState) {
    case 'open':
      return <span className="text-[10px] px-1 py-0.5 rounded bg-green-600/30 text-green-300">open</span>;
    case 'merged':
      return <span className="text-[10px] px-1 py-0.5 rounded bg-purple-600/30 text-purple-300">merged</span>;
    case 'closed':
      return <span className="text-[10px] px-1 py-0.5 rounded bg-red-600/30 text-red-300">closed</span>;
    default:
      return null;
  }
}

export function GithubButton({ workflowId, workflowStatus, githubState }: Props) {
  const [inFlight, setInFlight] = useState(false);

  if (!githubState) return null;

  async function handleCreatePr() {
    if (inFlight) return;
    setInFlight(true);
    try {
      await fetch(
        `/api/workflows/${encodeURIComponent(workflowId)}/github/create-pr`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ commandId: crypto.randomUUID() }),
        },
      );
    } finally {
      setInFlight(false);
    }
  }

  switch (githubState.status) {
    case 'disabled':
      return null;

    case 'unconfigured':
      return (
        <span
          title="GitHub integration not configured — add github: section to .yoke.yml"
          className="text-xs text-gray-600 cursor-help border border-gray-700 px-2 py-0.5 rounded"
        >
          GitHub ⚙
        </span>
      );

    case 'idle':
      if (shouldShowCreatePrButton(workflowStatus, 'idle')) {
        return (
          <button
            onClick={() => void handleCreatePr()}
            disabled={inFlight}
            className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-60 disabled:cursor-not-allowed border border-blue-700/50 px-2 py-0.5 rounded transition-colors"
          >
            {inFlight ? 'Creating…' : 'Create PR'}
          </button>
        );
      }
      return (
        <span className="text-xs text-gray-400 border border-gray-700 px-2 py-0.5 rounded">
          GitHub
        </span>
      );

    case 'creating':
      return (
        <span className="text-xs text-gray-400 border border-gray-700 px-2 py-0.5 rounded flex items-center gap-1">
          <span className="w-2.5 h-2.5 border border-gray-400 border-t-transparent rounded-full animate-spin" />
          Creating PR…
        </span>
      );

    case 'created':
      return (
        <a
          href={githubState.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={
            githubState.lastCheckedAt
              ? `Last checked: ${relativeTime(githubState.lastCheckedAt)}`
              : undefined
          }
          className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 border border-gray-700 px-2 py-0.5 rounded transition-colors"
        >
          PR #{githubState.prNumber}
          {prStateChip(githubState.prState)}
        </a>
      );

    case 'failed':
      if (shouldShowCreatePrButton(workflowStatus, 'failed')) {
        return (
          <button
            onClick={() => void handleCreatePr()}
            disabled={inFlight}
            title={githubState.error ?? 'GitHub PR creation failed — click to retry'}
            className="text-xs text-red-400 hover:text-red-300 disabled:opacity-60 disabled:cursor-not-allowed border border-red-800/50 px-2 py-0.5 rounded max-w-[160px] truncate transition-colors"
          >
            {inFlight ? 'Creating…' : 'Create PR'}
          </button>
        );
      }
      return (
        <span
          title={githubState.error ?? 'GitHub PR creation failed'}
          className="text-xs text-red-400 border border-red-800/50 px-2 py-0.5 rounded max-w-[160px] truncate"
        >
          GitHub: {githubState.error ?? 'failed'}
        </span>
      );
  }
}
