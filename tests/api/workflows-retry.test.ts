/**
 * POST /api/workflows/:id/retry — workflow-scoped retry tests (r3-02).
 *
 * The endpoint fires user_retry on ALL awaiting_user items in the workflow
 * (workflow-scoped, not per-item).  These tests verify that scope decision
 * end-to-end via real Fastify + real SQLite + the makeRetryItemsFn factory.
 *
 * Covers:
 *  - 200 { status: 'retried', items: [...] }  when awaiting_user items exist
 *  - 200 { status: 'none_awaiting', items: [] } when no items are awaiting
 *  - 404 when workflow does not exist
 *  - Only awaiting_user items are retried; other-status items are not touched
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerHandle } from '../../src/server/api/server.js';
import { openDbPool, type DbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import { makeRetryItemsFn } from '../../src/server/pipeline/retry-items.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: DbPool;
let handle: ServerHandle;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-wf-retry-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));

  const migrationsDir = new URL(
    '../../src/server/storage/migrations/',
    import.meta.url,
  ).pathname;
  await applyMigrations(db.writer, migrationsDir);

  const retryItems = makeRetryItemsFn(db, () => {
    // no-op broadcast in tests
  });

  handle = await createServer(db, { retryItems });
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

function insertWorkflow(status = 'in_progress'): string {
  seq++;
  const id = `wf-retry-${seq}-${Date.now()}`;
  const now = new Date().toISOString().slice(0, 19);
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', '{"stages":[]}', '{}', ?, ?, ?)`,
    )
    .run(id, `Retry Workflow ${seq}`, status, now, now);
  return id;
}

function insertItem(workflowId: string, status: string): string {
  const id = `item-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.writer
    .prepare(
      `INSERT INTO items (id, workflow_id, stage_id, data, status, current_phase, retry_count, updated_at)
       VALUES (?, ?, 'stage-1', '{}', ?, 'implement', 0, datetime('now'))`,
    )
    .run(id, workflowId, status);
  return id;
}

async function postRetry(id: string): Promise<{ statusCode: number; body: unknown }> {
  const res = await handle.fastify.inject({ method: 'POST', url: `/api/workflows/${id}/retry` });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/retry — workflow-scoped retry', () => {
  it('returns 404 for unknown workflow', async () => {
    const { statusCode, body } = await postRetry('nonexistent-workflow-id');
    expect(statusCode).toBe(404);
    expect((body as { error: string }).error).toMatch(/not found/i);
  });

  it('returns 200 none_awaiting when no items are in awaiting_user', async () => {
    const wfId = insertWorkflow('in_progress');
    insertItem(wfId, 'in_progress');

    const { statusCode, body } = await postRetry(wfId);
    expect(statusCode).toBe(200);
    expect((body as { status: string }).status).toBe('none_awaiting');
    expect((body as { items: unknown[] }).items).toHaveLength(0);
  });

  it('returns 200 retried and transitions ALL awaiting_user items', async () => {
    const wfId = insertWorkflow('in_progress');
    const item1 = insertItem(wfId, 'awaiting_user');
    const item2 = insertItem(wfId, 'awaiting_user');

    const { statusCode, body } = await postRetry(wfId);
    const result = body as { status: string; items: Array<{ itemId: string }> };

    expect(statusCode).toBe(200);
    expect(result.status).toBe('retried');
    expect(result.items).toHaveLength(2);
    const retriedIds = result.items.map((i) => i.itemId);
    expect(retriedIds).toContain(item1);
    expect(retriedIds).toContain(item2);

    // Both items should now be in_progress in the DB.
    const rows = db
      .reader()
      .prepare(`SELECT status FROM items WHERE workflow_id = ?`)
      .all(wfId) as Array<{ status: string }>;
    expect(rows.every((r) => r.status === 'in_progress')).toBe(true);
  });

  it('only retries awaiting_user items — other statuses are untouched', async () => {
    const wfId = insertWorkflow('in_progress');
    const awaiting = insertItem(wfId, 'awaiting_user');
    const inProgress = insertItem(wfId, 'in_progress');

    const { statusCode, body } = await postRetry(wfId);
    const result = body as { status: string; items: Array<{ itemId: string }> };

    expect(statusCode).toBe(200);
    expect(result.status).toBe('retried');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].itemId).toBe(awaiting);

    // The in_progress item should still be in_progress.
    const row = db
      .reader()
      .prepare(`SELECT status FROM items WHERE id = ?`)
      .get(inProgress) as { status: string };
    expect(row.status).toBe('in_progress');
  });
});
