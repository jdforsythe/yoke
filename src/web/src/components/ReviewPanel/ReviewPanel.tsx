/**
 * ReviewPanel — specialized stream rendering for review-phase sessions.
 *
 * Activated when the active session's phase is 'review' or 'pre_review'.
 * Receives the phase string from the parent (WorkflowDetailRoute), which
 * derives it from SessionStartedPayload.phase — no heuristics on stream
 * content are used for phase detection.
 *
 * Detects Task tool_use calls (name === 'Task' exactly) and renders each
 * as a collapsible subagent row. Non-Task tool calls render with the standard
 * ToolCallRenderer.
 *
 * Summary header: total, passed (ok), failed (error), pending counts.
 * Expanding a subagent row shows its nested stream output inline.
 */

import { memo, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { subscribe, getSessionBlocksSnapshot } from '@/store/renderStore';
import type { RenderBlock, ToolCallBlock } from '@/store/types';
import { ToolCallRenderer } from '@/components/LiveStream/ToolCallRenderer';
import { TextBlockRenderer } from '@/components/LiveStream/TextBlockRenderer';
import { ThinkingBlockRenderer } from '@/components/LiveStream/ThinkingBlockRenderer';
import { SystemNoticeRenderer } from '@/components/LiveStream/SystemNoticeRenderer';

// ---------------------------------------------------------------------------
// Sub-agent row
// ---------------------------------------------------------------------------

interface SubagentRowProps {
  block: ToolCallBlock;
  index: number;
}

const SubagentRow = memo(function SubagentRow({ block, index }: SubagentRowProps) {
  const [expanded, setExpanded] = useState(false);

  const taskDesc = extractTaskDescription(block.input);

  function statusIndicator() {
    switch (block.status) {
      case 'pending':
        return <span className="w-2 h-2 rounded-full bg-gray-500 shrink-0" />;
      case 'running':
        return <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse shrink-0" />;
      case 'ok':
        return <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />;
      case 'error':
        return <span className="w-2 h-2 rounded-full bg-red-400 shrink-0" />;
    }
  }

  return (
    <div className="border border-gray-700 rounded-lg mb-2 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left hover:bg-gray-700/30 transition-colors"
        aria-expanded={expanded}
      >
        {statusIndicator()}
        <span className="text-xs text-gray-500 w-6 shrink-0">#{index + 1}</span>
        <span className="text-sm text-gray-200 flex-1 truncate">{taskDesc}</span>
        <span className="text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="border-t border-gray-700 bg-gray-800/20">
          {block.output !== undefined ? (
            <div className="px-3 py-2">
              <p className="text-xs text-gray-500 mb-1">Output:</p>
              <pre className="text-xs font-mono text-gray-300 whitespace-pre-wrap break-words">
                {typeof block.output === 'string'
                  ? block.output
                  : JSON.stringify(block.output, null, 2)}
              </pre>
            </div>
          ) : (
            <div className="px-3 py-2 text-xs text-gray-500 italic">
              {block.status === 'running' ? 'Running…' : 'No output'}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

function extractTaskDescription(input: unknown): string {
  if (typeof input === 'string') return input.slice(0, 120);
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const desc = obj['description'] ?? obj['prompt'] ?? obj['task'] ?? obj['message'];
    if (typeof desc === 'string') return desc.slice(0, 120);
  }
  return JSON.stringify(input ?? '').slice(0, 120);
}

// ---------------------------------------------------------------------------
// ReviewPanel
// ---------------------------------------------------------------------------

interface Props {
  sessionId: string;
  /** Phase string from SessionStartedPayload.phase — passed by the parent. */
  phase: string;
}

export function ReviewPanel({ sessionId, phase: _phase }: Props) {
  // Session-specific stable snapshot — only re-renders when THIS session's
  // blocks change, not on frames for unrelated sessions or usage updates.
  const blocks = useSyncExternalStore(subscribe, () => getSessionBlocksSnapshot(sessionId));

  // Partition Task tool_use blocks from the rest.
  const taskBlocks: ToolCallBlock[] = [];
  const otherBlocks: RenderBlock[] = [];

  for (const block of blocks) {
    if (block.type === 'tool_call' && block.name === 'Task') {
      taskBlocks.push(block);
    } else {
      otherBlocks.push(block);
    }
  }

  const total = taskBlocks.length;
  const passed = taskBlocks.filter((b) => b.status === 'ok').length;
  const failed = taskBlocks.filter((b) => b.status === 'error').length;
  const pending = taskBlocks.filter((b) => b.status === 'pending' || b.status === 'running').length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Summary header */}
      {total > 0 && (
        <div className="shrink-0 px-4 py-2 border-b border-gray-700 bg-gray-800/30 flex items-center gap-4">
          <span className="text-xs text-gray-400 font-medium">Review</span>
          <div className="flex items-center gap-3 text-xs font-mono">
            <span className="text-gray-400">{total} subagents</span>
            {passed > 0 && <span className="text-green-400">✓ {passed}</span>}
            {failed > 0 && <span className="text-red-400">✗ {failed}</span>}
            {pending > 0 && <span className="text-gray-500">… {pending}</span>}
          </div>
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {/* Task subagent rows in invocation order */}
        {taskBlocks.map((block, i) => (
          <SubagentRow key={block.blockId} block={block} index={i} />
        ))}

        {/* Other blocks (non-Task tool calls, text, notices) */}
        {otherBlocks.map((block) => {
          switch (block.type) {
            case 'text':
              return <TextBlockRenderer key={block.blockId} block={block} />;
            case 'tool_call':
              return <ToolCallRenderer key={block.blockId} block={block} />;
            case 'thinking':
              return <ThinkingBlockRenderer key={block.blockId} block={block} />;
            case 'system_notice':
              return <SystemNoticeRenderer key={block.blockId} block={block} />;
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}
