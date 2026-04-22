/**
 * WebSocket protocol frame types — authoritative TypeScript definitions.
 *
 * Source: docs/design/protocol-websocket.md §8 (type block) and §2 (payload
 * shapes). These types are consumed by ws.ts (server-side handler) and will
 * also be re-exported for the future Dashboard client.
 *
 * Conventions:
 *  - ServerFrame: server → client envelope with v:1, type, seq, ts, payload.
 *  - ClientFrame: client → server envelope with v:1, type, id, payload.
 *  - seq rules: per-session monotonic starting at 1; non-session frames seq:0;
 *    backfill replays preserve original seq.
 */

import type { WorkflowGraph, GraphPatch } from '../../shared/types/graph.js';

// ---------------------------------------------------------------------------
// Envelope types (§8)
// ---------------------------------------------------------------------------

export type ServerFrameType =
  | 'hello'
  | 'workflow.snapshot'
  | 'workflow.update'
  | 'workflow.index.update'
  | 'workflow.created'
  | 'item.state'
  | 'item.data'
  | 'stage.started'
  | 'stage.complete'
  | 'session.started'
  | 'session.ended'
  | 'stream.initial_prompt'
  | 'stream.text'
  | 'stream.thinking'
  | 'stream.tool_use'
  | 'stream.tool_result'
  | 'stream.usage'
  | 'stream.system_notice'
  | 'prepost.command.started'
  | 'prepost.command.output'
  | 'prepost.command.ended'
  | 'graph.update'
  | 'notice'
  | 'error'
  | 'pong'
  | 'backfill.truncated';

export type ClientFrameType =
  | 'subscribe'
  | 'unsubscribe'
  | 'control'
  | 'ack'
  | 'ping';

export interface ServerFrame<T = unknown> {
  v: 1;
  type: ServerFrameType;
  /** Absent on hello, pong, notice (global frames). */
  workflowId?: string;
  /** Absent on workflow-scope frames. */
  sessionId?: string;
  /** Monotonic per session (starts at 1). Non-session frames: 0. */
  seq: number;
  ts: string;
  payload: T;
}

export interface ClientFrame<T = unknown> {
  v: 1;
  type: ClientFrameType;
  /** Client-generated commandId (uuid); idempotency key. */
  id: string;
  payload: T;
}

// ---------------------------------------------------------------------------
// Server frame payload types (§2)
// ---------------------------------------------------------------------------

/** §2.1 — sent once on connect before any other frame. */
export interface HelloPayload {
  serverVersion: string;
  protocolVersion: 1;
  capabilities: string[];
  heartbeatIntervalMs: number;
}

/** §2.2 — full workflow state dump, sent in response to subscribe. */
export interface WorkflowSnapshotPayload {
  workflow: {
    id: string;
    name: string;
    status: string;
    currentStage: string | null;
    createdAt: string;
    pausedAt: string | null;
    recoveryState?: unknown | null;
    githubState?: unknown | null;
  };
  stages: StageProjection[];
  items: ItemProjection[];
  activeSessions: SessionProjection[];
  pendingAttention: PendingAttentionEntry[];
  graph?: WorkflowGraph;
}

/** Graph-view live update — incremental patch over the last known WorkflowGraph. */
export interface GraphUpdatePayload {
  workflowId: string;
  patch: GraphPatch;
}

export interface StageProjection {
  id: string;
  /**
   * Optional human-readable description from the stage config. The dashboard
   * list view renders it under the STAGE · {id} header. Null when the stage
   * has no description set in config.
   */
  description: string | null;
  run: 'once' | 'per-item';
  phases: string[];
  status: 'pending' | 'in_progress' | 'complete' | 'blocked';
  needsApproval: boolean;
}

export interface ItemProjection {
  id: string;
  stageId: string;
  state: ItemStateProjection;
  displayTitle: string | null;
  displaySubtitle: string | null;
  /** Long-form description extracted via items_display.description JSONPath. */
  displayDescription: string | null;
  stableId: string | null;
  /**
   * Stable IDs of items this item depends on. Row UUIDs appear only as
   * fallback when the dep row has no stable_id (once-stage items).
   */
  dependsOn: string[];
}

export interface ItemStateProjection {
  status: string;
  currentPhase: string | null;
  retryCount: number;
  blockedReason: string | null;
}

export interface SessionProjection {
  sessionId: string;
  /** item_id from the sessions table; null for once-per-workflow sessions. */
  itemId: string | null;
  phase: string;
  attempt: number;
  startedAt: string;
  parentSessionId?: string | null;
}

export interface PendingAttentionEntry {
  id: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}

/** §2.3 — item.state partial update. */
export interface ItemStatePayload {
  itemId: string;
  stageId: string;
  state: Partial<ItemStateProjection>;
}

/** §2.3 — item.data on-demand blob. */
export interface ItemDataPayload {
  itemId: string;
  data: unknown;
}

/** §2.3a */
export interface StageStartedPayload {
  stageId: string;
  run: 'once' | 'per-item';
  itemCount?: number;
}

export interface StageCompletePayload {
  stageId: string;
  nextStageId: string | null;
  needsApproval: boolean;
  itemSummary?: {
    complete: number;
    blocked: number;
    abandoned: number;
  };
}

/** §2.5 */
export interface SessionStartedPayload {
  sessionId: string;
  /** item_id the session belongs to; null for once-per-workflow sessions. */
  itemId?: string | null;
  phase: string;
  attempt: number;
  startedAt: string;
  parentSessionId?: string | null;
}

/**
 * Initial prompt sent to the agent session. Captured at send time, written
 * as the first entry in the session's JSONL log and broadcast over WS.
 * Used by the UI to surface the fully-rendered prompt at the top of the
 * session log for debugging template substitutions.
 */
export interface InitialPromptPayload {
  sessionId: string;
  prompt: string;
  assembledAt: string;
}

export interface SessionEndedPayload {
  sessionId: string;
  endedAt: string;
  exitCode: number | null;
  statusFlags: Record<string, number | boolean>;
  reason: 'ok' | 'fail' | 'cancelled' | 'rate_limited' | 'tainted';
}

/** §2.8 */
export interface ErrorPayload {
  code: string;
  message: string;
  commandId?: string;
}

export interface NoticePayload {
  severity: 'info' | 'requires_attention';
  kind: string;
  message: string;
  persistedAttentionId?: number;
}

/** §2.4 — lightweight sidebar-list update for a single workflow. */
export interface WorkflowIndexUpdatePayload {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  unreadEvents: number;
}

/** §2.10 */
export interface BackfillTruncatedPayload {
  workflowId: string;
  sinceSeq: number;
  minAvailableSeq: number;
  /** URL to page the full log via HTTP GET /api/sessions/:id/log. */
  httpFetchUrl: string;
}

// ---------------------------------------------------------------------------
// Client frame payload types (§3)
// ---------------------------------------------------------------------------

export interface SubscribePayload {
  workflowId: string;
  sinceSeq?: number;
}

export interface UnsubscribePayload {
  workflowId: string;
}

export type ControlAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'skip'
  | 'rerun-phase'
  | 'inject-context'
  | 'unblock'
  | 'retry'
  | 'approve-stage';

export interface ControlPayload {
  workflowId: string;
  action: ControlAction;
  itemId?: string;
  stageId?: string;
  extra?: unknown;
}

export interface AckPayload {
  lastAppliedSeq: number;
  sessionId: string;
}

export interface PingPayload {
  clientTs: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a non-session ServerFrame (seq:0, no workflowId/sessionId unless
 * explicitly provided in opts).
 */
export function makeFrame<T>(
  type: ServerFrameType,
  payload: T,
  opts: { workflowId?: string; sessionId?: string; seq?: number } = {},
): ServerFrame<T> {
  return {
    v: 1,
    type,
    workflowId: opts.workflowId,
    sessionId: opts.sessionId,
    seq: opts.seq ?? 0,
    ts: new Date().toISOString(),
    payload,
  };
}

/** Build an error frame (seq:0, no workflowId/sessionId). */
export function makeErrorFrame(
  code: string,
  message: string,
  commandId?: string,
): ServerFrame<ErrorPayload> {
  return makeFrame('error', { code, message, ...(commandId ? { commandId } : {}) });
}
