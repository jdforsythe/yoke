/**
 * Tests for feat-workflow-archive.
 *
 * Covers:
 *  - POST /archive sets archived_at (200)
 *  - POST /unarchive clears archived_at (200)
 *  - GET /api/workflows excludes archived rows by default
 *  - GET /api/workflows?archived=true includes only archived rows
 *  - POST /archive on an in_progress workflow returns 409 with currentStatus
 *  - POST /archive on unknown workflow returns 404
 *
 * Uses fastify.inject() against real SQLite with migrations applied.
 * The archiveWorkflow callback is wired via makeArchiveWorkflowFn so the full
 * pipeline path is exercised, not a stub.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerHandle } from '../../src/server/api/server.js';
import { openDbPool, type DbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import { makeArchiveWorkflowFn } from '../../src/server/pipeline/archive-workflow.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: DbPool;
let handle: ServerHandle;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-wf-archive-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));

  const migrationsDir = new URL(
    '../../src/server/storage/migrations/',
    import.meta.url,
  ).pathname;
  await applyMigrations(db.writer, migrationsDir);

  const archiveWorkflow = makeArchiveWorkflowFn(db.writer, () => {
    // no-op broadcast in tests
  });

  handle = await createServer(db, { archiveWorkflow });
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

function insertWorkflow(opts?: { status?: string }): string {
  seq++;
  const id = `wf-arch-${seq}-${Date.now()}`;
  const now = new Date().toISOString().slice(0, 19);
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', '{"stages":[]}', '{}', ?, ?, ?)`,
    )
    .run(id, `Workflow ${seq}`, opts?.status ?? 'completed', now, now);
  return id;
}

async function postArchive(id: string): Promise<{ statusCode: number; body: unknown }> {
  const res = await handle.fastify.inject({ method: 'POST', url: `/api/workflows/${id}/archive` });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown };
}

async function postUnarchive(id: string): Promise<{ statusCode: number; body: unknown }> {
  const res = await handle.fastify.inject({ method: 'POST', url: `/api/workflows/${id}/unarchive` });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown };
}

async function getWorkflows(qs = ''): Promise<{ statusCode: number; body: unknown }> {
  const res = await handle.fastify.inject({ method: 'GET', url: `/api/workflows${qs}` });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown };
}

// ---------------------------------------------------------------------------
// archive endpoint
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/archive', () => {
  it('returns 200 and sets archived_at on a completed workflow', async () => {
    const id = insertWorkflow({ status: 'completed' });

    const { statusCode, body } = await postArchive(id);
    expect(statusCode).toBe(200);
    expect((body as Record<string, unknown>).status).toBe('archived');
    expect((body as Record<string, unknown>).workflowId).toBe(id);

    // Verify archived_at is now set in the DB.
    const row = db.reader()
      .prepare('SELECT archived_at FROM workflows WHERE id = ?')
      .get(id) as { archived_at: string | null };
    expect(row.archived_at).not.toBeNull();
  });

  it('returns 409 when the workflow is in_progress', async () => {
    const id = insertWorkflow({ status: 'in_progress' });

    const { statusCode, body } = await postArchive(id);
    expect(statusCode).toBe(409);
    expect((body as Record<string, unknown>).currentStatus).toBe('in_progress');
    expect(typeof (body as Record<string, unknown>).error).toBe('string');
  });

  it('returns 404 when the workflow does not exist', async () => {
    const { statusCode } = await postArchive('nonexistent-id');
    expect(statusCode).toBe(404);
  });

  it('can archive workflows in terminal states (pending, completed, abandoned)', async () => {
    for (const status of ['pending', 'completed', 'abandoned'] as const) {
      const id = insertWorkflow({ status });
      const { statusCode } = await postArchive(id);
      expect(statusCode).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// unarchive endpoint
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/unarchive', () => {
  it('returns 200 and clears archived_at', async () => {
    const id = insertWorkflow({ status: 'completed' });
    // First archive it.
    await postArchive(id);

    const { statusCode, body } = await postUnarchive(id);
    expect(statusCode).toBe(200);
    expect((body as Record<string, unknown>).status).toBe('unarchived');

    // Verify archived_at is now NULL.
    const row = db.reader()
      .prepare('SELECT archived_at FROM workflows WHERE id = ?')
      .get(id) as { archived_at: string | null };
    expect(row.archived_at).toBeNull();
  });

  it('returns 404 when the workflow does not exist', async () => {
    const { statusCode } = await postUnarchive('nonexistent-id');
    expect(statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/workflows — default excludes archived
// ---------------------------------------------------------------------------

describe('GET /api/workflows — archive filtering', () => {
  it('excludes archived workflows by default', async () => {
    const activeId = insertWorkflow({ status: 'completed' });
    const archivedId = insertWorkflow({ status: 'completed' });
    await postArchive(archivedId);

    const { statusCode, body } = await getWorkflows();
    expect(statusCode).toBe(200);

    const ids = (body as { workflows: Array<{ id: string }> }).workflows.map((w) => w.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(archivedId);
  });

  it('includes only archived workflows when ?archived=true', async () => {
    const activeId = insertWorkflow({ status: 'completed' });
    const archivedId = insertWorkflow({ status: 'completed' });
    await postArchive(archivedId);

    const { statusCode, body } = await getWorkflows('?archived=true');
    expect(statusCode).toBe(200);

    const ids = (body as { workflows: Array<{ id: string }> }).workflows.map((w) => w.id);
    expect(ids).toContain(archivedId);
    expect(ids).not.toContain(activeId);
  });

  it('returns empty list by default when all workflows are archived', async () => {
    const id = insertWorkflow({ status: 'completed' });
    await postArchive(id);

    const { body } = await getWorkflows();
    expect((body as { workflows: unknown[] }).workflows).toHaveLength(0);
  });

  it('unarchived workflow reappears in default list after unarchive', async () => {
    const id = insertWorkflow({ status: 'completed' });
    await postArchive(id);
    await postUnarchive(id);

    const { body } = await getWorkflows();
    const ids = (body as { workflows: Array<{ id: string }> }).workflows.map((w) => w.id);
    expect(ids).toContain(id);
  });
});
