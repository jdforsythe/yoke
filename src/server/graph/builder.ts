/**
 * buildConfiguredGraph — materialize a WorkflowGraph from the static pipeline
 * template.
 *
 * All nodes/edges are origin:'configured', status:'pending', traveled:false.
 * Per-item stages produce a stage node and its phase/prepost template, but no
 * item nodes — those are added later by applyEvent('item_seeded') once the
 * manifest is resolved at runtime.
 */

import type { Pipeline, Phase, PrePostCommand, ActionValue } from '../../shared/types/config.js';
import type {
  WorkflowGraph,
  GraphNode,
  GraphEdge,
  StageGraphNode,
  PhaseGraphNode,
  PrePostGraphNode,
} from '../../shared/types/graph.js';
import { stageNodeId, phaseNodeId, prepostNodeId, edgeId } from './ids.js';

export interface ConfiguredPipeline {
  pipeline: Pipeline;
  phases: Record<string, Phase>;
}

export function buildConfiguredGraph(
  workflowId: string,
  cfg: ConfiguredPipeline,
): WorkflowGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const stages = cfg.pipeline.stages;
  for (let si = 0; si < stages.length; si++) {
    const stage = stages[si];
    const stageNode: StageGraphNode = {
      id: stageNodeId(stage.id),
      kind: 'stage',
      label: stage.id,
      stageId: stage.id,
      run: stage.run,
      status: 'pending',
      origin: 'configured',
    };
    nodes.push(stageNode);

    // Once-only stages parent phases directly to the stage. Per-item stages
    // show the phase template (for the prepost wiring) but defer per-item
    // phase nodes to runtime.
    const itemIdForTemplate: string | null = null;
    for (let pi = 0; pi < stage.phases.length; pi++) {
      const phaseName = stage.phases[pi];
      const phaseCfg = cfg.phases[phaseName];
      const phaseNode: PhaseGraphNode = {
        id: phaseNodeId(stage.id, itemIdForTemplate, phaseName),
        kind: 'phase',
        label: phaseName,
        stageId: stage.id,
        itemId: itemIdForTemplate,
        phase: phaseName,
        status: 'pending',
        origin: 'configured',
      };
      nodes.push(phaseNode);

      if (pi === 0) {
        edges.push(makeSequenceEdge(stageNode.id, phaseNode.id));
      } else {
        const prev = phaseNodeId(stage.id, itemIdForTemplate, stage.phases[pi - 1]);
        edges.push(makeSequenceEdge(prev, phaseNode.id));
      }

      if (phaseCfg) {
        appendPrePostNodes(nodes, edges, stage.id, itemIdForTemplate, phaseName, 'pre', phaseCfg.pre);
        appendPrePostNodes(nodes, edges, stage.id, itemIdForTemplate, phaseName, 'post', phaseCfg.post);
      }
    }

    if (si > 0) {
      const prevStage = stages[si - 1];
      edges.push({
        id: edgeId('sequence', stageNodeId(prevStage.id), stageNode.id),
        from: stageNodeId(prevStage.id),
        to: stageNode.id,
        kind: 'sequence',
        style: 'solid',
        traveled: false,
      });
    }
  }

  return {
    version: 1,
    workflowId,
    nodes,
    edges,
    finalizedAt: null,
  };
}

function makeSequenceEdge(from: string, to: string): GraphEdge {
  return {
    id: edgeId('sequence', from, to),
    from,
    to,
    kind: 'sequence',
    style: 'solid',
    traveled: false,
  };
}

function appendPrePostNodes(
  nodes: GraphNode[],
  edges: GraphEdge[],
  stageId: string,
  itemId: string | null,
  phaseName: string,
  when: 'pre' | 'post',
  commands: PrePostCommand[] | undefined,
): void {
  if (!commands || commands.length === 0) return;
  const phaseId = phaseNodeId(stageId, itemId, phaseName);
  for (const cmd of commands) {
    const runId = configuredPrepostRunId(stageId, itemId, phaseName, when, cmd.name);
    const node: PrePostGraphNode = {
      id: prepostNodeId(runId),
      kind: 'prepost',
      label: cmd.name,
      phaseNodeId: phaseId,
      when,
      commandName: cmd.name,
      prepostRunId: runId,
      actionTaken: null,
      status: 'pending',
      origin: 'configured',
    };
    nodes.push(node);
    edges.push({
      id: edgeId('prepost', phaseId, node.id, when),
      from: phaseId,
      to: node.id,
      kind: 'prepost',
      style: 'solid',
      traveled: false,
    });

    appendConfiguredGotoEdges(edges, node.id, stageId, itemId, cmd.actions);
  }
}

function appendConfiguredGotoEdges(
  edges: GraphEdge[],
  fromNodeId: string,
  stageId: string,
  itemId: string | null,
  actions: Record<string, ActionValue>,
): void {
  for (const [code, action] of Object.entries(actions)) {
    if (typeof action !== 'object' || !('goto' in action)) continue;
    const targetPhaseId = phaseNodeId(stageId, itemId, action.goto);
    edges.push({
      id: edgeId('goto', fromNodeId, targetPhaseId, `exit=${code}`),
      from: fromNodeId,
      to: targetPhaseId,
      kind: 'goto',
      style: 'dotted',
      traveled: false,
      actionLabel: `exit=${code} → goto ${action.goto}`,
    });
  }
}

/**
 * Synthesize a stable id for template-level prepost nodes (no DB row exists
 * until runtime).  Matches exactly the runtime-origin id when the scheduler
 * emits the prepost_ended event with the same (stage, phase, when, name),
 * which lets applyEvent promote the configured node in place.
 */
export function configuredPrepostRunId(
  stageId: string,
  itemId: string | null,
  phase: string,
  when: 'pre' | 'post',
  commandName: string,
): string {
  return `cfg:${stageId}:${itemId ?? '_'}:${phase}:${when}:${commandName}`;
}
