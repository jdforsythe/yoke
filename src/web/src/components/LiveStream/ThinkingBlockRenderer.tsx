import { memo, useState } from 'react';
import type { ThinkingBlock } from '@/store/types';

/**
 * Renders a ThinkingBlock — collapsed by default, expandable inline.
 *
 * Uses local component state for expanded/collapsed toggle so the
 * render-model reducer stays free of UI state. Expanding does not
 * disrupt scroll position (height change is absorbed by virtualizer
 * measuring via measureElement).
 */
export const ThinkingBlockRenderer = memo(function ThinkingBlockRenderer({
  block,
}: {
  block: ThinkingBlock;
}) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = block.text.split('\n').length;

  return (
    <div className="px-4 py-2 border-l-2 border-indigo-500/40 bg-indigo-950/20 mx-2 my-1 rounded-r">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-xs text-indigo-300 hover:text-indigo-200 w-full text-left"
        aria-expanded={expanded}
      >
        <span className="text-indigo-500">{expanded ? '▼' : '▶'}</span>
        <span className="italic">
          {expanded ? 'Thinking…' : `Thinking… (${lineCount} line${lineCount !== 1 ? 's' : ''})`}
        </span>
        {!block.frozen && (
          <span className="ml-auto w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
        )}
      </button>
      {expanded && (
        <pre className="mt-2 text-xs text-indigo-200/70 font-mono whitespace-pre-wrap break-words overflow-x-auto">
          {block.text}
        </pre>
      )}
    </div>
  );
});
