/**
 * Module-level store for per-workflow graph projections (Graph View).
 *
 * Holds a Map<workflowId, WorkflowGraph> populated by two frame types:
 *   - workflow.snapshot: if payload.graph is present, it replaces any existing
 *     entry for that workflowId (snapshot is always authoritative).
 *   - graph.update:      incremental patch over the last known WorkflowGraph.
 *
 * React binding is via useSyncExternalStore; see useWorkflowGraph().
 *
 * A small LRU (last 4 workflows) is enforced to match the WS client's
 * concurrent-subscription cap. Without it, switching between many workflows
 * in one tab would grow the store unbounded.
 *
 * Graph-pane consumers are read-only; the only writer is the frame dispatcher
 * in WorkflowDetailRoute.
 */

import { useSyncExternalStore, useCallback } from 'react';
import type {
  WorkflowGraph,
  GraphNode,
  GraphEdge,
  GraphPatch,
  NodeStatusUpdate,
  EdgeUpdate,
} from '../../../shared/types/graph';
import type { ServerFrame, WorkflowSnapshotPayload, GraphUpdatePayload } from '../ws/types';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 4;

/** Insertion-order Map; re-inserting a key bumps it to most-recent. */
const _graphs = new Map<string, WorkflowGraph>();
const _listeners = new Set<() => void>();

function _notify(): void {
  for (const l of _listeners) l();
}

function _touch(workflowId: string, graph: WorkflowGraph): void {
  // Re-set to move to the end (most-recent in insertion order).
  _graphs.delete(workflowId);
  _graphs.set(workflowId, graph);
  while (_graphs.size > MAX_ENTRIES) {
    const oldest = _graphs.keys().next().value;
    if (oldest === undefined) break;
    _graphs.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function _applyPatch(graph: WorkflowGraph, patch: GraphPatch): WorkflowGraph {
  let nodes = graph.nodes;
  let edges = graph.edges;

  // Updates first so that add-then-update-in-same-patch still works predictably:
  // apply adds, then updates, then removes.
  if (patch.addNodes && patch.addNodes.length > 0) {
    const existing = new Set(nodes.map((n) => n.id));
    const incoming: GraphNode[] = [];
    for (const n of patch.addNodes) {
      if (existing.has(n.id)) continue;
      incoming.push(n);
    }
    if (incoming.length > 0) nodes = [...nodes, ...incoming];
  }

  if (patch.addEdges && patch.addEdges.length > 0) {
    const existing = new Set(edges.map((e) => e.id));
    const incoming: GraphEdge[] = [];
    for (const e of patch.addEdges) {
      if (existing.has(e.id)) continue;
      incoming.push(e);
    }
    if (incoming.length > 0) edges = [...edges, ...incoming];
  }

  if (patch.updateNodes && patch.updateNodes.length > 0) {
    const byId = new Map<string, NodeStatusUpdate>();
    for (const u of patch.updateNodes) byId.set(u.id, u);
    nodes = nodes.map((n) => {
      const u = byId.get(n.id);
      if (!u) return n;
      // Merge the partial update onto the existing node. Only the fields on
      // NodeStatusUpdate (status, endedAt, exitCode, actionTaken) can change;
      // other fields are preserved as-is. The kind discriminator is preserved,
      // so the variant of GraphNode stays sound — but TS can't see that, so cast.
      return { ...n, ...mergeNodeUpdate(u) } as GraphNode;
    });
  }

  if (patch.updateEdges && patch.updateEdges.length > 0) {
    const byId = new Map<string, EdgeUpdate>();
    for (const u of patch.updateEdges) byId.set(u.id, u);
    edges = edges.map((e) => {
      const u = byId.get(e.id);
      if (!u) return e;
      const next: GraphEdge = { ...e };
      if (u.traveled !== undefined) next.traveled = u.traveled;
      if (u.actionLabel !== undefined) next.actionLabel = u.actionLabel;
      return next;
    });
  }

  if (patch.removeNodeIds && patch.removeNodeIds.length > 0) {
    const drop = new Set(patch.removeNodeIds);
    nodes = nodes.filter((n) => !drop.has(n.id));
  }

  if (patch.removeEdgeIds && patch.removeEdgeIds.length > 0) {
    const drop = new Set(patch.removeEdgeIds);
    edges = edges.filter((e) => !drop.has(e.id));
  }

  const finalizedAt =
    patch.finalizedAt !== undefined ? patch.finalizedAt : graph.finalizedAt;

  return {
    version: graph.version,
    workflowId: graph.workflowId,
    nodes,
    edges,
    finalizedAt,
  };
}

/** Strip undefined fields from a NodeStatusUpdate so spread doesn't clobber defaults with undefined. */
function mergeNodeUpdate(u: NodeStatusUpdate): Partial<GraphNode> {
  const out: Record<string, unknown> = {};
  if (u.status !== undefined) out.status = u.status;
  if (u.endedAt !== undefined) out.endedAt = u.endedAt;
  if (u.exitCode !== undefined) out.exitCode = u.exitCode;
  if (u.actionTaken !== undefined) out.actionTaken = u.actionTaken;
  return out as Partial<GraphNode>;
}

// ---------------------------------------------------------------------------
// Public API — dispatch
// ---------------------------------------------------------------------------

/**
 * Feed a ServerFrame into the store. Only 'workflow.snapshot' and
 * 'graph.update' are relevant; other frame types are ignored.
 *
 * Safe to call unconditionally from the WS frame fan-out.
 */
export function dispatchGraphFrame(frame: ServerFrame): void {
  if (frame.type === 'workflow.snapshot') {
    const p = frame.payload as WorkflowSnapshotPayload;
    if (!p.graph) return;
    _touch(p.workflow.id, p.graph);
    _notify();
    return;
  }

  if (frame.type === 'graph.update') {
    const p = frame.payload as GraphUpdatePayload;
    const prev = _graphs.get(p.workflowId);
    if (!prev) {
      // No snapshot yet; we can't meaningfully apply a patch without the base
      // graph. Drop the patch; the next snapshot will bring us in sync.
      return;
    }
    const next = _applyPatch(prev, p.patch);
    _touch(p.workflowId, next);
    _notify();
  }
}

/** Clear all stored graphs. Intended for test isolation. */
export function resetGraphStore(): void {
  if (_graphs.size === 0) return;
  _graphs.clear();
  _notify();
}

/** Raw accessor — primarily for tests. */
export function getWorkflowGraph(workflowId: string): WorkflowGraph | null {
  return _graphs.get(workflowId) ?? null;
}

export function subscribeGraphStore(listener: () => void): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Subscribe a component to the graph for a given workflow.
 *
 * Returns the current WorkflowGraph or null if none has been received yet.
 * The returned reference is stable between dispatches — useSyncExternalStore
 * will only re-render when the reducer produces a new graph object for this
 * workflowId.
 */
export function useWorkflowGraph(
  workflowId: string | null | undefined,
): WorkflowGraph | null {
  const getSnapshot = useCallback(() => {
    if (!workflowId) return null;
    return _graphs.get(workflowId) ?? null;
  }, [workflowId]);
  return useSyncExternalStore(subscribeGraphStore, getSnapshot, getSnapshot);
}
