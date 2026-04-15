import { useState, useEffect, useRef } from 'react';
import { useRenderModel } from '@/hooks/useRenderModel';
import { getTotalUsage } from '@/store/renderStore';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function abbreviate(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TokenRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between text-xs font-mono">
      <span className="text-gray-400">{label}</span>
      <span className="text-gray-200">{value === 0 ? '—' : abbreviate(value)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UsageHUD
// ---------------------------------------------------------------------------

/**
 * Compact token-usage display in the AppShell top bar.
 *
 * Hidden when no usage data is available (no active workflow).
 * Clicking expands a dropdown with per-session breakdown.
 * Positioned with a portal anchor to avoid overflow clipping from the top bar.
 */
export function UsageHUD() {
  const model = useRenderModel();
  const total = getTotalUsage(model);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const hasData = total.inputTokens + total.outputTokens > 0;

  // Close dropdown on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onPointer(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  if (!hasData) return null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-2 py-1 rounded text-xs text-gray-300 hover:bg-gray-700 font-mono"
        aria-label="Token usage — click to expand"
        aria-expanded={open}
      >
        <span className="text-blue-400" title="Input tokens">
          ↑{abbreviate(total.inputTokens)}
        </span>
        <span className="text-green-400" title="Output tokens">
          ↓{abbreviate(total.outputTokens)}
        </span>
        {total.cacheReadInputTokens > 0 && (
          <span className="text-purple-400" title="Cache-read tokens">
            ⚡{abbreviate(total.cacheReadInputTokens)}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 p-3">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
            Workflow Tokens
          </h3>
          <div className="space-y-1">
            <TokenRow label="Input" value={total.inputTokens} />
            <TokenRow label="Output" value={total.outputTokens} />
            <TokenRow label="Cache read" value={total.cacheReadInputTokens} />
            <TokenRow label="Cache write" value={total.cacheCreationInputTokens} />
          </div>

          {model.sessions.size > 1 && (
            <>
              <div className="border-t border-gray-700 my-2" />
              <h4 className="text-xs text-gray-500 mb-1 uppercase tracking-wide">
                Per Session
              </h4>
              <div className="space-y-2">
                {Array.from(model.sessions.entries()).map(([sid, s]) => (
                  <div key={sid}>
                    <div className="text-gray-500 text-xs font-mono truncate mb-0.5">
                      {sid.slice(0, 14)}…
                    </div>
                    <div className="flex gap-3 text-xs font-mono">
                      <span className="text-blue-400">↑{abbreviate(s.usage.inputTokens)}</span>
                      <span className="text-green-400">↓{abbreviate(s.usage.outputTokens)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
