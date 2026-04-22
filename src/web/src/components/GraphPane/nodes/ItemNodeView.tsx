import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ItemGraphNode } from '../../../../../shared/types/graph';
import { graphStatusClass } from '../graphStatus';

interface Data extends Record<string, unknown> {
  graphNode: ItemGraphNode;
}

function ItemNodeViewImpl({ data, selected }: NodeProps) {
  const node = (data as Data).graphNode;
  const shortId = node.stableId ?? node.itemId.slice(0, 8);
  return (
    <div
      className={`flex flex-col w-full h-full rounded border ${
        selected ? 'border-blue-400' : 'border-gray-700'
      } bg-gray-850/30`}
      data-testid="graph-node-item"
      data-graph-node-id={node.id}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="flex items-center gap-2 px-2 py-1 border-b border-gray-700/60 bg-gray-800/40">
        <span className="text-[10px] uppercase tracking-wide text-gray-500">item</span>
        <span className="font-mono text-[10px] text-gray-300 truncate flex-1" title={node.itemId}>
          {shortId}
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${graphStatusClass(node.status)}`}>
          {node.status}
        </span>
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

export const ItemNodeView = memo(ItemNodeViewImpl);
