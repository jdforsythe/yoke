/**
 * Pure display formatters used by HistoryPane, FeatureBoard, and elsewhere.
 *
 * Lives separately from sessionDisplay.ts so tests under tests/web/ can
 * import these helpers without dragging in the render-store + fetch helpers
 * (which depend on browser globals like fetch and requestAnimationFrame).
 */

/** Coarse "Xs/Xm/Xh/Xd ago" timestamp for display. */
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Format a startedAt/endedAt span; "running" when not yet ended. */
export function duration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return 'running';
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Pill background/foreground classes keyed off session status. */
export function sessionStatusClass(status: string): string {
  switch (status) {
    case 'complete': return 'bg-green-500/20 text-green-300';
    case 'in_progress': return 'bg-blue-500/20 text-blue-300';
    case 'abandoned': return 'bg-gray-500/20 text-gray-400';
    default: return 'bg-red-500/20 text-red-300';
  }
}
