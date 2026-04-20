/**
 * Tests for GET /api/items/:id/sessions
 *
 * Covers:
 *   AC-1: 200 with sessions ordered by started_at DESC, camelCase fields
 *   AC-2: 200 with empty array when item has no sessions
 *   AC-3: 404 when item does not exist
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerHandle } from '../../src/server/api/server.js';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: ReturnType<typeof openDbPool>;
let handle: ServerHandle;

const migrationsDir = new URL(
  '../../src/server/storage/migrations/',
  import.meta.url,
).pathname;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-item-sessions-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));
  await applyMigrations(db.writer, migrationsDir);
  handle = await createServer(db);
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

async function get(url: string): Promise<InjectResult> {
  const res = await handle.fastify.inject({ method: 'GET', url });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown };
}

let seq = 0;

function insertWorkflow(): string {
  seq++;
  const id = `wf-${seq}`;
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', '{"stages":[]}', '{}', 'pending', datetime('now'), datetime('now'))`,
    )
    .run(id, `Workflow ${seq}`);
  return id;
}

function insertItem(workflowId: string): string {
  seq++;
  const id = `item-${seq}`;
  db.writer
    .prepare(
      `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
       VALUES (?, ?, 'stage-1', '{}', 'pending', datetime('now'))`,
    )
    .run(id, workflowId);
  return id;
}

function insertSession(
  workflowId: string,
  itemId: string,
  opts: {
    phase?: string;
    status?: string;
    startedAt?: string;
    endedAt?: string | null;
    exitCode?: number | null;
  } = {},
): string {
  seq++;
  const id = `sess-${seq}`;
  const phase = opts.phase ?? 'implement';
  const status = opts.status ?? 'complete';
  const startedAt = opts.startedAt ?? `2026-01-0${seq}T00:00:00Z`;
  const endedAt = opts.endedAt !== undefined ? opts.endedAt : `2026-01-0${seq}T01:00:00Z`;
  const exitCode = opts.exitCode !== undefined ? opts.exitCode : 0;
  db.writer
    .prepare(
      `INSERT INTO sessions (id, workflow_id, item_id, stage, phase, agent_profile, started_at, ended_at, exit_code, status)
       VALUES (?, ?, ?, 'stage-1', ?, 'default', ?, ?, ?, ?)`,
    )
    .run(id, workflowId, itemId, phase, startedAt, endedAt, exitCode, status);
  return id;
}

// ---------------------------------------------------------------------------
// AC-1: 200 with sessions ordered started_at DESC
// ---------------------------------------------------------------------------

describe('GET /api/items/:id/sessions — 200', () => {
  it('returns sessions for a known item ordered by started_at DESC', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    const s1 = insertSession(wfId, itemId, { startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T01:00:00Z' });
    const s2 = insertSession(wfId, itemId, { startedAt: '2026-01-02T00:00:00Z', endedAt: '2026-01-02T01:00:00Z' });
    const s3 = insertSession(wfId, itemId, { startedAt: '2026-01-03T00:00:00Z', endedAt: null, exitCode: null, status: 'in_progress' });

    const { statusCode, body } = await get(`/api/items/${itemId}/sessions`);

    expect(statusCode).toBe(200);
    const sessions = (body as { sessions: unknown[] }).sessions;
    expect(sessions).toHaveLength(3);
    // Most recent first
    expect((sessions[0] as { id: string }).id).toBe(s3);
    expect((sessions[1] as { id: string }).id).toBe(s2);
    expect((sessions[2] as { id: string }).id).toBe(s1);
  });

  it('returns camelCase fields in each session', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    insertSession(wfId, itemId, {
      phase: 'review',
      status: 'complete',
      startedAt: '2026-01-01T10:00:00Z',
      endedAt: '2026-01-01T11:00:00Z',
      exitCode: 0,
    });

    const { statusCode, body } = await get(`/api/items/${itemId}/sessions`);

    expect(statusCode).toBe(200);
    const [s] = (body as { sessions: unknown[] }).sessions as Array<Record<string, unknown>>;
    expect(s).toMatchObject({
      id: expect.any(String),
      phase: 'review',
      status: 'complete',
      startedAt: '2026-01-01T10:00:00Z',
      endedAt: '2026-01-01T11:00:00Z',
      exitCode: 0,
    });
    // No snake_case keys
    expect('started_at' in s).toBe(false);
    expect('ended_at' in s).toBe(false);
    expect('exit_code' in s).toBe(false);
  });

  it('returns null endedAt and exitCode for an in-progress session', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    insertSession(wfId, itemId, { endedAt: null, exitCode: null, status: 'in_progress' });

    const { statusCode, body } = await get(`/api/items/${itemId}/sessions`);

    expect(statusCode).toBe(200);
    const [s] = (body as { sessions: unknown[] }).sessions as Array<Record<string, unknown>>;
    expect(s.endedAt).toBeNull();
    expect(s.exitCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-2: empty array when item has no sessions
// ---------------------------------------------------------------------------

describe('GET /api/items/:id/sessions — empty', () => {
  it('returns empty sessions array when item has no sessions', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);

    const { statusCode, body } = await get(`/api/items/${itemId}/sessions`);

    expect(statusCode).toBe(200);
    expect((body as { sessions: unknown[] }).sessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-3: 404 when item does not exist
// ---------------------------------------------------------------------------

describe('GET /api/items/:id/sessions — 404', () => {
  it('returns 404 when item does not exist', async () => {
    const { statusCode, body } = await get('/api/items/no-such-item/sessions');

    expect(statusCode).toBe(404);
    expect((body as { error: string }).error).toBeTruthy();
  });
});
