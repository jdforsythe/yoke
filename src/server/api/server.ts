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
 *   - The only SQLite write in this module is attention ack (sets
 *     acknowledged_at on pending_attention rows); all workflow/item state
 *     transitions are the pipeline engine's domain.
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
  createWsHandler,
} from './ws.js';
import { IdempotencyStore } from './idempotency.js';

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

interface WorkflowRow {
  id: string;
  name: string;
  status: string;
  current_stage: string | null;
  created_at: string;
  updated_at: string;
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
}

export interface ServerHandle {
  fastify: FastifyInstance;
  state: ServerState;
}

/**
 * Creates and configures the Fastify server.
 *
 * Callers must await fastify.listen(...) to start accepting connections.
 * The returned instance's .server.address() gives the bound port.
 *
 * @param db  DbPool opened by the caller.
 */
export async function createServer(db: DbPool): Promise<ServerHandle> {
  const fastify = Fastify({ logger: false });

  // Shared state for the WS layer.
  const seqStore = new SessionSeqStore();
  const backfillBuffer = new BackfillBuffer();
  const idempotency = new IdempotencyStore();

  // Register WebSocket plugin.
  await fastify.register(fastifyWebsocket);

  // WebSocket route at /stream (§4 Lifecycle).
  // Registered directly on the root fastify instance so it inherits the
  // @fastify/websocket plugin decoration without sub-plugin scoping issues.
  const wsHandler = createWsHandler({ db, idempotency, seqStore, backfillBuffer });
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

      let sql = 'SELECT id, name, status, current_stage, created_at, updated_at FROM workflows WHERE 1=1';
      const params: unknown[] = [];

      if (qs.status) {
        sql += ' AND status = ?';
        params.push(qs.status);
      }
      if (qs.q) {
        sql += ' AND name LIKE ?';
        params.push(`%${qs.q}%`);
      }
      if (qs.before) {
        sql += ' AND created_at < ?';
        params.push(qs.before);
      }
      sql += ` ORDER BY created_at DESC LIMIT ${limit + 1}`;

      const rows = db.reader().prepare(sql).all(...params) as WorkflowRow[];
      const hasMore = rows.length > limit;
      const workflows = hasMore ? rows.slice(0, limit) : rows;

      return reply.send({
        workflows,
        hasMore,
        nextBefore: hasMore ? workflows[workflows.length - 1].created_at : null,
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
        .all(id) as Array<{
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
        }>;

      return reply.send({
        workflowId: id,
        events: events.map((e) => ({
          ...e,
          extra: e.extra ? (() => { try { return JSON.parse(e.extra!); } catch { return e.extra; } })() : null,
        })),
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
        .all(id);

      return reply.send({ workflowId: id, groupBy, rows });
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
      const cached = idempotency.get(body.commandId);
      if (cached !== undefined) {
        return reply.status(200).send(cached);
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

  // POST /api/workflows/:id/attention/:attentionId/ack
  // Clear a pending attention item.
  fastify.post(
    '/api/workflows/:id/attention/:attentionId/ack',
    async (
      req: FastifyRequest<{ Params: { id: string; attentionId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, attentionId } = req.params;
      const attId = parseInt(attentionId, 10);
      if (!isFinite(attId)) return badRequest(reply, 'attentionId must be an integer');

      const reader = db.reader();
      const wf = reader.prepare('SELECT id FROM workflows WHERE id = ?').get(id) as { id: string } | undefined;
      if (!wf) return notFound(reply, 'workflow not found');

      const row = reader
        .prepare('SELECT id, acknowledged_at FROM pending_attention WHERE id = ? AND workflow_id = ?')
        .get(attId, id) as { id: number; acknowledged_at: string | null } | undefined;

      if (!row) return notFound(reply, 'attention item not found');

      // Already acknowledged — idempotent.
      if (row.acknowledged_at) {
        return reply.send({ status: 'already_acknowledged', id: attId });
      }

      // This is the one write from the API layer: acknowledging a pending
      // attention item is an operational action, not a state-machine transition.
      db.writer
        .prepare(
          "UPDATE pending_attention SET acknowledged_at = datetime('now') WHERE id = ?",
        )
        .run(attId);

      return reply.send({ status: 'acknowledged', id: attId });
    },
  );

  return { fastify, state: { seqStore, backfillBuffer, idempotency } };
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
): Promise<FastifyInstance> {
  const host = opts.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') {
    throw new Error(`Server must bind to 127.0.0.1, not ${host} (D57)`);
  }
  const port = opts.port ?? 0;

  const { fastify } = await createServer(db);
  await fastify.listen({ host, port });
  return fastify;
}
