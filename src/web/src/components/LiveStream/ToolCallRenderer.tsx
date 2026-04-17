import { memo, useState } from 'react';
import type { ToolCallBlock } from '@/store/types';

/**
 * Renders a ToolCallBlock — collapsible with name header, status badge,
 * input JSON tree, and result.
 *
 * Input and output are rendered as pretty-printed JSON in <pre> blocks.
 * No dangerouslySetInnerHTML.
 */

function statusBadge(status: ToolCallBlock['status']) {
  switch (status) {
    case 'pending':
      return <span className="text-xs px-1.5 py-0.5 rounded bg-gray-600 text-gray-300">pending</span>;
    case 'running':
      return (
        <span className="text-xs px-1.5 py-0.5 rounded bg-blue-600/50 text-blue-300 animate-pulse">
          running
        </span>
      );
    case 'ok':
      return <span className="text-xs px-1.5 py-0.5 rounded bg-green-600/30 text-green-300">ok</span>;
    case 'error':
      return <span className="text-xs px-1.5 py-0.5 rounded bg-red-600/30 text-red-300">error</span>;
  }
}

function JsonPre({ value }: { value: unknown }) {
  return (
    <pre className="text-xs font-mono text-gray-300 bg-gray-800/60 rounded p-2 overflow-x-auto whitespace-pre max-h-64 overflow-y-auto">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export const ToolCallRenderer = memo(function ToolCallRenderer({
  block,
}: {
  block: ToolCallBlock;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="px-4 py-2 mx-2 my-1 rounded border border-gray-700 bg-gray-800/30">
      {/* Header row */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full text-left"
        aria-expanded={expanded}
      >
        <span className="text-indigo-400 text-xs font-mono">{expanded ? '▼' : '▶'}</span>
        <span className="text-sm font-mono text-gray-200 font-medium flex-1">{block.name}</span>
        {statusBadge(block.status)}
      </button>

      {/* Preview: show a brief input summary when collapsed */}
      {!expanded && block.input !== null && block.input !== undefined && (
        <div className="mt-1 ml-5 text-xs text-gray-500 font-mono truncate">
          {JSON.stringify(block.input).slice(0, 80)}
          {JSON.stringify(block.input).length > 80 ? '…' : ''}
        </div>
      )}

      {/* Expanded: full input + result */}
      {expanded && (
        <div className="mt-2 ml-5 space-y-2">
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Input</div>
            <JsonPre value={block.input} />
          </div>
          {block.output !== undefined && (
            <div>
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Result</div>
              <JsonPre value={block.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
});
