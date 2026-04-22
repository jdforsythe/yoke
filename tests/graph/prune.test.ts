import { describe, it, expect } from 'vitest';
import { buildConfiguredGraph } from '../../src/server/graph/builder.js';
import { applyEvent, applyPatch } from '../../src/server/graph/apply.js';
import { pruneUntraveled } from '../../src/server/graph/prune.js';
import type { WorkflowGraph, SessionGraphNode } from '../../src/shared/types/graph.js';
import type { GraphEvent } from '../../src/server/graph/events.js';
import { multiGotoPipeline } from './fixtures.js';

function drive(graph: WorkflowGraph, events: GraphEvent[]): WorkflowGraph {
  let g = graph;
  for (const ev of events) g = applyPatch(g, applyEvent(g, ev));
  return g;
}

describe('pruneUntraveled', () => {
  it('drops the untaken goto edge but keeps the traveled goto branch and runtime sessions', () => {
    const cfg = multiGotoPipeline();
    const initial = buildConfiguredGraph('wf-prune', cfg);

    // Fire: plan → implement → review exit=1 goto implement → implement → review ok → done.
    const events: GraphEvent[] = [
      {
        kind: 'session_started',
        stageId: 'work',
        itemId: null,
        phase: 'plan',
        sessionId: 's-plan',
        attempt: 1,
        parentSessionId: null,
        startedAt: '2026-04-22T00:00:00Z',
      },
      { kind: 'session_ended', sessionId: 's-plan', endedAt: '2026-04-22T00:01:00Z', exitCode: 0 },
      {
        kind: 'session_started',
        stageId: 'work',
        itemId: null,
        phase: 'implement',
        sessionId: 's-imp-1',
        attempt: 1,
        parentSessionId: null,
        startedAt: '2026-04-22T00:02:00Z',
      },
      { kind: 'session_ended', sessionId: 's-imp-1', endedAt: '2026-04-22T00:03:00Z', exitCode: 0 },
      {
        kind: 'session_started',
        stageId: 'work',
        itemId: null,
        phase: 'review',
        sessionId: 's-rev-1',
        attempt: 1,
        parentSessionId: null,
        startedAt: '2026-04-22T00:04:00Z',
      },
      { kind: 'session_ended', sessionId: 's-rev-1', endedAt: '2026-04-22T00:05:00Z', exitCode: 1 },
      {
        kind: 'prepost_ended',
        stageId: 'work',
        itemId: null,
        phase: 'review',
        when: 'post',
        commandName: 'check-verdict',
        prepostRunId: 'run:s-rev-1:post:check-verdict:2026-04-22T00:04:30Z',
        actionTaken: { kind: 'goto', goto: 'implement', maxRevisits: 3 },
      },
      {
        kind: 'session_started',
        stageId: 'work',
        itemId: null,
        phase: 'implement',
        sessionId: 's-imp-2',
        attempt: 2,
        parentSessionId: 's-imp-1',
        startedAt: '2026-04-22T00:06:00Z',
      },
      { kind: 'session_ended', sessionId: 's-imp-2', endedAt: '2026-04-22T00:07:00Z', exitCode: 0 },
      {
        kind: 'session_started',
        stageId: 'work',
        itemId: null,
        phase: 'review',
        sessionId: 's-rev-2',
        attempt: 2,
        parentSessionId: 's-rev-1',
        startedAt: '2026-04-22T00:08:00Z',
      },
      { kind: 'session_ended', sessionId: 's-rev-2', endedAt: '2026-04-22T00:09:00Z', exitCode: 0 },
      {
        kind: 'prepost_ended',
        stageId: 'work',
        itemId: null,
        phase: 'review',
        when: 'post',
        commandName: 'check-verdict',
        prepostRunId: 'run:s-rev-2:post:check-verdict:2026-04-22T00:08:30Z',
        actionTaken: { kind: 'continue' },
      },
      { kind: 'workflow_status', status: 'completed' },
    ];

    const driven = drive(initial, events);
    const pruned = pruneUntraveled(driven);

    // The untaken goto edge (exit=2 → plan) is removed.
    const gotoPlanEdges = pruned.edges.filter(
      (e) => e.kind === 'goto' && e.to === 'phase:work:_:plan',
    );
    expect(gotoPlanEdges).toHaveLength(0);

    // The taken goto edge to implement remains and is traveled.
    const gotoImplEdges = pruned.edges.filter(
      (e) => e.kind === 'goto' && e.to === 'phase:work:_:implement',
    );
    expect(gotoImplEdges.length).toBeGreaterThanOrEqual(1);
    expect(gotoImplEdges.every((e) => e.traveled)).toBe(true);

    // Both implement sessions are retained.
    const implementSessions = pruned.nodes.filter(
      (n): n is SessionGraphNode => n.kind === 'session' && n.phaseNodeId === 'phase:work:_:implement',
    );
    expect(implementSessions.map((s) => s.sessionId).sort()).toEqual(['s-imp-1', 's-imp-2']);

    // Sequence spine (stages/phases) still present.
    expect(pruned.nodes.find((n) => n.id === 'phase:work:_:plan')).toBeDefined();
    expect(pruned.nodes.find((n) => n.id === 'phase:work:_:implement')).toBeDefined();
    expect(pruned.nodes.find((n) => n.id === 'phase:work:_:review')).toBeDefined();
  });
});
