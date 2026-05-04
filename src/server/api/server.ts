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

import * as path from 'path';
import { existsSync, statSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import fastifyWebsocket, { type SocketStream } from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { DbPool } from '../storage/db.js';
import { readArtifactFile, readLogPage } from '../session-log/reader.js';
import { makePrepostOutputDir } from '../session-log/writer.js';
import {
  SessionSeqStore,
  BackfillBuffer,
  WsClientRegistry,
  createWsHandler,
} from './ws.js';
import { IdempotencyStore } from './idempotency.js';
import type { WorkflowRow, WorkflowStatus } from '../../shared/types/workflow.js';
import type {
  ItemTimelineRow,
  ItemTimelinePrepostRow,
} from '../../shared/types/timeline.js';

// Re-export so consumers can import from a single server entry point.
export type { WorkflowRow, WorkflowStatus } from '../../shared/types/workflow.js';
export type {
  ItemTimelineRow,
  ItemTimelineSessionRow,
  ItemTimelinePrepostRow,
  ItemTimelineResponse,
} from '../../shared/types/timeline.js';

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

// ---------------------------------------------------------------------------
// Item timeline helpers (GET /api/workflows/:id/items/:itemId/timeline)
// ---------------------------------------------------------------------------

interface DbTimelineSessionRow {
  id: string;
  phase: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  parent_session_id: string | null;
}

interface DbTimelinePrepostRow {
  id: number;
  when_phase: 'pre' | 'post';
  command_name: string;
  phase: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  action_taken: string | null;
  stdout_path: string | null;
  stderr_path: string | null;
}

/**
 * Parse the `prepost_runs.action_taken` JSON column into a shaped object.
 * Returns null if the column is null, empty, or malformed — the endpoint
 * treats any parse failure as "no action recorded" rather than 500, since
 * a malformed row should not break the rest of the timeline.
 */
/**
 * Parse a graph `prepostRunId` of the form `run:<sid>:<when>:<cmd>:<startedAt>`
 * back into its coordinates.  startedAt (ISO 8601) contains colons, so we split
 * left-to-right up to the first three delimiters and treat the remainder as
 * startedAt.  `sid === '_'` maps back to `null` (no session attached).
 */
function parsePrepostRunId(
  id: string,
): { sessionId: string | null; when: 'pre' | 'post'; commandName: string; startedAt: string } | null {
  if (!id.startsWith('run:')) return null;
  const rest = id.slice(4);
  const i1 = rest.indexOf(':');
  if (i1 < 0) return null;
  const sidRaw = rest.slice(0, i1);
  const rest1 = rest.slice(i1 + 1);
  const i2 = rest1.indexOf(':');
  if (i2 < 0) return null;
  const when = rest1.slice(0, i2);
  if (when !== 'pre' && when !== 'post') return null;
  const rest2 = rest1.slice(i2 + 1);
  const i3 = rest2.indexOf(':');
  if (i3 < 0) return null;
  const commandName = rest2.slice(0, i3);
  const startedAt = rest2.slice(i3 + 1);
  if (!startedAt) return null;
  return {
    sessionId: sidRaw === '_' ? null : sidRaw,
    when,
    commandName,
    startedAt,
  };
}

function parseActionTaken(raw: string | null): ItemTimelinePrepostRow['actionTaken'] {
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const out: NonNullable<ItemTimelinePrepostRow['actionTaken']> = {};
    if (typeof obj.goto === 'string') out.goto = obj.goto;
    if (typeof obj.retry === 'boolean') out.retry = obj.retry;
    if (typeof obj.fail === 'boolean') out.fail = obj.fail;
    if (typeof obj.continue === 'boolean') out.continue = obj.continue;
    return out;
  } catch {
    return null;
  }
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

interface DbTimeseriesRow {
  bucket: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  session_count: number;
}

function mapTimeseriesRow(row: DbTimeseriesRow) {
  return {
    bucket: row.bucket,
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

// ---------------------------------------------------------------------------
// Template / workflow-creation callback types (t-07)
// ---------------------------------------------------------------------------

/** Shape returned by ListTemplatesFn to the GET /api/templates response. */
export interface TemplateSummaryItem {
  name: string;
  description: string | null;
}

/**
 * Returns the list of templates available in the configured templates directory.
 * Called by GET /api/templates. If omitted, the endpoint returns {templates: []}.
 */
export type ListTemplatesFn = () => TemplateSummaryItem[];

export type CreateWorkflowResult =
  | { status: 'template_not_found' }
  | { status: 'template_error'; message: string }
  | { status: 'created'; workflowId: string; name: string; sameTemplateNames: string[] };

/**
 * Creates a new workflow from the named template with the given user-supplied name.
 * Called by POST /api/workflows. The DB write must happen inside this callback (RC-3).
 * If omitted, the endpoint returns 501.
 */
export type CreateWorkflowFn = (input: {
  templateName: string;
  name: string;
}) => CreateWorkflowResult;

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
  /**
   * Called when a client POSTs to POST /api/workflows/:id/github/create-pr.
   * Validates eligibility then runs pushBranch + createPr.
   * If omitted, the endpoint returns 501 Not Implemented.
   */
  createPrExecutor?: import('../pipeline/create-pr-executor.js').CreatePrExecutorFn;
  /**
   * Returns the list of templates for GET /api/templates.
   * If omitted, the endpoint returns {templates: []}.
   */
  listTemplates?: ListTemplatesFn;
  /**
   * Creates a new workflow from a template for POST /api/workflows.
   * Must perform the DB write (RC-3 — no writes in API layer).
   * If omitted, the endpoint returns 501 Not Implemented.
   */
  createWorkflow?: CreateWorkflowFn;
  /**
   * Absolute path to the directory containing the active .yoke.yml. Used by
   * the prepost-artifact endpoint to compute the expected root for a given
   * workflow (via makePrepostOutputDir) so the path-traversal guard can
   * reject any stored DB path that does not resolve under that root.
   *
   * When omitted, the endpoint returns 501 Not Implemented — the server
   * cannot validate artifact paths without knowing the configDir.
   */
  configDir?: string;
  /**
   * Override for os.homedir() used when computing the expected root for the
   * prepost-artifact guard. Tests pass a per-test tmp dir so captured files
   * and the guard agree on the same tree.
   */
  homeDir?: string;
  /**
   * Absolute path to the directory containing the bundled web assets
   * (typically `<package-root>/dist/web`). When the directory exists, the
   * server serves static files from it with an SPA fallback to index.html
   * for any non-API GET. When omitted (or the directory does not exist),
   * static serving is skipped — useful in tests and during the dev flow
   * where Vite serves the UI on its own port.
   */
  webRoot?: string;
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

      return reply.send({ workflowId: id, bucket, rows: (rows as DbTimeseriesRow[]).map(mapTimeseriesRow) });
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

        // accepted — build response body based on which accepted variant fired
        const responseBody: Record<string, unknown> = {
          status: 'accepted',
          commandId: body.commandId,
          workflowId: id,
          action: body.action,
        };
        if ('cancelledItems' in result) responseBody.cancelledItems = result.cancelledItems;
        if ('pausedAt' in result) responseBody.pausedAt = result.pausedAt;
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

  // GET /api/workflows/:workflowId/items/:itemId/timeline
  // Returns a chronologically merged list of sessions + prepost_runs for the
  // item, ascending by started_at, tie-broken by row id (lexicographic).
  // 404 when workflow or item is unknown, or item belongs to a different workflow.
  fastify.get(
    '/api/workflows/:workflowId/items/:itemId/timeline',
    async (
      req: FastifyRequest<{ Params: { workflowId: string; itemId: string } }>,
      reply: FastifyReply,
    ) => {
      const { workflowId, itemId } = req.params;
      const reader = db.reader();

      const wf = reader
        .prepare('SELECT id, config FROM workflows WHERE id = ?')
        .get(workflowId) as { id: string; config: string } | undefined;
      if (!wf) return notFound(reply, 'workflow not found');

      const item = reader
        .prepare('SELECT id FROM items WHERE id = ? AND workflow_id = ?')
        .get(itemId, workflowId) as { id: string } | undefined;
      // Cross-workflow access returns 404 — do not leak existence.
      if (!item) return notFound(reply, 'item not found');

      // Build phaseName → description from the workflow's resolved config.
      // Phases missing from config (e.g. legacy rows after a config change)
      // emit `null` in phaseDescription.
      const phaseDescByName = new Map<string, string>();
      try {
        const parsed = JSON.parse(wf.config) as {
          phases?: Record<string, { description?: string }>;
        };
        if (parsed.phases) {
          for (const [name, phase] of Object.entries(parsed.phases)) {
            if (phase && typeof phase.description === 'string') {
              phaseDescByName.set(name, phase.description);
            }
          }
        }
      } catch {
        // Malformed config JSON — every phaseDescription falls through to null.
      }

      const sessionRows = reader
        .prepare(
          `SELECT id, phase, status, started_at, ended_at, exit_code, parent_session_id
           FROM sessions
           WHERE item_id = ?
           ORDER BY started_at ASC, id ASC`,
        )
        .all(itemId) as DbTimelineSessionRow[];

      const prepostRows = reader
        .prepare(
          `SELECT id, when_phase, command_name, phase, started_at, ended_at,
                  exit_code, action_taken, stdout_path, stderr_path
           FROM prepost_runs
           WHERE item_id = ?
           ORDER BY started_at ASC, id ASC`,
        )
        .all(itemId) as DbTimelinePrepostRow[];

      // `attempt` is derived (not stored) — it is the 1-based index of a session
      // within its (item_id, phase) cohort ordered by started_at. We could use
      // items.retry_count (see src/server/pipeline/retry-items.ts:99) but that's
      // a single counter per item and cannot disambiguate multi-phase retries,
      // so we count prior sessions for the same phase here.
      const attemptByPhase = new Map<string, number>();
      const sessionRowsMapped: ItemTimelineRow[] = sessionRows.map((r) => {
        const next = (attemptByPhase.get(r.phase) ?? 0) + 1;
        attemptByPhase.set(r.phase, next);
        return {
          kind: 'session',
          id: r.id,
          phase: r.phase,
          phaseDescription: phaseDescByName.get(r.phase) ?? null,
          attempt: next,
          status: r.status,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          exitCode: r.exit_code,
          parentSessionId: r.parent_session_id,
        };
      });

      const prepostRowsMapped: ItemTimelineRow[] = prepostRows.map((r) => {
        // prepost_runs has no `status` column — derive from exit_code
        // (null/0 = ok, non-zero = fail).
        const status: 'ok' | 'fail' = r.exit_code == null || r.exit_code === 0 ? 'ok' : 'fail';
        return {
          kind: 'prepost',
          id: String(r.id),
          whenPhase: r.when_phase,
          commandName: r.command_name,
          phase: r.phase,
          phaseDescription: phaseDescByName.get(r.phase) ?? null,
          status,
          exitCode: r.exit_code,
          actionTaken: parseActionTaken(r.action_taken),
          startedAt: r.started_at,
          endedAt: r.ended_at,
          stdoutPath: r.stdout_path,
          stderrPath: r.stderr_path,
        };
      });

      const rows: ItemTimelineRow[] = [...sessionRowsMapped, ...prepostRowsMapped].sort((a, b) => {
        if (a.startedAt < b.startedAt) return -1;
        if (a.startedAt > b.startedAt) return 1;
        // Stable tie-breaker — lexicographic id compare is sufficient when the
        // timestamps are equal and no higher-resolution signal is available.
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });

      return reply.send({ rows });
    },
  );

  // GET /api/workflows/:workflowId/items/:itemId/prepost/:prepostId/:stream
  // Returns the captured stdout or stderr for one prepost_runs row as
  // { content, totalSize, truncated }. Files are already capped at
  // OUTPUT_CAPTURE_LIMIT (32 KiB) on write so a single response is fine —
  // no pagination needed.
  //
  // Security — the stored stdout_path / stderr_path is server-written by the
  // runner, but a malicious or corrupted DB row could still point outside the
  // workflow's output tree. We defend against that by recomputing the expected
  // root via makePrepostOutputDir({ configDir, workflowId }) and asserting
  // the resolved stored path starts with the resolved root. Cross-workflow /
  // cross-item mismatches return 404 (do not leak existence via 400).
  fastify.get(
    '/api/workflows/:workflowId/items/:itemId/prepost/:prepostId/:stream',
    async (
      req: FastifyRequest<{
        Params: { workflowId: string; itemId: string; prepostId: string; stream: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { workflowId, itemId, prepostId, stream } = req.params;

      if (stream !== 'stdout' && stream !== 'stderr') {
        return badRequest(reply, "stream must be 'stdout' or 'stderr'");
      }

      if (!callbacks.configDir) {
        return reply.status(501).send({ error: 'prepost artifact serving not configured' });
      }

      const reader = db.reader();
      // Look up the row by id only; cross-workflow / cross-item mismatches
      // return 404 in the next step (no differentiated error code to avoid
      // leaking whether a given id exists in a different workflow).
      const prepostIdNum = Number(prepostId);
      if (!Number.isInteger(prepostIdNum) || prepostIdNum <= 0) {
        return notFound(reply, 'prepost run not found');
      }

      const row = reader
        .prepare(
          'SELECT id, workflow_id, item_id, stdout_path, stderr_path FROM prepost_runs WHERE id = ?',
        )
        .get(prepostIdNum) as
        | {
            id: number;
            workflow_id: string;
            item_id: string | null;
            stdout_path: string | null;
            stderr_path: string | null;
          }
        | undefined;

      if (!row) return notFound(reply, 'prepost run not found');
      if (row.workflow_id !== workflowId || row.item_id !== itemId) {
        return notFound(reply, 'prepost run not found');
      }

      const storedPath = stream === 'stdout' ? row.stdout_path : row.stderr_path;
      if (!storedPath) {
        return reply.status(404).send({ error: 'no output captured' });
      }

      // Path-traversal guard. We recompute the expected root from the
      // server-local configDir (+ optional homeDir override for tests) and
      // assert the stored path resolves under it. path.resolve() canonicalises
      // the input without requiring the file to exist (unlike fs.realpath),
      // which is fine because the root itself is not a symlink target in
      // normal yoke operation.
      const expectedRoot = path.resolve(
        makePrepostOutputDir({
          configDir: callbacks.configDir,
          workflowId,
          homeDir: callbacks.homeDir,
        }),
      );
      const resolvedPath = path.resolve(storedPath);
      // Append a sep so "/a/b" does not spuriously contain "/a/bc".
      const rootWithSep = expectedRoot.endsWith(path.sep) ? expectedRoot : expectedRoot + path.sep;
      if (!resolvedPath.startsWith(rootWithSep)) {
        return badRequest(reply, 'stored artifact path is outside the expected root');
      }

      const file = await readArtifactFile(resolvedPath);
      if (!file) return notFound(reply, 'artifact file not found');

      return reply.send(file);
    },
  );

  // GET /api/workflows/:workflowId/prepost-run/:runId/:stream
  // Graph-view sibling of the /items/:itemId/prepost/:prepostId/:stream
  // endpoint above.  The Graph View knows a prepost node by its synthetic
  // runId (`run:<sessionId>:<when>:<cmd>:<startedAt>`) which encodes the
  // coordinates uniquely identifying a prepost_runs row — but not the
  // numeric DB id.  This endpoint parses the synthetic id, looks up the
  // matching row, and serves the artifact using the same path-traversal
  // guard as the timeline endpoint.
  fastify.get(
    '/api/workflows/:workflowId/prepost-run/:runId/:stream',
    async (
      req: FastifyRequest<{
        Params: { workflowId: string; runId: string; stream: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { workflowId, runId, stream } = req.params;

      if (stream !== 'stdout' && stream !== 'stderr') {
        return badRequest(reply, "stream must be 'stdout' or 'stderr'");
      }
      if (!callbacks.configDir) {
        return reply.status(501).send({ error: 'prepost artifact serving not configured' });
      }

      const parsed = parsePrepostRunId(runId);
      if (!parsed) return notFound(reply, 'prepost run not found');

      const reader = db.reader();
      const row = reader
        .prepare(
          `SELECT stdout_path, stderr_path FROM prepost_runs
           WHERE workflow_id = ?
             AND (session_id IS ? OR session_id = ?)
             AND when_phase = ?
             AND command_name = ?
             AND started_at = ?`,
        )
        .get(
          workflowId,
          parsed.sessionId,
          parsed.sessionId,
          parsed.when,
          parsed.commandName,
          parsed.startedAt,
        ) as
        | { stdout_path: string | null; stderr_path: string | null }
        | undefined;

      if (!row) return notFound(reply, 'prepost run not found');

      const storedPath = stream === 'stdout' ? row.stdout_path : row.stderr_path;
      if (!storedPath) {
        return reply.status(404).send({ error: 'no output captured' });
      }

      const expectedRoot = path.resolve(
        makePrepostOutputDir({
          configDir: callbacks.configDir,
          workflowId,
          homeDir: callbacks.homeDir,
        }),
      );
      const resolvedPath = path.resolve(storedPath);
      const rootWithSep = expectedRoot.endsWith(path.sep) ? expectedRoot : expectedRoot + path.sep;
      if (!resolvedPath.startsWith(rootWithSep)) {
        return badRequest(reply, 'stored artifact path is outside the expected root');
      }

      const file = await readArtifactFile(resolvedPath);
      if (!file) return notFound(reply, 'artifact file not found');

      return reply.send(file);
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

  // POST /api/workflows/:id/github/create-pr
  // Creates a GitHub PR for a terminal workflow. Idempotent via commandId.
  // The write is delegated to callbacks.createPrExecutor (RC-3 — no writes in API layer).
  fastify.post(
    '/api/workflows/:id/github/create-pr',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const body = req.body as { commandId?: string } | null;

      if (!body?.commandId) return badRequest(reply, 'commandId is required');
      if (!callbacks.createPrExecutor) {
        return reply.status(501).send({ error: 'create-pr not configured' });
      }

      const cached = idempotency.get(body.commandId);
      if (cached !== undefined) return reply.status(200).send(cached);

      const result = await callbacks.createPrExecutor(id, body.commandId);

      if (result.status === 'workflow_not_found') return notFound(reply, 'workflow not found');
      if (result.status === 'non_terminal') {
        return reply.status(409).send({
          error: `workflow is not terminal: current status is '${result.currentStatus}'`,
          currentStatus: result.currentStatus,
        });
      }
      if (result.status === 'github_state_conflict') {
        return reply.status(409).send({
          error: `cannot create PR when github_state is '${result.currentGithubState}'`,
          currentGithubState: result.currentGithubState,
        });
      }

      const responseBody = {
        status: 'created',
        prNumber: result.prNumber,
        prUrl: result.prUrl,
        usedPath: result.usedPath,
      };
      idempotency.set(body.commandId, responseBody);
      return reply.status(200).send(responseBody);
    },
  );

  // GET /api/templates
  // Returns {templates: [{name, description}]} for the configured template directory.
  // Invalid template files are skipped by the callback (list never fails the request).
  fastify.get('/api/templates', async (_req: FastifyRequest, reply: FastifyReply) => {
    const templates = callbacks.listTemplates?.() ?? [];
    return reply.send({ templates });
  });

  // POST /api/workflows
  // Creates a new workflow from a named template with a user-supplied name.
  // Validates templateName (must exist) and name (must be non-empty after trim).
  // Returns 201 with {workflowId, name, sameTemplateNames} on success.
  // Broadcasts 'workflow.created' to all connected WS clients (sidebar update).
  fastify.post('/api/workflows', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Record<string, unknown> | null;

    const rawTemplateName = body?.templateName;
    if (typeof rawTemplateName !== 'string' || !rawTemplateName.trim()) {
      return badRequest(reply, 'templateName is required');
    }
    const templateName = rawTemplateName.trim();

    const rawName = body?.name;
    if (rawName === undefined || rawName === null) {
      return badRequest(reply, 'name is required');
    }
    const name = String(rawName).trim();
    if (!name) {
      return badRequest(reply, 'name must be non-empty');
    }

    if (!callbacks.createWorkflow) {
      return reply.status(501).send({ error: 'workflow creation not configured' });
    }

    const result = callbacks.createWorkflow({ templateName, name });

    if (result.status === 'template_not_found') {
      return reply.status(404).send({ error: `template '${templateName}' not found` });
    }
    if (result.status === 'template_error') {
      return reply.status(422).send({
        error: `template '${templateName}' has errors: ${result.message}`,
      });
    }

    // Broadcast to all connected clients so the sidebar can show the new workflow.
    registry.broadcastAll('workflow.created', {
      workflowId: result.workflowId,
      name: result.name,
    });

    return reply.status(201).send({
      workflowId: result.workflowId,
      name: result.name,
      sameTemplateNames: result.sameTemplateNames,
    });
  });

  // -------------------------------------------------------------------------
  // Static dashboard hosting + SPA fallback
  //
  // When callbacks.webRoot points at a directory containing a built dashboard
  // (Vite output: index.html + assets/), the server hosts those files at /
  // and falls back to index.html for any non-API GET that hits the
  // not-found handler. API and WS routes still respond first because they
  // are registered above.
  // -------------------------------------------------------------------------
  const webRoot = resolveWebRoot(callbacks.webRoot);
  if (webRoot) {
    await fastify.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      // decorateReply must stay true so the SPA fallback can use
      // reply.sendFile('index.html') below.
      decorateReply: true,
      // Disable wildcard so @fastify/static doesn't collide with API and
      // WebSocket routes; we wire the SPA fallback via setNotFoundHandler.
      wildcard: false,
    });

    fastify.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? '';
      const accept = req.headers.accept ?? '';
      // Never SPA-fallback for API, /stream, or non-GET requests; let the
      // client see the real 404. JSON clients (Accept: application/json)
      // also get the JSON 404 instead of the index page.
      if (
        req.method !== 'GET' ||
        url.startsWith('/api/') ||
        url.startsWith('/stream') ||
        accept.includes('application/json')
      ) {
        return reply.status(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return { fastify, state: { seqStore, backfillBuffer, idempotency, registry } };
}

/**
 * Decide whether to host static assets.
 *
 * Only honors the caller-supplied webRoot. start.ts (production) computes
 * the path from the package install location; tests and dev pass nothing,
 * so static serving is skipped and Vite handles the UI on its own port.
 */
function resolveWebRoot(explicit: string | undefined): string | null {
  if (!explicit) return null;
  try {
    if (
      existsSync(explicit) &&
      statSync(explicit).isDirectory() &&
      existsSync(path.join(explicit, 'index.html'))
    ) {
      return explicit;
    }
  } catch {
    // fall through
  }
  return null;
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
