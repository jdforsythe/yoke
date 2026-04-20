/**
 * Cross-transport idempotency for POST /api/workflows/:id/control + WS
 * control frames.
 *
 * A commandId sent via HTTP MUST dedupe against the same commandId replayed
 * via WS (and vice versa).  Both transports share the IdempotencyStore
 * created inside createServer, so we verify the executor fires exactly once
 * per commandId regardless of which wire originated it.
 *
 * Uses a counting wrapper around the production ControlExecutorFn: real
 * executor logic runs on the first call and the wrapper increments a counter.
 * A subsequent duplicate commandId must NOT reach the executor (the cache
 * short-circuit is in the API layer, before callbacks.controlExecutor is
 * invoked).
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
} from '../../src/server/api/server.js';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import { makeControlExecutor } from '../../src/server/pipeline/control-executor.js';
import type { ControlExecutorFn } from '../../src/server/pipeline/control-executor.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: ReturnType<typeof openDbPool>;
let handle: ServerHandle;
let wsUrl: string;
let executorCallCount: number;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-ctrl-idem-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));
  const migrationsDir = new URL(
    '../../src/server/storage/migrations/',
    import.meta.url,
  ).pathname;
  await applyMigrations(db.writer, migrationsDir);

  executorCallCount = 0;
  const real = makeControlExecutor(
    db.writer,
    () => { /* killSession — no-op for idempotency tests */ },
    () => { /* broadcast — no-op for idempotency tests */ },
  );
  const counting: ControlExecutorFn = (wfId, action) => {
    executorCallCount++;
    return real(wfId, action);
  };

  const callbacks: ServerCallbacks = { controlExecutor: counting };
  handle = await createServer(db, callbacks);
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
// Test fixtures
// ---------------------------------------------------------------------------

let wfSeq = 0;
function insertWorkflow(): string {
  wfSeq++;
  const id = `wf-idem-${wfSeq}`;
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', '{"stages":[]}', '{}', 'running', datetime('now'), datetime('now'))`,
    )
    .run(id, `Idem Workflow ${wfSeq}`);
  // Give it one in_progress item so the executor has something to do.
  db.writer
    .prepare(
      `INSERT INTO items (id, workflow_id, stage_id, data, status, current_phase,
                          retry_count, updated_at)
       VALUES (?, ?, 'stage-1', '{}', 'in_progress', 'implement', 0, datetime('now'))`,
    )
    .run(`${id}-item-A`, id);
  return id;
}

async function injectHttp(url: string, body: object): Promise<{ statusCode: number; body: unknown }> {
  const res = await handle.fastify.inject({
    method: 'POST',
    url,
    payload: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown };
}

// ---------------------------------------------------------------------------
// Minimal WS session helper (only what these tests need).
// ---------------------------------------------------------------------------

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
        // ignore
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

// ---------------------------------------------------------------------------
// HTTP-only idempotency
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/control — HTTP idempotency', () => {
  it('executes once for two requests with the same commandId; second response matches first', async () => {
    const wfId = insertWorkflow();
    const cmd = { commandId: 'cmd-http-dup-1', action: 'cancel' };

    const r1 = await injectHttp(`/api/workflows/${wfId}/control`, cmd);
    expect(r1.statusCode).toBe(202);
    expect(executorCallCount).toBe(1);

    const r2 = await injectHttp(`/api/workflows/${wfId}/control`, cmd);
    expect(r2.statusCode).toBe(200);
    expect(executorCallCount).toBe(1); // NOT executed again
    expect(JSON.stringify(r2.body)).toBe(JSON.stringify(r1.body));
  });
});

// ---------------------------------------------------------------------------
// WS-only idempotency
// ---------------------------------------------------------------------------

describe('WS control frame — idempotency', () => {
  it('executes once for two control frames with the same commandId; second response matches first', async () => {
    const wfId = insertWorkflow();
    const s = await connectWs();
    await s.next(); // hello

    const frame = {
      v: 1,
      type: 'control',
      id: 'cmd-ws-dup-1',
      payload: { workflowId: wfId, action: 'cancel' },
    };

    s.send(frame);
    const r1 = await s.next();
    expect(executorCallCount).toBe(1);

    s.send(frame);
    const r2 = await s.next();
    s.close();

    expect(executorCallCount).toBe(1); // NOT executed again
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

// ---------------------------------------------------------------------------
// Cross-transport idempotency (HTTP then WS, same commandId)
// ---------------------------------------------------------------------------

describe('Cross-transport idempotency (HTTP ↔ WS share the idempotency store)', () => {
  it('HTTP first, then WS with the same commandId — executor fires once, WS echoes cached HTTP body byte-for-byte', async () => {
    const wfId = insertWorkflow();
    const commandId = 'cmd-cross-1';

    const r1 = await injectHttp(`/api/workflows/${wfId}/control`, {
      commandId,
      action: 'cancel',
    });
    expect(r1.statusCode).toBe(202);
    expect(executorCallCount).toBe(1);

    // Now replay via WS — should hit the cache (executor NOT called again).
    const s = await connectWs();
    await s.next(); // hello
    s.send({
      v: 1,
      type: 'control',
      id: commandId,
      payload: { workflowId: wfId, action: 'cancel' },
    });
    const wsResponse = await s.next(); // cached response echoed back
    s.close();

    expect(executorCallCount).toBe(1); // NOT executed again
    // The WS echoes the exact cached HTTP response body byte-for-byte (RC-3).
    expect(JSON.stringify(wsResponse)).toBe(JSON.stringify(r1.body));
  });
});
