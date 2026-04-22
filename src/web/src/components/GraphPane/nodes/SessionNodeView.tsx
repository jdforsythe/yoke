import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { SessionGraphNode } from '../../../../../shared/types/graph';
import { graphStatusClass } from '../graphStatus';

interface Data extends Record<string, unknown> {
  graphNode: SessionGraphNode;
}

function SessionNodeViewImpl({ data, selected }: NodeProps) {
  const node = (data as Data).graphNode;
  const started = node.startedAt ? new Date(node.startedAt) : null;
  const startedLabel = started ? started.toLocaleTimeString() : '—';
  return (
    <div
      className={`flex flex-col w-full h-full rounded border px-2 py-1.5 gap-1 cursor-pointer ${
        selected ? 'border-blue-400 ring-1 ring-blue-400/60' : 'border-gray-700 hover:border-gray-500'
      } bg-gray-900`}
      data-testid="graph-node-session"
      data-graph-node-id={node.id}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-gray-500">session</span>
        <span className="text-xs font-semibold text-gray-100 truncate flex-1">
          attempt {node.attempt}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${graphStatusClass(node.status)}`}>
          {node.status}
        </span>
        <span className="text-[10px] text-gray-500">{startedLabel}</span>
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

export const SessionNodeView = memo(SessionNodeViewImpl);
