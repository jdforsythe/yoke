/**
 * E2E smoke tests for Graph View (feat-graph-view, PR 3).
 *
 * Covers:
 *  - Graph tab (?view=graph) renders the @xyflow/react canvas
 *  - Subscribe→snapshot→render round-trip (no mock-WS race)
 *  - Stage + phase + session nodes appear
 *  - Clicking a session node attaches the right pane to its live stream
 *  - Clicking empty canvas collapses the right pane
 *
 * Uses setupWs() + helpers (not the realBackend fixture) because the graph is
 * delivered via the workflow.snapshot frame; we don't need the scheduler to
 * build it for these assertions.
 */

import { test, expect } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import {
  mockWorkflowsApi,
  helloFrame,
  WF_ID,
  WF_NAME,
} from './helpers';
import type {
  WorkflowGraph,
  GraphNode,
  GraphEdge,
} from '../../shared/types/graph';

// ---------------------------------------------------------------------------
// Snapshot with a graph field
// ---------------------------------------------------------------------------

function mkGraph(extraNodes: GraphNode[] = [], extraEdges: GraphEdge[] = []): WorkflowGraph {
  const nodes: GraphNode[] = [
    {
      id: 'stage:impl',
      kind: 'stage',
      stageId: 'impl',
      run: 'once',
      label: 'impl',
      status: 'in_progress',
      origin: 'configured',
    },
    {
      id: 'phase:impl:_:implement',
      kind: 'phase',
      stageId: 'impl',
      itemId: null,
      phase: 'implement',
      label: 'implement',
      status: 'in_progress',
      origin: 'configured',
    },
    {
      id: 'session:sess-1',
      kind: 'session',
      phaseNodeId: 'phase:impl:_:implement',
      sessionId: 'sess-1',
      attempt: 1,
      parentSessionId: null,
      startedAt: '2026-04-22T00:00:00Z',
      endedAt: null,
      exitCode: null,
      label: 'attempt 1',
      status: 'in_progress',
      origin: 'runtime',
    },
    ...extraNodes,
  ];

  const edges: GraphEdge[] = [
    {
      id: 'e:seq:stage:impl->phase:impl:_:implement',
      from: 'stage:impl',
      to: 'phase:impl:_:implement',
      kind: 'sequence',
      style: 'solid',
      traveled: true,
    },
    ...extraEdges,
  ];

  return { version: 1, workflowId: WF_ID, nodes, edges, finalizedAt: null };
}

function snapshotFrameWithGraph(graph: WorkflowGraph): string {
  return JSON.stringify({
    v: 1,
    type: 'workflow.snapshot',
    workflowId: WF_ID,
    seq: 1,
    ts: new Date().toISOString(),
    payload: {
      workflow: {
        id: WF_ID,
        name: WF_NAME,
        status: 'in_progress',
        currentStage: 'impl',
        createdAt: new Date().toISOString(),
        recoveryState: null,
        githubState: null,
      },
      stages: [
        {
          id: 'impl',
          run: 'once',
          phases: ['implement'],
          status: 'in_progress',
          needsApproval: false,
        },
      ],
      items: [],
      activeSessions: [
        {
          sessionId: 'sess-1',
          itemId: null,
          phase: 'implement',
          attempt: 1,
          startedAt: '2026-04-22T00:00:00Z',
          parentSessionId: null,
        },
      ],
      pendingAttention: [],
      graph,
    },
  });
}

async function setupGraphWs(
  page: Parameters<typeof mockWorkflowsApi>[0],
  graph: WorkflowGraph,
): Promise<void> {
  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    ws.send(helloFrame());
    let sent = false;
    ws.onMessage((msg: string | Buffer) => {
      if (sent) return;
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          sent = true;
          ws.send(snapshotFrameWithGraph(graph));
        }
      } catch {
        // ignore malformed frames
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await mockWorkflowsApi(page, [{ id: WF_ID, name: WF_NAME, status: 'in_progress' }]);
});

test('Graph tab renders stage + phase + session nodes from the snapshot graph', async ({ page }) => {
  // Wait on the incoming workflow.snapshot frame at the browser level — avoids
  // the control-matrix flake class where the WS send races with page.goto.
  const snapshotSeen = page.waitForEvent('websocket').then((ws) => {
    return new Promise<void>((resolve) => {
      ws.on('framereceived', (ev) => {
        if (typeof ev.payload === 'string' && ev.payload.includes('"workflow.snapshot"')) {
          resolve();
        }
      });
    });
  });

  await setupGraphWs(page, mkGraph());
  await page.goto(`/workflow/${WF_ID}?view=graph`);

  await snapshotSeen;

  await expect(page.getByTestId('graph-pane')).toBeVisible();
  await expect(page.getByTestId('graph-node-stage')).toBeVisible();
  await expect(page.getByTestId('graph-node-phase')).toBeVisible();
  await expect(page.getByTestId('graph-node-session')).toBeVisible();
});

test('clicking a session node swaps the right pane to the live stream', async ({ page }) => {
  await setupGraphWs(page, mkGraph());
  await page.goto(`/workflow/${WF_ID}?view=graph`);

  const sessionNode = page.getByTestId('graph-node-session').first();
  await expect(sessionNode).toBeVisible();
  await sessionNode.click();

  // LiveStreamPane mounts an (initially empty) scrollable stream container
  // when it receives a sessionId. No log frames are sent, so the pane exists
  // but is empty. NodeSummaryPanel must NOT render for a session click.
  await expect(page.getByTestId('node-summary-panel')).toHaveCount(0);
});

test('clicking empty canvas collapses the right pane', async ({ page }) => {
  await setupGraphWs(page, mkGraph());
  await page.goto(`/workflow/${WF_ID}?view=graph`);

  await expect(page.getByTestId('graph-node-stage')).toBeVisible();
  // Click a non-session node (stage) first to open the right pane.
  await page.getByTestId('graph-node-stage').first().click();
  await expect(page.getByTestId('node-summary-panel')).toBeVisible();

  // Click the xyflow pane background to clear selection.
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('node-summary-panel')).toHaveCount(0);
});

test('retry/goto edges render with a dotted stroke', async ({ page }) => {
  // Two session nodes under the same phase, connected by a retry edge.
  const session2: GraphNode = {
    id: 'session:sess-2',
    kind: 'session',
    phaseNodeId: 'phase:impl:_:implement',
    sessionId: 'sess-2',
    attempt: 2,
    parentSessionId: 'sess-1',
    startedAt: '2026-04-22T00:05:00Z',
    endedAt: null,
    exitCode: null,
    label: 'attempt 2',
    status: 'in_progress',
    origin: 'runtime',
  };
  const retryEdge: GraphEdge = {
    id: 'e:retry:session:sess-1->session:sess-2',
    from: 'session:sess-1',
    to: 'session:sess-2',
    kind: 'retry',
    style: 'dotted',
    traveled: true,
  };

  await setupGraphWs(page, mkGraph([session2], [retryEdge]));
  await page.goto(`/workflow/${WF_ID}?view=graph`);

  await expect(page.getByTestId('graph-node-session')).toHaveCount(2);

  // The retry edge is rendered by xyflow inside a <g data-id="..."> wrapper;
  // the inner <path> carries the dashed stroke style we set on the edge.
  const edgePath = page
    .locator('g.react-flow__edge[data-id="e:retry:session:sess-1->session:sess-2"] path.react-flow__edge-path')
    .first();
  await expect(edgePath).toBeVisible();
  const style = (await edgePath.getAttribute('style')) ?? '';
  expect(style).toMatch(/4[, ]\s*4/);
});
