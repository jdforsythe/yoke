/**
 * Shared test utilities for Yoke dashboard e2e smoke tests.
 *
 * Provides:
 *  - Frame builders for WS mock messages (hello, snapshot, index-update)
 *  - setupWs() — intercepts /stream WebSocket before page navigation,
 *    sends hello immediately, and optionally calls a handler on subscribe
 *  - mockWorkflowsApi() — intercepts GET /api/workflows* with a fixed response
 */

import type { Page, WebSocketRoute } from '@playwright/test';

// ---------------------------------------------------------------------------
// Well-known test constants
// ---------------------------------------------------------------------------

export const WF_ID = 'wf-test-001';
export const WF_NAME = 'Test Workflow';

// ---------------------------------------------------------------------------
// Frame builders
// ---------------------------------------------------------------------------

function mkFrame(type: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, type, seq: 0, ts: new Date().toISOString(), ...extra });
}

export function helloFrame(protocolVersion = 1): string {
  return mkFrame('hello', {
    payload: {
      serverVersion: '0.1.0',
      protocolVersion,
      capabilities: [],
      heartbeatIntervalMs: 30_000,
    },
  });
}

export interface SnapshotOpts {
  workflow?: {
    status?: string;
    recoveryState?: {
      recoveredAt: string;
      priorStatus: string;
      resumeMethod: 'continue' | 'fresh';
      uncommittedChanges: boolean;
      lastKnownSessionId: string | null;
    } | null;
    githubState?: {
      status: 'disabled' | 'unconfigured' | 'idle' | 'creating' | 'created' | 'failed';
      prNumber?: number;
      prUrl?: string;
      prState?: 'open' | 'merged' | 'closed';
      error?: string;
      lastCheckedAt?: string;
    } | null;
  };
  stages?: Array<{
    id: string;
    run: 'once' | 'per-item';
    phases: string[];
    status: 'pending' | 'in_progress' | 'complete' | 'blocked';
    needsApproval: boolean;
  }>;
  items?: Array<{
    id: string;
    stageId: string;
    displayTitle: string | null;
    displaySubtitle: string | null;
    state: { status: string; currentPhase: string | null; retryCount: number; blockedReason: string | null };
  }>;
  activeSessions?: Array<{
    sessionId: string;
    phase: string;
    attempt: number;
    startedAt: string;
    parentSessionId: string | null;
  }>;
  pendingAttention?: Array<{
    id: number;
    kind: string;
    payload: unknown;
    createdAt: string;
  }>;
}

export function snapshotFrame(opts: SnapshotOpts = {}): string {
  const defaultWorkflow = {
    id: WF_ID,
    name: WF_NAME,
    status: 'in_progress',
    currentStage: 'stage-1',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    recoveryState: null,
    githubState: null,
  };

  return mkFrame('workflow.snapshot', {
    workflowId: WF_ID,
    seq: 1,
    payload: {
      workflow: { ...defaultWorkflow, ...opts.workflow },
      stages: opts.stages ?? [
        {
          id: 'stage-1',
          run: 'once',
          phases: ['implement'],
          status: 'in_progress',
          needsApproval: false,
        },
      ],
      items: opts.items ?? [],
      activeSessions: opts.activeSessions ?? [],
      pendingAttention: opts.pendingAttention ?? [],
    },
  });
}

export function indexUpdateFrame(id: string, name: string, status: string): string {
  return mkFrame('workflow.index.update', {
    workflowId: id,
    seq: 2,
    payload: { id, name, status, updatedAt: new Date().toISOString(), unreadEvents: 1 },
  });
}

// ---------------------------------------------------------------------------
// WS mock setup
// ---------------------------------------------------------------------------

export type WsSubscribeHandler = (ws: WebSocketRoute) => void;

/**
 * Set up a WebSocket mock before page.goto().
 *
 * Sends hello immediately when the connection opens.
 * If onSubscribe is provided, calls it the first time the page sends a
 * `subscribe` frame — use it to send the workflow snapshot.
 */
export async function setupWs(page: Page, onSubscribe?: WsSubscribeHandler): Promise<void> {
  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    ws.send(helloFrame());

    if (onSubscribe) {
      let subscribed = false;
      ws.onMessage((msg: string | Buffer) => {
        if (subscribed) return;
        try {
          const f = JSON.parse(msg.toString()) as { type: string };
          if (f.type === 'subscribe') {
            subscribed = true;
            onSubscribe(ws);
          }
        } catch {
          // malformed — ignore
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// REST API mock
// ---------------------------------------------------------------------------

export interface WorkflowRow {
  id: string;
  name: string;
  status: string;
  updatedAt?: string;
  createdAt?: string;
  unreadEvents?: number;
}

/**
 * Mock GET /api/workflows* (list endpoint + any sub-paths).
 *
 * Returns the given workflows array with sensible defaults for timestamps.
 */
export async function mockWorkflowsApi(page: Page, workflows: WorkflowRow[] = []): Promise<void> {
  const now = new Date().toISOString();
  await page.route('**/api/workflows**', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        workflows: workflows.map((w) => ({
          updatedAt: now,
          createdAt: now,
          unreadEvents: 0,
          ...w,
        })),
        hasMore: false,
      }),
    });
  });
}
