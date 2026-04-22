/**
 * GraphPane — placeholder view for the Graph View feature (PR 2).
 *
 * This PR proves the end-to-end frame flow: workflow.snapshot.graph +
 * graph.update patches are applied by the graph-store, and this pane
 * subscribes to the store for the currently-selected workflow.
 *
 * Rendering is intentionally bare — counts + small head-of-list tables —
 * so reviewers can visually confirm frames are arriving before the full
 * @xyflow/react canvas lands in PR 3.
 */

import { useWorkflowGraph } from '@/store/graphStore';

interface Props {
  workflowId: string;
}

const HEAD_ROWS = 20;

export function GraphPane({ workflowId }: Props) {
  const graph = useWorkflowGraph(workflowId);

  if (!graph) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        waiting for graph…
      </div>
    );
  }

  const nodeHead = graph.nodes.slice(0, HEAD_ROWS);
  const edgeHead = graph.edges.slice(0, HEAD_ROWS);

  return (
    <div className="flex flex-col gap-4 p-4 text-xs text-gray-300" data-testid="graph-pane">
      <div className="flex gap-4 text-sm font-medium">
        <span data-testid="graph-node-count">nodes: {graph.nodes.length}</span>
        <span data-testid="graph-edge-count">edges: {graph.edges.length}</span>
        <span data-testid="graph-finalized">
          finalized: {graph.finalizedAt ? 'yes' : 'no'}
        </span>
      </div>

      <section>
        <h2 className="text-sm font-semibold text-gray-200 mb-2">
          Nodes{graph.nodes.length > HEAD_ROWS ? ` (first ${HEAD_ROWS} of ${graph.nodes.length})` : ''}
        </h2>
        {nodeHead.length === 0 ? (
          <div className="text-gray-500">none</div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="text-gray-400 border-b border-gray-700">
              <tr>
                <th className="py-1 pr-3 font-medium">id</th>
                <th className="py-1 pr-3 font-medium">kind</th>
                <th className="py-1 pr-3 font-medium">status</th>
              </tr>
            </thead>
            <tbody>
              {nodeHead.map((n) => (
                <tr key={n.id} className="border-b border-gray-800">
                  <td className="py-1 pr-3 font-mono text-gray-300">{n.id}</td>
                  <td className="py-1 pr-3">{n.kind}</td>
                  <td className="py-1 pr-3">{n.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-200 mb-2">
          Edges{graph.edges.length > HEAD_ROWS ? ` (first ${HEAD_ROWS} of ${graph.edges.length})` : ''}
        </h2>
        {edgeHead.length === 0 ? (
          <div className="text-gray-500">none</div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="text-gray-400 border-b border-gray-700">
              <tr>
                <th className="py-1 pr-3 font-medium">from</th>
                <th className="py-1 pr-3 font-medium">to</th>
                <th className="py-1 pr-3 font-medium">kind</th>
                <th className="py-1 pr-3 font-medium">traveled</th>
              </tr>
            </thead>
            <tbody>
              {edgeHead.map((e) => (
                <tr key={e.id} className="border-b border-gray-800">
                  <td className="py-1 pr-3 font-mono text-gray-300">{e.from}</td>
                  <td className="py-1 pr-3 font-mono text-gray-300">{e.to}</td>
                  <td className="py-1 pr-3">{e.kind}</td>
                  <td className="py-1 pr-3">{e.traveled ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
