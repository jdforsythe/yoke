/**
 * POST /api/workflows/:id/control — execution tests.
 *
 * Covers the cancel executor wiring: items transition to abandoned, running
 * sessions are SIGTERMed via the injected killSession callback, workflow
 * status flips to abandoned, and a workflow.update frame is broadcast.
 *
 * Uses real Fastify + real SQLite (mirrors fastify-http.test.ts).  killSession
 * is recorded into an array so we can assert the exact ids passed in.  The
 * broadcast fn is wrapped so test code can assert a workflow.update was
 * emitted without standing up a WS client.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerHandle } from '../../src/server/api/server.js';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import { makeControlExecutor } from '../../src/server/pipeline/control-executor.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: ReturnType<typeof openDbPool>;
let handle: ServerHandle;
let killedSessions: string[];
let broadcastCalls: Array<{ workflowId: string; frameType: string; payload: unknown }>;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-ctrl-exec-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));
  const migrationsDir = new URL(
    '../../src/server/storage/migrations/',
    import.meta.url,
  ).pathname;
  await applyMigrations(db.writer, migrationsDir);

  killedSessions = [];
  broadcastCalls = [];

  const controlExecutor = makeControlExecutor(
    db.writer,
    (sid) => killedSessions.push(sid),
    (wfId, frameType, payload) => {
      broadcastCalls.push({ workflowId: wfId, frameType, payload });
      // Also forward to the real registry so WS clients (if any) see it.
      handle.state.registry.broadcast(wfId, null, frameType, payload);
    },
  );

  handle = await createServer(db, { controlExecutor });
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
    ...(body
      ? {
          payload: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }
      : {}),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown };
}

let wfSeq = 0;
function insertWorkflow(status = 'running'): string {
  wfSeq++;
  const id = `wf-${wfSeq}`;
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', '{"stages":[]}', '{}', ?, datetime('now'), datetime('now'))`,
    )
    .run(id, `Workflow ${wfSeq}`, status);
  return id;
}

function insertItem(
  workflowId: string,
  itemId: string,
  status = 'in_progress',
  stageId = 'stage-1',
  phase: string | null = 'implement',
): void {
  db.writer
    .prepare(
      `INSERT INTO items
         (id, workflow_id, stage_id, data, status, current_phase, retry_count, updated_at)
       VALUES (?, ?, ?, '{}', ?, ?, 0, datetime('now'))`,
    )
    .run(itemId, workflowId, stageId, status, phase);
}

function insertSession(
  workflowId: string,
  sessionId: string,
  opts: { itemId?: string; ended?: boolean } = {},
): void {
  const endedAt = opts.ended ? new Date().toISOString() : null;
  db.writer
    .prepare(
      `INSERT INTO sessions
         (id, workflow_id, item_id, stage, phase, agent_profile,
          started_at, ended_at, status)
       VALUES (?, ?, ?, 'stage-1', 'implement', 'default',
               datetime('now'), ?, 'running')`,
    )
    .run(sessionId, workflowId, opts.itemId ?? null, endedAt);
}

function getItem(id: string): { status: string } | undefined {
  return db.writer
    .prepare('SELECT status FROM items WHERE id = ?')
    .get(id) as { status: string } | undefined;
}

function getWorkflow(id: string): { status: string } | undefined {
  return db.writer
    .prepare('SELECT status FROM workflows WHERE id = ?')
    .get(id) as { status: string } | undefined;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/control cancel — executor wiring', () => {
  it('cancels all non-terminal items, kills running sessions, flips workflow to abandoned', async () => {
    const wfId = insertWorkflow('running');
    insertItem(wfId, 'item-A', 'in_progress');
    insertItem(wfId, 'item-B', 'in_progress');
    insertSession(wfId, 'ses-A', { itemId: 'item-A' });
    insertSession(wfId, 'ses-B', { itemId: 'item-B' });

    const { statusCode, body } = await inject('POST', `/api/workflows/${wfId}/control`, {
      commandId: 'cmd-cancel-1',
      action: 'cancel',
    });

    expect(statusCode).toBe(202);
    expect((body as any).status).toBe('accepted');
    expect((body as any).cancelledItems).toBe(2);

    expect(getItem('item-A')?.status).toBe('abandoned');
    expect(getItem('item-B')?.status).toBe('abandoned');

    expect(getWorkflow(wfId)?.status).toBe('abandoned');

    expect(killedSessions.sort()).toEqual(['ses-A', 'ses-B']);

    const updates = broadcastCalls.filter((c) => c.frameType === 'workflow.update');
    expect(updates.length).toBe(1);
    expect(updates[0].workflowId).toBe(wfId);
    expect((updates[0].payload as any).cancelled).toBe(true);
    expect((updates[0].payload as any).status).toBe('abandoned');
  });

  it('skips already-terminal items (complete / abandoned) from the cancel count', async () => {
    const wfId = insertWorkflow('running');
    insertItem(wfId, 'item-live', 'in_progress');
    insertItem(wfId, 'item-done', 'complete');
    insertItem(wfId, 'item-dead', 'abandoned');
    insertSession(wfId, 'ses-live', { itemId: 'item-live' });

    const { statusCode, body } = await inject('POST', `/api/workflows/${wfId}/control`, {
      commandId: 'cmd-cancel-skip',
      action: 'cancel',
    });

    expect(statusCode).toBe(202);
    expect((body as any).cancelledItems).toBe(1);
    expect(getItem('item-live')?.status).toBe('abandoned');
    expect(getItem('item-done')?.status).toBe('complete');
    expect(getItem('item-dead')?.status).toBe('abandoned');
    expect(killedSessions).toEqual(['ses-live']);
  });

  it('does not kill sessions that already ended', async () => {
    const wfId = insertWorkflow('running');
    insertItem(wfId, 'item-z', 'in_progress');
    insertSession(wfId, 'ses-ended', { itemId: 'item-z', ended: true });
    insertSession(wfId, 'ses-alive', { itemId: 'item-z' });

    await inject('POST', `/api/workflows/${wfId}/control`, {
      commandId: 'cmd-filter',
      action: 'cancel',
    });

    expect(killedSessions).toEqual(['ses-alive']);
  });
});

// ---------------------------------------------------------------------------
// Ordered frame sequence assertions (AC-2)
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/control cancel — broadcast frame ordering', () => {
  it('emits item.state × N before the terminal workflow.update × 1', async () => {
    const wfId = insertWorkflow('running');
    insertItem(wfId, 'item-seq-A', 'in_progress', 'stage-1', 'implement');
    insertItem(wfId, 'item-seq-B', 'in_progress', 'stage-1', 'review');
    insertItem(wfId, 'item-seq-C', 'in_progress', 'stage-1', 'implement');

    await inject('POST', `/api/workflows/${wfId}/control`, {
      commandId: 'cmd-seq',
      action: 'cancel',
    });

    // Assert N=3 item.state frames followed by 1 workflow.update.
    const itemFrames = broadcastCalls.filter((c) => c.frameType === 'item.state');
    const wfFrames = broadcastCalls.filter((c) => c.frameType === 'workflow.update');

    expect(itemFrames.length).toBe(3);
    expect(wfFrames.length).toBe(1);

    // All item.state frames must appear before the workflow.update frame.
    // (findLastIndex not available in this TS target — use reduce instead)
    const lastItemFrameIdx = broadcastCalls.reduce(
      (acc, c, i) => (c.frameType === 'item.state' ? i : acc),
      -1,
    );
    const wfFrameIdx = broadcastCalls.findIndex((c) => c.frameType === 'workflow.update');
    expect(lastItemFrameIdx).toBeLessThan(wfFrameIdx);

    // Each item.state payload must reflect the abandoned transition.
    for (const frame of itemFrames) {
      expect(frame.workflowId).toBe(wfId);
      const p = frame.payload as {
        itemId: string;
        stageId: string;
        state: { status: string; blockedReason: null };
      };
      expect(p.stageId).toBe('stage-1');
      expect(p.state.status).toBe('abandoned');
      expect(p.state.blockedReason).toBeNull();
    }

    // Confirm all three items are represented.
    const itemIds = itemFrames.map((f) => (f.payload as { itemId: string }).itemId).sort();
    expect(itemIds).toEqual(['item-seq-A', 'item-seq-B', 'item-seq-C']);
  });

  it('emits only workflow.update when all items are already terminal (zero non-terminal)', async () => {
    const wfId = insertWorkflow('running');
    // All items terminal — cancel loop selects nothing.
    insertItem(wfId, 'item-term-A', 'complete');
    insertItem(wfId, 'item-term-B', 'abandoned');

    const { statusCode, body } = await inject('POST', `/api/workflows/${wfId}/control`, {
      commandId: 'cmd-all-terminal',
      action: 'cancel',
    });

    expect(statusCode).toBe(202);
    expect((body as any).cancelledItems).toBe(0);

    const itemFrames = broadcastCalls.filter((c) => c.frameType === 'item.state');
    const wfFrames = broadcastCalls.filter((c) => c.frameType === 'workflow.update');

    expect(itemFrames.length).toBe(0);
    expect(wfFrames.length).toBe(1);
    expect((wfFrames[0].payload as any).status).toBe('abandoned');
  });

  it('does not emit item.state for terminal items that were pre-filtered by SQL', async () => {
    const wfId = insertWorkflow('running');
    insertItem(wfId, 'item-live-only', 'in_progress');
    insertItem(wfId, 'item-done', 'complete');
    insertItem(wfId, 'item-dead', 'abandoned');

    await inject('POST', `/api/workflows/${wfId}/control`, {
      commandId: 'cmd-skip-terminal',
      action: 'cancel',
    });

    const itemFrames = broadcastCalls.filter((c) => c.frameType === 'item.state');
    expect(itemFrames.length).toBe(1);
    expect((itemFrames[0].payload as { itemId: string }).itemId).toBe('item-live-only');
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/control cancel — error handling', () => {
  it('returns 404 for an unknown workflow', async () => {
    const { statusCode } = await inject('POST', '/api/workflows/does-not-exist/control', {
      commandId: 'cmd-404',
      action: 'cancel',
    });
    expect(statusCode).toBe(404);
    expect(killedSessions).toEqual([]);
    expect(broadcastCalls).toEqual([]);
  });

  it('returns 409 for an already-terminal workflow', async () => {
    const wfId = insertWorkflow('abandoned');
    insertItem(wfId, 'item-x', 'abandoned');

    const { statusCode, body } = await inject('POST', `/api/workflows/${wfId}/control`, {
      commandId: 'cmd-409',
      action: 'cancel',
    });
    expect(statusCode).toBe(409);
    expect((body as any).error).toMatch(/terminal/i);
    expect(killedSessions).toEqual([]);
  });

  it('returns 409 for a completed workflow', async () => {
    const wfId = insertWorkflow('completed');

    const { statusCode } = await inject('POST', `/api/workflows/${wfId}/control`, {
      commandId: 'cmd-409b',
      action: 'cancel',
    });
    expect(statusCode).toBe(409);
  });

  it('returns 400 for an unsupported action (pause/resume not yet implemented)', async () => {
    const wfId = insertWorkflow('running');

    const { statusCode, body } = await inject('POST', `/api/workflows/${wfId}/control`, {
      commandId: 'cmd-400',
      action: 'pause',
    });
    expect(statusCode).toBe(400);
    expect((body as any).action).toBe('pause');
    expect(killedSessions).toEqual([]);
  });
});
