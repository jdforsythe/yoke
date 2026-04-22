/**
 * applyEvent — translate a GraphEvent into a GraphPatch and apply it.
 *
 * applyEvent is pure w.r.t. the input graph: it returns a patch describing
 * what changed.  applyPatch mutates a graph in place and is used by the
 * scheduler after computing the patch to keep the in-memory copy in sync.
 *
 * Mutation rules mirror the plan:
 *   item_seeded     → add item subflow + per-item phase/prepost nodes + dep edges
 *   session_started → add session node under its phase; retry edge if stacking
 *   session_ended   → update endedAt/exitCode on the matching session node
 *   prepost_ended   → update actionTaken on the configured prepost node;
 *                     mark goto edge traveled and add runtime goto edge if any
 *   item_state      → rollup item node status
 *   stage_started   → mark stage in_progress
 *   stage_complete  → mark stage complete
 *   workflow_status → set finalizedAt on terminal statuses (prune handled upstream)
 */

import type {
  WorkflowGraph,
  GraphNode,
  GraphEdge,
  GraphPatch,
  GraphNodeStatus,
  ItemGraphNode,
  PhaseGraphNode,
  SessionGraphNode,
  PrePostGraphNode,
  StageGraphNode,
  ResolvedAction,
} from '../../shared/types/graph.js';
import type { GraphEvent } from './events.js';
import {
  stageNodeId,
  itemNodeId,
  phaseNodeId,
  sessionNodeId,
  prepostNodeId,
  edgeId,
} from './ids.js';

const TERMINAL_WORKFLOW_STATUSES = new Set([
  'completed',
  'completed_with_blocked',
  'abandoned',
]);

export function applyEvent(graph: WorkflowGraph, event: GraphEvent): GraphPatch {
  switch (event.kind) {
    case 'item_seeded':
      return applyItemSeeded(graph, event);
    case 'session_started':
      return applySessionStarted(graph, event);
    case 'session_ended':
      return applySessionEnded(graph, event);
    case 'prepost_ended':
      return applyPrepostEnded(graph, event);
    case 'item_state':
      return applyItemState(graph, event);
    case 'stage_started':
      return { updateNodes: [{ id: stageNodeId(event.stageId), status: 'in_progress' }] };
    case 'stage_complete':
      return { updateNodes: [{ id: stageNodeId(event.stageId), status: 'complete' }] };
    case 'workflow_status': {
      if (!TERMINAL_WORKFLOW_STATUSES.has(event.status)) return {};
      return { finalizedAt: new Date().toISOString() };
    }
  }
}

export function applyPatch(graph: WorkflowGraph, patch: GraphPatch): WorkflowGraph {
  const nodeById = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  const edgeById = new Map<string, GraphEdge>(graph.edges.map((e) => [e.id, e]));

  for (const n of patch.addNodes ?? []) nodeById.set(n.id, n);
  for (const e of patch.addEdges ?? []) edgeById.set(e.id, e);

  for (const u of patch.updateNodes ?? []) {
    const existing = nodeById.get(u.id);
    if (!existing) continue;
    nodeById.set(u.id, mergeNodeUpdate(existing, u));
  }
  for (const u of patch.updateEdges ?? []) {
    const existing = edgeById.get(u.id);
    if (!existing) continue;
    edgeById.set(u.id, { ...existing, ...stripUndefined(u) });
  }
  for (const id of patch.removeNodeIds ?? []) nodeById.delete(id);
  for (const id of patch.removeEdgeIds ?? []) edgeById.delete(id);

  return {
    ...graph,
    nodes: [...nodeById.values()],
    edges: [...edgeById.values()],
    finalizedAt: patch.finalizedAt ?? graph.finalizedAt,
  };
}

// ---------------------------------------------------------------------------
// Per-event implementations
// ---------------------------------------------------------------------------

function applyItemSeeded(
  graph: WorkflowGraph,
  event: Extract<GraphEvent, { kind: 'item_seeded' }>,
): GraphPatch {
  const stage = findStage(graph, event.stageId);
  if (!stage || stage.run !== 'per-item') return {};

  const phaseNames = phaseNamesFromConfiguredTemplate(graph, event.stageId);

  const addNodes: GraphNode[] = [];
  const addEdges: GraphEdge[] = [];
  const stableToItem = new Map<string, string>();
  for (const itm of event.items) {
    if (itm.stableId) stableToItem.set(itm.stableId, itm.itemId);
  }

  const existingNodeIds = new Set(graph.nodes.map((n) => n.id));

  for (const itm of event.items) {
    const itemId = itemNodeId(event.stageId, itm.itemId);
    if (!existingNodeIds.has(itemId)) {
      const node: ItemGraphNode = {
        id: itemId,
        kind: 'item',
        label: itm.displayTitle ?? itm.stableId ?? itm.itemId,
        stageId: event.stageId,
        itemId: itm.itemId,
        stableId: itm.stableId,
        status: 'pending',
        origin: 'runtime',
      };
      addNodes.push(node);
      existingNodeIds.add(itemId);

      addEdges.push({
        id: edgeId('sequence', stageNodeId(event.stageId), itemId),
        from: stageNodeId(event.stageId),
        to: itemId,
        kind: 'sequence',
        style: 'solid',
        traveled: false,
      });
    }

    for (let pi = 0; pi < phaseNames.length; pi++) {
      const phaseName = phaseNames[pi];
      const phaseId = phaseNodeId(event.stageId, itm.itemId, phaseName);
      if (existingNodeIds.has(phaseId)) continue;
      const pNode: PhaseGraphNode = {
        id: phaseId,
        kind: 'phase',
        label: phaseName,
        stageId: event.stageId,
        itemId: itm.itemId,
        phase: phaseName,
        status: 'pending',
        origin: 'runtime',
      };
      addNodes.push(pNode);
      existingNodeIds.add(phaseId);
      const fromId =
        pi === 0 ? itemId : phaseNodeId(event.stageId, itm.itemId, phaseNames[pi - 1]);
      addEdges.push({
        id: edgeId('sequence', fromId, phaseId),
        from: fromId,
        to: phaseId,
        kind: 'sequence',
        style: 'solid',
        traveled: false,
      });
    }
  }

  for (const itm of event.items) {
    if (!itm.dependsOn) continue;
    for (const dep of itm.dependsOn) {
      const depItemId = stableToItem.get(dep);
      if (!depItemId) continue;
      const fromId = itemNodeId(event.stageId, depItemId);
      const toId = itemNodeId(event.stageId, itm.itemId);
      addEdges.push({
        id: edgeId('dependency', fromId, toId),
        from: fromId,
        to: toId,
        kind: 'dependency',
        style: 'solid',
        traveled: false,
      });
    }
  }

  return { addNodes, addEdges };
}

function applySessionStarted(
  graph: WorkflowGraph,
  event: Extract<GraphEvent, { kind: 'session_started' }>,
): GraphPatch {
  const phaseId = phaseNodeId(event.stageId, event.itemId, event.phase);
  const phaseNode = graph.nodes.find((n) => n.id === phaseId) as PhaseGraphNode | undefined;

  const addNodes: GraphNode[] = [];
  const addEdges: GraphEdge[] = [];
  const updateNodes: GraphPatch['updateNodes'] = [];

  if (!phaseNode) {
    // Runtime-origin phase node — created on demand (e.g. once-stage phase
    // missing because pipeline changed, or a defensive path).
    const ph: PhaseGraphNode = {
      id: phaseId,
      kind: 'phase',
      label: event.phase,
      stageId: event.stageId,
      itemId: event.itemId,
      phase: event.phase,
      status: 'in_progress',
      origin: 'runtime',
    };
    addNodes.push(ph);
  } else {
    updateNodes.push({ id: phaseId, status: 'in_progress' });
  }

  const sessionId = sessionNodeId(event.sessionId);
  const sNode: SessionGraphNode = {
    id: sessionId,
    kind: 'session',
    label: `#${event.attempt}`,
    phaseNodeId: phaseId,
    sessionId: event.sessionId,
    attempt: event.attempt,
    parentSessionId: event.parentSessionId,
    startedAt: event.startedAt,
    endedAt: null,
    exitCode: null,
    status: 'in_progress',
    origin: 'runtime',
  };
  addNodes.push(sNode);

  addEdges.push({
    id: edgeId('sequence', phaseId, sessionId),
    from: phaseId,
    to: sessionId,
    kind: 'sequence',
    style: 'solid',
    traveled: true,
  });

  const priorTerminalSession = findPriorTerminalSessionForPhase(graph, phaseId, event.sessionId);
  if (priorTerminalSession) {
    addEdges.push({
      id: edgeId('retry', priorTerminalSession.id, sessionId),
      from: priorTerminalSession.id,
      to: sessionId,
      kind: 'retry',
      style: 'dotted',
      traveled: true,
    });
  }

  return { addNodes, addEdges, updateNodes };
}

function applySessionEnded(
  graph: WorkflowGraph,
  event: Extract<GraphEvent, { kind: 'session_ended' }>,
): GraphPatch {
  const id = sessionNodeId(event.sessionId);
  const existing = graph.nodes.find((n) => n.id === id);
  if (!existing || existing.kind !== 'session') return {};

  const status: GraphNodeStatus = event.exitCode === 0 ? 'complete' : 'abandoned';
  // Phase rollup reflects the latest session's terminal status; a subsequent
  // session_started (retry/goto) on the same phase will flip it back to in_progress.
  return {
    updateNodes: [
      {
        id,
        status,
        endedAt: event.endedAt,
        exitCode: event.exitCode,
      },
      { id: existing.phaseNodeId, status },
    ],
  };
}

function applyPrepostEnded(
  graph: WorkflowGraph,
  event: Extract<GraphEvent, { kind: 'prepost_ended' }>,
): GraphPatch {
  // Configured prepost nodes use the synthetic id 'cfg:...'; runtime rows
  // use the row id.  For per-item stages the configured template lives under
  // itemId=null, but runtime emits carry the actual itemId — we promote the
  // configured template's id to the runtime form the first time we see it.
  const runtimeId = prepostNodeId(event.prepostRunId);
  const configuredTemplateRunId = `cfg:${event.stageId}:${event.itemId ?? '_'}:${event.phase}:${event.when}:${event.commandName}`;
  const configuredId = prepostNodeId(configuredTemplateRunId);

  const existingRuntime = graph.nodes.find((n) => n.id === runtimeId);
  const existingConfigured = graph.nodes.find((n) => n.id === configuredId);
  const phaseId = phaseNodeId(event.stageId, event.itemId, event.phase);

  const addNodes: GraphNode[] = [];
  const addEdges: GraphEdge[] = [];
  const updateNodes: GraphPatch['updateNodes'] = [];
  const updateEdges: GraphPatch['updateEdges'] = [];
  const removeNodeIds: string[] = [];
  const removeEdgeIds: string[] = [];

  const targetId = runtimeId;
  const targetStatus: GraphNodeStatus = event.actionTaken
    ? resolvedActionToStatus(event.actionTaken)
    : 'complete';

  if (existingRuntime) {
    updateNodes.push({ id: runtimeId, status: targetStatus, actionTaken: event.actionTaken });
  } else {
    const node: PrePostGraphNode = {
      id: runtimeId,
      kind: 'prepost',
      label: event.commandName,
      phaseNodeId: phaseId,
      when: event.when,
      commandName: event.commandName,
      prepostRunId: event.prepostRunId,
      actionTaken: event.actionTaken,
      status: targetStatus,
      origin: 'runtime',
    };
    addNodes.push(node);

    if (existingConfigured) {
      for (const e of graph.edges) {
        if (e.from === configuredId) {
          addEdges.push({ ...e, id: edgeId(e.kind, runtimeId, e.to, derivePortSuffix(e.id)), from: runtimeId });
          removeEdgeIds.push(e.id);
        } else if (e.to === configuredId) {
          addEdges.push({ ...e, id: edgeId(e.kind, e.from, runtimeId, derivePortSuffix(e.id)), to: runtimeId });
          removeEdgeIds.push(e.id);
        }
      }
      removeNodeIds.push(configuredId);
    } else {
      addEdges.push({
        id: edgeId('prepost', phaseId, runtimeId, event.when),
        from: phaseId,
        to: runtimeId,
        kind: 'prepost',
        style: 'solid',
        traveled: true,
      });
    }
  }

  if (event.actionTaken?.kind === 'goto' && event.actionTaken.goto) {
    const targetPhaseId = phaseNodeId(event.stageId, event.itemId, event.actionTaken.goto);
    // The goto edge may already have been promoted onto the runtime prepost
    // node earlier in this patch (in which case we flip it to traveled in
    // place); otherwise update the persisted edge or add a new one.
    const pendingMatch = addEdges.find(
      (e) => e.kind === 'goto' && e.from === runtimeId && e.to === targetPhaseId,
    );
    const priorMatch = graph.edges.find(
      (e) =>
        e.kind === 'goto' &&
        (e.from === configuredId || e.from === runtimeId) &&
        e.to === targetPhaseId,
    );
    if (pendingMatch) {
      pendingMatch.traveled = true;
    } else if (priorMatch && !removeEdgeIds.includes(priorMatch.id)) {
      updateEdges.push({ id: priorMatch.id, traveled: true });
    } else {
      addEdges.push({
        id: edgeId('goto', targetId, targetPhaseId, 'runtime'),
        from: targetId,
        to: targetPhaseId,
        kind: 'goto',
        style: 'dotted',
        traveled: true,
        actionLabel: `goto ${event.actionTaken.goto}`,
      });
    }
  }

  return { addNodes, addEdges, updateNodes, updateEdges, removeNodeIds, removeEdgeIds };
}

function applyItemState(
  graph: WorkflowGraph,
  event: Extract<GraphEvent, { kind: 'item_state' }>,
): GraphPatch {
  const id = itemNodeId(event.stageId, event.itemId);
  const existing = graph.nodes.find((n) => n.id === id);
  if (!existing) return {};
  const status = normalizeItemStatus(event.status);
  if (!status) return {};
  return { updateNodes: [{ id, status }] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findStage(graph: WorkflowGraph, stageId: string): StageGraphNode | undefined {
  const n = graph.nodes.find((x) => x.id === stageNodeId(stageId));
  return n && n.kind === 'stage' ? n : undefined;
}

function phaseNamesFromConfiguredTemplate(graph: WorkflowGraph, stageId: string): string[] {
  const phases = graph.nodes
    .filter(
      (n): n is PhaseGraphNode =>
        n.kind === 'phase' && n.stageId === stageId && n.itemId === null,
    )
    .map((n) => n.phase);
  const edgePairs = new Map<string, string>();
  const phaseIdSet = new Set(phases.map((p) => phaseNodeId(stageId, null, p)));
  for (const e of graph.edges) {
    if (e.kind !== 'sequence') continue;
    if (phaseIdSet.has(e.from) && phaseIdSet.has(e.to)) {
      edgePairs.set(e.from, e.to);
    }
  }
  const head = [...phaseIdSet].find((id) => ![...edgePairs.values()].includes(id));
  if (!head) return phases;
  const order: string[] = [];
  let cur: string | undefined = head;
  while (cur) {
    const p = graph.nodes.find((n) => n.id === cur) as PhaseGraphNode | undefined;
    if (p) order.push(p.phase);
    cur = edgePairs.get(cur);
  }
  return order.length === phases.length ? order : phases;
}

function findPriorTerminalSessionForPhase(
  graph: WorkflowGraph,
  phaseNodeIdStr: string,
  excludeSessionId: string,
): SessionGraphNode | undefined {
  let latest: SessionGraphNode | undefined;
  for (const n of graph.nodes) {
    if (n.kind !== 'session') continue;
    if (n.phaseNodeId !== phaseNodeIdStr) continue;
    if (n.sessionId === excludeSessionId) continue;
    if (n.endedAt === null) continue;
    if (!latest || (n.endedAt ?? '') > (latest.endedAt ?? '')) {
      latest = n;
    }
  }
  return latest;
}

function resolvedActionToStatus(action: ResolvedAction): GraphNodeStatus {
  switch (action.kind) {
    case 'continue':
      return 'complete';
    case 'goto':
    case 'retry':
      return 'complete';
    case 'stop':
    case 'stop-and-ask':
    case 'fail':
      return 'abandoned';
  }
}

function normalizeItemStatus(raw: string): GraphNodeStatus | null {
  switch (raw) {
    case 'pending':
    case 'ready':
    case 'bootstrapping':
    case 'awaiting_retry':
    case 'rate_limited':
    case 'awaiting_user':
      return 'pending';
    case 'in_progress':
      return 'in_progress';
    case 'complete':
      return 'complete';
    case 'blocked':
      return 'blocked';
    case 'abandoned':
      return 'abandoned';
    case 'skipped':
      return 'skipped';
    default:
      return null;
  }
}

function mergeNodeUpdate(
  node: GraphNode,
  update: NonNullable<GraphPatch['updateNodes']>[number],
): GraphNode {
  const next: Record<string, unknown> = { ...(node as unknown as Record<string, unknown>) };
  if (update.status !== undefined) next.status = update.status;
  if (update.endedAt !== undefined && node.kind === 'session') next.endedAt = update.endedAt;
  if (update.exitCode !== undefined && node.kind === 'session') next.exitCode = update.exitCode;
  if (update.actionTaken !== undefined && node.kind === 'prepost') next.actionTaken = update.actionTaken;
  return next as unknown as GraphNode;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function derivePortSuffix(existingId: string): string | undefined {
  // Preserve any trailing `:suffix` (e.g. the `pre`/`post` port hint) so
  // reassigned edges are still unique after promotion from configured to
  // runtime prepost nodes.
  const parts = existingId.split(':');
  const last = parts.at(-1);
  if (!last) return undefined;
  if (last === 'pre' || last === 'post' || last.startsWith('exit=')) return last;
  return undefined;
}
