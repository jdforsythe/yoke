/**
 * WebSocket connection handler.
 *
 * Implements the protocol defined in docs/design/protocol-websocket.md.
 *
 * Responsibilities:
 *  - Send hello frame immediately on connect (AC-1).
 *  - Validate ClientFrame.v; close 4001 on mismatch (AC-1).
 *  - Route subscribe / unsubscribe / control / ack / ping frames.
 *  - Enforce subscription cap (4 per client); send error + close 4002 on
 *    the 5th subscribe (AC-3).
 *  - For subscribe: send workflow.snapshot then backfill frames (or
 *    backfill.truncated if sinceSeq is too old) (AC-2).
 *  - Per-session monotonic seq starting at 1; non-session frames seq:0;
 *    backfill replays preserve original seq (RC: seq rules).
 *  - control commandId idempotency: cached response within 5 min (AC-4).
 *
 * Non-responsibilities (deferred to pipeline engine integration):
 *  - Pushing live frames to connected clients — the pipeline engine will call
 *    SessionSeqStore.next() + BackfillBuffer.push() + broadcast().
 *  - Validating / executing control actions beyond recording + caching.
 */

import type { WebSocket } from 'ws';
import type { DbPool } from '../storage/db.js';
import type {
  ClientFrame,
  SubscribePayload,
  UnsubscribePayload,
  ControlPayload,
  AckPayload,
  PingPayload,
  ServerFrame,
  ServerFrameType,
  WorkflowSnapshotPayload,
  StageProjection,
  ItemProjection,
  SessionProjection,
  PendingAttentionEntry,
} from './frames.js';
import { makeFrame, makeErrorFrame } from './frames.js';
import type { IdempotencyStore } from './idempotency.js';
import { JSONPath } from 'jsonpath-plus';

// ---------------------------------------------------------------------------
// Module-level caches
// ---------------------------------------------------------------------------

/**
 * Cache of validated JSONPath expression strings. JSONPath evaluation itself
 * is not cached (each item has distinct data); the set exists so that
 * malformed expressions only emit one console warning over the server's
 * lifetime rather than once per snapshot.
 */
const badJsonPathExprs = new Set<string>();

/**
 * Evaluate a JSONPath expression against json and return the first match as
 * a string. Returns null if evaluation fails or produces a non-string /
 * empty result — buildSnapshot treats these as "no description".
 */
function evalDescriptionPath(expr: string, json: unknown): string | null {
  try {
    const result = JSONPath({ path: expr, json: json as object }) as unknown[];
    const first = result.length > 0 ? result[0] : undefined;
    return typeof first === 'string' && first.length > 0 ? first : null;
  } catch (err) {
    if (!badJsonPathExprs.has(expr)) {
      badJsonPathExprs.add(expr);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`items_display.description JSONPath '${expr}' failed: ${msg}`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 1;
const MAX_SUBSCRIPTIONS = 4;
const SERVER_VERSION = '0.0.1';
const HEARTBEAT_INTERVAL_MS = 30_000;
const CAPABILITIES: string[] = ['backfill', 'keepalive', 'prepost'];

/** Max frames retained per session for WS backfill replay. */
export const MAX_BACKFILL_BUFFER = 500;

// ---------------------------------------------------------------------------
// SessionSeqStore — monotonic seq per sessionId
// ---------------------------------------------------------------------------

/**
 * Tracks the current seq number for each active session.
 * Shared across all WS connections (frames from the pipeline engine are
 * stamped with the next seq and then broadcast to all subscribed clients).
 */
export class SessionSeqStore {
  private readonly seqs = new Map<string, number>();

  /** Increments and returns the next seq for sessionId (starts at 1). */
  next(sessionId: string): number {
    const seq = (this.seqs.get(sessionId) ?? 0) + 1;
    this.seqs.set(sessionId, seq);
    return seq;
  }

  /** Returns the current (last issued) seq for sessionId, or 0 if none. */
  current(sessionId: string): number {
    return this.seqs.get(sessionId) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// BackfillBuffer — per-session in-memory frame ring buffer
// ---------------------------------------------------------------------------

/**
 * Retains the last MAX_BACKFILL_BUFFER frames per session for WS backfill
 * replay. When a client reconnects with sinceSeq:
 *   - If sinceSeq >= earliestRetained − 1: replay frames with seq > sinceSeq.
 *   - Else: caller should emit backfill.truncated and point to HTTP endpoint.
 */
export class BackfillBuffer {
  private readonly buffers = new Map<string, ServerFrame[]>();

  /**
   * Appends frame to the session's ring buffer, evicting the oldest entry
   * if the buffer exceeds MAX_BACKFILL_BUFFER.
   */
  push(sessionId: string, frame: ServerFrame): void {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = [];
      this.buffers.set(sessionId, buf);
    }
    buf.push(frame);
    if (buf.length > MAX_BACKFILL_BUFFER) {
      buf.shift();
    }
  }

  /**
   * Returns frames for sessionId with seq > sinceSeq, or null if sinceSeq
   * predates the earliest retained frame (caller should emit
   * backfill.truncated). Returns [] if no frames exist yet.
   */
  getFramesSince(sessionId: string, sinceSeq: number): ServerFrame[] | null {
    const buf = this.buffers.get(sessionId);
    if (!buf || buf.length === 0) return [];
    const earliest = buf[0].seq;
    // Client is asking for frames older than what we still hold.
    if (sinceSeq < earliest - 1) return null;
    return buf.filter((f) => f.seq > sinceSeq);
  }

  /** Earliest retained seq for sessionId, or 1 if no frames yet. */
  earliestSeq(sessionId: string): number {
    const buf = this.buffers.get(sessionId);
    return buf?.[0]?.seq ?? 1;
  }
}

// ---------------------------------------------------------------------------
// WsClientRegistry — tracks subscriptions for scheduler broadcast
// ---------------------------------------------------------------------------

/**
 * Tracks active WebSocket connections and their workflow subscriptions.
 *
 * The pipeline engine / scheduler calls broadcast() to push frames to all
 * clients subscribed to a workflow without knowing about individual sockets.
 *
 * The registry is created once per server instance and shared across all
 * connections. createWsHandler() registers each new socket on connect.
 */
export class WsClientRegistry {
  private readonly clients = new Map<WebSocket, Set<string>>();

  constructor(
    private readonly seqStore: SessionSeqStore,
    private readonly backfillBuffer: BackfillBuffer,
  ) {}

  /**
   * Registers a newly-connected socket. Sets up the 'close' handler to
   * automatically deregister it. Called from createWsHandler on connect.
   */
  register(socket: WebSocket): void {
    this.clients.set(socket, new Set());
    socket.on('close', () => {
      this.clients.delete(socket);
    });
  }

  /** Records that `socket` is subscribed to `workflowId`. */
  subscribe(socket: WebSocket, workflowId: string): void {
    this.clients.get(socket)?.add(workflowId);
  }

  /** Records that `socket` is no longer subscribed to `workflowId`. */
  unsubscribe(socket: WebSocket, workflowId: string): void {
    this.clients.get(socket)?.delete(workflowId);
  }

  /**
   * Broadcasts a frame to all clients subscribed to `workflowId`.
   *
   * For session-scoped frames (sessionId non-null):
   *   - Assigns the next monotonic seq from seqStore.
   *   - Pushes the frame into the backfillBuffer for reconnecting clients.
   * For workflow-scope frames (sessionId null): seq is 0.
   */
  broadcast(
    workflowId: string,
    sessionId: string | null,
    frameType: ServerFrameType,
    payload: unknown,
  ): void {
    const seq = sessionId ? this.seqStore.next(sessionId) : 0;
    const frame = makeFrame(frameType, payload, {
      workflowId,
      ...(sessionId ? { sessionId } : {}),
      seq,
    });

    if (sessionId) {
      this.backfillBuffer.push(sessionId, frame);
    }

    for (const [socket, subs] of this.clients) {
      // workflow.index.update is sent to all connected clients so the sidebar
      // stays up-to-date regardless of which workflow page the client is viewing.
      const isSubscribed = subs.has(workflowId) || frameType === 'workflow.index.update';
      if (isSubscribed && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    }
  }

  /**
   * Broadcasts a frame to ALL connected clients regardless of their workflow
   * subscriptions. Used for global notifications such as 'workflow.created'
   * where no client is yet subscribed to the new workflow.
   */
  broadcastAll(frameType: ServerFrameType, payload: unknown): void {
    const frame = makeFrame(frameType, payload, { seq: 0 });
    for (const [socket] of this.clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    }
  }

  /** Number of currently registered sockets. Useful for tests. */
  get size(): number {
    return this.clients.size;
  }
}

// ---------------------------------------------------------------------------
// WsHandlerContext — shared state injected into each connection
// ---------------------------------------------------------------------------

export interface WsHandlerContext {
  db: DbPool;
  idempotency: IdempotencyStore;
  seqStore: SessionSeqStore;
  backfillBuffer: BackfillBuffer;
  /** Optional client registry for broadcast. Added when the scheduler is running. */
  registry?: WsClientRegistry;
  /**
   * Lazy accessor for the workflow control executor.  Exposed as a function
   * so server.ts can thread the callback through createServer without knowing
   * about createWsHandler internals, and so start.ts can wire the executor
   * after createServer returns (same pattern used for other callbacks via
   * the mutable ServerCallbacks bag).
   */
  getControlExecutor?: () => import('../pipeline/control-executor.js').ControlExecutorFn | undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

/** Read a workflow snapshot from the read-only SQLite connection. */
export function buildSnapshot(db: DbPool, workflowId: string): WorkflowSnapshotPayload | null {
  const reader = db.reader();

  const wf = reader
    .prepare(
      `SELECT id, name, status, current_stage, created_at, recovery_state,
              github_state, github_pr_number, github_pr_url, github_pr_state,
              github_error, github_last_checked_at, paused_at
         FROM workflows WHERE id = ?`,
    )
    .get(workflowId) as {
      id: string;
      name: string;
      status: string;
      current_stage: string | null;
      created_at: string;
      recovery_state: string | null;
      github_state: string | null;
      github_pr_number: number | null;
      github_pr_url: string | null;
      github_pr_state: string | null;
      github_error: string | null;
      github_last_checked_at: string | null;
      paused_at: string | null;
    } | undefined;

  if (!wf) return null;

  const githubState = buildGithubStateProjection(wf);

  // Parse pipeline to get stages.
  const pipelineRow = reader
    .prepare('SELECT pipeline FROM workflows WHERE id = ?')
    .get(workflowId) as { pipeline: string } | undefined;

  let stages: StageProjection[] = [];
  /**
   * Per-stage items_display.description JSONPath, keyed by stage id.
   * Populated from the pipeline JSON alongside stage projection so both
   * loops share a single parse.
   */
  const stageDescriptionExpr = new Map<string, string>();
  if (pipelineRow?.pipeline) {
    try {
      const pipeline = JSON.parse(pipelineRow.pipeline) as {
        stages?: Array<{
          id: string;
          run: 'once' | 'per-item';
          phases: string[];
          needs_approval?: boolean;
          items_display?: { description?: string };
        }>;
      };
      const items = reader
        .prepare('SELECT stage_id, status FROM items WHERE workflow_id = ?')
        .all(workflowId) as Array<{ stage_id: string; status: string }>;

      stages = (pipeline.stages ?? []).map((s) => {
        if (s.items_display?.description) {
          stageDescriptionExpr.set(s.id, s.items_display.description);
        }
        return {
          id: s.id,
          run: s.run,
          phases: s.phases,
          status: computeStageStatus(items, s.id),
          needsApproval: s.needs_approval ?? false,
        };
      });
    } catch {
      // malformed pipeline JSON — return empty stages rather than crashing
    }
  }

  const itemRows = reader
    .prepare(
      'SELECT id, stage_id, stable_id, status, current_phase, retry_count, blocked_reason, depends_on, data FROM items WHERE workflow_id = ? ORDER BY rowid',
    )
    .all(workflowId) as Array<{
      id: string;
      stage_id: string;
      stable_id: string | null;
      status: string;
      current_phase: string | null;
      retry_count: number;
      blocked_reason: string | null;
      depends_on: string | null;
      data: string;
    }>;

  // rowId → stableId for translating depends_on row-UUID arrays to
  // human-readable stable IDs. Falls back to the raw UUID when the
  // referenced row has no stable_id (once-stage items).
  const rowIdToStableId = new Map<string, string>();
  for (const i of itemRows) {
    if (i.stable_id) rowIdToStableId.set(i.id, i.stable_id);
  }

  const items: ItemProjection[] = itemRows.map((i) => {
    // Translate depends_on row UUIDs → stable IDs (UUID fallback).
    let dependsOn: string[] = [];
    if (i.depends_on) {
      try {
        const raw = JSON.parse(i.depends_on) as unknown;
        if (Array.isArray(raw)) {
          dependsOn = raw
            .filter((x): x is string => typeof x === 'string')
            .map((rowId) => rowIdToStableId.get(rowId) ?? rowId);
        }
      } catch {
        // malformed depends_on JSON — treat as empty (no crash)
      }
    }

    // Evaluate items_display.description if configured for this item's stage.
    let displayDescription: string | null = null;
    const expr = stageDescriptionExpr.get(i.stage_id);
    if (expr) {
      try {
        const data = JSON.parse(i.data) as unknown;
        displayDescription = evalDescriptionPath(expr, data);
      } catch {
        // malformed items.data JSON — leave description null
      }
    }

    return {
      id: i.id,
      stageId: i.stage_id,
      stableId: i.stable_id ?? null,
      state: {
        status: i.status,
        currentPhase: i.current_phase,
        retryCount: i.retry_count,
        blockedReason: i.blocked_reason,
      },
      displayTitle: null,
      displaySubtitle: null,
      displayDescription,
      dependsOn,
    };
  });

  const sessionRows = reader
    .prepare(
      'SELECT id, item_id, phase, started_at, parent_session_id FROM sessions WHERE workflow_id = ? AND ended_at IS NULL ORDER BY started_at',
    )
    .all(workflowId) as Array<{
      id: string;
      item_id: string | null;
      phase: string;
      started_at: string;
      parent_session_id: string | null;
    }>;

  const activeSessions: SessionProjection[] = sessionRows.map((s) => ({
    sessionId: s.id,
    itemId: s.item_id,
    phase: s.phase,
    attempt: 0, // TODO: compute from events table when pipeline engine is integrated
    startedAt: s.started_at,
    parentSessionId: s.parent_session_id,
  }));

  const attentionRows = reader
    .prepare(
      'SELECT id, kind, payload, created_at FROM pending_attention WHERE workflow_id = ? AND acknowledged_at IS NULL ORDER BY created_at',
    )
    .all(workflowId) as Array<{
      id: number;
      kind: string;
      payload: string;
      created_at: string;
    }>;

  const pendingAttention: PendingAttentionEntry[] = attentionRows.map((a) => ({
    id: a.id,
    kind: a.kind,
    payload: (() => {
      try {
        return JSON.parse(a.payload);
      } catch {
        return a.payload;
      }
    })(),
    createdAt: a.created_at,
  }));

  return {
    workflow: {
      id: wf.id,
      name: wf.name,
      status: wf.status,
      currentStage: wf.current_stage,
      createdAt: wf.created_at,
      pausedAt: wf.paused_at ?? null,
      recoveryState: wf.recovery_state ? JSON.parse(wf.recovery_state) : null,
      githubState,
    },
    stages,
    items,
    activeSessions,
    pendingAttention,
  };
}

/**
 * Shape the workflows.github_* columns into the GithubState the client expects.
 * Mirrors the broadcast payload built in writeGithubState (github/service.ts).
 * Returns null when github_state is NULL (pre-github-migration rows only).
 */
const GITHUB_STATUSES = new Set([
  'disabled',
  'unconfigured',
  'idle',
  'creating',
  'created',
  'failed',
]);

const GITHUB_PR_STATES = new Set(['open', 'merged', 'closed']);

function buildGithubStateProjection(row: {
  github_state: string | null;
  github_pr_number: number | null;
  github_pr_url: string | null;
  github_pr_state: string | null;
  github_error: string | null;
  github_last_checked_at: string | null;
}): Record<string, unknown> | null {
  if (!row.github_state || !GITHUB_STATUSES.has(row.github_state)) return null;

  const out: Record<string, unknown> = { status: row.github_state };
  if (row.github_pr_number != null) out.prNumber = row.github_pr_number;
  if (row.github_pr_url) out.prUrl = row.github_pr_url;
  if (row.github_pr_state && GITHUB_PR_STATES.has(row.github_pr_state)) {
    out.prState = row.github_pr_state;
  }
  if (row.github_last_checked_at) out.lastCheckedAt = row.github_last_checked_at;
  if (row.github_error) {
    try {
      const parsed = JSON.parse(row.github_error) as
        | { kind: 'api_failed'; message: string }
        | { kind: 'auth_failed'; attempts: Array<{ source: string; reason: string }> };
      out.error =
        parsed.kind === 'api_failed'
          ? parsed.message
          : parsed.attempts.map((a) => `${a.source}: ${a.reason}`).join('; ');
    } catch {
      out.error = row.github_error;
    }
  }
  return out;
}

/** Derive stage status from item rows for that stage. */
function computeStageStatus(
  items: Array<{ stage_id: string; status: string }>,
  stageId: string,
): StageProjection['status'] {
  const stageItems = items.filter((i) => i.stage_id === stageId);
  if (stageItems.length === 0) return 'pending';
  const statuses = new Set(stageItems.map((i) => i.status));
  if (statuses.has('in_progress') || statuses.has('bootstrapping')) return 'in_progress';
  if (
    stageItems.every((i) =>
      ['complete', 'blocked', 'abandoned'].includes(i.status),
    )
  ) {
    return stageItems.some((i) => i.status === 'blocked') ? 'blocked' : 'complete';
  }
  if (statuses.has('awaiting_user') || statuses.has('awaiting_retry')) return 'in_progress';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Per-connection handlers
// ---------------------------------------------------------------------------

function handleSubscribe(
  socket: WebSocket,
  frame: ClientFrame<SubscribePayload>,
  subscriptions: Map<string, boolean>,
  ctx: WsHandlerContext,
): void {
  const { workflowId, sinceSeq } = frame.payload;

  // Enforce subscription cap (AC-3).
  if (!subscriptions.has(workflowId) && subscriptions.size >= MAX_SUBSCRIPTIONS) {
    send(socket, makeErrorFrame('SUBSCRIPTION_LIMIT', 'Maximum 4 concurrent subscriptions'));
    socket.close(4002, 'Subscription limit exceeded');
    return;
  }

  // Load snapshot from read-only SQLite connection (RC: no writes from API).
  const snapshot = buildSnapshot(ctx.db, workflowId);
  if (!snapshot) {
    process.stdout.write(`[MAIN_REPO_WS] NOT_FOUND for ${workflowId}\n`);
    send(socket, makeFrame('error', { code: 'NOT_FOUND', message: `Workflow ${workflowId} not found` }, { workflowId }));
    return;
  }

  subscriptions.set(workflowId, true);
  ctx.registry?.subscribe(socket, workflowId);

  // Send workflow.snapshot (non-session frame: seq:0).
  send(
    socket,
    makeFrame('workflow.snapshot', snapshot, { workflowId }),
  );

  // Handle backfill if sinceSeq is provided (AC-2).
  if (sinceSeq !== undefined) {
    // Find active sessions for this workflow to source backfill.
    const reader = ctx.db.reader();
    const sessionRows = reader
      .prepare('SELECT id FROM sessions WHERE workflow_id = ? ORDER BY started_at')
      .all(workflowId) as Array<{ id: string }>;

    for (const row of sessionRows) {
      const sessionId = row.id;
      const frames = ctx.backfillBuffer.getFramesSince(sessionId, sinceSeq);

      if (frames === null) {
        // sinceSeq predates retained buffer — emit backfill.truncated (AC-2).
        const minAvailableSeq = ctx.backfillBuffer.earliestSeq(sessionId);
        send(
          socket,
          makeFrame(
            'backfill.truncated',
            {
              workflowId,
              sinceSeq,
              minAvailableSeq,
              httpFetchUrl: `/api/sessions/${sessionId}/log?sinceSeq=${sinceSeq}&limit=1000`,
            },
            { workflowId },
          ),
        );
      } else {
        // Replay frames with original seq preserved (AC-2, RC: seq rules).
        for (const f of frames) {
          send(socket, f);
        }
      }
    }
  }
}

function handleUnsubscribe(
  socket: WebSocket,
  frame: ClientFrame<UnsubscribePayload>,
  subscriptions: Map<string, boolean>,
  ctx: WsHandlerContext,
): void {
  subscriptions.delete(frame.payload.workflowId);
  ctx.registry?.unsubscribe(socket, frame.payload.workflowId);
  // The server now stops sending workflow-scoped frames for this workflowId.
  // No acknowledgment frame is sent — protocol does not require one.
}

function handleControl(
  socket: WebSocket,
  frame: ClientFrame<ControlPayload>,
  _ctx: WsHandlerContext,
): void {
  const commandId = frame.id;
  const { workflowId, action } = frame.payload;

  // Idempotency check (AC-4): return cached response without re-executing.
  // Shared with the HTTP endpoint's idempotency store so a commandId sent via
  // either transport is deduped (the UI may retry through the other channel).
  const cached = _ctx.idempotency.get(commandId);
  if (cached !== undefined) {
    send(socket, cached as ServerFrame);
    return;
  }

  const executor = _ctx.getControlExecutor?.();

  if (executor) {
    const result = executor(workflowId, action);

    if (result.status === 'workflow_not_found') {
      const err = makeErrorFrame('NOT_FOUND', `Workflow ${workflowId} not found`, commandId);
      _ctx.idempotency.set(commandId, err);
      send(socket, err);
      return;
    }
    if (result.status === 'invalid_action') {
      const err = makeErrorFrame(
        'INVALID_ACTION',
        `Unsupported control action: ${result.action}`,
        commandId,
      );
      _ctx.idempotency.set(commandId, err);
      send(socket, err);
      return;
    }
    if (result.status === 'already_terminal') {
      const err = makeErrorFrame(
        'ALREADY_TERMINAL',
        'Workflow is already terminal',
        commandId,
      );
      _ctx.idempotency.set(commandId, err);
      send(socket, err);
      return;
    }

    const message =
      'cancelledItems' in result
        ? `Control action '${action}' accepted (${result.cancelledItems} items cancelled)`
        : `Control action '${action}' accepted`;
    const ok = makeFrame(
      'notice',
      {
        severity: 'info' as const,
        kind: 'control_accepted',
        message,
      },
      { workflowId },
    );
    _ctx.idempotency.set(commandId, ok);
    send(socket, ok);
    return;
  }

  // No executor wired — fall back to the stub behaviour so existing tests
  // (which exercise the protocol envelope but not the cancel side-effect)
  // keep passing.  Record and cache the response. Actual execution deferred.
  const response = makeFrame(
    'notice',
    {
      severity: 'info' as const,
      kind: 'control_accepted',
      message: `Control action '${action}' accepted`,
    },
    { workflowId },
  );

  _ctx.idempotency.set(commandId, response);
  send(socket, response);
}

function handleAck(
  _frame: ClientFrame<AckPayload>,
  _ctx: WsHandlerContext,
): void {
  // ack is advisory — server never waits for it. Its purpose is to allow
  // trimming retained backfill buffers when all subscribers have acknowledged
  // past a seq. Buffer trimming is not implemented in this phase.
}

function handlePing(socket: WebSocket, frame: ClientFrame<PingPayload>): void {
  send(socket, makeFrame('pong', { commandId: frame.id }, {}));
}

// ---------------------------------------------------------------------------
// Public: createWsHandler — factory for per-connection handler
// ---------------------------------------------------------------------------

/**
 * Returns a WebSocket connection handler that implements the Yoke WS protocol.
 *
 * ctx is shared across all connections created from one server instance
 * (idempotency store, seq counters, backfill buffers).
 */
export function createWsHandler(ctx: WsHandlerContext) {
  return function handleConnection(socket: WebSocket): void {
    // Per-connection subscription state (workflowId → true).
    const subscriptions = new Map<string, boolean>();

    // Register this socket in the client registry so broadcast() reaches it.
    ctx.registry?.register(socket);

    // Send hello immediately on connect before any other frame (AC-1, §2.1).
    send(
      socket,
      makeFrame('hello', {
        serverVersion: SERVER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      }),
    );

    socket.on('message', (data: Buffer | string) => {
      let frame: ClientFrame<unknown>;
      try {
        frame = JSON.parse(data.toString()) as ClientFrame<unknown>;
      } catch {
        send(socket, makeErrorFrame('BAD_FRAME', 'JSON parse error'));
        return;
      }

      // Protocol version check (AC-1): close 4001 on mismatch.
      if (frame.v !== PROTOCOL_VERSION) {
        socket.close(4001, 'Protocol version mismatch');
        return;
      }

      // Route by type.
      switch (frame.type) {
        case 'subscribe':
          handleSubscribe(
            socket,
            frame as ClientFrame<SubscribePayload>,
            subscriptions,
            ctx,
          );
          break;

        case 'unsubscribe':
          handleUnsubscribe(
            socket,
            frame as ClientFrame<UnsubscribePayload>,
            subscriptions,
            ctx,
          );
          break;

        case 'control':
          handleControl(socket, frame as ClientFrame<ControlPayload>, ctx);
          break;

        case 'ack':
          handleAck(frame as ClientFrame<AckPayload>, ctx);
          break;

        case 'ping':
          handlePing(socket, frame as ClientFrame<PingPayload>);
          break;

        default:
          send(
            socket,
            makeErrorFrame('BAD_FRAME', `Unknown frame type: ${String(frame.type)}`),
          );
      }
    });

    socket.on('error', () => {
      // Log-worthy in production but not fatal; socket will close on its own.
    });
  };
}
