import { describe, it, expect } from 'vitest';
import { buildConfiguredGraph } from '../../src/server/graph/builder.js';
import type {
  PhaseGraphNode,
  StageGraphNode,
  PrePostGraphNode,
} from '../../src/shared/types/graph.js';
import {
  onceStageOnePhase,
  perItemStageWithPrePost,
  multiStagePipeline,
  multiGotoPipeline,
} from './fixtures.js';

describe('buildConfiguredGraph', () => {
  it('once-only stage with one phase emits stage, phase, and a stage→phase sequence edge', () => {
    const cfg = onceStageOnePhase();
    const graph = buildConfiguredGraph('wf-1', cfg);

    const stages = graph.nodes.filter((n): n is StageGraphNode => n.kind === 'stage');
    const phases = graph.nodes.filter((n): n is PhaseGraphNode => n.kind === 'phase');

    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({
      id: 'stage:plan',
      stageId: 'plan',
      run: 'once',
      origin: 'configured',
      status: 'pending',
    });

    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({
      phase: 'plan',
      stageId: 'plan',
      itemId: null,
      origin: 'configured',
    });

    const seqEdges = graph.edges.filter((e) => e.kind === 'sequence');
    expect(seqEdges).toHaveLength(1);
    expect(seqEdges[0]).toMatchObject({
      from: 'stage:plan',
      to: phases[0].id,
      traveled: false,
    });
  });

  it('per-item stage with one pre and one post command emits two prepost nodes and one goto edge', () => {
    const cfg = perItemStageWithPrePost();
    const graph = buildConfiguredGraph('wf-2', cfg);

    const prepost = graph.nodes.filter((n): n is PrePostGraphNode => n.kind === 'prepost');
    expect(prepost).toHaveLength(2);
    const bywhen = Object.fromEntries(prepost.map((p) => [p.when, p.commandName]));
    expect(bywhen).toEqual({ pre: 'check-workspace', post: 'check-verdict' });

    const prepostEdges = graph.edges.filter((e) => e.kind === 'prepost');
    expect(prepostEdges).toHaveLength(2);
    for (const e of prepostEdges) expect(e.style).toBe('solid');

    const gotoEdges = graph.edges.filter((e) => e.kind === 'goto');
    expect(gotoEdges).toHaveLength(1);
    expect(gotoEdges[0]).toMatchObject({
      style: 'dotted',
      traveled: false,
      actionLabel: 'exit=1 → goto implement',
    });

    // No item nodes yet (seeded at runtime).
    expect(graph.nodes.find((n) => n.kind === 'item')).toBeUndefined();
  });

  it('multi-stage pipeline emits sequence edges between consecutive stages', () => {
    const cfg = multiStagePipeline();
    const graph = buildConfiguredGraph('wf-3', cfg);

    const stageIds = graph.nodes.filter((n) => n.kind === 'stage').map((n) => n.id);
    expect(stageIds).toEqual(['stage:plan', 'stage:impl', 'stage:review']);

    const stageSeqEdges = graph.edges.filter(
      (e) =>
        e.kind === 'sequence' &&
        stageIds.includes(e.from) &&
        stageIds.includes(e.to),
    );
    expect(stageSeqEdges).toHaveLength(2);
    expect(stageSeqEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'stage:plan', to: 'stage:impl' }),
        expect.objectContaining({ from: 'stage:impl', to: 'stage:review' }),
      ]),
    );
  });

  it('multiple gotos configured in post actions each emit their own dotted edge', () => {
    const cfg = multiGotoPipeline();
    const graph = buildConfiguredGraph('wf-4', cfg);

    const gotoEdges = graph.edges.filter((e) => e.kind === 'goto');
    expect(gotoEdges).toHaveLength(2);
    const targets = gotoEdges.map((e) => e.to).sort();
    expect(targets).toEqual(['phase:work:_:implement', 'phase:work:_:plan'].sort());
    for (const e of gotoEdges) {
      expect(e.style).toBe('dotted');
      expect(e.traveled).toBe(false);
    }
  });
});
