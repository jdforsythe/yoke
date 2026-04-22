/**
 * pruneUntraveled — remove configured-only branches that no runtime path
 * visited, producing the "finalized" graph persisted at workflow completion.
 *
 * Rules:
 *  - The sequence spine (stage → phase → stage) is always preserved, even if
 *    traveled:false, because it is the skeleton the UI lays out on.
 *  - Runtime-origin nodes and their incident edges are never removed.
 *  - A configured node is removable iff:
 *      * it is not on the sequence spine that a traveled runtime path uses, and
 *      * every incident edge is either traveled:false OR points at another
 *        removable node.
 *  - In practice we drop:
 *      * goto edges with traveled:false
 *      * prepost nodes that have no runtime rows (configured placeholders
 *        replaced by promotion always disappear before this runs)
 *    and any configured nodes that become orphaned afterwards.
 */

import type { WorkflowGraph, GraphNode, GraphEdge } from '../../shared/types/graph.js';

export function pruneUntraveled(graph: WorkflowGraph): WorkflowGraph {
  const nodeById = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  const keptEdges: GraphEdge[] = [];
  const removedEdges: GraphEdge[] = [];

  for (const e of graph.edges) {
    if (shouldKeepEdge(e)) keptEdges.push(e);
    else removedEdges.push(e);
  }

  // Collect candidate nodes to prune: configured prepost/phase/goto targets
  // that are no longer reachable via any remaining incoming edge.
  const incomingCount = new Map<string, number>();
  for (const n of nodeById.values()) incomingCount.set(n.id, 0);
  for (const e of keptEdges) {
    incomingCount.set(e.to, (incomingCount.get(e.to) ?? 0) + 1);
  }

  const removedNodes = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const n of nodeById.values()) {
      if (removedNodes.has(n.id)) continue;
      if (!isPrunable(n)) continue;
      if ((incomingCount.get(n.id) ?? 0) > 0) continue;
      removedNodes.add(n.id);
      progress = true;
      for (const e of keptEdges) {
        if (e.from === n.id) {
          incomingCount.set(e.to, (incomingCount.get(e.to) ?? 1) - 1);
        }
      }
    }
  }

  const finalEdges = keptEdges.filter(
    (e) => !removedNodes.has(e.from) && !removedNodes.has(e.to),
  );
  const finalNodes = [...nodeById.values()].filter((n) => !removedNodes.has(n.id));

  return { ...graph, nodes: finalNodes, edges: finalEdges };
}

function shouldKeepEdge(e: GraphEdge): boolean {
  if (e.kind === 'sequence' || e.kind === 'dependency') return true;
  if (e.traveled) return true;
  return false;
}

function isPrunable(n: GraphNode): boolean {
  if (n.origin === 'runtime') return false;
  if (n.kind === 'stage' || n.kind === 'item') return false;
  if (n.kind === 'phase') return false;
  return true;
}
