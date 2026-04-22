import { describe, it, expect } from 'vitest';
import { buildConfiguredGraph } from '../../src/server/graph/builder.js';
import { applyEvent, applyPatch } from '../../src/server/graph/apply.js';
import type { WorkflowGraph, SessionGraphNode, PhaseGraphNode, PrePostGraphNode } from '../../src/shared/types/graph.js';
import type { GraphEvent } from '../../src/server/graph/events.js';
import { implementReviewWithGoto } from './fixtures.js';

function drive(graph: WorkflowGraph, events: GraphEvent[]): WorkflowGraph {
  let g = graph;
  for (const ev of events) g = applyPatch(g, applyEvent(g, ev));
  return g;
}

describe('applyEvent — session stacking on post-command goto', () => {
  it('second implement session stacks under the same phase node; prepost→implement goto edge is dotted and traveled; no new phase nodes added', () => {
    const cfg = implementReviewWithGoto();
    const initial = buildConfiguredGraph('wf-1', cfg);

    const phaseNodesBefore = initial.nodes.filter((n) => n.kind === 'phase');
    const implementPhaseId = 'phase:work:_:implement';
    const reviewPhaseId = 'phase:work:_:review';

    const events: GraphEvent[] = [
      { kind: 'stage_started', stageId: 'work' },
      {
        kind: 'session_started',
        stageId: 'work',
        itemId: null,
        phase: 'implement',
        sessionId: 's1',
        attempt: 1,
        parentSessionId: null,
        startedAt: '2026-04-22T10:00:00Z',
      },
      { kind: 'session_ended', sessionId: 's1', endedAt: '2026-04-22T10:01:00Z', exitCode: 0 },
      {
        kind: 'session_started',
        stageId: 'work',
        itemId: null,
        phase: 'review',
        sessionId: 's2',
        attempt: 1,
        parentSessionId: null,
        startedAt: '2026-04-22T10:02:00Z',
      },
      { kind: 'session_ended', sessionId: 's2', endedAt: '2026-04-22T10:03:00Z', exitCode: 0 },
      {
        kind: 'prepost_ended',
        stageId: 'work',
        itemId: null,
        phase: 'review',
        when: 'post',
        commandName: 'check-verdict',
        prepostRunId: 'run:s2:post:check-verdict:2026-04-22T10:02:30Z',
        actionTaken: { kind: 'goto', goto: 'implement', maxRevisits: 3 },
      },
      {
        kind: 'session_started',
        stageId: 'work',
        itemId: null,
        phase: 'implement',
        sessionId: 's3',
        attempt: 2,
        parentSessionId: 's1',
        startedAt: '2026-04-22T10:04:00Z',
      },
      { kind: 'session_ended', sessionId: 's3', endedAt: '2026-04-22T10:05:00Z', exitCode: 0 },
      {
        kind: 'session_started',
        stageId: 'work',
        itemId: null,
        phase: 'review',
        sessionId: 's4',
        attempt: 2,
        parentSessionId: 's2',
        startedAt: '2026-04-22T10:06:00Z',
      },
      { kind: 'session_ended', sessionId: 's4', endedAt: '2026-04-22T10:07:00Z', exitCode: 0 },
      { kind: 'stage_complete', stageId: 'work' },
      { kind: 'workflow_status', status: 'completed' },
    ];

    const final = drive(initial, events);

    // No new phase nodes added (retries stack under existing phase).
    const phaseNodesAfter = final.nodes.filter((n) => n.kind === 'phase');
    expect(phaseNodesAfter).toHaveLength(phaseNodesBefore.length);

    // Two session nodes under implement phase (s1, s3).
    const implementSessions = final.nodes.filter(
      (n): n is SessionGraphNode => n.kind === 'session' && n.phaseNodeId === implementPhaseId,
    );
    expect(implementSessions.map((s) => s.sessionId).sort()).toEqual(['s1', 's3']);

    // Configured goto edge now traveled:true (prune test exercises the flag more).
    // Alternatively a new runtime-origin dotted goto from the prepost to the implement phase.
    const gotoEdges = final.edges.filter(
      (e) => e.kind === 'goto' && e.to === implementPhaseId,
    );
    expect(gotoEdges.length).toBeGreaterThanOrEqual(1);
    expect(gotoEdges.some((e) => e.traveled && e.style === 'dotted')).toBe(true);

    // The review phase must still exist unchanged aside from status.
    const review = final.nodes.find((n) => n.id === reviewPhaseId) as PhaseGraphNode | undefined;
    expect(review).toBeDefined();
    expect(review?.kind).toBe('phase');

    // The prepost node has its actionTaken populated.
    const prepost = final.nodes.find(
      (n): n is PrePostGraphNode => n.kind === 'prepost' && n.commandName === 'check-verdict',
    );
    expect(prepost?.actionTaken?.kind).toBe('goto');
    expect(prepost?.actionTaken?.goto).toBe('implement');

    // Phase rollup: after terminal sessions, phase status matches the latest session.
    const implement = final.nodes.find((n) => n.id === implementPhaseId) as PhaseGraphNode | undefined;
    expect(implement?.status).toBe('complete');
    expect(review?.status).toBe('complete');
  });

  it('phase status rolls up to abandoned when latest session exits non-zero, then back to in_progress on retry', () => {
    const cfg = implementReviewWithGoto();
    const g0 = buildConfiguredGraph('wf-2', cfg);
    const phaseId = 'phase:work:_:implement';

    const g1 = drive(g0, [
      { kind: 'stage_started', stageId: 'work' },
      {
        kind: 'session_started',
        stageId: 'work',
        itemId: null,
        phase: 'implement',
        sessionId: 'a1',
        attempt: 1,
        parentSessionId: null,
        startedAt: '2026-04-22T10:00:00Z',
      },
      { kind: 'session_ended', sessionId: 'a1', endedAt: '2026-04-22T10:01:00Z', exitCode: 1 },
    ]);
    expect((g1.nodes.find((n) => n.id === phaseId) as PhaseGraphNode).status).toBe('abandoned');

    const g2 = drive(g1, [
      {
        kind: 'session_started',
        stageId: 'work',
        itemId: null,
        phase: 'implement',
        sessionId: 'a2',
        attempt: 2,
        parentSessionId: 'a1',
        startedAt: '2026-04-22T10:02:00Z',
      },
    ]);
    expect((g2.nodes.find((n) => n.id === phaseId) as PhaseGraphNode).status).toBe('in_progress');

    const g3 = drive(g2, [
      { kind: 'session_ended', sessionId: 'a2', endedAt: '2026-04-22T10:03:00Z', exitCode: 0 },
    ]);
    expect((g3.nodes.find((n) => n.id === phaseId) as PhaseGraphNode).status).toBe('complete');
  });
});
