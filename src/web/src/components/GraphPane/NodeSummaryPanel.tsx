/**
 * Right-pane summary surfaced when the user picks a non-session graph node.
 * Non-session nodes have no log stream to attach to; this panel shows the
 * configured/resolved metadata that the canvas node itself doesn't have room
 * for.
 */

import type {
  GraphNode,
  WorkflowGraph,
} from '../../../../shared/types/graph';
import { graphStatusClass } from './graphStatus';

interface Props {
  node: GraphNode;
  graph: WorkflowGraph;
}

export function NodeSummaryPanel({ node, graph }: Props) {
  return (
    <div
      className="flex flex-col h-full overflow-y-auto p-4 gap-3 text-xs text-gray-300"
      data-testid="node-summary-panel"
      data-graph-node-id={node.id}
    >
      <Header node={node} />
      <Body node={node} graph={graph} />
    </div>
  );
}

function Header({ node }: { node: GraphNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-gray-700 pb-2">
      <span className="text-[10px] uppercase tracking-wide text-gray-500">{node.kind}</span>
      <span className="text-sm font-semibold text-gray-100 truncate flex-1">{node.label}</span>
      <span className={`text-[10px] px-1.5 py-0.5 rounded ${graphStatusClass(node.status)}`}>
        {node.status}
      </span>
    </div>
  );
}

function Body({ node, graph }: { node: GraphNode; graph: WorkflowGraph }) {
  switch (node.kind) {
    case 'stage':
      return <StageBody node={node} graph={graph} />;
    case 'item':
      return <ItemBody node={node} graph={graph} />;
    case 'phase':
      return <PhaseBody node={node} graph={graph} />;
    case 'prepost':
      return <PrePostBody node={node} />;
    case 'session':
      // The LiveStreamPane owns session rendering; this branch is here only
      // for exhaustiveness — GraphPane routes session clicks to the stream.
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <Row label="sessionId" value={node.sessionId} />
          <Row label="attempt" value={String(node.attempt)} />
        </dl>
      );
  }
}

function StageBody({
  node,
  graph,
}: {
  node: Extract<GraphNode, { kind: 'stage' }>;
  graph: WorkflowGraph;
}) {
  const phases = graph.nodes.filter(
    (n) => n.kind === 'phase' && n.stageId === node.stageId,
  );
  const items = graph.nodes.filter(
    (n) => n.kind === 'item' && n.stageId === node.stageId,
  );
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      <Row label="id" value={node.stageId} mono />
      <Row label="run" value={node.run} />
      <Row label="phases" value={String(phases.length)} />
      {node.run === 'per-item' && <Row label="items" value={String(items.length)} />}
      {node.description && <Row label="description" value={node.description} />}
    </dl>
  );
}

function ItemBody({
  node,
  graph,
}: {
  node: Extract<GraphNode, { kind: 'item' }>;
  graph: WorkflowGraph;
}) {
  const phases = graph.nodes.filter(
    (n) => n.kind === 'phase' && n.itemId === node.itemId,
  );
  const incomingDeps = graph.edges.filter(
    (e) => e.kind === 'dependency' && e.to === node.id,
  );
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      <Row label="stableId" value={node.stableId ?? '—'} mono />
      <Row label="itemId" value={node.itemId} mono />
      <Row label="stage" value={node.stageId} mono />
      <Row label="deps" value={String(incomingDeps.length)} />
      <Row label="phases" value={String(phases.length)} />
    </dl>
  );
}

function PhaseBody({
  node,
  graph,
}: {
  node: Extract<GraphNode, { kind: 'phase' }>;
  graph: WorkflowGraph;
}) {
  const sessions = graph.nodes.filter(
    (n) => n.kind === 'session' && n.phaseNodeId === node.id,
  ) as Array<Extract<GraphNode, { kind: 'session' }>>;
  const attemptMax = sessions.reduce((m, s) => Math.max(m, s.attempt), 0);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      <Row label="phase" value={node.phase} />
      <Row label="stage" value={node.stageId} mono />
      {node.itemId && <Row label="item" value={node.itemId} mono />}
      <Row label="sessions" value={String(sessions.length)} />
      <Row label="attempts" value={String(attemptMax)} />
    </dl>
  );
}

function PrePostBody({ node }: { node: Extract<GraphNode, { kind: 'prepost' }> }) {
  const action = node.actionTaken;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      <Row label="when" value={node.when} />
      <Row label="command" value={node.commandName} />
      <Row label="runId" value={node.prepostRunId} mono />
      {action && <Row label="action" value={formatAction(action)} />}
    </dl>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-gray-500">{label}</dt>
      <dd className={`${mono ? 'font-mono' : ''} text-gray-200 break-words`}>{value}</dd>
    </>
  );
}

function formatAction(a: NonNullable<Extract<GraphNode, { kind: 'prepost' }>['actionTaken']>): string {
  if (a.kind === 'goto') return `goto ${a.goto ?? '?'}`;
  if (a.kind === 'fail') return `fail${a.failReason ? `: ${a.failReason}` : ''}`;
  return a.kind;
}
