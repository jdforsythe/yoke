import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PrePostGraphNode } from '../../../../../shared/types/graph';
import { graphStatusClass } from '../graphStatus';

interface Data extends Record<string, unknown> {
  graphNode: PrePostGraphNode;
}

function PrePostNodeViewImpl({ data, selected }: NodeProps) {
  const node = (data as Data).graphNode;
  const actionSummary = node.actionTaken
    ? node.actionTaken.kind === 'goto'
      ? `goto ${node.actionTaken.goto ?? '?'}`
      : node.actionTaken.kind
    : null;
  return (
    <div
      className={`flex flex-col w-full h-full rounded border px-2 py-1.5 gap-1 ${
        selected ? 'border-blue-400' : 'border-gray-700'
      } bg-purple-950/30`}
      data-testid="graph-node-prepost"
      data-graph-node-id={node.id}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-purple-400">{node.when}</span>
        <span className="text-xs font-semibold text-gray-100 truncate flex-1">
          {node.commandName}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${graphStatusClass(node.status)}`}>
          {node.status}
        </span>
        {actionSummary && (
          <span className="text-[10px] text-purple-300 truncate">{actionSummary}</span>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

export const PrePostNodeView = memo(PrePostNodeViewImpl);
