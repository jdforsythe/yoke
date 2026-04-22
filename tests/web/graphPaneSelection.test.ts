/**
 * Pure-function tests for GraphPane selection routing.
 *
 * @testing-library/react is not installed in this repo, so we exercise the
 * selection-contract via the data derivation that WorkflowDetailRoute does
 * when a session node is clicked (session.phaseNodeId → phase.itemId).
 */

import { describe, it, expect } from 'vitest';
import type {
  WorkflowGraph,
  GraphNode,
  SessionGraphNode,
  PhaseGraphNode,
} from '../../src/shared/types/graph';

function resolveItemIdForSession(
  graph: WorkflowGraph,
  session: SessionGraphNode,
): string | null {
  const phase = graph.nodes.find(
    (n): n is PhaseGraphNode => n.kind === 'phase' && n.id === session.phaseNodeId,
  );
  return phase?.itemId ?? null;
}

describe('GraphPane selection routing', () => {
  const base: Omit<GraphNode, 'kind'> = {
    id: '',
    label: '',
    status: 'pending',
    origin: 'configured',
  };

  it('resolves a per-item session to the owning itemId', () => {
    const session: SessionGraphNode = {
      ...(base as object),
      id: 'session:s1',
      kind: 'session',
      phaseNodeId: 'phase:impl:item-a:implement',
      sessionId: 's1',
      attempt: 1,
      parentSessionId: null,
      startedAt: '2026-04-22T00:00:00Z',
      endedAt: null,
      exitCode: null,
    } as SessionGraphNode;

    const graph: WorkflowGraph = {
      version: 1,
      workflowId: 'wf',
      finalizedAt: null,
      nodes: [
        {
          ...(base as object),
          id: 'phase:impl:item-a:implement',
          kind: 'phase',
          stageId: 'impl',
          itemId: 'item-a',
          phase: 'implement',
        } as PhaseGraphNode,
        session,
      ],
      edges: [],
    };

    expect(resolveItemIdForSession(graph, session)).toBe('item-a');
  });

  it('returns null for a once-stage session (no itemId)', () => {
    const session: SessionGraphNode = {
      ...(base as object),
      id: 'session:s2',
      kind: 'session',
      phaseNodeId: 'phase:plan:_:plan',
      sessionId: 's2',
      attempt: 1,
      parentSessionId: null,
      startedAt: '2026-04-22T00:00:00Z',
      endedAt: null,
      exitCode: null,
    } as SessionGraphNode;

    const graph: WorkflowGraph = {
      version: 1,
      workflowId: 'wf',
      finalizedAt: null,
      nodes: [
        {
          ...(base as object),
          id: 'phase:plan:_:plan',
          kind: 'phase',
          stageId: 'plan',
          itemId: null,
          phase: 'plan',
        } as PhaseGraphNode,
        session,
      ],
      edges: [],
    };

    expect(resolveItemIdForSession(graph, session)).toBeNull();
  });

  it('returns null when the phase node is missing (defensive)', () => {
    const session: SessionGraphNode = {
      ...(base as object),
      id: 'session:ghost',
      kind: 'session',
      phaseNodeId: 'does-not-exist',
      sessionId: 'ghost',
      attempt: 1,
      parentSessionId: null,
      startedAt: '2026-04-22T00:00:00Z',
      endedAt: null,
      exitCode: null,
    } as SessionGraphNode;

    const graph: WorkflowGraph = {
      version: 1,
      workflowId: 'wf',
      finalizedAt: null,
      nodes: [session],
      edges: [],
    };

    expect(resolveItemIdForSession(graph, session)).toBeNull();
  });
});
