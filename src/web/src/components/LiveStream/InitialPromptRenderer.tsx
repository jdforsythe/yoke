import { memo, useState } from 'react';
import type { InitialPromptBlock } from '@/store/types';

/**
 * Renders the fully-rendered prompt sent to the agent at the top of the
 * session log. Collapsed by default because prompts can be long
 * (tens to hundreds of KB). Click the header or the toggle to expand.
 */
export const InitialPromptRenderer = memo(function InitialPromptRenderer({
  block,
}: {
  block: InitialPromptBlock;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const charCount = block.prompt.length;

  async function copyToClipboard(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(block.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; silently ignore
    }
  }

  return (
    <div className="px-3 py-1.5 mx-2 my-1 rounded border border-indigo-700/40 bg-indigo-900/20">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 text-left"
        aria-expanded={expanded}
        data-testid="initial-prompt-toggle"
      >
        <span className="text-xs text-indigo-400 font-mono shrink-0">
          {expanded ? '▼' : '▶'}
        </span>
        <span className="text-xs text-indigo-300 font-medium flex-1">
          Initial prompt
        </span>
        <span className="text-xs text-gray-500 shrink-0 font-mono">
          {charCount.toLocaleString()} chars
        </span>
        <button
          onClick={copyToClipboard}
          className="text-xs px-1.5 py-0.5 rounded bg-indigo-700/30 text-indigo-300 hover:bg-indigo-700/50 shrink-0"
          data-testid="initial-prompt-copy"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </button>

      {expanded && (
        <pre
          className="mt-2 p-2 rounded bg-gray-900/70 text-xs font-mono text-gray-200 whitespace-pre-wrap break-words overflow-auto max-h-96"
          data-testid="initial-prompt-body"
        >
          {block.prompt}
        </pre>
      )}
    </div>
  );
});
