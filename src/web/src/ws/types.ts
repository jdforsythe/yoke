/**
 * WebSocket protocol types — from protocol-websocket.md §8 (authoritative).
 * Do NOT modify without updating the server-side types in sync.
 */

import type { WorkflowStatus } from '../../../shared/types/workflow';
import type { WorkflowGraph, GraphPatch } from '../../../shared/types/graph';

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
  workflowId?: string;
  sessionId?: string;
  seq: number;
  ts: string;
  payload: T;
}

export interface ClientFrame<T = unknown> {
  v: 1;
  type: ClientFrameType;
  id: string;
  payload: T;
}

// ---------------------------------------------------------------------------
// Server payload types
// ---------------------------------------------------------------------------

export interface HelloPayload {
  serverVersion: string;
  protocolVersion: 1;
  capabilities: string[];
  heartbeatIntervalMs: number;
}

export interface RecoveryState {
  recoveredAt: string;
  priorStatus: string;
  resumeMethod: 'continue' | 'fresh';
  uncommittedChanges: boolean;
  lastKnownSessionId: string | null;
}

export interface GithubState {
  status: 'disabled' | 'unconfigured' | 'idle' | 'creating' | 'created' | 'failed';
  prNumber?: number;
  prUrl?: string;
  prState?: 'open' | 'merged' | 'closed';
  error?: string;
  lastCheckedAt?: string;
}

export interface PendingAttention {
  id: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export interface StageProjection {
  id: string;
  run: 'once' | 'per-item';
  phases: string[];
  status: 'pending' | 'in_progress' | 'complete' | 'blocked';
  needsApproval: boolean;
}

export interface ItemStateProjection {
  status: string;
  currentPhase: string | null;
  retryCount: number;
  blockedReason: string | null;
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

export interface SessionProjection {
  sessionId: string;
  /** item_id from the sessions table; null for once-per-workflow sessions. */
  itemId: string | null;
  phase: string;
  attempt: number;
  startedAt: string;
  parentSessionId: string | null;
}

export interface WorkflowSnapshotPayload {
  workflow: {
    id: string;
    name: string;
    status: string;
    currentStage: string | null;
    createdAt: string;
    pausedAt?: string | null;
    recoveryState?: RecoveryState | null;
    githubState?: GithubState | null;
  };
  stages: StageProjection[];
  items: ItemProjection[];
  activeSessions: SessionProjection[];
  pendingAttention: PendingAttention[];
  /** Optional graph projection (Graph View). Absent on workflows that have
   *  never received a graph frame. */
  graph?: WorkflowGraph;
}

/** Graph-view live update — incremental patch over the last known WorkflowGraph. */
export interface GraphUpdatePayload {
  workflowId: string;
  patch: GraphPatch;
}

export interface WorkflowIndexUpdatePayload {
  id: string;
  name: string;
  status: WorkflowStatus;
  updatedAt: string;
  unreadEvents: number;
}

export interface WorkflowCreatedPayload {
  workflowId: string;
  name: string;
}

export interface ItemStatePayload {
  itemId: string;
  stageId: string;
  state: Partial<ItemStateProjection>;
}

export interface ItemDataPayload {
  itemId: string;
  data: unknown;
}

export interface StageStartedPayload {
  stageId: string;
  run: 'once' | 'per-item';
  itemCount?: number;
}

export interface StageCompletePayload {
  stageId: string;
  nextStageId: string | null;
  needsApproval: boolean;
  itemSummary?: { complete: number; blocked: number; abandoned: number };
}

export interface SessionStartedPayload {
  sessionId: string;
  /** item_id the session belongs to; null / absent for once-per-workflow sessions. */
  itemId?: string | null;
  phase: string;
  attempt: number;
  startedAt: string;
  parentSessionId?: string | null;
}

export interface SessionEndedPayload {
  sessionId: string;
  endedAt: string;
  exitCode: number | null;
  statusFlags: Record<string, number | boolean>;
  reason: 'ok' | 'fail' | 'cancelled' | 'rate_limited' | 'tainted';
}

export interface StreamInitialPrompt {
  sessionId: string;
  prompt: string;
  assembledAt: string;
}

export interface StreamText {
  sessionId: string;
  blockId: string;
  textDelta: string;
  final?: boolean;
}

export interface StreamThinking {
  sessionId: string;
  blockId: string;
  textDelta: string;
  final?: boolean;
}

export interface StreamToolUse {
  sessionId: string;
  toolUseId: string;
  name: string;
  input: unknown;
  status: 'pending' | 'running';
}

export interface StreamToolResult {
  sessionId: string;
  toolUseId: string;
  status: 'ok' | 'error';
  output: unknown;
}

export interface StreamUsage {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  rawUsage: unknown;
}

export interface StreamSystemNotice {
  sessionId?: string;
  severity: 'info' | 'warn' | 'error';
  source: 'harness' | 'stderr' | 'heartbeat' | 'rate_limit' | 'hook' | 'recovery';
  message: string;
  extra?: unknown;
}

export interface PrepostCommandStarted {
  runId: number;
  phase: string;
  when: 'pre' | 'post';
  name: string;
  argv: string[];
  startedAt: string;
}

export interface PrepostCommandOutput {
  runId: number;
  stream: 'stdout' | 'stderr';
  chunk: string;
}

export interface PrepostCommandEnded {
  runId: number;
  exitCode: number;
  action: unknown;
  endedAt: string;
}

export interface NoticePayload {
  severity: 'info' | 'requires_attention';
  kind: string;
  message: string;
  persistedAttentionId?: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
  commandId?: string;
}

export interface BackfillTruncatedPayload {
  workflowId: string;
  sinceSeq: number;
  minAvailableSeq: number;
  httpFetchUrl: string;
}

// ---------------------------------------------------------------------------
// Client payload types
// ---------------------------------------------------------------------------

export interface SubscribePayload {
  workflowId: string;
  sinceSeq?: number;
}

export interface UnsubscribePayload {
  workflowId: string;
}

export interface ControlPayload {
  workflowId: string;
  action:
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'skip'
    | 'rerun-phase'
    | 'inject-context'
    | 'unblock'
    | 'retry'
    | 'approve-stage';
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

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'version_mismatch';
