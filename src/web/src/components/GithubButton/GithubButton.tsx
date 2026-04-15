/**
 * GithubButton — reflects GithubState from the workflow snapshot.
 *
 * All six status values are handled exhaustively:
 *   disabled    → hidden (returns null)
 *   unconfigured → greyed out with setup hint tooltip
 *   idle        → "GitHub" ready indicator
 *   creating    → spinner
 *   created     → clickable PR link with state badge
 *   failed      → error text (truncated with tooltip)
 *
 * State updates arrive via workflow.update frames; this component is
 * read-only and makes no HTTP requests.
 */

import type { GithubState } from '@/ws/types';

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

export function GithubButton({ githubState }: Props) {
  if (!githubState) return null;

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
