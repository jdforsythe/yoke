import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PhaseGraphNode } from '../../../../../shared/types/graph';
import { graphStatusClass } from '../graphStatus';

interface Data extends Record<string, unknown> {
  graphNode: PhaseGraphNode;
}

function PhaseNodeViewImpl({ data, selected }: NodeProps) {
  const node = (data as Data).graphNode;
  return (
    <div
      className={`flex flex-col w-full h-full rounded border px-2 py-1.5 gap-1 ${
        selected ? 'border-blue-400' : 'border-gray-700'
      } bg-gray-800`}
      data-testid="graph-node-phase"
      data-graph-node-id={node.id}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-gray-500">phase</span>
        <span className="text-xs font-semibold text-gray-100 truncate flex-1">{node.phase}</span>
      </div>
      <div>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${graphStatusClass(node.status)}`}>
          {node.status}
        </span>
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

export const PhaseNodeView = memo(PhaseNodeViewImpl);
