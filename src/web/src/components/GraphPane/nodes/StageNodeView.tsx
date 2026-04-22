import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { StageGraphNode } from '../../../../../shared/types/graph';
import { graphStatusClass } from '../graphStatus';

interface Data extends Record<string, unknown> {
  graphNode: StageGraphNode;
}

function StageNodeViewImpl({ data, selected }: NodeProps) {
  const node = (data as Data).graphNode;
  return (
    <div
      className={`flex flex-col w-full h-full rounded-md border ${
        selected ? 'border-blue-400' : 'border-gray-700'
      } bg-gray-900/40`}
      data-testid="graph-node-stage"
      data-graph-node-id={node.id}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="flex items-center gap-2 px-2 py-1 border-b border-gray-700/80 bg-gray-800/60">
        <span className="text-[10px] uppercase tracking-wide text-gray-500">stage</span>
        <span className="text-xs font-semibold text-gray-100 truncate flex-1">{node.label}</span>
        <span className="text-[10px] text-gray-400">{node.run}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${graphStatusClass(node.status)}`}>
          {node.status}
        </span>
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

export const StageNodeView = memo(StageNodeViewImpl);
