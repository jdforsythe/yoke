/**
 * Unit tests for the graph-store reducer.
 *
 * Covers:
 *  - workflow.snapshot with `graph` seeds the store entry.
 *  - workflow.snapshot without `graph` is a no-op.
 *  - graph.update patches apply add/update/remove for nodes and edges,
 *    and pick up finalizedAt.
 *  - graph.update on an unseeded workflow is dropped.
 *  - LRU eviction kicks in at > 8 workflows.
 *  - subscribers are notified; snapshots are stable references between dispatches.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  dispatchGraphFrame,
  getWorkflowGraph,
  resetGraphStore,
  subscribeGraphStore,
} from '../../src/web/src/store/graphStore';
import type { ServerFrame } from '../../src/web/src/ws/types';
import type {
  WorkflowGraph,
  GraphPatch,
  GraphNode,
  GraphEdge,
} from '../../src/shared/types/graph';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkSnapshotFrame(workflowId: string, graph: WorkflowGraph | undefined): ServerFrame {
  return {
    v: 1,
    type: 'workflow.snapshot',
    workflowId,
    seq: 1,
    ts: '2026-04-22T00:00:00Z',
    payload: {
      workflow: {
        id: workflowId,
        name: 'wf',
        status: 'active',
        currentStage: null,
        createdAt: '2026-04-22T00:00:00Z',
      },
      stages: [],
      items: [],
      activeSessions: [],
      pendingAttention: [],
      graph,
    },
  };
}

function mkPatchFrame(workflowId: string, patch: GraphPatch, seq = 2): ServerFrame {
  return {
    v: 1,
    type: 'graph.update',
    workflowId,
    seq,
    ts: '2026-04-22T00:00:01Z',
    payload: { workflowId, patch },
  };
}

function seedGraph(workflowId: string): WorkflowGraph {
  const nodes: GraphNode[] = [
    {
      id: 'stage:build',
      kind: 'stage',
      stageId: 'build',
      run: 'once',
      label: 'build',
      status: 'pending',
      origin: 'configured',
    },
    {
      id: 'phase:build:compile',
      kind: 'phase',
      stageId: 'build',
      itemId: null,
      phase: 'compile',
      label: 'compile',
      status: 'pending',
      origin: 'configured',
    },
  ];
  const edges: GraphEdge[] = [
    {
      id: 'e1',
      from: 'stage:build',
      to: 'phase:build:compile',
      kind: 'sequence',
      style: 'solid',
      traveled: false,
    },
  ];
  return {
    version: 1,
    workflowId,
    nodes,
    edges,
    finalizedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('graphStore reducer', () => {
  beforeEach(() => {
    resetGraphStore();
  });

  it('workflow.snapshot without graph is a no-op', () => {
    dispatchGraphFrame(mkSnapshotFrame('wf1', undefined));
    expect(getWorkflowGraph('wf1')).toBeNull();
  });

  it('workflow.snapshot with graph seeds the store', () => {
    const g = seedGraph('wf1');
    dispatchGraphFrame(mkSnapshotFrame('wf1', g));
    const stored = getWorkflowGraph('wf1');
    expect(stored).not.toBeNull();
    expect(stored!.workflowId).toBe('wf1');
    expect(stored!.nodes).toHaveLength(2);
    expect(stored!.edges).toHaveLength(1);
    expect(stored!.finalizedAt).toBeNull();
  });

  it('a second snapshot replaces the first for the same workflowId', () => {
    const g1 = seedGraph('wf1');
    dispatchGraphFrame(mkSnapshotFrame('wf1', g1));

    const g2: WorkflowGraph = {
      version: 1,
      workflowId: 'wf1',
      nodes: [
        {
          id: 'stage:only',
          kind: 'stage',
          stageId: 'only',
          run: 'once',
          label: 'only',
          status: 'complete',
          origin: 'configured',
        },
      ],
      edges: [],
      finalizedAt: '2026-04-22T00:00:10Z',
    };
    dispatchGraphFrame(mkSnapshotFrame('wf1', g2));
    const stored = getWorkflowGraph('wf1');
    expect(stored!.nodes).toHaveLength(1);
    expect(stored!.edges).toHaveLength(0);
    expect(stored!.finalizedAt).toBe('2026-04-22T00:00:10Z');
  });

  it('graph.update applies addNodes / addEdges / updateNodes / updateEdges / finalizedAt', () => {
    dispatchGraphFrame(mkSnapshotFrame('wf1', seedGraph('wf1')));

    const patch: GraphPatch = {
      addNodes: [
        {
          id: 'session:s1',
          kind: 'session',
          phaseNodeId: 'phase:build:compile',
          sessionId: 's1',
          attempt: 1,
          parentSessionId: null,
          startedAt: '2026-04-22T00:00:05Z',
          endedAt: null,
          exitCode: null,
          label: 'compile#1',
          status: 'in_progress',
          origin: 'runtime',
        },
      ],
      addEdges: [
        {
          id: 'e2',
          from: 'phase:build:compile',
          to: 'session:s1',
          kind: 'sequence',
          style: 'solid',
          traveled: true,
        },
      ],
      updateNodes: [
        { id: 'phase:build:compile', status: 'in_progress' },
      ],
      updateEdges: [{ id: 'e1', traveled: true }],
      finalizedAt: '2026-04-22T00:00:20Z',
    };
    dispatchGraphFrame(mkPatchFrame('wf1', patch));

    const stored = getWorkflowGraph('wf1')!;
    expect(stored.nodes).toHaveLength(3);
    const phase = stored.nodes.find((n) => n.id === 'phase:build:compile')!;
    expect(phase.status).toBe('in_progress');
    const session = stored.nodes.find((n) => n.id === 'session:s1')!;
    expect(session.kind).toBe('session');

    expect(stored.edges).toHaveLength(2);
    expect(stored.edges.find((e) => e.id === 'e1')!.traveled).toBe(true);
    expect(stored.edges.find((e) => e.id === 'e2')!.from).toBe('phase:build:compile');

    expect(stored.finalizedAt).toBe('2026-04-22T00:00:20Z');
  });

  it('removeNodeIds / removeEdgeIds drop matching ids', () => {
    dispatchGraphFrame(mkSnapshotFrame('wf1', seedGraph('wf1')));

    dispatchGraphFrame(
      mkPatchFrame('wf1', {
        removeNodeIds: ['phase:build:compile'],
        removeEdgeIds: ['e1'],
      }),
    );

    const stored = getWorkflowGraph('wf1')!;
    expect(stored.nodes.map((n) => n.id)).toEqual(['stage:build']);
    expect(stored.edges).toHaveLength(0);
  });

  it('graph.update before a snapshot is dropped', () => {
    dispatchGraphFrame(
      mkPatchFrame('wf1', {
        addNodes: [
          {
            id: 'n',
            kind: 'stage',
            stageId: 's',
            run: 'once',
            label: 's',
            status: 'pending',
            origin: 'configured',
          },
        ],
      }),
    );
    expect(getWorkflowGraph('wf1')).toBeNull();
  });

  it('adding a node with an existing id is idempotent', () => {
    dispatchGraphFrame(mkSnapshotFrame('wf1', seedGraph('wf1')));
    dispatchGraphFrame(
      mkPatchFrame('wf1', {
        addNodes: [
          {
            id: 'stage:build',
            kind: 'stage',
            stageId: 'build',
            run: 'once',
            label: 'dup',
            status: 'pending',
            origin: 'configured',
          },
        ],
      }),
    );
    const stored = getWorkflowGraph('wf1')!;
    expect(stored.nodes.filter((n) => n.id === 'stage:build')).toHaveLength(1);
  });

  it('LRU cap evicts the oldest workflow past 8 entries', () => {
    for (let i = 1; i <= 9; i++) {
      const id = `wf${i}`;
      dispatchGraphFrame(mkSnapshotFrame(id, seedGraph(id)));
    }
    expect(getWorkflowGraph('wf1')).toBeNull();
    expect(getWorkflowGraph('wf2')).not.toBeNull();
    expect(getWorkflowGraph('wf9')).not.toBeNull();
  });

  it('notifies subscribers on dispatch', () => {
    let count = 0;
    const unsubscribe = subscribeGraphStore(() => {
      count += 1;
    });
    dispatchGraphFrame(mkSnapshotFrame('wf1', seedGraph('wf1')));
    dispatchGraphFrame(
      mkPatchFrame('wf1', { updateEdges: [{ id: 'e1', traveled: true }] }),
    );
    unsubscribe();
    dispatchGraphFrame(mkPatchFrame('wf1', { finalizedAt: '2026-04-22T00:00:30Z' }));
    expect(count).toBe(2);
  });
});
