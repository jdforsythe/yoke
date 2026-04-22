/**
 * Shared graph-view types — imported by the server graph module and the web UI.
 *
 * WorkflowGraph is a persisted per-workflow projection of the DAG surfaced by
 * the Graph view: configured pipeline shape + runtime-observed sessions,
 * pre/post command results and goto/retry edges.  It is always derivable from
 * the durable history in `items` / `sessions` / `prepost_runs`; the stored
 * copy (`workflows.graph_state`) is a cache that accrues one patch per
 * scheduler broadcast so reconnecting clients do not re-render from scratch.
 */

import type { ResolvedAction } from '../../server/pipeline/engine.js';

export type { ResolvedAction };

export type GraphNodeStatus =
  | 'pending'
  | 'in_progress'
  | 'complete'
  | 'blocked'
  | 'abandoned'
  | 'skipped';

export type GraphNodeOrigin = 'configured' | 'runtime';

interface NodeBase {
  id: string;
  label: string;
  status: GraphNodeStatus;
  origin: GraphNodeOrigin;
  description?: string | null;
}

export type StageGraphNode = NodeBase & {
  kind: 'stage';
  stageId: string;
  run: 'once' | 'per-item';
};

export type ItemGraphNode = NodeBase & {
  kind: 'item';
  stageId: string;
  itemId: string;
  stableId: string | null;
};

export type PhaseGraphNode = NodeBase & {
  kind: 'phase';
  stageId: string;
  itemId: string | null;
  phase: string;
};

export type SessionGraphNode = NodeBase & {
  kind: 'session';
  phaseNodeId: string;
  sessionId: string;
  attempt: number;
  parentSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
};

export type PrePostGraphNode = NodeBase & {
  kind: 'prepost';
  phaseNodeId: string;
  when: 'pre' | 'post';
  commandName: string;
  prepostRunId: string;
  actionTaken: ResolvedAction | null;
};

export type GraphNode =
  | StageGraphNode
  | ItemGraphNode
  | PhaseGraphNode
  | SessionGraphNode
  | PrePostGraphNode;

export type GraphEdgeKind =
  | 'sequence'
  | 'dependency'
  | 'retry'
  | 'goto'
  | 'prepost';

export type GraphEdgeStyle = 'solid' | 'dotted';

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  style: GraphEdgeStyle;
  traveled: boolean;
  actionLabel?: string;
}

export interface WorkflowGraph {
  version: 1;
  workflowId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  finalizedAt: string | null;
}

// ---------------------------------------------------------------------------
// Patch — the payload diffed from applyEvent / emitted on graph.update frames.
// ---------------------------------------------------------------------------

export type NodeStatusUpdate = {
  id: string;
  status?: GraphNodeStatus;
  endedAt?: string | null;
  exitCode?: number | null;
  actionTaken?: ResolvedAction | null;
};

export type EdgeUpdate = {
  id: string;
  traveled?: boolean;
  actionLabel?: string;
};

export interface GraphPatch {
  addNodes?: GraphNode[];
  addEdges?: GraphEdge[];
  updateNodes?: NodeStatusUpdate[];
  updateEdges?: EdgeUpdate[];
  removeNodeIds?: string[];
  removeEdgeIds?: string[];
  finalizedAt?: string | null;
}
