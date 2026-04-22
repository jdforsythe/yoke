/**
 * Tests for GET /api/workflows/:workflowId/items/:itemId/timeline
 *
 * Covers:
 *   AC-1: 200 with sessions + prepost_runs merged and sorted by started_at ASC.
 *   AC-2: rows are filtered by item_id (no bleed from other items).
 *   AC-3: action_taken JSON is parsed through to the response row.
 *   AC-4: 404 when the item does not exist under the given workflow.
 *   AC-5: 200 with { rows: [] } when the item exists but has no sessions/prepost runs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerHandle } from '../../src/server/api/server.js';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import type { ItemTimelineRow } from '../../src/shared/types/timeline.js';

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
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-item-timeline-'));
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
    id?: string;
    phase?: string;
    status?: string;
    startedAt: string;
    endedAt?: string | null;
    exitCode?: number | null;
    parentSessionId?: string | null;
  },
): string {
  seq++;
  const id = opts.id ?? `sess-${seq}`;
  const phase = opts.phase ?? 'implement';
  const status = opts.status ?? 'ok';
  const endedAt = opts.endedAt !== undefined ? opts.endedAt : null;
  const exitCode = opts.exitCode !== undefined ? opts.exitCode : null;
  const parent = opts.parentSessionId ?? null;
  db.writer
    .prepare(
      `INSERT INTO sessions
         (id, workflow_id, item_id, parent_session_id, stage, phase, agent_profile,
          started_at, ended_at, exit_code, status)
       VALUES (?, ?, ?, ?, 'stage-1', ?, 'default', ?, ?, ?, ?)`,
    )
    .run(id, workflowId, itemId, parent, phase, opts.startedAt, endedAt, exitCode, status);
  return id;
}

function insertPrepost(
  workflowId: string,
  itemId: string,
  opts: {
    whenPhase?: 'pre' | 'post';
    commandName?: string;
    phase?: string;
    startedAt: string;
    endedAt?: string | null;
    exitCode?: number | null;
    actionTaken?: string | null;
    stdoutPath?: string | null;
    stderrPath?: string | null;
  },
): number {
  const whenPhase = opts.whenPhase ?? 'post';
  const commandName = opts.commandName ?? 'lint';
  const phase = opts.phase ?? 'implement';
  const endedAt = opts.endedAt !== undefined ? opts.endedAt : null;
  const exitCode = opts.exitCode !== undefined ? opts.exitCode : null;
  const actionTaken = opts.actionTaken ?? null;
  const stdoutPath = opts.stdoutPath ?? null;
  const stderrPath = opts.stderrPath ?? null;
  const info = db.writer
    .prepare(
      `INSERT INTO prepost_runs
         (workflow_id, item_id, stage, phase, when_phase, command_name, argv,
          started_at, ended_at, exit_code, action_taken, stdout_path, stderr_path)
       VALUES (?, ?, 'stage-1', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      workflowId,
      itemId,
      phase,
      whenPhase,
      commandName,
      opts.startedAt,
      endedAt,
      exitCode,
      actionTaken,
      stdoutPath,
      stderrPath,
    );
  return Number(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// AC-1: ordering (sessions + prepost interleaved by started_at ASC)
// ---------------------------------------------------------------------------

describe('GET /api/workflows/:workflowId/items/:itemId/timeline — ordering', () => {
  it('merges sessions and prepost_runs sorted by started_at ASC', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);

    // Interleave: session at t=1, prepost at t=2, session at t=3.
    const s1 = insertSession(wfId, itemId, {
      id: 'sess-A',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:30:00Z',
      exitCode: 0,
      status: 'ok',
    });
    const postId = insertPrepost(wfId, itemId, {
      whenPhase: 'post',
      commandName: 'lint',
      startedAt: '2026-01-02T00:00:00Z',
      endedAt: '2026-01-02T00:01:00Z',
      exitCode: 0,
    });
    const s2 = insertSession(wfId, itemId, {
      id: 'sess-B',
      startedAt: '2026-01-03T00:00:00Z',
      endedAt: '2026-01-03T00:30:00Z',
      exitCode: 0,
      status: 'ok',
      parentSessionId: s1,
    });

    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/items/${itemId}/timeline`,
    );

    expect(statusCode).toBe(200);
    const rows = (body as { rows: ItemTimelineRow[] }).rows;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: 'session', id: s1 });
    expect(rows[1]).toMatchObject({ kind: 'prepost', id: String(postId) });
    expect(rows[2]).toMatchObject({ kind: 'session', id: s2, parentSessionId: s1 });
  });

  it('computes attempt as the 1-based index within a (item, phase) cohort', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);

    insertSession(wfId, itemId, {
      id: 'sess-imp1',
      phase: 'implement',
      startedAt: '2026-01-01T00:00:00Z',
    });
    insertSession(wfId, itemId, {
      id: 'sess-imp2',
      phase: 'implement',
      startedAt: '2026-01-02T00:00:00Z',
    });
    insertSession(wfId, itemId, {
      id: 'sess-rev1',
      phase: 'review',
      startedAt: '2026-01-03T00:00:00Z',
    });

    const { body } = await get(`/api/workflows/${wfId}/items/${itemId}/timeline`);
    const rows = (body as { rows: ItemTimelineRow[] }).rows.filter(
      (r): r is Extract<ItemTimelineRow, { kind: 'session' }> => r.kind === 'session',
    );
    expect(rows).toHaveLength(3);
    const byId = new Map(rows.map((r) => [r.id, r.attempt]));
    expect(byId.get('sess-imp1')).toBe(1);
    expect(byId.get('sess-imp2')).toBe(2);
    expect(byId.get('sess-rev1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-2: filtering by item_id
// ---------------------------------------------------------------------------

describe('GET /api/workflows/:workflowId/items/:itemId/timeline — filtering', () => {
  it('returns only rows for the requested item', async () => {
    const wfId = insertWorkflow();
    const itemA = insertItem(wfId);
    const itemB = insertItem(wfId);

    insertSession(wfId, itemA, { id: 'sess-A1', startedAt: '2026-01-01T00:00:00Z' });
    insertSession(wfId, itemB, { id: 'sess-B1', startedAt: '2026-01-01T01:00:00Z' });
    insertPrepost(wfId, itemB, { startedAt: '2026-01-01T02:00:00Z' });

    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/items/${itemA}/timeline`,
    );
    expect(statusCode).toBe(200);
    const rows = (body as { rows: ItemTimelineRow[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'session', id: 'sess-A1' });
  });
});

// ---------------------------------------------------------------------------
// AC-3: action_taken passthrough
// ---------------------------------------------------------------------------

describe('GET /api/workflows/:workflowId/items/:itemId/timeline — actionTaken', () => {
  it('parses action_taken JSON into a typed object on the row', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);

    insertPrepost(wfId, itemId, {
      whenPhase: 'post',
      commandName: 'test',
      phase: 'implement',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:00:05Z',
      exitCode: 1,
      actionTaken: '{"goto":"implement"}',
    });

    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/items/${itemId}/timeline`,
    );
    expect(statusCode).toBe(200);
    const rows = (body as { rows: ItemTimelineRow[] }).rows;
    expect(rows).toHaveLength(1);
    const row = rows[0] as Extract<ItemTimelineRow, { kind: 'prepost' }>;
    expect(row.kind).toBe('prepost');
    expect(row.status).toBe('fail');
    expect(row.actionTaken).toEqual({ goto: 'implement' });
  });
});

// ---------------------------------------------------------------------------
// AC-4: 404 for unknown item
// ---------------------------------------------------------------------------

describe('GET /api/workflows/:workflowId/items/:itemId/timeline — 404', () => {
  it('returns 404 when the item does not exist', async () => {
    const wfId = insertWorkflow();
    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/items/no-such-item/timeline`,
    );
    expect(statusCode).toBe(404);
    expect((body as { error: string }).error).toBeTruthy();
  });

  it('returns 404 when the workflow does not exist', async () => {
    const { statusCode } = await get('/api/workflows/no-such-wf/items/x/timeline');
    expect(statusCode).toBe(404);
  });

  it('returns 404 when the item exists but belongs to a different workflow', async () => {
    const wfA = insertWorkflow();
    const wfB = insertWorkflow();
    const itemB = insertItem(wfB);

    const { statusCode } = await get(`/api/workflows/${wfA}/items/${itemB}/timeline`);
    expect(statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// AC-5: empty rows array when item has no sessions/prepost runs
// ---------------------------------------------------------------------------

describe('GET /api/workflows/:workflowId/items/:itemId/timeline — empty', () => {
  it('returns 200 with empty rows array when the item has no history', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);

    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/items/${itemId}/timeline`,
    );
    expect(statusCode).toBe(200);
    expect((body as { rows: ItemTimelineRow[] }).rows).toEqual([]);
  });
});
