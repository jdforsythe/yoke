/**
 * Regression: once-stages do not have item nodes in the graph, but ingest
 * (createWorkflow) seeds an items row for them and subsequent session/prepost
 * rows carry that itemId. Without normalization in deriveFromHistory, the
 * runtime phase id would become `phase:<stage>:<itemId>:<phase>` parented to a
 * non-existent item node, leaving an orphan and causing ELK to throw
 * "Referenced shape does not exist" on layout.
 *
 * See `normalizeItemId` inside `buildEventStream` in src/server/graph/derive.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveFromHistory,
  prepostRunId,
  type HistoryItemRow,
  type HistorySessionRow,
  type HistoryPrepostRow,
} from '../../src/server/graph/derive.js';
import type { Pipeline, Phase } from '../../src/shared/types/config.js';
import { makePhase } from './fixtures.js';

function mixedPipeline(): { pipeline: Pipeline; phases: Record<string, Phase> } {
  return {
    pipeline: {
      stages: [
        { id: 'plan', run: 'once', phases: ['plan'] },
        {
          id: 'impl',
          run: 'per-item',
          phases: ['implement'],
          items_from: 'items.json',
          items_list: '$.items',
          items_id: '$.id',
        },
      ],
    },
    phases: {
      plan: makePhase({
        post: [
          {
            name: 'check-verdict',
            run: ['bash', '-c', 'true'],
            actions: { '0': 'continue' },
          },
        ],
      }),
      implement: makePhase(),
    },
  };
}

describe('deriveFromHistory once-stage itemId normalization', () => {
  it('collapses runtime nodes onto the configured once-stage phase even when storage rows carry an itemId', () => {
    const cfg = mixedPipeline();

    // Mimic ingest.ts: once-stages still get an items row with a synthetic id.
    const onceItemId = 'once-plan-item';
    const perItemId = 'item-A';

    const items: HistoryItemRow[] = [
      {
        id: onceItemId,
        stageId: 'plan',
        stableId: null,
        status: 'completed',
        currentPhase: null,
        dependsOn: null,
      },
      {
        id: perItemId,
        stageId: 'impl',
        stableId: 'A',
        status: 'completed',
        currentPhase: null,
        dependsOn: null,
      },
    ];

    const sessions: HistorySessionRow[] = [
      {
        id: 's-once',
        itemId: onceItemId, // production scenario: once-stage session carries itemId
        stage: 'plan',
        phase: 'plan',
        attempt: 1,
        parentSessionId: null,
        startedAt: '2026-04-22T10:00:00Z',
        endedAt: '2026-04-22T10:01:00Z',
        exitCode: 0,
      },
      {
        id: 's-per-item',
        itemId: perItemId,
        stage: 'impl',
        phase: 'implement',
        attempt: 1,
        parentSessionId: null,
        startedAt: '2026-04-22T10:02:00Z',
        endedAt: '2026-04-22T10:03:00Z',
        exitCode: 0,
      },
    ];

    const prepostRuns: HistoryPrepostRow[] = [
      {
        sessionId: 's-once',
        stage: 'plan',
        phase: 'plan',
        itemId: onceItemId, // ditto for prepost rows
        when: 'post',
        commandName: 'check-verdict',
        startedAt: '2026-04-22T10:00:30Z',
        endedAt: '2026-04-22T10:00:31Z',
        actionTaken: 'continue',
      },
    ];

    const graph = deriveFromHistory({
      workflowId: 'wf-1',
      pipeline: cfg.pipeline,
      phases: cfg.phases,
      items,
      sessions,
      prepostRuns,
      workflowStatus: 'completed',
    });

    const nodeIds = new Set(graph.nodes.map((n) => n.id));

    // Configured once-stage phase node exists with the canonical id.
    const onceConfiguredPhaseId = 'phase:plan:_:plan';
    expect(nodeIds.has(onceConfiguredPhaseId)).toBe(true);

    // No phantom phase node parented to the synthetic once-stage item.
    const phantomPhaseId = `phase:plan:${onceItemId}:plan`;
    expect(nodeIds.has(phantomPhaseId)).toBe(false);

    // Once-stage session points at the configured phase, not an orphan.
    const onceSession = graph.nodes.find((n) => n.id === 'session:s-once');
    expect(onceSession).toBeDefined();
    expect(onceSession?.kind).toBe('session');
    if (onceSession?.kind === 'session') {
      expect(onceSession.phaseNodeId).toBe(onceConfiguredPhaseId);
    }

    // Once-stage prepost likewise parents to the configured phase.
    const oncePrepostId = `prepost:${prepostRunId('s-once', 'post', 'check-verdict', '2026-04-22T10:00:30Z')}`;
    const oncePrepost = graph.nodes.find((n) => n.id === oncePrepostId);
    expect(oncePrepost).toBeDefined();
    if (oncePrepost?.kind === 'prepost') {
      expect(oncePrepost.phaseNodeId).toBe(onceConfiguredPhaseId);
    }

    // Every edge endpoint must reference an existing node (no dangling edges
    // — this is the actual condition that made ELK throw in production).
    for (const e of graph.edges) {
      expect(nodeIds.has(e.from), `edge ${e.id} from ${e.from} missing`).toBe(true);
      expect(nodeIds.has(e.to), `edge ${e.id} to ${e.to} missing`).toBe(true);
    }
  });

  it('does NOT collapse itemId for per-item stages — runtime phase nodes remain parented to their item', () => {
    const cfg = mixedPipeline();
    const perItemId = 'item-A';

    const items: HistoryItemRow[] = [
      {
        id: perItemId,
        stageId: 'impl',
        stableId: 'A',
        status: 'completed',
        currentPhase: null,
        dependsOn: null,
      },
    ];

    const sessions: HistorySessionRow[] = [
      {
        id: 's1',
        itemId: perItemId,
        stage: 'impl',
        phase: 'implement',
        attempt: 1,
        parentSessionId: null,
        startedAt: '2026-04-22T10:00:00Z',
        endedAt: '2026-04-22T10:01:00Z',
        exitCode: 0,
      },
    ];

    const graph = deriveFromHistory({
      workflowId: 'wf-1',
      pipeline: cfg.pipeline,
      phases: cfg.phases,
      items,
      sessions,
      prepostRuns: [],
    });

    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    // Per-item runtime phase keeps the itemId — confirms normalization only
    // fires for once-stages. (A configured `phase:impl:_:implement` template
    // node also exists from buildConfiguredGraph, which is fine.)
    expect(nodeIds.has(`phase:impl:${perItemId}:implement`)).toBe(true);

    const session = graph.nodes.find((n) => n.id === 'session:s1');
    if (session?.kind === 'session') {
      expect(session.phaseNodeId).toBe(`phase:impl:${perItemId}:implement`);
    }
  });
});
