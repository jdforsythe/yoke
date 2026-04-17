import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSyncExternalStore } from 'react';
import { subscribe, getUsageSnapshot, getSnapshot } from '@/store/renderStore';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function abbreviate(n: number): string {
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
 * Subscribes with getUsageSnapshot so it ONLY re-renders when token counts
 * change — not on every text delta, tool call, or other non-usage frame.
 *
 * The dropdown is rendered via a React portal (document.body) to avoid
 * overflow clipping from the top bar's layout context.
 */
export function UsageHUD() {
  // getUsageSnapshot returns a stable reference unless totals change,
  // so useSyncExternalStore will only trigger a re-render on usage frames.
  const total = useSyncExternalStore(subscribe, getUsageSnapshot);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Separate ref for the portal div so the outside-click handler can
  // distinguish clicks inside the dropdown from clicks outside both elements.
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number } | null>(null);

  const hasData = total.inputTokens + total.outputTokens > 0;

  function handleOpen() {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      setDropdownPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen((o) => !o);
  }

  // Close dropdown on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      // Keep open when clicking inside the trigger button OR inside the portal
      // dropdown (which is NOT a DOM child of containerRef since it's a portal).
      if (containerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  if (!hasData) {
    return (
      <div className="px-2 py-1 text-xs text-gray-500 font-mono" aria-label="No token usage data">
        — tokens
      </div>
    );
  }

  // Per-session breakdown is derived from the full render model (read-only,
  // no extra subscription needed — only accessed when the dropdown is open).
  const model = getSnapshot();

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={handleOpen}
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
        {total.cacheCreationInputTokens > 0 && (
          <span className="text-orange-400" title="Cache-write tokens">
            ✦{abbreviate(total.cacheCreationInputTokens)}
          </span>
        )}
      </button>

      {open && dropdownPos !== null && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed',
            top: dropdownPos.top,
            right: dropdownPos.right,
          }}
          className="w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-[9999] p-3"
        >
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
            Workflow Tokens
          </h3>
          <div className="space-y-1">
            <TokenRow label="Input" value={total.inputTokens} />
            <TokenRow label="Output" value={total.outputTokens} />
            <TokenRow label="Cache read" value={total.cacheReadInputTokens} />
            <TokenRow label="Cache write" value={total.cacheCreationInputTokens} />
          </div>

          {model.sessions.size > 0 && (
            <>
              <div className="border-t border-gray-700 my-2" />
              <h4 className="text-xs text-gray-500 mb-1 uppercase tracking-wide">
                Per Session
              </h4>
              <div className="space-y-2">
                {Array.from(model.sessions.entries()).map(([sid, s]) => (
                  <div key={sid}>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-gray-500 text-xs font-mono truncate">
                        {sid.slice(0, 14)}…
                      </span>
                      {s.phase && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-gray-700 text-gray-400 shrink-0">
                          {s.phase}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs font-mono">
                      <span className="text-blue-400" title="Input">↑{abbreviate(s.usage.inputTokens)}</span>
                      <span className="text-green-400" title="Output">↓{abbreviate(s.usage.outputTokens)}</span>
                      {s.usage.cacheReadInputTokens > 0 && (
                        <span className="text-purple-400" title="Cache read">⚡{abbreviate(s.usage.cacheReadInputTokens)}</span>
                      )}
                      {s.usage.cacheCreationInputTokens > 0 && (
                        <span className="text-orange-400" title="Cache write">✦{abbreviate(s.usage.cacheCreationInputTokens)}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
