/**
 * PrepostOutputPane — right-pane viewer for captured prepost stdout/stderr.
 *
 * F4 served the artifact endpoint:
 *   GET /api/workflows/:wf/items/:item/prepost/:id/{stdout,stderr}
 * which returns { content, totalSize, truncated } for a file capped at
 * OUTPUT_CAPTURE_LIMIT (32 KiB) by the runner.
 *
 * This pane fetches that response once per (prepostId, stream) pair and
 * renders the decoded text in a monospaced pre-block with a small header
 * line. Results are cached in a module-level Map so re-selecting an
 * already-viewed row in the inline timeline is instant.
 */

import { useEffect, useState } from 'react';

interface CacheEntry {
  content: string;
  totalSize: number;
  truncated: boolean;
}

/** Module-level cache keyed by `${prepostId}:${stream}`. */
const cache = new Map<string, CacheEntry>();

interface Props {
  workflowId: string;
  itemId: string;
  prepostId: string;
  stream: 'stdout' | 'stderr';
  /** Human-friendly command label shown in the header (e.g. "check"). */
  commandName: string;
}

export function PrepostOutputPane({
  workflowId,
  itemId,
  prepostId,
  stream,
  commandName,
}: Props) {
  const cacheKey = `${prepostId}:${stream}`;
  const [entry, setEntry] = useState<CacheEntry | null>(() => cache.get(cacheKey) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cached = cache.get(cacheKey);
    if (cached) {
      setEntry(cached);
      setError(null);
      return;
    }
    let cancelled = false;
    const url =
      `/api/workflows/${encodeURIComponent(workflowId)}` +
      `/items/${encodeURIComponent(itemId)}` +
      `/prepost/${encodeURIComponent(prepostId)}` +
      `/${stream}`;
    setEntry(null);
    setError(null);
    void fetch(url)
      .then(async (r) => {
        if (!r.ok) {
          const msg =
            r.status === 404
              ? 'No output captured for this run'
              : `Failed to load output (HTTP ${r.status})`;
          throw new Error(msg);
        }
        return (await r.json()) as CacheEntry;
      })
      .then((data) => {
        if (cancelled) return;
        cache.set(cacheKey, data);
        setEntry(data);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, itemId, prepostId, stream, cacheKey]);

  return (
    <div className="flex flex-col h-full" data-testid="prepost-output-pane">
      <div className="shrink-0 px-3 py-1.5 text-[10px] text-gray-400 border-b border-gray-700 bg-gray-900 flex items-center gap-2">
        <span className="font-medium text-gray-300">{commandName}</span>
        <span className="uppercase tracking-wide">{stream}</span>
        {entry && (
          <span className="text-gray-500">
            {entry.totalSize} bytes{entry.truncated ? ' (truncated)' : ''}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto bg-gray-950">
        {error ? (
          <div
            className="px-3 py-2 text-xs text-amber-300"
            data-testid="prepost-output-error"
          >
            {error}
          </div>
        ) : entry ? (
          <pre
            className="px-3 py-2 text-xs font-mono text-gray-100 whitespace-pre-wrap break-words"
            data-testid="prepost-output-text"
          >
            {entry.content}
          </pre>
        ) : (
          <div className="px-3 py-2 text-xs text-gray-500">Loading…</div>
        )}
      </div>
    </div>
  );
}

/**
 * Test-only hook to clear the module cache between runs. Not exported from
 * the barrel; importable via the file path directly.
 */
export function __clearPrepostOutputCache(): void {
  cache.clear();
}
