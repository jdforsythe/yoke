/**
 * Tests for GET /api/workflows/:id/items/:itemId/data
 *
 * Covers:
 *   AC-1: 200 with parsed items.data JSON when both ids exist and item belongs to workflow
 *   AC-2: 404 when workflow does not exist, item does not exist, or item belongs to different workflow
 *   AC-3: 500 with clear error body when items.data exists but cannot be parsed
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
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-items-data-'));
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

function insertItem(workflowId: string, data: string): string {
  seq++;
  const id = `item-${seq}`;
  db.writer
    .prepare(
      `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
       VALUES (?, ?, 'stage-1', ?, 'pending', datetime('now'))`,
    )
    .run(id, workflowId, data);
  return id;
}

// ---------------------------------------------------------------------------
// AC-1: 200 with valid data
// ---------------------------------------------------------------------------

describe('GET /api/workflows/:id/items/:itemId/data — 200', () => {
  it('returns parsed JSON object', async () => {
    const wfId = insertWorkflow();
    const payload = { description: 'Build the thing', priority: 1 };
    const itemId = insertItem(wfId, JSON.stringify(payload));

    const { statusCode, body } = await get(`/api/workflows/${wfId}/items/${itemId}/data`);

    expect(statusCode).toBe(200);
    expect(body).toEqual(payload);
  });

  it('returns parsed JSON array', async () => {
    const wfId = insertWorkflow();
    const payload = [1, 2, 3];
    const itemId = insertItem(wfId, JSON.stringify(payload));

    const { statusCode, body } = await get(`/api/workflows/${wfId}/items/${itemId}/data`);

    expect(statusCode).toBe(200);
    expect(body).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// AC-2: 404 paths
// ---------------------------------------------------------------------------

describe('GET /api/workflows/:id/items/:itemId/data — 404', () => {
  it('returns 404 when workflow does not exist', async () => {
    const { statusCode, body } = await get('/api/workflows/no-such-wf/items/any-item/data');

    expect(statusCode).toBe(404);
    expect((body as { error: string }).error).toBeTruthy();
  });

  it('returns 404 when item does not exist under known workflow', async () => {
    const wfId = insertWorkflow();

    const { statusCode, body } = await get(`/api/workflows/${wfId}/items/no-such-item/data`);

    expect(statusCode).toBe(404);
    expect((body as { error: string }).error).toBeTruthy();
  });

  it('returns 404 when item belongs to a different workflow (no existence leak)', async () => {
    const wfA = insertWorkflow();
    const wfB = insertWorkflow();
    const itemInA = insertItem(wfA, '{"x":1}');

    // Request item from wfB — should 404, not 403
    const { statusCode, body } = await get(`/api/workflows/${wfB}/items/${itemInA}/data`);

    expect(statusCode).toBe(404);
    expect((body as { error: string }).error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AC-3: 500 when items.data is not valid JSON
// ---------------------------------------------------------------------------

describe('GET /api/workflows/:id/items/:itemId/data — 500', () => {
  it('returns 500 with clear error when data column is not valid JSON', async () => {
    const wfId = insertWorkflow();
    // Bypass the insertItem helper and write corrupt data directly.
    seq++;
    const itemId = `item-corrupt-${seq}`;
    db.writer
      .prepare(
        `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
         VALUES (?, ?, 'stage-1', 'NOT_JSON{{{{', 'pending', datetime('now'))`,
      )
      .run(itemId, wfId);

    const { statusCode, body } = await get(`/api/workflows/${wfId}/items/${itemId}/data`);

    expect(statusCode).toBe(500);
    expect((body as { error: string }).error).toMatch(/not valid JSON/i);
  });
});
