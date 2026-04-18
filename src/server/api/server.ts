/**
 * Yoke Fastify HTTP + WebSocket server.
 *
 * This module replaces the interim Node.js http.Server in http.ts.  It
 * implements:
 *   - All HTTP companion endpoints from protocol-websocket.md §7.
 *   - WebSocket route at /stream (protocol per ws.ts).
 *   - Exclusive 127.0.0.1 binding (D57, RC: no 0.0.0.0 code path).
 *
 * Design invariants:
 *   - All reads use db.reader() (read-only connection).
 *   - No SQLite writes in this module (RC-3). The attention ack endpoint
 *     delegates the write to an injected AckAttentionFn callback so the API
 *     layer itself has no write path.
 *   - No authentication middleware (D57).
 *   - No 0.0.0.0 bind path exists anywhere in this file.
 */

import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import fastifyWebsocket, { type SocketStream } from '@fastify/websocket';
import type { DbPool } from '../storage/db.js';
import { readLogPage } from '../session-log/reader.js';
import {
  SessionSeqStore,
  BackfillBuffer,
  WsClientRegistry,
  createWsHandler,
} from './ws.js';
import { IdempotencyStore } from './idempotency.js';
import type { WorkflowRow, WorkflowStatus } from '../../shared/types/workflow.js';

// Re-export so consumers can import from a single server entry point.
export type { WorkflowRow, WorkflowStatus } from '../../shared/types/workflow.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ error: message });
}

function notFound(reply: FastifyReply, message = 'not found'): FastifyReply {
  return reply.status(404).send({ error: message });
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/** Raw row shape as returned by SQLite (snake_case column names). */
interface DbWorkflowRow {
  id: string;
  name: string;
  status: string;
  current_stage: string | null;
  created_at: string;
  updated_at: string;
  active_sessions: number;
  archived_at: string | null;
}

function mapWorkflowRow(row: DbWorkflowRow): WorkflowRow {
  return {
    id: row.id,
    name: row.name,
    status: row.status as WorkflowStatus,
    currentStage: row.current_stage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeSessions: row.active_sessions,
    unreadEvents: 0,
  };
}

interface DbTimelineEvent {
  id: number;
  ts: string;
  workflow_id: string;
  item_id: string | null;
  session_id: string | null;
  stage: string | null;
  phase: string | null;
  attempt: number | null;
  event_type: string;
  level: string;
  message: string;
  extra: string | null;
}

function mapTimelineEvent(e: DbTimelineEvent) {
  return {
    id: e.id,
    ts: e.ts,
    workflowId: e.workflow_id,
    itemId: e.item_id,
    sessionId: e.session_id,
    stage: e.stage,
    phase: e.phase,
    attempt: e.attempt,
    eventType: e.event_type,
    level: e.level,
    message: e.message,
    extra: e.extra ? (() => { try { return JSON.parse(e.extra!); } catch { return e.extra; } })() : null,
  };
}

interface DbItemSession {
  id: string;
  phase: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
}

function mapItemSession(row: DbItemSession) {
  return {
    id: row.id,
    phase: row.phase,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
  };
}

interface DbUsageRow {
  dimension: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  session_count: number;
}

function mapUsageRow(row: DbUsageRow) {
  return {
    dimension: row.dimension,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    sessionCount: row.session_count,
  };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface ServerOptions {
  /**
   * Bind host — MUST be '127.0.0.1'. Passing any other value throws at
   * listen time. Default: '127.0.0.1'.
   */
  host?: '127.0.0.1';
  /** Server port. 0 = OS-assigned (default for tests). */
  port?: number;
}

/** Shared in-memory state for the WS layer — exposed so tests and the pipeline engine integration can push frames. */
export interface ServerState {
  seqStore: SessionSeqStore;
  backfillBuffer: BackfillBuffer;
  idempotency: IdempotencyStore;
  /** Client registry for scheduler-driven broadcast. */
  registry: WsClientRegistry;
}

// Re-export so callers don't need a separate import.
export type { WsClientRegistry } from './ws.js';

export interface ServerHandle {
  fastify: FastifyInstance;
  state: ServerState;
}

/**
 * Result returned by AckAttentionFn to the API layer.
 * The callback owns both the read and the write for the ack operation so that
 * the API layer has no SQLite write path (RC-3).
 */
export type AckAttentionResult =
  | { status: 'acknowledged'; id: number }
  | { status: 'already_acknowledged'; id: number }
  | { status: 'not_found' };

/**
 * Callback that handles POST /api/workflows/:id/attention/:attentionId/ack.
 * Implementations must: verify the attention item exists and belongs to
 * workflowId, check acknowledged_at, write acknowledged_at = datetime('now')
 * if not already set, and return the appropriate result.
 *
 * The write MUST NOT happen inside the API layer (RC-3). Callers inject this
 * callback so the actual SQLite write lives in the pipeline engine layer.
 */
export type AckAttentionFn = (workflowId: string, attentionId: number) => AckAttentionResult;

// Re-export RetryItemsResult so the CLI can import it from a single place.
export type { RetryItemsResult, RetryItemsFn } from '../pipeline/retry-items.js';

// Re-export control executor types so the CLI can import them from a single place.
export type {
  ControlExecutorResult,
  ControlExecutorFn,
} from '../pipeline/control-executor.js';

// Re-export archive types so the CLI can import from a single place.
export type {
  ArchiveWorkflowResult,
  ArchiveWorkflowFn,
} from '../pipeline/archive-workflow.js';

/**
 * Optional callbacks injected into the server at creation time.
 * These allow the API layer to delegate writes to the pipeline engine layer
 * without the API module having any SQLite write path (RC-3).
 */
export interface ServerCallbacks {
  /**
   * Called when a client POSTs to
   * /api/workflows/:id/attention/:attentionId/ack.
   * If omitted, the endpoint returns 501 Not Implemented.
   */
  ackAttention?: AckAttentionFn;
  /**
   * Called when a client POSTs to POST /api/workflows/:id/retry.
   * Transitions all awaiting_user items in the workflow to in_progress.
   * If omitted, the endpoint returns 501 Not Implemented.
   */
  retryItems?: import('../pipeline/retry-items.js').RetryItemsFn;
  /**
   * Called when a client POSTs to POST /api/workflows/:id/control or sends a
   * WS control frame.  Executes cancel (and future pause/resume) actions via
   * the pipeline engine.  If omitted, the endpoint falls back to the legacy
   * stub behaviour (record + cache without executing) so existing tests keep
   * working.
   */
  controlExecutor?: import('../pipeline/control-executor.js').ControlExecutorFn;
  /**
   * Called when a client POSTs to POST /api/workflows/:id/archive or
   * POST /api/workflows/:id/unarchive.
   * If omitted, those endpoints return 501 Not Implemented.
   */
  archiveWorkflow?: import('../pipeline/archive-workflow.js').ArchiveWorkflowFn;
}

/**
 * Creates and configures the Fastify server.
 *
 * Callers must await fastify.listen(...) to start accepting connections.
 * The returned instance's .server.address() gives the bound port.
 *
 * @param db         DbPool opened by the caller.
 * @param callbacks  Optional injected handlers for write operations (RC-3).
 */
export async function createServer(db: DbPool, callbacks: ServerCallbacks = {}): Promise<ServerHandle> {
  const fastify = Fastify({ logger: false });

  // Shared state for the WS layer.
  const seqStore = new SessionSeqStore();
  const backfillBuffer = new BackfillBuffer();
  const idempotency = new IdempotencyStore();
  const registry = new WsClientRegistry(seqStore, backfillBuffer);

  // Register WebSocket plugin.
  await fastify.register(fastifyWebsocket);

  // WebSocket route at /stream (§4 Lifecycle).
  // Registered directly on the root fastify instance so it inherits the
  // @fastify/websocket plugin decoration without sub-plugin scoping issues.
  const wsHandler = createWsHandler({
    db,
    idempotency,
    seqStore,
    backfillBuffer,
    registry,
    // controlExecutor is read at call time via the callbacks closure so
    // start.ts can wire it in after createServer returns (same pattern as
    // ackAttention / retryItems above).
    getControlExecutor: () => callbacks.controlExecutor,
  });
  fastify.get('/stream', { websocket: true }, (connection: SocketStream) => {
    wsHandler(connection.socket);
  });

  // -------------------------------------------------------------------------
  // §7 HTTP companion endpoints
  // All read from db.reader() — no workflow/item state writes.
  // -------------------------------------------------------------------------

  // GET /api/workflows?status=&q=&before=&limit=
  // Keyset pagination (D47). Ordered by created_at DESC.
  fastify.get(
    '/api/workflows',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const qs = req.query as Record<string, string | undefined>;
      const limitRaw = parseInt(qs.limit ?? '20', 10);
      if (!isFinite(limitRaw) || limitRaw < 1) return badRequest(reply, 'limit must be a positive integer');
      const limit = Math.min(limitRaw, 100);

      let sql =
        'SELECT w.id, w.name, w.status, w.current_stage, w.created_at, w.updated_at, w.archived_at,' +
        ' (SELECT COUNT(*) FROM sessions s WHERE s.workflow_id = w.id AND s.ended_at IS NULL) AS active_sessions' +
        ' FROM workflows w WHERE 1=1';
      const params: unknown[] = [];

      // Exclude archived rows by default; include them only when ?archived=true.
      if (qs.archived === 'true') {
        sql += ' AND w.archived_at IS NOT NULL';
      } else {
        sql += ' AND w.archived_at IS NULL';
      }

      if (qs.status) {
        sql += ' AND w.status = ?';
        params.push(qs.status);
      }
      if (qs.q) {
        sql += ' AND w.name LIKE ?';
        params.push(`%${qs.q}%`);
      }
      if (qs.before) {
        sql += ' AND w.created_at < ?';
        params.push(qs.before);
      }
      sql += ` ORDER BY w.created_at DESC LIMIT ${limit + 1}`;

      const rows = db.reader().prepare(sql).all(...params) as DbWorkflowRow[];
      const hasMore = rows.length > limit;
      const workflows = (hasMore ? rows.slice(0, limit) : rows).map(mapWorkflowRow);

      return reply.send({
        workflows,
        hasMore,
        nextBefore: hasMore ? workflows[workflows.length - 1]!.createdAt : null,
      });
    },
  );

  // GET /api/workflows/:id/timeline
  // Merged SQLite events + JSONL (§Obs, D34).
  fastify.get(
    '/api/workflows/:id/timeline',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const reader = db.reader();

      const wf = reader.prepare('SELECT id FROM workflows WHERE id = ?').get(id) as { id: string } | undefined;
      if (!wf) return notFound(reply, 'workflow not found');

      const events = reader
        .prepare(
          'SELECT id, ts, workflow_id, item_id, session_id, stage, phase, attempt, event_type, level, message, extra FROM events WHERE workflow_id = ? ORDER BY ts, id',
        )
        .all(id) as DbTimelineEvent[];

      return reply.send({
        workflowId: id,
        events: events.map(mapTimelineEvent),
      });
    },
  );

  // GET /api/sessions/:id/log?sinceSeq=&limit=
  // Paged stream-json fetch (D48a). Reads from JSONL file via readLogPage.
  fastify.get(
    '/api/sessions/:id/log',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const qs = req.query as Record<string, string | undefined>;

      const sinceSeqRaw = qs.sinceSeq !== undefined ? parseInt(qs.sinceSeq, 10) : 0;
      const limitRaw = qs.limit !== undefined ? parseInt(qs.limit, 10) : 100;

      if (!isFinite(sinceSeqRaw) || sinceSeqRaw < 0) return badRequest(reply, 'sinceSeq must be a non-negative integer');
      if (!isFinite(limitRaw) || limitRaw < 1) return badRequest(reply, 'limit must be a positive integer');

      const sinceSeq = Math.max(0, sinceSeqRaw);
      const limit = Math.max(1, limitRaw);

      const reader = db.reader();
      const row = reader
        .prepare('SELECT session_log_path FROM sessions WHERE id = ?')
        .get(id) as { session_log_path: string | null } | undefined;

      if (!row) return notFound(reply, 'session not found');

      if (!row.session_log_path) {
        return reply.send({ entries: [], nextSeq: sinceSeq, hasMore: false });
      }

      const page = await readLogPage(row.session_log_path, sinceSeq, limit);
      if (!page) {
        return reply.send({ entries: [], nextSeq: sinceSeq, hasMore: false });
      }

      return reply.send(page);
    },
  );

  // GET /api/workflows/:id/usage?groupBy=feature|phase|profile|session
  // Token aggregates per groupBy dimension.
  fastify.get(
    '/api/workflows/:id/usage',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const qs = req.query as Record<string, string | undefined>;
      const groupBy = qs.groupBy ?? 'session';

      const validGroupBy = ['feature', 'phase', 'profile', 'session'];
      if (!validGroupBy.includes(groupBy)) {
        return badRequest(reply, `groupBy must be one of: ${validGroupBy.join(', ')}`);
      }

      const reader = db.reader();
      const wf = reader.prepare('SELECT id FROM workflows WHERE id = ?').get(id) as { id: string } | undefined;
      if (!wf) return notFound(reply, 'workflow not found');

      // Map groupBy dimension to SQLite column.
      const groupCol: Record<string, string> = {
        feature: 'item_id',
        phase: 'phase',
        profile: 'agent_profile',
        session: 'id',
      };
      const col = groupCol[groupBy];

      const rows = reader
        .prepare(
          `SELECT ${col} AS dimension,
                  SUM(input_tokens) AS input_tokens,
                  SUM(output_tokens) AS output_tokens,
                  SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
                  SUM(cache_read_input_tokens) AS cache_read_input_tokens,
                  COUNT(*) AS session_count
           FROM sessions
           WHERE workflow_id = ?
           GROUP BY ${col}
           ORDER BY input_tokens DESC`,
        )
        .all(id) as DbUsageRow[];

      return reply.send({ workflowId: id, groupBy, rows: rows.map(mapUsageRow) });
    },
  );

  // GET /api/workflows/:id/usage/timeseries?bucket=hour|day
  // Usage timeseries bucketed by hour or day.
  fastify.get(
    '/api/workflows/:id/usage/timeseries',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const qs = req.query as Record<string, string | undefined>;
      const bucket = qs.bucket ?? 'hour';

      if (bucket !== 'hour' && bucket !== 'day') {
        return badRequest(reply, 'bucket must be hour or day');
      }

      const reader = db.reader();
      const wf = reader.prepare('SELECT id FROM workflows WHERE id = ?').get(id) as { id: string } | undefined;
      if (!wf) return notFound(reply, 'workflow not found');

      // SQLite strftime format for the requested bucket.
      const fmt = bucket === 'hour' ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%dT00:00:00Z';

      const rows = reader
        .prepare(
          `SELECT strftime('${fmt}', started_at) AS bucket,
                  SUM(input_tokens) AS input_tokens,
                  SUM(output_tokens) AS output_tokens,
                  SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
                  SUM(cache_read_input_tokens) AS cache_read_input_tokens,
                  COUNT(*) AS session_count
           FROM sessions
           WHERE workflow_id = ?
           GROUP BY bucket
           ORDER BY bucket ASC`,
        )
        .all(id);

      return reply.send({ workflowId: id, bucket, rows });
    },
  );

  // POST /api/workflows/:id/control
  // Idempotent manual control (mirrors WS control frame).
  fastify.post(
    '/api/workflows/:id/control',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const body = req.body as {
        commandId?: string;
        action?: string;
        itemId?: string;
        stageId?: string;
        extra?: unknown;
      } | null;

      if (!body?.commandId) return badRequest(reply, 'commandId is required');
      if (!body.action) return badRequest(reply, 'action is required');

      const reader = db.reader();
      const wf = reader.prepare('SELECT id FROM workflows WHERE id = ?').get(id) as { id: string } | undefined;
      if (!wf) return notFound(reply, 'workflow not found');

      // Idempotency check (AC-4, RC: not by re-executing).
      // Cache hits always reply 200 (distinct from the original 202) so the
      // client can tell re-play apart from first execution; the body is the
      // identical body originally returned.
      const cached = idempotency.get(body.commandId);
      if (cached !== undefined) {
        return reply.status(200).send(cached);
      }

      // If an executor is wired (start.ts injects it), delegate real execution
      // to the engine layer. Otherwise fall back to the stub accepted-response
      // so existing tests that don't inject callbacks keep passing.
      if (callbacks.controlExecutor) {
        const result = callbacks.controlExecutor(id, body.action);

        if (result.status === 'workflow_not_found') {
          return notFound(reply, 'workflow not found');
        }
        if (result.status === 'invalid_action') {
          return reply.status(400).send({
            error: `invalid action: ${result.action}`,
            action: result.action,
          });
        }
        if (result.status === 'already_terminal') {
          return reply.status(409).send({
            error: 'workflow is already terminal',
          });
        }

        // accepted
        const responseBody = {
          status: 'accepted',
          commandId: body.commandId,
          workflowId: id,
          action: body.action,
          cancelledItems: result.cancelledItems,
        };
        // Cache AFTER successful execution (so a failure retry can re-run).
        idempotency.set(body.commandId, responseBody);
        return reply.status(202).send(responseBody);
      }

      // Cache and return accepted response. Actual execution deferred to pipeline engine.
      const response = {
        status: 'accepted',
        commandId: body.commandId,
        workflowId: id,
        action: body.action,
      };
      idempotency.set(body.commandId, response);

      return reply.status(202).send(response);
    },
  );

  // POST /api/push/subscriptions — browser-push stub (AC-3, RC-2).
  // Returns 501 Not Implemented. Real web-push (VAPID, subscription storage) is
  // deferred; no VAPID key generation or delivery attempt is made.
  fastify.post('/api/push/subscriptions', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(501).send({
      error: 'not_implemented',
      message: 'Browser push delivery is not yet implemented. This endpoint is a stub.',
    });
  });

  // POST /api/workflows/:id/attention/:attentionId/ack
  // Clear a pending attention item.
  // The write is delegated to callbacks.ackAttention (RC-3 — no writes in API layer).
  fastify.post(
    '/api/workflows/:id/attention/:attentionId/ack',
    async (
      req: FastifyRequest<{ Params: { id: string; attentionId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, attentionId } = req.params;
      const attId = parseInt(attentionId, 10);
      if (!isFinite(attId)) return badRequest(reply, 'attentionId must be an integer');

      if (!callbacks.ackAttention) {
        return reply.status(501).send({ error: 'attention ack not configured' });
      }

      // Verify the workflow exists using the read-only connection.
      const wf = db.reader().prepare('SELECT id FROM workflows WHERE id = ?').get(id) as { id: string } | undefined;
      if (!wf) return notFound(reply, 'workflow not found');

      // Delegate the pending_attention read + write to the injected callback
      // so that no SQLite write occurs inside the API layer (RC-3).
      const result = callbacks.ackAttention(id, attId);
      if (result.status === 'not_found') return notFound(reply, 'attention item not found');
      return reply.send(result);
    },
  );

  // GET /api/workflows/:id/items/:itemId/data
  // Returns the parsed items.data JSON for the given item.
  // 404 when workflow or item is not found, or item belongs to a different workflow.
  // 500 when items.data exists but cannot be parsed as JSON (defensive — schema guarantees valid JSON).
  fastify.get(
    '/api/workflows/:id/items/:itemId/data',
    async (
      req: FastifyRequest<{ Params: { id: string; itemId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, itemId } = req.params;
      const reader = db.reader();

      const wf = reader.prepare('SELECT id FROM workflows WHERE id = ?').get(id) as { id: string } | undefined;
      if (!wf) return notFound(reply, 'workflow not found');

      const item = reader
        .prepare('SELECT data FROM items WHERE id = ? AND workflow_id = ?')
        .get(itemId, id) as { data: string } | undefined;
      // Cross-workflow access returns 404 (item not found) — do not leak existence.
      if (!item) return notFound(reply, 'item not found');

      let parsed: unknown;
      try {
        parsed = JSON.parse(item.data);
      } catch {
        return reply.status(500).send({ error: 'item data is not valid JSON' });
      }

      return reply.send(parsed);
    },
  );

  // GET /api/items/:id/sessions
  // Returns past sessions for an item ordered by started_at DESC.
  fastify.get(
    '/api/items/:id/sessions',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const reader = db.reader();

      const item = reader
        .prepare('SELECT id FROM items WHERE id = ?')
        .get(id) as { id: string } | undefined;
      if (!item) return notFound(reply, 'item not found');

      const sessions = reader
        .prepare(
          `SELECT id, phase, status, started_at, ended_at, exit_code
           FROM sessions
           WHERE item_id = ?
           ORDER BY started_at DESC`,
        )
        .all(id) as DbItemSession[];

      return reply.send({ sessions: sessions.map(mapItemSession) });
    },
  );

  // POST /api/workflows/:id/archive and POST /api/workflows/:id/unarchive
  // Soft-archive or restore a workflow.
  // The write is delegated to callbacks.archiveWorkflow (RC-3 — no writes in API layer).
  // Archiving an in_progress workflow returns 409 with the current status.
  const handleArchive = (action: 'archive' | 'unarchive') =>
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;

      if (!callbacks.archiveWorkflow) {
        return reply.status(501).send({ error: 'archive not configured' });
      }

      const result = callbacks.archiveWorkflow(id, action);

      if (result.status === 'workflow_not_found') return notFound(reply, 'workflow not found');
      if (result.status === 'conflict') {
        return reply.status(409).send({
          error: `cannot archive a workflow with status '${result.currentStatus}'`,
          currentStatus: result.currentStatus,
        });
      }
      return reply.status(200).send(result);
    };

  fastify.post('/api/workflows/:id/archive', handleArchive('archive'));
  fastify.post('/api/workflows/:id/unarchive', handleArchive('unarchive'));

  // POST /api/workflows/:id/retry
  // Transition all awaiting_user items in the workflow back to in_progress.
  // The write is delegated to callbacks.retryItems (RC-3 — no writes in API layer).
  fastify.post(
    '/api/workflows/:id/retry',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;

      if (!callbacks.retryItems) {
        return reply.status(501).send({ error: 'retry not configured' });
      }

      const result = callbacks.retryItems(id);

      if (result.status === 'workflow_not_found') return notFound(reply, 'workflow not found');
      if (result.status === 'none_awaiting') {
        return reply.status(200).send({ status: 'none_awaiting', items: [] });
      }
      return reply.status(200).send(result);
    },
  );

  return { fastify, state: { seqStore, backfillBuffer, idempotency, registry } };
}

// ---------------------------------------------------------------------------
// Convenience: listen with enforced 127.0.0.1 binding (AC-6, RC)
// ---------------------------------------------------------------------------

/**
 * Creates the server and starts listening on 127.0.0.1. Throws if host is
 * anything other than '127.0.0.1' — no 0.0.0.0 bind path exists (D57).
 *
 * @returns The listening Fastify instance.
 */
export async function listenServer(
  db: DbPool,
  opts: ServerOptions = {},
  callbacks: ServerCallbacks = {},
): Promise<FastifyInstance> {
  const host = opts.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') {
    throw new Error(`Server must bind to 127.0.0.1, not ${host} (D57)`);
  }
  const port = opts.port ?? 0;

  const { fastify } = await createServer(db, callbacks);
  await fastify.listen({ host, port });
  return fastify;
}
