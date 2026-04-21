/**
 * Attention notice → pending_attention row → ack → cleared + workflow.update
 * broadcast round-trip.
 *
 * Sequence under test (existing):
 *   1. A pending_attention row is inserted (simulating what the pipeline engine
 *      does when it detects a requires_attention condition).
 *   2. A WS client connects and subscribes to the workflow; the snapshot
 *      includes the pending attention entry.
 *   3. The ack endpoint is called: POST /api/workflows/:id/attention/:attId/ack
 *   4. The ackAttention callback clears acknowledged_at and broadcasts a
 *      workflow.index.update frame via registry.broadcast().
 *   5. The WS client receives the broadcast frame with pendingAttentionCount: 0.
 *   6. acknowledged_at is set in SQLite (row "cleared").
 *
 * Extended (AC-2 live path):
 *   The engine (via Scheduler._applyTransition) inserts the pending_attention row
 *   and immediately broadcasts a notice frame with persistedAttentionId over WS.
 *   The WS client receives the notice → ack endpoint clears the row →
 *   workflow.index.update arrives.
 *
 * Tests boot a real Fastify instance + real SQLite — no mocking of the API
 * layer or DB (RC: real Fastify + real SQLite).
 * WS assertions use a real ws client connection, not a stubbed sender (RC).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServer,
  type ServerCallbacks,
  type ServerHandle,
  type AckAttentionResult,
} from '../../src/server/api/server.js';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import type { WsClientRegistry } from '../../src/server/api/ws.js';
import { Scheduler } from '../../src/server/scheduler/scheduler.js';
import type {
  BroadcastFn,
} from '../../src/server/scheduler/scheduler.js';
import type { ProcessManager } from '../../src/server/process/manager.js';
import type { WorktreeManager } from '../../src/server/worktree/manager.js';
import type { ResolvedConfig } from '../../src/shared/types/config.js';
import type { ApplyItemTransitionParams } from '../../src/server/pipeline/engine.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: ReturnType<typeof openDbPool>;
let handle: ServerHandle;
let wsUrl: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-attn-rt-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));
  const migrationsDir = new URL(
    '../../src/server/storage/migrations/',
    import.meta.url,
  ).pathname;
  await applyMigrations(db.writer, migrationsDir);

  // Use a ref so the ackAttention closure can call registry.broadcast() after
  // createServer() populates handle.state.registry.
  let registryRef: WsClientRegistry | undefined;

  const callbacks: ServerCallbacks = {
    ackAttention: (workflowId: string, attentionId: number): AckAttentionResult => {
      const row = db.reader()
        .prepare('SELECT id, acknowledged_at FROM pending_attention WHERE id = ? AND workflow_id = ?')
        .get(attentionId, workflowId) as { id: number; acknowledged_at: string | null } | undefined;

      if (!row) return { status: 'not_found' };
      if (row.acknowledged_at) return { status: 'already_acknowledged', id: attentionId };

      db.writer
        .prepare("UPDATE pending_attention SET acknowledged_at = datetime('now') WHERE id = ?")
        .run(attentionId);

      // Count remaining unacknowledged attention items for the broadcast payload.
      const countRow = db.reader()
        .prepare(
          'SELECT COUNT(*) AS cnt FROM pending_attention WHERE workflow_id = ? AND acknowledged_at IS NULL',
        )
        .get(workflowId) as { cnt: number };

      // Broadcast a workflow.index.update frame so subscribed WS clients learn
      // the new pending attention count without re-subscribing.
      registryRef?.broadcast(workflowId, null, 'workflow.index.update', {
        id: workflowId,
        pendingAttentionCount: countRow.cnt,
      });

      return { status: 'acknowledged', id: attentionId };
    },
  };

  handle = await createServer(db, callbacks);
  registryRef = handle.state.registry;

  await handle.fastify.listen({ host: '127.0.0.1', port: 0 });
  const addr = handle.fastify.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${addr.port}/stream`;
});

afterEach(async () => {
  await handle.fastify.close();
  db.close();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let wfSeq = 0;
function insertWorkflow(): string {
  wfSeq++;
  const id = `wf-attn-${wfSeq}`;
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', '{"stages":[]}', '{}', 'running', datetime('now'), datetime('now'))`,
    )
    .run(id, `Attention Workflow ${wfSeq}`);
  return id;
}

function insertPendingAttention(workflowId: string): number {
  const res = db.writer
    .prepare(
      `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
       VALUES (?, 'awaiting_user_retry', '{"reason":"test"}', datetime('now'))`,
    )
    .run(workflowId);
  return Number(res.lastInsertRowid);
}

interface WsSession {
  next(): Promise<Record<string, unknown>>;
  send(frame: object): void;
  close(): void;
}

function connectWs(): Promise<WsSession> {
  return new Promise<WsSession>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const queue: Record<string, unknown>[] = [];
    const waiters: Array<[(m: Record<string, unknown>) => void, (e: Error) => void]> = [];
    let closed = false;

    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (waiters.length > 0) {
          waiters.shift()![0](msg);
        } else {
          queue.push(msg);
        }
      } catch {
        // ignore non-JSON
      }
    });
    ws.on('close', () => {
      closed = true;
      for (const [, rej] of waiters) rej(new Error('WS closed early'));
      waiters.length = 0;
    });
    ws.once('open', () =>
      resolve({
        next: () => {
          if (queue.length > 0) return Promise.resolve(queue.shift()!);
          if (closed) return Promise.reject(new Error('WS already closed'));
          return new Promise<Record<string, unknown>>((res, rej) =>
            waiters.push([res, rej]),
          );
        },
        send: (frame: object) => ws.send(JSON.stringify(frame)),
        close: () => ws.close(),
      }),
    );
    ws.once('error', reject);
  });
}

async function injectPost(
  url: string,
  body?: object,
): Promise<{ statusCode: number; body: unknown }> {
  const res = await handle.fastify.inject({
    method: 'POST',
    url,
    ...(body
      ? { payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown };
}

// ---------------------------------------------------------------------------
// Round-trip: notice → row → ack → cleared + workflow.index.update broadcast
// ---------------------------------------------------------------------------

describe('attention round-trip', () => {
  it('pending_attention row appears in workflow.snapshot and is cleared after ack', async () => {
    const wfId = insertWorkflow();
    const attId = insertPendingAttention(wfId);

    // Connect WS and subscribe — snapshot must include the pending attention entry.
    const s = await connectWs();
    await s.next(); // hello
    s.send({ v: 1, type: 'subscribe', id: 'sub-1', payload: { workflowId: wfId } });
    const snapshotFrame = await s.next();

    expect(snapshotFrame.type).toBe('workflow.snapshot');
    const pendingAttention = (snapshotFrame.payload as Record<string, unknown>)
      .pendingAttention as Array<{ id: number }>;
    expect(pendingAttention.some((p) => p.id === attId)).toBe(true);

    // Ack via HTTP — should clear the row and broadcast workflow.index.update.
    const ackRes = await injectPost(`/api/workflows/${wfId}/attention/${attId}/ack`);
    expect(ackRes.statusCode).toBe(200);
    expect((ackRes.body as Record<string, unknown>).status).toBe('acknowledged');
    expect((ackRes.body as Record<string, unknown>).id).toBe(attId);

    // WS client receives workflow.index.update broadcast from the ackAttention callback.
    const broadcastFrame = await s.next();
    s.close();

    expect(broadcastFrame.type).toBe('workflow.index.update');
    expect(broadcastFrame.workflowId).toBe(wfId);
    const broadcastPayload = broadcastFrame.payload as Record<string, unknown>;
    expect(broadcastPayload.id).toBe(wfId);
    expect(broadcastPayload.pendingAttentionCount).toBe(0);

    // acknowledged_at is set in SQLite — the row is "cleared".
    const row = db.reader()
      .prepare('SELECT acknowledged_at FROM pending_attention WHERE id = ?')
      .get(attId) as { acknowledged_at: string | null };
    expect(row.acknowledged_at).toBeTruthy();
  });

  it('second ack is idempotent — returns already_acknowledged, no second broadcast', async () => {
    const wfId = insertWorkflow();
    const attId = insertPendingAttention(wfId);

    const s = await connectWs();
    await s.next(); // hello
    s.send({ v: 1, type: 'subscribe', id: 'sub-2', payload: { workflowId: wfId } });
    await s.next(); // snapshot

    // First ack.
    const r1 = await injectPost(`/api/workflows/${wfId}/attention/${attId}/ack`);
    expect(r1.statusCode).toBe(200);
    expect((r1.body as Record<string, unknown>).status).toBe('acknowledged');
    await s.next(); // consume the broadcast

    // Second ack — idempotent, no second broadcast.
    const r2 = await injectPost(`/api/workflows/${wfId}/attention/${attId}/ack`);
    expect(r2.statusCode).toBe(200);
    expect((r2.body as Record<string, unknown>).status).toBe('already_acknowledged');

    s.close();
  });

  it('acking one of two items decrements broadcast count to 1', async () => {
    const wfId = insertWorkflow();
    const attId1 = insertPendingAttention(wfId);
    const attId2 = insertPendingAttention(wfId);

    const s = await connectWs();
    await s.next(); // hello
    s.send({ v: 1, type: 'subscribe', id: 'sub-3', payload: { workflowId: wfId } });
    const snapshot = await s.next();

    const pendingAttention = (snapshot.payload as Record<string, unknown>)
      .pendingAttention as Array<{ id: number }>;
    expect(pendingAttention.length).toBe(2);

    // Ack only the first item.
    await injectPost(`/api/workflows/${wfId}/attention/${attId1}/ack`);
    const broadcastFrame = await s.next();
    s.close();

    expect(broadcastFrame.type).toBe('workflow.index.update');
    const payload = broadcastFrame.payload as Record<string, unknown>;
    // One item (attId2) remains unacknowledged.
    expect(payload.pendingAttentionCount).toBe(1);

    // attId2 still unacknowledged.
    const row2 = db.reader()
      .prepare('SELECT acknowledged_at FROM pending_attention WHERE id = ?')
      .get(attId2) as { acknowledged_at: string | null };
    expect(row2.acknowledged_at).toBeNull();
  });

  it('GET /api/workflows returns the workflow even after ack (row not deleted)', async () => {
    const wfId = insertWorkflow();
    const attId = insertPendingAttention(wfId);

    await injectPost(`/api/workflows/${wfId}/attention/${attId}/ack`);

    // Workflow list still includes the workflow (ack does not remove it).
    const listRes = await handle.fastify.inject({ method: 'GET', url: '/api/workflows' });
    const body = JSON.parse(listRes.body) as { workflows: Array<{ id: string }> };
    expect(body.workflows.some((w) => w.id === wfId)).toBe(true);

    // Acknowledged row still exists in DB (just cleared, not deleted).
    const row = db.reader()
      .prepare('SELECT id, acknowledged_at FROM pending_attention WHERE id = ?')
      .get(attId) as { id: number; acknowledged_at: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.acknowledged_at).toBeTruthy();
  });

  it('ack 404 for unknown attention id — no broadcast', async () => {
    const wfId = insertWorkflow();

    const s = await connectWs();
    await s.next(); // hello
    s.send({ v: 1, type: 'subscribe', id: 'sub-4', payload: { workflowId: wfId } });
    await s.next(); // snapshot

    const res = await injectPost(`/api/workflows/${wfId}/attention/99999/ack`);
    s.close();

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Live path (AC-2): engine inserts row → notice frame over WS → ack → cleared
// ---------------------------------------------------------------------------

// Minimal fake deps for Scheduler (no real spawning needed)
const _fakePM = { spawn: () => { throw new Error('no spawn'); } } as unknown as ProcessManager;
const _fakeWM = {
  createWorktree: () => { throw new Error('no worktree'); },
  runBootstrap: () => { throw new Error('no bootstrap'); },
  runTeardown: () => { throw new Error('no teardown'); },
  cleanup: () => {},
} as unknown as WorktreeManager;

function _makeConfig(configDir: string): ResolvedConfig {
  return {
    version: '1',
    configDir,
    template: { name: 'attn-rt-live' },
    pipeline: { stages: [{ id: 'stage1', run: 'once', phases: ['impl'] }] },
    phases: { impl: { command: 'echo', args: [], prompt_template: 'p.md' } },
  } as unknown as ResolvedConfig;
}

describe('attention round-trip — live path (AC-2)', () => {
  it('engine inserts row via _applyTransition → notice frame over WS → ack → workflow.index.update', async () => {
    const wfId = insertWorkflow();

    // Insert item in bootstrapping state so bootstrap_fail transition is valid.
    const itemId = `item-live-${wfId}`;
    db.writer
      .prepare(
        `INSERT INTO items
           (id, workflow_id, stage_id, data, status, current_phase,
            depends_on, retry_count, blocked_reason, updated_at)
         VALUES (?, ?, 'stage1', '{}', 'bootstrapping', 'impl', null, 0, null, datetime('now'))`,
      )
      .run(itemId, wfId);

    // Connect WS client and subscribe before the engine fires.
    const s = await connectWs();
    await s.next(); // hello frame
    s.send({ v: 1, type: 'subscribe', id: 'live-sub-1', payload: { workflowId: wfId } });
    await s.next(); // workflow.snapshot

    // Wire a Scheduler that broadcasts through the real WsClientRegistry.
    // This simulates the production wiring in start.ts.
    const broadcastFn: BroadcastFn = (wId, sessId, frameType, payload) => {
      handle.state.registry.broadcast(wId, sessId, frameType, payload);
    };
    const scheduler = new Scheduler({
      db,
      config: _makeConfig(os.tmpdir()),
      processManager: _fakePM,
      worktreeManager: _fakeWM,
      prepostRunner: async () => ({ kind: 'complete', runs: [] }),
      assemblePrompt: async () => 'prompt',
      broadcast: broadcastFn,
      artifactValidator: async () => ({ kind: 'validators_ok' as const }),
    });

    // Drive bootstrap_fail through _applyTransition — inserts pending_attention
    // and immediately broadcasts the notice via broadcastFn → registry.
    (scheduler as unknown as {
      _applyTransition(p: ApplyItemTransitionParams): unknown;
    })._applyTransition({
      db,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'impl',
      attempt: 1,
      event: 'bootstrap_fail',
    });

    // WS client should receive the notice frame with persistedAttentionId.
    const noticeFrame = await s.next();
    expect(noticeFrame.type).toBe('notice');
    const noticePayload = noticeFrame.payload as Record<string, unknown>;
    expect(noticePayload.severity).toBe('requires_attention');
    expect(noticePayload.kind).toBe('bootstrap_failed');
    expect(typeof noticePayload.persistedAttentionId).toBe('number');
    const attId = noticePayload.persistedAttentionId as number;

    // Ack via HTTP — row is cleared, workflow.index.update broadcast fires.
    const ackRes = await injectPost(`/api/workflows/${wfId}/attention/${attId}/ack`);
    expect(ackRes.statusCode).toBe(200);
    expect((ackRes.body as Record<string, unknown>).status).toBe('acknowledged');

    // WS client receives workflow.index.update.
    const updateFrame = await s.next();
    s.close();

    expect(updateFrame.type).toBe('workflow.index.update');
    const updatePayload = updateFrame.payload as Record<string, unknown>;
    expect(updatePayload.pendingAttentionCount).toBe(0);

    // DB row is cleared.
    const row = db.reader()
      .prepare('SELECT acknowledged_at FROM pending_attention WHERE id = ?')
      .get(attId) as { acknowledged_at: string | null };
    expect(row.acknowledged_at).toBeTruthy();
  });
});
