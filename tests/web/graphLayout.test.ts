/**
 * Unit tests for the GraphPane layout engine.
 *
 * Verifies:
 *  - stage nodes are reactflow subflows (no parentId)
 *  - items are parented to their stage; phases/sessions/preposts nest one
 *    more level deep under items for per-item stages
 *  - dependency topo-order puts roots leftmost (ELK honoured the edges)
 *  - the structural-hash memo returns the same reference for identical
 *    graphs across repeated calls
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { layoutGraph, _resetLayoutCache } from '../../src/web/src/components/GraphPane/graphLayout';
import type {
  WorkflowGraph,
  GraphNode,
  GraphEdge,
} from '../../src/shared/types/graph';

function node(partial: { id: string; kind: GraphNode['kind'] } & Record<string, unknown>): GraphNode {
  const base = { label: partial.id, status: 'pending', origin: 'configured' };
  return { ...base, ...partial } as GraphNode;
}

function edge(id: string, from: string, to: string, kind: GraphEdge['kind'] = 'sequence'): GraphEdge {
  return {
    id,
    from,
    to,
    kind,
    style: kind === 'retry' || kind === 'goto' ? 'dotted' : 'solid',
    traveled: false,
  };
}

function makeFixtureGraph(): WorkflowGraph {
  // Stage 1: once, with one phase
  // Stage 2: per-item, 3 items with 2→1 dependency chain
  //   item-a  item-b (depends on item-a)  item-c (depends on item-b)
  //   each item has one implement phase + one session
  const nodes: GraphNode[] = [
    node({
      id: 's-plan',
      kind: 'stage',
      stageId: 'plan',
      run: 'once',
    }),
    node({
      id: 'p-plan-plan',
      kind: 'phase',
      stageId: 'plan',
      itemId: null,
      phase: 'plan',
    }),
    node({
      id: 's-impl',
      kind: 'stage',
      stageId: 'impl',
      run: 'per-item',
    }),
    node({
      id: 'i-a',
      kind: 'item',
      stageId: 'impl',
      itemId: 'item-a',
      stableId: 'a',
    }),
    node({
      id: 'i-b',
      kind: 'item',
      stageId: 'impl',
      itemId: 'item-b',
      stableId: 'b',
    }),
    node({
      id: 'i-c',
      kind: 'item',
      stageId: 'impl',
      itemId: 'item-c',
      stableId: 'c',
    }),
    node({
      id: 'p-a-impl',
      kind: 'phase',
      stageId: 'impl',
      itemId: 'item-a',
      phase: 'implement',
    }),
    node({
      id: 'p-b-impl',
      kind: 'phase',
      stageId: 'impl',
      itemId: 'item-b',
      phase: 'implement',
    }),
    node({
      id: 'p-c-impl',
      kind: 'phase',
      stageId: 'impl',
      itemId: 'item-c',
      phase: 'implement',
    }),
    node({
      id: 'sess-a',
      kind: 'session',
      phaseNodeId: 'p-a-impl',
      sessionId: 'sess-a',
      attempt: 1,
      parentSessionId: null,
      startedAt: '2026-04-22T00:00:00Z',
      endedAt: null,
      exitCode: null,
    }),
  ];

  const edges: GraphEdge[] = [
    edge('e-plan-impl', 's-plan', 's-impl'),
    edge('e-b-dep-a', 'i-a', 'i-b', 'dependency'),
    edge('e-c-dep-b', 'i-b', 'i-c', 'dependency'),
  ];

  return {
    version: 1,
    workflowId: 'wf-1',
    nodes,
    edges,
    finalizedAt: null,
  };
}

describe('graphLayout', () => {
  beforeEach(() => {
    _resetLayoutCache();
  });

  it('stage nodes are top-level (no parentId)', async () => {
    const graph = makeFixtureGraph();
    const out = await layoutGraph(graph);
    const stages = out.nodes.filter((n) => n.type === 'stage');
    expect(stages.length).toBe(2);
    for (const s of stages) {
      expect(s.parentId).toBeUndefined();
    }
  });

  it('item nodes are parented to their stage', async () => {
    const graph = makeFixtureGraph();
    const out = await layoutGraph(graph);
    const items = out.nodes.filter((n) => n.type === 'item');
    expect(items.length).toBe(3);
    for (const i of items) {
      expect(i.parentId).toBe('s-impl');
    }
  });

  it('phase/session nodes nest under items for per-item stages and under stage for once-stages', async () => {
    const graph = makeFixtureGraph();
    const out = await layoutGraph(graph);

    const pPlan = out.nodes.find((n) => n.id === 'p-plan-plan');
    expect(pPlan?.parentId).toBe('s-plan');

    const pA = out.nodes.find((n) => n.id === 'p-a-impl');
    expect(pA?.parentId).toBe('i-a');

    const sessA = out.nodes.find((n) => n.id === 'sess-a');
    expect(sessA?.parentId).toBe('i-a');
  });

  it('cross-item dependency edges survive the layout with valid endpoints', async () => {
    // Regression guard: dependency edges between items under a per-item stage
    // must be emitted by layoutGraph and reference real xyflow node ids, so
    // ReactFlow renders them rather than silently dropping them.
    const graph = makeFixtureGraph();
    const out = await layoutGraph(graph);

    const nodeIds = new Set(out.nodes.map((n) => n.id));

    const depEdges = out.edges.filter((e) => {
      const data = e.data as { graphEdge?: GraphEdge } | undefined;
      return data?.graphEdge?.kind === 'dependency';
    });
    expect(depEdges).toHaveLength(2);
    for (const e of depEdges) {
      expect(nodeIds.has(e.source)).toBe(true);
      expect(nodeIds.has(e.target)).toBe(true);
    }

    // Both specific dep edges are present.
    const ab = depEdges.find((e) => e.source === 'i-a' && e.target === 'i-b');
    const bc = depEdges.find((e) => e.source === 'i-b' && e.target === 'i-c');
    expect(ab).toBeDefined();
    expect(bc).toBeDefined();
  });

  it('topological ordering: dependency roots have smaller x than dependents', async () => {
    const graph = makeFixtureGraph();
    const out = await layoutGraph(graph);

    const a = out.nodes.find((n) => n.id === 'i-a');
    const b = out.nodes.find((n) => n.id === 'i-b');
    const c = out.nodes.find((n) => n.id === 'i-c');
    expect(a && b && c).toBeTruthy();

    expect(a!.position.x).toBeLessThan(b!.position.x);
    expect(b!.position.x).toBeLessThan(c!.position.x);
  });

  it('memoizes by structural hash: two calls return the same reference', async () => {
    const graph = makeFixtureGraph();
    const first = await layoutGraph(graph);
    const second = await layoutGraph(graph);
    expect(second).toBe(first);
  });

  it('per-item stage with template phases + real items: no ELK shape-reference error', async () => {
    // Regression: configured template phase nodes (itemId=null) are orphaned
    // once real items are seeded.  Edges referencing them (e.g. goto edges from
    // configured prepost nodes back to the template phase) must be filtered out
    // before being passed to ELK, otherwise ELK throws
    // "Referenced shape does not exist: phase:bootstrap:_:implement".
    const nodes: GraphNode[] = [
      node({ id: 'stage:bootstrap', kind: 'stage', stageId: 'bootstrap', run: 'per-item' }),
      // Configured template phases (itemId=null) — exist in graph.nodes but
      // should NOT appear in the ELK tree once real items are present.
      node({ id: 'phase:bootstrap:_:implement', kind: 'phase', stageId: 'bootstrap', itemId: null, phase: 'implement' }),
      node({ id: 'phase:bootstrap:_:review', kind: 'phase', stageId: 'bootstrap', itemId: null, phase: 'review' }),
      // Configured prepost with a goto action back to the template implement phase.
      node({ id: 'prepost:cfg:bootstrap:_:review:post:check-verdict', kind: 'prepost', phaseNodeId: 'phase:bootstrap:_:review', when: 'post', commandName: 'check-verdict', prepostRunId: 'cfg:bootstrap:_:review:post:check-verdict', actionTaken: null }),
      // Real items seeded at runtime.
      node({ id: 'item:bootstrap:item-x', kind: 'item', stageId: 'bootstrap', itemId: 'item-x', stableId: 'x' }),
      node({ id: 'phase:bootstrap:item-x:implement', kind: 'phase', stageId: 'bootstrap', itemId: 'item-x', phase: 'implement' }),
      node({ id: 'phase:bootstrap:item-x:review', kind: 'phase', stageId: 'bootstrap', itemId: 'item-x', phase: 'review' }),
    ];
    const edges: GraphEdge[] = [
      // Template edges (built by builder.ts at configured time).
      edge('e1', 'stage:bootstrap', 'phase:bootstrap:_:implement'),
      edge('e2', 'phase:bootstrap:_:implement', 'phase:bootstrap:_:review'),
      edge('e3', 'phase:bootstrap:_:review', 'prepost:cfg:bootstrap:_:review:post:check-verdict', 'prepost'),
      // The goto edge that was previously causing the ELK error.
      edge('e-goto', 'prepost:cfg:bootstrap:_:review:post:check-verdict', 'phase:bootstrap:_:implement', 'goto'),
      // Runtime item edges.
      edge('e4', 'stage:bootstrap', 'item:bootstrap:item-x'),
      edge('e5', 'item:bootstrap:item-x', 'phase:bootstrap:item-x:implement'),
      edge('e6', 'phase:bootstrap:item-x:implement', 'phase:bootstrap:item-x:review'),
    ];
    const graph: WorkflowGraph = { version: 1, workflowId: 'wf-reg', nodes, edges, finalizedAt: null };
    // Should not throw.
    const out = await layoutGraph(graph);
    const outNodeIds = new Set(out.nodes.map((n) => n.id));
    // Real nodes must be present; orphaned template nodes must not cause errors.
    expect(outNodeIds.has('stage:bootstrap')).toBe(true);
    expect(outNodeIds.has('item:bootstrap:item-x')).toBe(true);
    expect(outNodeIds.has('phase:bootstrap:item-x:implement')).toBe(true);
  });

  it('memoization cache differentiates structurally-distinct graphs', async () => {
    const graph = makeFixtureGraph();
    const first = await layoutGraph(graph);

    const graphExtra: WorkflowGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        node({
          id: 'sess-a-2',
          kind: 'session',
          phaseNodeId: 'p-a-impl',
          sessionId: 'sess-a-2',
          attempt: 2,
          parentSessionId: 'sess-a',
          startedAt: '2026-04-22T00:01:00Z',
          endedAt: null,
          exitCode: null,
        }),
      ],
      edges: [...graph.edges, edge('e-retry', 'sess-a', 'sess-a-2', 'retry')],
    };

    const second = await layoutGraph(graphExtra);
    expect(second).not.toBe(first);
    const retry = second.edges.find((e) => e.id === 'e-retry');
    expect(retry?.style?.strokeDasharray).toBe('4 4');
  });
});
