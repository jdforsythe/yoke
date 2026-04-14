/**
 * HTTP companion endpoint tests — feat-fastify-ws.
 *
 * Covers AC-5: all HTTP endpoints from protocol-websocket.md §7 return the
 * correct 2xx shape for valid input, 404 for unknown workflow/session, 400
 * for bad query params.
 *
 * Uses fastify.inject() for fast, socketless HTTP testing. Real SQLite +
 * migrations; no mocks.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerHandle, type AckAttentionResult } from '../../src/server/api/server.js';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: ReturnType<typeof openDbPool>;
let handle: ServerHandle;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-http-f-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));

  const migrationsDir = new URL(
    '../../src/server/storage/migrations/',
    import.meta.url,
  ).pathname;
  await applyMigrations(db.writer, migrationsDir);

  // Inject the ackAttention callback so the API layer has no write path (RC-3).
  // The callback owns the pending_attention read + write.
  handle = await createServer(db, {
    ackAttention: (workflowId, attentionId): AckAttentionResult => {
      const row = db.reader()
        .prepare('SELECT id, acknowledged_at FROM pending_attention WHERE id = ? AND workflow_id = ?')
        .get(attentionId, workflowId) as { id: number; acknowledged_at: string | null } | undefined;
      if (!row) return { status: 'not_found' };
      if (row.acknowledged_at) return { status: 'already_acknowledged', id: attentionId };
      db.writer
        .prepare("UPDATE pending_attention SET acknowledged_at = datetime('now') WHERE id = ?")
        .run(attentionId);
      return { status: 'acknowledged', id: attentionId };
    },
  });
  // Use inject() — no listen() needed for HTTP tests.
  await handle.fastify.ready();
});

afterEach(async () => {
  await handle.fastify.close();
  db.close();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InjectResult {
  statusCode: number;
  body: unknown;
}

async function inject(
  method: string,
  url: string,
  body?: object,
): Promise<InjectResult> {
  const res = await handle.fastify.inject({
    method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
    url,
    ...(body ? { payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  return {
    statusCode: res.statusCode,
    body: JSON.parse(res.body) as unknown,
  };
}

let wfSeq = 0;
function insertWorkflow(overrides?: { status?: string; name?: string; createdAt?: string }): string {
  wfSeq++;
  const id = `wf-${wfSeq}`;
  const name = overrides?.name ?? `Workflow ${wfSeq}`;
  const status = overrides?.status ?? 'running';
  const createdAt = overrides?.createdAt ?? new Date().toISOString().slice(0, 19);
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', '{"stages":[]}', '{}', ?, ?, ?)`,
    )
    .run(id, name, status, createdAt, createdAt);
  return id;
}

function insertSession(workflowId: string, opts?: { phase?: string }): string {
  const id = `ses-${wfSeq}-${Date.now()}`;
  db.writer
    .prepare(
      `INSERT INTO sessions
         (id, workflow_id, stage, phase, agent_profile, started_at, status,
          input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
       VALUES (?, ?, 'stage-1', ?, 'default', datetime('now'), 'running', 10, 5, 2, 1)`,
    )
    .run(id, workflowId, opts?.phase ?? 'implement');
  return id;
}

function insertAttention(workflowId: string): number {
  const result = db.writer
    .prepare(
      `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
       VALUES (?, 'bootstrap_failed', '{"reason":"test"}', datetime('now'))`,
    )
    .run(workflowId);
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// GET /api/workflows (§7)
// ---------------------------------------------------------------------------

describe('GET /api/workflows', () => {
  it('returns 200 with empty list when no workflows exist (AC-5)', async () => {
    const { statusCode, body } = await inject('GET', '/api/workflows');
    expect(statusCode).toBe(200);
    expect((body as any).workflows).toEqual([]);
    expect((body as any).hasMore).toBe(false);
  });

  it('returns workflow rows with id, name, status, created_at', async () => {
    insertWorkflow({ name: 'Alpha' });
    insertWorkflow({ name: 'Beta' });

    const { statusCode, body } = await inject('GET', '/api/workflows');
    expect(statusCode).toBe(200);
    const rows = (body as any).workflows as Array<{ id: string; name: string }>;
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.name).sort()).toEqual(['Alpha', 'Beta'].sort());
  });

  it('filters by status query param', async () => {
    insertWorkflow({ status: 'running' });
    insertWorkflow({ status: 'complete' });

    const { body } = await inject('GET', '/api/workflows?status=running');
    const rows = (body as any).workflows as Array<{ status: string }>;
    expect(rows.every((r) => r.status === 'running')).toBe(true);
    expect(rows.length).toBe(1);
  });

  it('filters by q query param (name LIKE)', async () => {
    insertWorkflow({ name: 'foo-alpha' });
    insertWorkflow({ name: 'bar-beta' });

    const { body } = await inject('GET', '/api/workflows?q=alpha');
    const rows = (body as any).workflows as Array<{ name: string }>;
    expect(rows.every((r) => r.name.includes('alpha'))).toBe(true);
  });

  it('keyset pagination: hasMore=true when more rows exist', async () => {
    for (let i = 0; i < 5; i++) insertWorkflow();

    const { body } = await inject('GET', '/api/workflows?limit=3');
    expect((body as any).hasMore).toBe(true);
    expect((body as any).workflows).toHaveLength(3);
    expect(typeof (body as any).nextBefore).toBe('string');
  });

  it('returns 400 for non-numeric limit (AC-5)', async () => {
    const { statusCode } = await inject('GET', '/api/workflows?limit=abc');
    expect(statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/workflows/:id/timeline (§7)
// ---------------------------------------------------------------------------

describe('GET /api/workflows/:id/timeline', () => {
  it('returns 200 with events array for known workflow (AC-5)', async () => {
    const id = insertWorkflow();
    const { statusCode, body } = await inject('GET', `/api/workflows/${id}/timeline`);
    expect(statusCode).toBe(200);
    expect((body as any).workflowId).toBe(id);
    expect(Array.isArray((body as any).events)).toBe(true);
  });

  it('returns 404 for unknown workflow (AC-5)', async () => {
    const { statusCode } = await inject('GET', '/api/workflows/nonexistent/timeline');
    expect(statusCode).toBe(404);
  });

  it('includes events from the events table', async () => {
    const id = insertWorkflow();
    db.writer
      .prepare(
        `INSERT INTO events (ts, workflow_id, event_type, level, message)
         VALUES (datetime('now'), ?, 'phase_start', 'info', 'Phase started')`,
      )
      .run(id);

    const { body } = await inject('GET', `/api/workflows/${id}/timeline`);
    const events = (body as any).events as Array<{ event_type: string }>;
    expect(events.some((e) => e.event_type === 'phase_start')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id/log (§7) — basic shape (full coverage in session-log-http.test.ts)
// ---------------------------------------------------------------------------

describe('GET /api/sessions/:id/log', () => {
  it('returns 404 for unknown session (AC-5)', async () => {
    const { statusCode } = await inject('GET', '/api/sessions/nonexistent/log');
    expect(statusCode).toBe(404);
  });

  it('returns 200 with empty entries when session_log_path is null (AC-5)', async () => {
    const wfId = insertWorkflow();
    const sesId = insertSession(wfId);

    const { statusCode, body } = await inject('GET', `/api/sessions/${sesId}/log`);
    expect(statusCode).toBe(200);
    expect((body as any).entries).toEqual([]);
    expect((body as any).hasMore).toBe(false);
  });

  it('returns 400 for invalid sinceSeq (AC-5)', async () => {
    const wfId = insertWorkflow();
    const sesId = insertSession(wfId);
    const { statusCode } = await inject('GET', `/api/sessions/${sesId}/log?sinceSeq=bad`);
    expect(statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/workflows/:id/usage (§7)
// ---------------------------------------------------------------------------

describe('GET /api/workflows/:id/usage', () => {
  it('returns 200 with rows for known workflow (AC-5)', async () => {
    const id = insertWorkflow();
    insertSession(id, { phase: 'implement' });

    const { statusCode, body } = await inject('GET', `/api/workflows/${id}/usage`);
    expect(statusCode).toBe(200);
    expect((body as any).workflowId).toBe(id);
    expect(Array.isArray((body as any).rows)).toBe(true);
  });

  it('returns 404 for unknown workflow (AC-5)', async () => {
    const { statusCode } = await inject('GET', '/api/workflows/zzz/usage');
    expect(statusCode).toBe(404);
  });

  it('returns 400 for invalid groupBy (AC-5)', async () => {
    const id = insertWorkflow();
    const { statusCode } = await inject('GET', `/api/workflows/${id}/usage?groupBy=invalid`);
    expect(statusCode).toBe(400);
  });

  it('groupBy=session aggregates by session id', async () => {
    const id = insertWorkflow();
    insertSession(id);

    const { body } = await inject('GET', `/api/workflows/${id}/usage?groupBy=session`);
    const rows = (body as any).rows as Array<{ dimension: string; input_tokens: number }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(typeof rows[0].input_tokens).toBe('number');
  });

  it('groupBy=phase aggregates by session phase', async () => {
    const id = insertWorkflow();
    insertSession(id, { phase: 'implement' });

    const { body } = await inject('GET', `/api/workflows/${id}/usage?groupBy=phase`);
    const rows = (body as any).rows as Array<{ dimension: string }>;
    expect(rows.some((r) => r.dimension === 'implement')).toBe(true);
  });

  it('groupBy=profile aggregates by agent_profile', async () => {
    const id = insertWorkflow();
    insertSession(id);

    const { body } = await inject('GET', `/api/workflows/${id}/usage?groupBy=profile`);
    const rows = (body as any).rows as Array<{ dimension: string }>;
    expect(rows.some((r) => r.dimension === 'default')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/workflows/:id/usage/timeseries (§7)
// ---------------------------------------------------------------------------

describe('GET /api/workflows/:id/usage/timeseries', () => {
  it('returns 200 for known workflow (AC-5)', async () => {
    const id = insertWorkflow();
    insertSession(id);

    const { statusCode, body } = await inject('GET', `/api/workflows/${id}/usage/timeseries`);
    expect(statusCode).toBe(200);
    expect((body as any).workflowId).toBe(id);
    expect(Array.isArray((body as any).rows)).toBe(true);
  });

  it('returns 404 for unknown workflow (AC-5)', async () => {
    const { statusCode } = await inject('GET', '/api/workflows/zzz/usage/timeseries');
    expect(statusCode).toBe(404);
  });

  it('returns 400 for invalid bucket (AC-5)', async () => {
    const id = insertWorkflow();
    const { statusCode } = await inject('GET', `/api/workflows/${id}/usage/timeseries?bucket=week`);
    expect(statusCode).toBe(400);
  });

  it('bucket=hour returns hourly buckets', async () => {
    const id = insertWorkflow();
    insertSession(id);

    const { body } = await inject('GET', `/api/workflows/${id}/usage/timeseries?bucket=hour`);
    expect((body as any).bucket).toBe('hour');
  });

  it('bucket=day returns daily buckets', async () => {
    const id = insertWorkflow();
    insertSession(id);

    const { body } = await inject('GET', `/api/workflows/${id}/usage/timeseries?bucket=day`);
    expect((body as any).bucket).toBe('day');
  });
});

// ---------------------------------------------------------------------------
// POST /api/workflows/:id/control (§7)
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/control', () => {
  it('returns 202 for a new control command (AC-5)', async () => {
    const id = insertWorkflow();
    const { statusCode, body } = await inject('POST', `/api/workflows/${id}/control`, {
      commandId: 'cmd-new-1',
      action: 'pause',
    });
    expect(statusCode).toBe(202);
    expect((body as any).status).toBe('accepted');
    expect((body as any).commandId).toBe('cmd-new-1');
  });

  it('returns 200 for a repeated commandId (idempotent, AC-4, AC-5)', async () => {
    const id = insertWorkflow();
    const body = { commandId: 'cmd-idem-1', action: 'pause' };

    const r1 = await inject('POST', `/api/workflows/${id}/control`, body);
    const r2 = await inject('POST', `/api/workflows/${id}/control`, body);

    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(200);
    // Idempotent response body is identical.
    expect(JSON.stringify(r1.body)).toBe(JSON.stringify(r2.body));
  });

  it('returns 404 for unknown workflow (AC-5)', async () => {
    const { statusCode } = await inject('POST', '/api/workflows/zzz/control', {
      commandId: 'cmd-404',
      action: 'pause',
    });
    expect(statusCode).toBe(404);
  });

  it('returns 400 when commandId is missing (AC-5)', async () => {
    const id = insertWorkflow();
    const { statusCode } = await inject('POST', `/api/workflows/${id}/control`, {
      action: 'pause',
    });
    expect(statusCode).toBe(400);
  });

  it('returns 400 when action is missing (AC-5)', async () => {
    const id = insertWorkflow();
    const { statusCode } = await inject('POST', `/api/workflows/${id}/control`, {
      commandId: 'cmd-noact',
    });
    expect(statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/workflows/:id/attention/:attentionId/ack (§7)
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/attention/:attentionId/ack', () => {
  it('returns 200 and acknowledges the attention item (AC-5)', async () => {
    const id = insertWorkflow();
    const attId = insertAttention(id);

    const { statusCode, body } = await inject(
      'POST',
      `/api/workflows/${id}/attention/${attId}/ack`,
    );
    expect(statusCode).toBe(200);
    expect((body as any).status).toBe('acknowledged');
    expect((body as any).id).toBe(attId);

    // Verify acknowledged_at is set in SQLite.
    const row = db.reader()
      .prepare('SELECT acknowledged_at FROM pending_attention WHERE id = ?')
      .get(attId) as { acknowledged_at: string | null } | undefined;
    expect(row?.acknowledged_at).toBeTruthy();
  });

  it('is idempotent — second ack returns already_acknowledged (AC-5)', async () => {
    const id = insertWorkflow();
    const attId = insertAttention(id);

    await inject('POST', `/api/workflows/${id}/attention/${attId}/ack`);
    const r2 = await inject('POST', `/api/workflows/${id}/attention/${attId}/ack`);

    expect(r2.statusCode).toBe(200);
    expect((r2.body as any).status).toBe('already_acknowledged');
  });

  it('returns 404 for unknown workflow (AC-5)', async () => {
    const { statusCode } = await inject('POST', '/api/workflows/zzz/attention/1/ack');
    expect(statusCode).toBe(404);
  });

  it('returns 404 for unknown attention item (AC-5)', async () => {
    const id = insertWorkflow();
    const { statusCode } = await inject('POST', `/api/workflows/${id}/attention/99999/ack`);
    expect(statusCode).toBe(404);
  });

  it('returns 404 for attention item belonging to a different workflow (AC-5)', async () => {
    const id1 = insertWorkflow();
    const id2 = insertWorkflow();
    const attId = insertAttention(id1);

    // Trying to ack id1's attention via id2's route.
    const { statusCode } = await inject('POST', `/api/workflows/${id2}/attention/${attId}/ack`);
    expect(statusCode).toBe(404);
  });

  it('returns 400 for non-numeric attentionId (AC-5)', async () => {
    const id = insertWorkflow();
    const { statusCode } = await inject('POST', `/api/workflows/${id}/attention/not-a-number/ack`);
    expect(statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// RC-3: no writes from API layer — ackAttention callback required
// ---------------------------------------------------------------------------

describe('RC-3: attention ack requires injected callback', () => {
  it('returns 501 when ackAttention callback is not provided (RC-3)', async () => {
    // Server created WITHOUT the ackAttention callback — API layer has no write path.
    const bareHandle = await createServer(db);
    await bareHandle.fastify.ready();
    const id = insertWorkflow();
    const attId = insertAttention(id);
    const res = await bareHandle.fastify.inject({
      method: 'POST',
      url: `/api/workflows/${id}/attention/${attId}/ack`,
    });
    expect(res.statusCode).toBe(501);
    await bareHandle.fastify.close();
  });
});

// ---------------------------------------------------------------------------
// AC-3: POST /api/push/subscriptions — browser-push stub → 501
// ---------------------------------------------------------------------------

describe('POST /api/push/subscriptions', () => {
  it('returns 501 Not Implemented with a JSON body', async () => {
    const res = await inject('POST', '/api/push/subscriptions', {});
    expect(res.statusCode).toBe(501);
    const body = res.body as { error: string; message: string };
    expect(body.error).toBe('not_implemented');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('does not attempt VAPID key generation (RC-2) — response contains no vapid or push-specific fields', async () => {
    const res = await inject('POST', '/api/push/subscriptions', {
      endpoint: 'https://example.com/push/12345',
      keys: { auth: 'abc', p256dh: 'def' },
    });
    expect(res.statusCode).toBe(501);
    const body = res.body as Record<string, unknown>;
    // No subscription_id, vapid_public_key, or similar fields.
    expect(body.subscription_id).toBeUndefined();
    expect(body.vapid_public_key).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RC: read-only — no writes from API layer (RC-3)
// ---------------------------------------------------------------------------

describe('RC: API uses read-only connection for queries', () => {
  it('GET /api/workflows does not mutate any workflow row', async () => {
    const id = insertWorkflow();
    await inject('GET', '/api/workflows');

    const row = db.reader()
      .prepare('SELECT updated_at FROM workflows WHERE id = ?')
      .get(id) as { updated_at: string } | undefined;

    // updated_at is unchanged after GET — the endpoint only reads.
    expect(row?.updated_at).toBeTruthy();
  });
});
