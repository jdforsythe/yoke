import { memo, useState } from 'react';
import type { SystemNoticeBlock } from '@/store/types';

/**
 * Renders a SystemNoticeBlock with a left-rule accent coloured by severity.
 *
 * For prepost.command blocks (runId is set):
 *   - Shows command name + phase header
 *   - Collapsible stdout/stderr output log with per-stream colour coding
 *   - Finalised with exit-code badge when prepostFinalized is true
 *
 * Severity colours: info=blue, warn=amber, error=red, requires_attention=amber
 */

function severityClasses(severity: SystemNoticeBlock['severity']) {
  switch (severity) {
    case 'info':
      return { border: 'border-l-blue-500', bg: 'bg-blue-950/10', text: 'text-blue-300' };
    case 'warn':
    case 'requires_attention':
      return { border: 'border-l-amber-500', bg: 'bg-amber-950/10', text: 'text-amber-300' };
    case 'error':
      return { border: 'border-l-red-500', bg: 'bg-red-950/10', text: 'text-red-300' };
  }
}

export const SystemNoticeRenderer = memo(function SystemNoticeRenderer({
  block,
}: {
  block: SystemNoticeBlock;
}) {
  const [logExpanded, setLogExpanded] = useState(false);
  const cls = severityClasses(block.severity);
  const hasOutput = block.outputChunks && block.outputChunks.length > 0;
  const isPrepost = block.runId !== undefined;

  return (
    <div
      className={`px-3 py-1.5 mx-2 my-0.5 rounded-r border-l-2 ${cls.border} ${cls.bg}`}
    >
      {/* Message line */}
      <div className="flex items-start gap-2">
        <span className={`text-xs font-mono ${cls.text} flex-1`}>{block.message}</span>
        <span className="text-xs text-gray-600 shrink-0">{block.source}</span>

        {/* Exit code badge for finalised prepost commands */}
        {isPrepost && block.prepostFinalized && block.exitCode !== undefined && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded font-mono ${
              block.exitCode === 0
                ? 'bg-green-600/30 text-green-300'
                : 'bg-red-600/30 text-red-300'
            }`}
          >
            exit {block.exitCode}
          </span>
        )}

        {/* Action label for finalised prepost commands (continue / abort / ...) */}
        {isPrepost && block.prepostFinalized && block.action != null &&
          typeof (block.action as Record<string, unknown>).type === 'string' && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded font-mono ${
              (block.action as { type: string }).type === 'abort'
                ? 'bg-red-600/20 text-red-400'
                : 'bg-gray-600/30 text-gray-400'
            }`}
          >
            {(block.action as { type: string }).type}
          </span>
        )}

        {/* Toggle button for prepost output log */}
        {isPrepost && hasOutput && (
          <button
            onClick={() => setLogExpanded((v) => !v)}
            className="text-xs text-gray-500 hover:text-gray-300 shrink-0"
            aria-expanded={logExpanded}
          >
            {logExpanded ? 'hide log' : 'show log'}
          </button>
        )}
      </div>

      {/* Prepost output log — collapsible, preserves expanded state across re-renders */}
      {isPrepost && hasOutput && logExpanded && (
        <div className="mt-1.5 rounded bg-gray-900/60 p-2 overflow-x-auto max-h-48 overflow-y-auto">
          {block.outputChunks!.map((chunk, i) => (
            <span
              key={i}
              className={`text-xs font-mono whitespace-pre-wrap break-words ${
                chunk.stream === 'stderr' ? 'text-red-400' : 'text-gray-300'
              }`}
            >
              {chunk.chunk}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});
