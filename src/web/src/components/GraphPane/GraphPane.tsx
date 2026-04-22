/**
 * GraphPane — n8n-style canvas for the WorkflowGraph projection.
 *
 * Layout is computed off the main thread via elkjs (graphLayout.ts) and
 * memoized by a structural hash, so status-only updates don't lurch the
 * canvas geometry.
 *
 * Selection: session node clicks hoist into WorkflowDetailRoute's existing
 * per-item selection so the shared right pane (LiveStreamPane + HistoryPane
 * + ControlMatrix) keeps working. Non-session node clicks route into the
 * route's `selectedGraphNodeId` state which swaps the right-pane contents
 * for a NodeSummaryPanel.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  type NodeMouseHandler,
  type Node,
  type Edge,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useWorkflowGraph } from '@/store/graphStore';
import type { GraphNode, SessionGraphNode } from '../../../../shared/types/graph';
import { layoutGraph } from './graphLayout';
import { StageNodeView } from './nodes/StageNodeView';
import { ItemNodeView } from './nodes/ItemNodeView';
import { PhaseNodeView } from './nodes/PhaseNodeView';
import { SessionNodeView } from './nodes/SessionNodeView';
import { PrePostNodeView } from './nodes/PrePostNodeView';

interface Props {
  workflowId: string;
  /**
   * Emitted when a session node is clicked. The route mirrors this to
   * selectedItemId so the existing right pane attaches to the right session.
   */
  onSelectSession?: (session: SessionGraphNode) => void;
  /** Emitted for non-session clicks — drives the NodeSummaryPanel in the right pane. */
  onSelectGraphNode?: (node: GraphNode | null) => void;
  /** Controlled current selection (by graph node id) for highlight sync. */
  selectedGraphNodeId?: string | null;
}

const nodeTypes = {
  stage: StageNodeView,
  item: ItemNodeView,
  phase: PhaseNodeView,
  session: SessionNodeView,
  prepost: PrePostNodeView,
};

export function GraphPane(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphPaneInner {...props} />
    </ReactFlowProvider>
  );
}

function GraphPaneInner({
  workflowId,
  onSelectSession,
  onSelectGraphNode,
  selectedGraphNodeId,
}: Props) {
  const graph = useWorkflowGraph(workflowId);

  const [rfNodes, setRfNodes] = useState<Node[]>([]);
  const [rfEdges, setRfEdges] = useState<Edge[]>([]);
  const [laidOutHash, setLaidOutHash] = useState<string | null>(null);

  // Structural key drives a re-layout; status-only changes keep the cached
  // positions. Layout is async (elk runs in a worker-ish pipeline internally).
  const structuralKey = useMemo(() => {
    if (!graph) return null;
    const n = graph.nodes
      .map((x) => `${x.id}:${x.kind}`)
      .sort()
      .join('|');
    const e = graph.edges
      .map((x) => x.id)
      .sort()
      .join('|');
    return `${n}#${e}`;
  }, [graph]);

  useEffect(() => {
    if (!graph) return;
    let cancelled = false;
    void layoutGraph(graph).then((out) => {
      if (cancelled) return;
      setRfNodes(out.nodes);
      setRfEdges(out.edges);
      setLaidOutHash(structuralKey);
    });
    return () => {
      cancelled = true;
    };
  }, [graph, structuralKey]);

  // Status-only rehydration: merge the latest graph node data into the laid-out
  // xyflow nodes so badges update without a re-layout.
  useEffect(() => {
    if (!graph || laidOutHash !== structuralKey) return;
    setRfNodes((prev) => {
      if (prev.length === 0) return prev;
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      let changed = false;
      const next = prev.map((p) => {
        const fresh = byId.get(p.id);
        if (!fresh) return p;
        const existing = (p.data as { graphNode?: GraphNode } | undefined)?.graphNode;
        if (existing === fresh) return p;
        changed = true;
        return { ...p, data: { ...p.data, graphNode: fresh } };
      });
      return changed ? next : prev;
    });
  }, [graph, laidOutHash, structuralKey]);

  // Apply a selection ring via the xyflow `selected` flag so the rendered
  // outline matches whichever node the parent route marks current.
  const displayedNodes = useMemo(() => {
    if (!selectedGraphNodeId) return rfNodes;
    return rfNodes.map((n) =>
      n.selected === (n.id === selectedGraphNodeId)
        ? n
        : { ...n, selected: n.id === selectedGraphNodeId },
    );
  }, [rfNodes, selectedGraphNodeId]);

  const onNodeClick: NodeMouseHandler = (_evt, node) => {
    const payload = (node.data as { graphNode?: GraphNode } | undefined)?.graphNode;
    if (!payload) return;
    if (payload.kind === 'session') {
      onSelectSession?.(payload);
      onSelectGraphNode?.(payload);
    } else {
      onSelectGraphNode?.(payload);
    }
  };

  const onPaneClick = () => {
    onSelectGraphNode?.(null);
  };

  const onSelectionChange = (params: OnSelectionChangeParams) => {
    if (params.nodes.length === 0) return;
    const first = params.nodes[0]!;
    const payload = (first.data as { graphNode?: GraphNode } | undefined)?.graphNode;
    if (!payload) return;
    if (payload.kind === 'session') onSelectSession?.(payload);
  };

  if (!graph) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        waiting for graph…
      </div>
    );
  }

  return (
    <div className="relative w-full h-full" data-testid="graph-pane">
      {graph.finalizedAt && (
        <div
          className="absolute top-2 right-2 z-10 text-[10px] px-2 py-0.5 rounded bg-green-500/20 text-green-300 border border-green-700/40"
          data-testid="graph-finalized-pill"
        >
          finalized
        </div>
      )}
      <ReactFlow
        nodes={displayedNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onSelectionChange={onSelectionChange}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
