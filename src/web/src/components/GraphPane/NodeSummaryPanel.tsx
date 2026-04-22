/**
 * Right-pane summary surfaced when the user picks a non-session graph node.
 * Non-session nodes have no log stream to attach to; this panel shows the
 * configured/resolved metadata that the canvas node itself doesn't have room
 * for.
 *
 * Prepost nodes additionally render a stdout/stderr tail fetched from
 * /api/workflows/:wf/prepost-run/:runId/:stream — the Graph View-specific
 * sibling of the FeatureBoard timeline endpoint keyed on the synthetic
 * runId rather than the numeric DB id.
 */

import { useEffect, useState } from 'react';
import type {
  GraphNode,
  WorkflowGraph,
} from '../../../../shared/types/graph';
import { graphStatusClass } from './graphStatus';

/**
 * Session nodes are routed to LiveStreamPane by WorkflowDetailRoute, so they
 * never reach this panel.  Narrowing the prop type makes the routing
 * invariant explicit and keeps the switch below exhaustive without a dead
 * branch.
 */
type SummaryNode = Exclude<GraphNode, { kind: 'session' }>;

interface Props {
  node: SummaryNode;
  graph: WorkflowGraph;
  /**
   * Workflow id for API calls (currently only the prepost-output fetch).
   * Optional because StageBody/ItemBody/PhaseBody don't need it; when a
   * prepost node is shown and this is absent the tail section is hidden.
   */
  workflowId?: string;
}

export function NodeSummaryPanel({ node, graph, workflowId }: Props) {
  return (
    <div
      className="flex flex-col h-full overflow-y-auto p-4 gap-3 text-xs text-gray-300"
      data-testid="node-summary-panel"
      data-graph-node-id={node.id}
    >
      <Header node={node} />
      <Body node={node} graph={graph} workflowId={workflowId} />
    </div>
  );
}

function Header({ node }: { node: SummaryNode }) {
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

function Body({
  node,
  graph,
  workflowId,
}: {
  node: SummaryNode;
  graph: WorkflowGraph;
  workflowId: string | undefined;
}) {
  switch (node.kind) {
    case 'stage':
      return <StageBody node={node} graph={graph} />;
    case 'item':
      return <ItemBody node={node} graph={graph} />;
    case 'phase':
      return <PhaseBody node={node} graph={graph} />;
    case 'prepost':
      return <PrePostBody node={node} workflowId={workflowId} />;
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

function PrePostBody({
  node,
  workflowId,
}: {
  node: Extract<GraphNode, { kind: 'prepost' }>;
  workflowId: string | undefined;
}) {
  const action = node.actionTaken;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <Row label="when" value={node.when} />
        <Row label="command" value={node.commandName} />
        <Row label="runId" value={node.prepostRunId} mono />
        {action && <Row label="action" value={formatAction(action)} />}
      </dl>
      {workflowId && (
        <>
          <PrepostOutputSection
            workflowId={workflowId}
            runId={node.prepostRunId}
            stream="stdout"
          />
          <PrepostOutputSection
            workflowId={workflowId}
            runId={node.prepostRunId}
            stream="stderr"
          />
        </>
      )}
    </div>
  );
}

interface OutputFetch {
  content: string;
  totalSize: number;
  truncated: boolean;
}

/**
 * Module-level fetch cache keyed by `${runId}:${stream}`.  Matches
 * PrepostOutputPane's behaviour — re-selecting the same prepost node is an
 * instant hit, and clicking away + back doesn't re-fetch.
 */
const _outputCache = new Map<string, OutputFetch | { error: string }>();

function PrepostOutputSection({
  workflowId,
  runId,
  stream,
}: {
  workflowId: string;
  runId: string;
  stream: 'stdout' | 'stderr';
}) {
  const cacheKey = `${runId}:${stream}`;
  const initial = _outputCache.get(cacheKey);
  const [state, setState] = useState<OutputFetch | { error: string } | null>(initial ?? null);

  useEffect(() => {
    const cached = _outputCache.get(cacheKey);
    if (cached) {
      setState(cached);
      return;
    }
    let cancelled = false;
    const url =
      `/api/workflows/${encodeURIComponent(workflowId)}` +
      `/prepost-run/${encodeURIComponent(runId)}` +
      `/${stream}`;
    setState(null);
    void fetch(url)
      .then(async (r) => {
        if (r.status === 404) {
          const msg = 'No output captured';
          _outputCache.set(cacheKey, { error: msg });
          if (!cancelled) setState({ error: msg });
          return;
        }
        if (!r.ok) {
          const msg = `Failed to load (HTTP ${r.status})`;
          _outputCache.set(cacheKey, { error: msg });
          if (!cancelled) setState({ error: msg });
          return;
        }
        const data = (await r.json()) as OutputFetch;
        _outputCache.set(cacheKey, data);
        if (!cancelled) setState(data);
      })
      .catch((err: Error) => {
        const msg = err.message;
        _outputCache.set(cacheKey, { error: msg });
        if (!cancelled) setState({ error: msg });
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, runId, stream, cacheKey]);

  const headerLabel = stream.toUpperCase();

  return (
    <section
      className="flex flex-col border border-gray-700 rounded overflow-hidden"
      data-testid={`prepost-${stream}`}
    >
      <div className="flex items-center gap-2 px-2 py-1 bg-gray-900 border-b border-gray-700 text-[10px] text-gray-400">
        <span className="font-medium text-gray-300">{headerLabel}</span>
        {state && 'content' in state && (
          <span className="text-gray-500">
            {state.totalSize} bytes{state.truncated ? ' (truncated)' : ''}
          </span>
        )}
      </div>
      {state == null ? (
        <div className="px-2 py-1 text-gray-500">Loading…</div>
      ) : 'error' in state ? (
        <div
          className="px-2 py-1 text-amber-300"
          data-testid={`prepost-${stream}-error`}
        >
          {state.error}
        </div>
      ) : (
        <pre
          className="px-2 py-1 font-mono text-gray-100 whitespace-pre-wrap break-words max-h-48 overflow-auto"
          data-testid={`prepost-${stream}-text`}
        >
          {state.content || '(empty)'}
        </pre>
      )}
    </section>
  );
}

/** Test-only cache reset. */
export function __clearNodeSummaryOutputCache(): void {
  _outputCache.clear();
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
