/**
 * Regression tests for fix-camelcase-api.
 *
 * Asserts that GET /api/workflows returns camelCase field names (createdAt,
 * updatedAt) instead of the raw SQLite snake_case columns (created_at,
 * updated_at), and that the response conforms to the shared WorkflowRow type.
 *
 * Uses fastify.inject() for fast, socketless HTTP testing against real SQLite.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerHandle } from '../../src/server/api/server.js';
import type { WorkflowRow } from '../../src/shared/types/workflow.js';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: ReturnType<typeof openDbPool>;
let handle: ServerHandle;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-wf-list-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));

  const migrationsDir = new URL(
    '../../src/server/storage/migrations/',
    import.meta.url,
  ).pathname;
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

let seq = 0;
function insertWorkflow(opts?: { name?: string; status?: string; createdAt?: string }): string {
  seq++;
  const id = `wf-${seq}-${Date.now()}`;
  const now = new Date().toISOString().slice(0, 19);
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', '{"stages":[]}', '{}', ?, ?, ?)`,
    )
    .run(
      id,
      opts?.name ?? `Workflow ${seq}`,
      opts?.status ?? 'pending',
      opts?.createdAt ?? now,
      now,
    );
  return id;
}

async function getWorkflows(qs = ''): Promise<{ statusCode: number; body: unknown }> {
  const res = await handle.fastify.inject({ method: 'GET', url: `/api/workflows${qs}` });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown };
}

// ---------------------------------------------------------------------------
// camelCase field names
// ---------------------------------------------------------------------------

describe('GET /api/workflows — camelCase response shape', () => {
  it('returns createdAt and updatedAt (not created_at / updated_at)', async () => {
    insertWorkflow({ name: 'camel-test' });

    const { statusCode, body } = await getWorkflows();
    expect(statusCode).toBe(200);

    const rows = (body as { workflows: WorkflowRow[] }).workflows;
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    // camelCase fields must be present and be non-empty strings.
    expect(typeof row.createdAt).toBe('string');
    expect(row.createdAt.length).toBeGreaterThan(0);
    expect(typeof row.updatedAt).toBe('string');
    expect(row.updatedAt.length).toBeGreaterThan(0);

    // snake_case fields must NOT appear.
    expect((row as unknown as Record<string, unknown>)['created_at']).toBeUndefined();
    expect((row as unknown as Record<string, unknown>)['updated_at']).toBeUndefined();
  });

  it('createdAt and updatedAt are valid ISO date strings', async () => {
    insertWorkflow({ name: 'iso-check' });

    const { body } = await getWorkflows();
    const row = (body as { workflows: WorkflowRow[] }).workflows[0]!;

    expect(Number.isNaN(new Date(row.createdAt).getTime())).toBe(false);
    expect(Number.isNaN(new Date(row.updatedAt).getTime())).toBe(false);
  });

  it('response matches the shared WorkflowRow shape', async () => {
    insertWorkflow({ name: 'shape-check', status: 'in_progress' });

    const { body } = await getWorkflows();
    const row = (body as { workflows: WorkflowRow[] }).workflows[0]!;

    // All required WorkflowRow fields must be present.
    expect(typeof row.id).toBe('string');
    expect(typeof row.name).toBe('string');
    expect(typeof row.status).toBe('string');
    expect('currentStage' in row).toBe(true);
    expect(typeof row.activeSessions).toBe('number');
    expect(typeof row.unreadEvents).toBe('number');
    expect(typeof row.createdAt).toBe('string');
    expect(typeof row.updatedAt).toBe('string');
  });

  it('unreadEvents is 0 (populated by WS, not REST)', async () => {
    insertWorkflow();

    const { body } = await getWorkflows();
    const row = (body as { workflows: WorkflowRow[] }).workflows[0]!;
    expect(row.unreadEvents).toBe(0);
  });

  it('nextBefore cursor uses camelCase createdAt value (keyset pagination)', async () => {
    // Insert 3 workflows with distinct timestamps.
    const t0 = '2024-01-01T00:00:00';
    const t1 = '2024-01-02T00:00:00';
    const t2 = '2024-01-03T00:00:00';
    insertWorkflow({ createdAt: t2 });
    insertWorkflow({ createdAt: t1 });
    insertWorkflow({ createdAt: t0 });

    // Fetch with limit=2.
    const { body } = await getWorkflows('?limit=2');
    const typed = body as { workflows: WorkflowRow[]; hasMore: boolean; nextBefore: string | null };

    expect(typed.hasMore).toBe(true);
    expect(typed.nextBefore).not.toBeNull();
    // nextBefore must be a valid date string (no NaN).
    expect(Number.isNaN(new Date(typed.nextBefore!).getTime())).toBe(false);

    // Using nextBefore as the 'before' cursor should fetch the remaining page.
    const page2 = await getWorkflows(`?limit=2&before=${encodeURIComponent(typed.nextBefore!)}`);
    const page2Rows = (page2.body as { workflows: WorkflowRow[] }).workflows;
    expect(page2Rows.length).toBe(1);
  });
});
