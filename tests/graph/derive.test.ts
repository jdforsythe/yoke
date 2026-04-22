import { describe, it, expect } from 'vitest';
import { buildConfiguredGraph } from '../../src/server/graph/builder.js';
import { applyEvent, applyPatch } from '../../src/server/graph/apply.js';
import {
  deriveFromHistory,
  prepostRunId,
  type HistoryItemRow,
  type HistorySessionRow,
  type HistoryPrepostRow,
} from '../../src/server/graph/derive.js';
import type { WorkflowGraph } from '../../src/shared/types/graph.js';
import type { GraphEvent } from '../../src/server/graph/events.js';
import { implementReviewWithGoto } from './fixtures.js';

function drive(initial: WorkflowGraph, events: GraphEvent[]): WorkflowGraph {
  let g = initial;
  for (const ev of events) g = applyPatch(g, applyEvent(g, ev));
  return g;
}

function normalize(g: WorkflowGraph): WorkflowGraph {
  return {
    ...g,
    nodes: [...g.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: [...g.edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

describe('deriveFromHistory', () => {
  it('one-shot rebuild matches incremental applyEvent stream for the same history', () => {
    const cfg = implementReviewWithGoto();

    const events: GraphEvent[] = [
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
        prepostRunId: prepostRunId('s2', 'post', 'check-verdict', '2026-04-22T10:02:30Z'),
        actionTaken: { kind: 'continue' },
      },
      { kind: 'workflow_status', status: 'completed' },
    ];

    const incremental = drive(buildConfiguredGraph('wf-1', cfg), events);

    const items: HistoryItemRow[] = [];
    const sessions: HistorySessionRow[] = [
      {
        id: 's1',
        itemId: null,
        stage: 'work',
        phase: 'implement',
        attempt: 1,
        parentSessionId: null,
        startedAt: '2026-04-22T10:00:00Z',
        endedAt: '2026-04-22T10:01:00Z',
        exitCode: 0,
      },
      {
        id: 's2',
        itemId: null,
        stage: 'work',
        phase: 'review',
        attempt: 1,
        parentSessionId: null,
        startedAt: '2026-04-22T10:02:00Z',
        endedAt: '2026-04-22T10:03:00Z',
        exitCode: 0,
      },
    ];
    const prepostRuns: HistoryPrepostRow[] = [
      {
        sessionId: 's2',
        stage: 'work',
        phase: 'review',
        itemId: null,
        when: 'post',
        commandName: 'check-verdict',
        startedAt: '2026-04-22T10:02:30Z',
        endedAt: '2026-04-22T10:02:31Z',
        actionTaken: 'continue',
      },
    ];

    const derived = deriveFromHistory({
      workflowId: 'wf-1',
      pipeline: cfg.pipeline,
      phases: cfg.phases,
      items,
      sessions,
      prepostRuns,
      workflowStatus: 'completed',
    });

    // finalizedAt comes from applyEvent(workflow_status:completed), which uses
    // new Date().toISOString() — we normalize it before comparing.
    const a = normalize({ ...incremental, finalizedAt: null });
    const b = normalize({ ...derived, finalizedAt: null });
    expect(b.nodes).toEqual(a.nodes);
    expect(b.edges).toEqual(a.edges);
  });
});
