/**
 * Hierarchical left-to-right layout for WorkflowGraph via elkjs.
 *
 * Structure: stage nodes are xyflow subflows (no parentId). Per-item stages
 * contain item subflows (parentId = stage). Phase / session / prepost are
 * leaves — parented to their item for per-item stages, or to the stage for
 * once-stages.
 *
 * Memoization: layouts are cached by a structural hash over (node ids +
 * parent refs + edge ids). Status-only updates re-use the cached geometry
 * so the canvas doesn't lurch on every frame.
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import type { Edge, Node } from '@xyflow/react';
import type {
  WorkflowGraph,
  GraphNode,
  GraphEdge,
  SessionGraphNode,
  PhaseGraphNode,
  PrePostGraphNode,
  ItemGraphNode,
} from '../../../../shared/types/graph';

export interface LayoutedGraph {
  nodes: Node[];
  edges: Edge[];
}

export interface GraphNodeData extends Record<string, unknown> {
  graphNode: GraphNode;
}

export interface GraphEdgeData extends Record<string, unknown> {
  graphEdge: GraphEdge;
}

// Leaf node sizes (the x/y carried on xyflow nodes are leaf-local for
// subflow children; elkjs also uses these for container sizing).
const STAGE_PADDING = { top: 40, left: 16, right: 16, bottom: 16 };
const ITEM_PADDING = { top: 32, left: 12, right: 12, bottom: 12 };
const LEAF_WIDTH = 200;
const LEAF_HEIGHT = 64;
const ITEM_MIN_WIDTH = LEAF_WIDTH + ITEM_PADDING.left + ITEM_PADDING.right;
const ITEM_MIN_HEIGHT = LEAF_HEIGHT + ITEM_PADDING.top + ITEM_PADDING.bottom;

const elk = new ELK();

const _layoutCache = new Map<string, LayoutedGraph>();
const MAX_CACHE = 8;

function _structuralHash(graph: WorkflowGraph): string {
  const idx = _buildParentIndex(graph);
  const nodeKeys = graph.nodes
    .map((n) => `${n.id}:${_parentOf(n, graph, idx) ?? ''}`)
    .sort()
    .join('|');
  const edgeKeys = graph.edges
    .map((e) => `${e.id}:${e.from}->${e.to}`)
    .sort()
    .join('|');
  return `${graph.workflowId}#${nodeKeys}#${edgeKeys}`;
}

/**
 * Build reverse-lookup indices so stageId/itemId values on child nodes can
 * be resolved to the actual graph node ids (the two namespaces differ —
 * stageId='impl' but the stage node is id='stage:impl').
 */
interface ParentIndex {
  stageIdToNodeId: Map<string, string>;
  itemIdToNodeId: Map<string, string>;
  phaseById: Map<string, PhaseGraphNode>;
}

function _buildParentIndex(graph: WorkflowGraph): ParentIndex {
  const stageIdToNodeId = new Map<string, string>();
  const itemIdToNodeId = new Map<string, string>();
  const phaseById = new Map<string, PhaseGraphNode>();
  for (const n of graph.nodes) {
    if (n.kind === 'stage') stageIdToNodeId.set(n.stageId, n.id);
    else if (n.kind === 'item') itemIdToNodeId.set(n.itemId, n.id);
    else if (n.kind === 'phase') phaseById.set(n.id, n);
  }
  return { stageIdToNodeId, itemIdToNodeId, phaseById };
}

function _parentOf(node: GraphNode, graph: WorkflowGraph, idx?: ParentIndex): string | null {
  const index = idx ?? _buildParentIndex(graph);
  switch (node.kind) {
    case 'stage':
      return null;
    case 'item':
      return index.stageIdToNodeId.get(node.stageId) ?? null;
    case 'phase':
      if (node.itemId) return index.itemIdToNodeId.get(node.itemId) ?? null;
      return index.stageIdToNodeId.get(node.stageId) ?? null;
    case 'session':
      return _phaseParent(node, index);
    case 'prepost':
      return _phaseParent(node, index);
  }
}

function _phaseParent(
  node: SessionGraphNode | PrePostGraphNode,
  idx: ParentIndex,
): string | null {
  const phase = idx.phaseById.get(node.phaseNodeId);
  if (!phase) return null;
  // Sessions/preposts visually sit next to their phase, not inside it — parent
  // to whatever parents the phase (item or stage) so they share the phase's x-lane.
  if (phase.itemId) return idx.itemIdToNodeId.get(phase.itemId) ?? null;
  return idx.stageIdToNodeId.get(phase.stageId) ?? null;
}

interface ElkChild {
  id: string;
  width?: number;
  height?: number;
  children?: ElkChild[];
  edges?: ElkLayoutEdge[];
  layoutOptions?: Record<string, string>;
}

interface ElkLayoutEdge {
  id: string;
  sources: string[];
  targets: string[];
}

interface ElkResultNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkResultNode[];
}

/**
 * Partition edges by the subgraph they live in: stage-level dependency/sequence
 * edges between items go under the stage; inter-stage sequence edges go at
 * the root; session↔session stay where they were emitted. Parenting an edge
 * deeper than the LCA of its endpoints makes ELK silently drop it.
 */
function _partitionEdges(
  graph: WorkflowGraph,
  nodeIndex: Map<string, GraphNode>,
  pidx: ParentIndex,
): Map<string, GraphEdge[]> {
  const bucket = new Map<string, GraphEdge[]>(); // key '' = root
  const push = (scope: string, e: GraphEdge) => {
    let list = bucket.get(scope);
    if (!list) {
      list = [];
      bucket.set(scope, list);
    }
    list.push(e);
  };

  for (const edge of graph.edges) {
    const from = nodeIndex.get(edge.from);
    const to = nodeIndex.get(edge.to);
    if (!from || !to) continue;
    const fromParent = _parentOf(from, graph, pidx);
    const toParent = _parentOf(to, graph, pidx);

    if (fromParent === toParent) {
      push(fromParent ?? '', edge);
      continue;
    }

    // Different parents → place the edge at the lowest common ancestor. For
    // this tree (root → stage → item → leaves) the LCA is either the shared
    // grandparent (stage) or root.
    const fromChain = _ancestors(from.id, graph, nodeIndex, pidx);
    const toChain = _ancestors(to.id, graph, nodeIndex, pidx);
    const lca = _lca(fromChain, toChain);
    push(lca, edge);
  }
  return bucket;
}

function _ancestors(
  id: string,
  graph: WorkflowGraph,
  nodeIndex: Map<string, GraphNode>,
  pidx: ParentIndex,
): string[] {
  const chain: string[] = [];
  let cur: string | null = id;
  while (cur) {
    const node = nodeIndex.get(cur);
    if (!node) break;
    const parent = _parentOf(node, graph, pidx);
    chain.push(parent ?? '');
    cur = parent;
  }
  return chain;
}

function _lca(a: string[], b: string[]): string {
  const setA = new Set(a);
  for (const candidate of b) if (setA.has(candidate)) return candidate;
  return '';
}

/** Build the hierarchical ELK input tree. */
function _buildElkTree(graph: WorkflowGraph): ElkChild {
  const nodeIndex = new Map<string, GraphNode>();
  for (const n of graph.nodes) nodeIndex.set(n.id, n);
  const pidx = _buildParentIndex(graph);

  const bucket = _partitionEdges(graph, nodeIndex, pidx);

  const makeLeaf = (n: GraphNode): ElkChild => ({
    id: n.id,
    width: LEAF_WIDTH,
    height: LEAF_HEIGHT,
  });

  const phaseBuckets = new Map<string, GraphNode[]>(); // parentKey -> phases/sessions/preposts
  const addUnderParent = (parentKey: string, n: GraphNode) => {
    let list = phaseBuckets.get(parentKey);
    if (!list) {
      list = [];
      phaseBuckets.set(parentKey, list);
    }
    list.push(n);
  };

  const items = graph.nodes.filter((n): n is ItemGraphNode => n.kind === 'item');
  const itemChildren = new Map<string, GraphNode[]>();
  for (const it of items) itemChildren.set(it.id, []);

  for (const n of graph.nodes) {
    if (n.kind === 'stage' || n.kind === 'item') continue;
    const parent = _parentOf(n, graph, pidx);
    if (parent === null) continue;
    if (itemChildren.has(parent)) itemChildren.get(parent)!.push(n);
    else addUnderParent(parent, n);
  }

  const stages = graph.nodes.filter((n): n is Extract<GraphNode, { kind: 'stage' }> => n.kind === 'stage');

  // Configured template nodes (phases/preposts with itemId=null) for per-item
  // stages that already have real items are placed in phaseBuckets but NOT added
  // to the ELK tree (the stage switches to item-subflow layout). Any edges
  // referencing them must be filtered out or ELK throws
  // "Referenced shape does not exist".
  const orphanedNodeIds = new Set<string>();
  for (const s of stages) {
    if (items.some((it) => it.stageId === s.stageId)) {
      for (const n of phaseBuckets.get(s.id) ?? []) orphanedNodeIds.add(n.id);
    }
  }
  const notOrphaned = (e: GraphEdge) =>
    !orphanedNodeIds.has(e.from) && !orphanedNodeIds.has(e.to);

  const stageChildren: ElkChild[] = stages.map((s) => {
    const owns = items.filter((it) => it.stageId === s.stageId);
    const children: ElkChild[] = [];
    if (owns.length > 0) {
      for (const it of owns) {
        const kids = itemChildren.get(it.id) ?? [];
        const itemSubEdges = (bucket.get(it.id) ?? []).map((e) => ({
          id: e.id,
          sources: [e.from],
          targets: [e.to],
        }));
        children.push({
          id: it.id,
          width: ITEM_MIN_WIDTH,
          height: ITEM_MIN_HEIGHT,
          layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.padding': `[top=${ITEM_PADDING.top},left=${ITEM_PADDING.left},bottom=${ITEM_PADDING.bottom},right=${ITEM_PADDING.right}]`,
            'elk.layered.spacing.nodeNodeBetweenLayers': '40',
            'elk.spacing.nodeNode': '24',
          },
          children: kids.map(makeLeaf),
          edges: itemSubEdges,
        });
      }
    } else {
      const kids = phaseBuckets.get(s.id) ?? [];
      for (const k of kids) children.push(makeLeaf(k));
    }

    const stageSubEdges = (bucket.get(s.id) ?? []).filter(notOrphaned).map((e) => ({
      id: e.id,
      sources: [e.from],
      targets: [e.to],
    }));

    return {
      id: s.id,
      width: LEAF_WIDTH,
      height: LEAF_HEIGHT,
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.padding': `[top=${STAGE_PADDING.top},left=${STAGE_PADDING.left},bottom=${STAGE_PADDING.bottom},right=${STAGE_PADDING.right}]`,
        'elk.layered.spacing.nodeNodeBetweenLayers': '60',
        'elk.spacing.nodeNode': '32',
      },
      children,
      edges: stageSubEdges,
    };
  });

  const rootEdges = (bucket.get('') ?? []).filter(notOrphaned).map((e) => ({
    id: e.id,
    sources: [e.from],
    targets: [e.to],
  }));

  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.spacing.nodeNode': '40',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      // Allow root-level edges to reference nested children (e.g. a run:once
      // stage → nested-phase sequence edge).  Without this, ELK throws
      // UnsupportedGraphException when the edge's endpoints are at different
      // hierarchy levels.
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    },
    children: stageChildren,
    edges: rootEdges,
  };
}

function _edgeStyle(edge: GraphEdge): Edge['style'] {
  if (edge.style === 'dotted') {
    return { strokeDasharray: '4 4', stroke: '#94a3b8' };
  }
  const stroke =
    edge.kind === 'dependency'
      ? '#60a5fa'
      : edge.kind === 'prepost'
        ? '#a78bfa'
        : '#cbd5e1';
  return { stroke };
}

function _walkPositions(
  root: ElkResultNode,
  out: Map<string, { x: number; y: number; width: number; height: number }>,
): void {
  if (root.children) {
    for (const c of root.children) {
      out.set(c.id, {
        x: c.x ?? 0,
        y: c.y ?? 0,
        width: c.width ?? LEAF_WIDTH,
        height: c.height ?? LEAF_HEIGHT,
      });
      _walkPositions(c, out);
    }
  }
}

function _toRfNodes(
  graph: WorkflowGraph,
  positions: Map<string, { x: number; y: number; width: number; height: number }>,
): Node[] {
  const pidx = _buildParentIndex(graph);
  const result: Node[] = [];
  const order: GraphNode['kind'][] = ['stage', 'item', 'phase', 'session', 'prepost'];
  // xyflow requires parents to be declared before their children in the array.
  const nodes = [...graph.nodes].sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
  );

  for (const n of nodes) {
    const pos = positions.get(n.id) ?? { x: 0, y: 0, width: LEAF_WIDTH, height: LEAF_HEIGHT };
    const parent = _parentOf(n, graph, pidx);

    const base: Node = {
      id: n.id,
      type:
        n.kind === 'stage'
          ? 'stage'
          : n.kind === 'item'
            ? 'item'
            : n.kind === 'phase'
              ? 'phase'
              : n.kind === 'session'
                ? 'session'
                : 'prepost',
      position: { x: pos.x, y: pos.y },
      data: { graphNode: n } satisfies GraphNodeData,
    };

    base.style = { width: pos.width, height: pos.height };
    // xyflow v12 MiniMap reads node.width/node.height directly (not from
    // style) when computing the mini overview. Without these, nodes
    // disappear from the minimap when they live inside a subflow parent.
    base.width = pos.width;
    base.height = pos.height;

    if (parent) {
      base.parentId = parent;
      base.extent = 'parent';
    }

    result.push(base);
  }
  return result;
}

function _toRfEdges(graph: WorkflowGraph): Edge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    type: 'smoothstep',
    label: e.actionLabel,
    labelStyle: { fontSize: 10, fill: '#cbd5e1' },
    labelBgStyle: { fill: '#1f2937' },
    labelBgPadding: [4, 2] as [number, number],
    style: _edgeStyle(e),
    data: { graphEdge: e } satisfies GraphEdgeData,
  }));
}

export async function layoutGraph(graph: WorkflowGraph): Promise<LayoutedGraph> {
  const hash = _structuralHash(graph);
  const cached = _layoutCache.get(hash);
  if (cached) return cached;

  const tree = _buildElkTree(graph);
  const laidOut = (await elk.layout(tree as ElkResultNode)) as ElkResultNode;

  const positions = new Map<string, { x: number; y: number; width: number; height: number }>();
  _walkPositions(laidOut, positions);

  const rfNodes = _toRfNodes(graph, positions);
  const rfEdges = _toRfEdges(graph);

  const result: LayoutedGraph = { nodes: rfNodes, edges: rfEdges };

  if (_layoutCache.size >= MAX_CACHE) {
    const firstKey = _layoutCache.keys().next().value;
    if (firstKey !== undefined) _layoutCache.delete(firstKey);
  }
  _layoutCache.set(hash, result);
  return result;
}

/** Test-only: flush the layout cache between test cases. */
export function _resetLayoutCache(): void {
  _layoutCache.clear();
}

export const _internal = {
  structuralHash: _structuralHash,
  parentOf: _parentOf,
};
