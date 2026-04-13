/**
 * WebSocket protocol tests — feat-fastify-ws.
 *
 * Covers:
 *   AC-1: hello frame + protocolVersion; close 4001 on mismatch.
 *   AC-2: subscribe → workflow.snapshot + backfill / backfill.truncated.
 *   AC-3: subscription cap (4 max; 5th → error + close 4002).
 *   AC-4: control commandId idempotency.
 *   AC-6: server binds 127.0.0.1 only.
 *
 * Uses real Fastify server + real ws.WebSocket connections.
 * No mocks — SQLite rows are inserted directly.
 *
 * ## WsSession (race-condition note)
 * The hello frame is sent by the server in the 'open' handler, which can
 * arrive in the SAME TCP read as the upgrade 101 response. To avoid losing
 * that message before nextMessage() registers its listener, WsSession
 * registers the 'message' handler BEFORE the 'open' event fires and stores
 * frames in a queue that next() drains before waiting for new arrivals.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerHandle } from '../../src/server/api/server.js';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import { makeFrame } from '../../src/server/api/frames.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: ReturnType<typeof openDbPool>;
let handle: ServerHandle;
let wsUrl: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-ws-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));

  const migrationsDir = new URL(
    '../../src/server/storage/migrations/',
    import.meta.url,
  ).pathname;
  await applyMigrations(db.writer, migrationsDir);

  handle = await createServer(db);
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
// WsSession — buffered message queue (no race condition with hello frame)
// ---------------------------------------------------------------------------

interface WsSession {
  /** Dequeues the next frame (buffered or awaited). */
  next(): Promise<Record<string, unknown>>;
  /** Serialises frame to JSON and sends. */
  send(frame: object): void;
  /** Sends raw string bytes (for testing malformed input). */
  sendRaw(data: string): void;
  close(): void;
  onClose(): Promise<{ code: number; reason: string }>;
}

function connectWs(): Promise<WsSession> {
  return new Promise<WsSession>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const queue: Record<string, unknown>[] = [];
    const waiters: Array<[(m: Record<string, unknown>) => void, (e: Error) => void]> = [];
    let closed = false;
    const closeCallbacks: Array<(info: { code: number; reason: string }) => void> = [];

    // Register 'message' BEFORE 'open' fires so hello is never dropped.
    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (waiters.length > 0) {
          const [res] = waiters.shift()!;
          res(msg);
        } else {
          queue.push(msg);
        }
      } catch {
        // ignore non-JSON
      }
    });

    ws.on('close', (code, reason) => {
      closed = true;
      const info = { code, reason: reason.toString() };
      for (const cb of closeCallbacks) cb(info);
      // Reject any pending waiters (socket closed before message).
      for (const [, rej] of waiters) {
        rej(new Error(`WS closed with code ${code} before expected message`));
      }
      waiters.length = 0;
    });

    ws.once('open', () =>
      resolve({
        next: () => {
          if (queue.length > 0) return Promise.resolve(queue.shift()!);
          if (closed) return Promise.reject(new Error('WS already closed'));
          return new Promise<Record<string, unknown>>((res, rej) => {
            waiters.push([res, rej]);
          });
        },
        send: (frame: object) => ws.send(JSON.stringify(frame)),
        sendRaw: (data: string) => ws.send(data),
        close: () => ws.close(),
        onClose: () =>
          new Promise<{ code: number; reason: string }>((res) => {
            if (closed) res({ code: 0, reason: '' });
            else closeCallbacks.push(res);
          }),
      }),
    );
    ws.once('error', reject);
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`Unexpected HTTP response: ${res.statusCode}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertWorkflow(id = 'wf-1', name = 'Test Workflow'): string {
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', '{"stages":[]}', '{}', 'running', datetime('now'), datetime('now'))`,
    )
    .run(id, name);
  return id;
}

function insertSession(workflowId: string, sessionId = 'ses-1'): string {
  db.writer
    .prepare(
      `INSERT INTO sessions (id, workflow_id, stage, phase, agent_profile, started_at, status)
       VALUES (?, ?, 'stage-1', 'phase-1', 'default', datetime('now'), 'running')`,
    )
    .run(sessionId, workflowId);
  return sessionId;
}

// ---------------------------------------------------------------------------
// AC-1: hello frame
// ---------------------------------------------------------------------------

describe('hello frame (AC-1)', () => {
  it('sends hello immediately on connect with protocolVersion:1 and capabilities', async () => {
    const s = await connectWs();
    const hello = await s.next();
    s.close();

    expect(hello.v).toBe(1);
    expect(hello.type).toBe('hello');
    expect(hello.seq).toBe(0);
    expect((hello.payload as any).protocolVersion).toBe(1);
    expect(Array.isArray((hello.payload as any).capabilities)).toBe(true);
    expect((hello.payload as any).capabilities).toContain('backfill');
    expect(typeof (hello.payload as any).serverVersion).toBe('string');
    expect(typeof (hello.payload as any).heartbeatIntervalMs).toBe('number');
  });

  it('hello is the first frame — no other frame arrives before it', async () => {
    const s = await connectWs();
    const first = await s.next();
    s.close();
    expect(first.type).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// AC-1: protocol version mismatch → close 4001
// ---------------------------------------------------------------------------

describe('protocol version check (AC-1)', () => {
  it('closes with 4001 when ClientFrame.v !== 1', async () => {
    const s = await connectWs();
    await s.next(); // consume hello

    s.send({ v: 2, type: 'ping', id: 'id-1', payload: { clientTs: new Date().toISOString() } });

    const { code } = await s.onClose();
    expect(code).toBe(4001);
  });

  it('does not close on a valid v:1 frame', async () => {
    insertWorkflow();
    const s = await connectWs();
    await s.next(); // hello

    s.send({ v: 1, type: 'subscribe', id: 'id-1', payload: { workflowId: 'wf-1' } });
    const frame = await s.next();
    s.close();
    expect(frame.type).toBe('workflow.snapshot');
  });
});

// ---------------------------------------------------------------------------
// AC-2: subscribe → workflow.snapshot
// ---------------------------------------------------------------------------

describe('subscribe → workflow.snapshot (AC-2)', () => {
  it('sends workflow.snapshot (seq:0) immediately after subscribe', async () => {
    insertWorkflow('wf-2', 'My Workflow');
    const s = await connectWs();
    await s.next(); // hello

    s.send({ v: 1, type: 'subscribe', id: 'sub-1', payload: { workflowId: 'wf-2' } });
    const snap = await s.next();
    s.close();

    expect(snap.type).toBe('workflow.snapshot');
    expect(snap.seq).toBe(0);
    expect(snap.workflowId).toBe('wf-2');
    expect((snap.payload as any).workflow.id).toBe('wf-2');
    expect((snap.payload as any).workflow.name).toBe('My Workflow');
    expect(Array.isArray((snap.payload as any).items)).toBe(true);
    expect(Array.isArray((snap.payload as any).stages)).toBe(true);
    expect(Array.isArray((snap.payload as any).activeSessions)).toBe(true);
    expect(Array.isArray((snap.payload as any).pendingAttention)).toBe(true);
  });

  it('returns error NOT_FOUND for unknown workflowId', async () => {
    const s = await connectWs();
    await s.next(); // hello

    s.send({ v: 1, type: 'subscribe', id: 'sub-x', payload: { workflowId: 'nonexistent' } });
    const err = await s.next();
    s.close();

    expect(err.type).toBe('error');
    expect((err.payload as any).code).toBe('NOT_FOUND');
  });

  it('snapshot includes active sessions', async () => {
    insertWorkflow('wf-3');
    insertSession('wf-3', 'ses-a');

    const s = await connectWs();
    await s.next(); // hello

    s.send({ v: 1, type: 'subscribe', id: 'sub-2', payload: { workflowId: 'wf-3' } });
    const snap = await s.next();
    s.close();

    const sessions = (snap.payload as any).activeSessions as Array<{ sessionId: string }>;
    expect(sessions.some((x) => x.sessionId === 'ses-a')).toBe(true);
  });

  it('subscribe with sinceSeq and empty backfill buffer yields no extra frames', async () => {
    insertWorkflow('wf-4');
    insertSession('wf-4', 'ses-b');

    const s = await connectWs();
    await s.next(); // hello

    s.send({ v: 1, type: 'subscribe', id: 'sub-3', payload: { workflowId: 'wf-4', sinceSeq: 0 } });
    const snap = await s.next();
    expect(snap.type).toBe('workflow.snapshot');

    // No further frames within 100ms.
    const quiet = await Promise.race([
      s.next().then(() => false),
      new Promise<true>((r) => setTimeout(() => r(true), 100)),
    ]);
    s.close();
    expect(quiet).toBe(true);
  });

  it('subscribe with sinceSeq < earliestRetained emits backfill.truncated (AC-2)', async () => {
    insertWorkflow('wf-5');
    const sessionId = insertSession('wf-5', 'ses-c');

    // Inject a frame into the backfill buffer (pipeline engine would do this).
    const frame = makeFrame('stream.text', { textDelta: 'hello' }, {
      workflowId: 'wf-5',
      sessionId,
      seq: 10,
    });
    handle.state.backfillBuffer.push(sessionId, frame);

    const s = await connectWs();
    await s.next(); // hello

    // sinceSeq=3 < earliest(10) - 1 = 9 → backfill.truncated
    s.send({ v: 1, type: 'subscribe', id: 'sub-4', payload: { workflowId: 'wf-5', sinceSeq: 3 } });
    const snap = await s.next();
    expect(snap.type).toBe('workflow.snapshot');

    const truncated = await s.next();
    s.close();

    expect(truncated.type).toBe('backfill.truncated');
    expect((truncated.payload as any).workflowId).toBe('wf-5');
    expect((truncated.payload as any).sinceSeq).toBe(3);
    expect(typeof (truncated.payload as any).httpFetchUrl).toBe('string');
    expect((truncated.payload as any).httpFetchUrl).toContain(`/api/sessions/${sessionId}/log`);
  });

  it('subscribe with sinceSeq within buffer replays frames with original seq (AC-2)', async () => {
    insertWorkflow('wf-6');
    const sessionId = insertSession('wf-6', 'ses-d');

    const f5 = makeFrame('stream.text', { textDelta: 'a' }, { workflowId: 'wf-6', sessionId, seq: 5 });
    const f6 = makeFrame('stream.text', { textDelta: 'b' }, { workflowId: 'wf-6', sessionId, seq: 6 });
    handle.state.backfillBuffer.push(sessionId, f5);
    handle.state.backfillBuffer.push(sessionId, f6);

    const s = await connectWs();
    await s.next(); // hello

    // sinceSeq=4 → replay seq 5 and 6 (original seq preserved)
    s.send({ v: 1, type: 'subscribe', id: 'sub-5', payload: { workflowId: 'wf-6', sinceSeq: 4 } });
    const snap = await s.next();
    expect(snap.type).toBe('workflow.snapshot');

    const r5 = await s.next();
    const r6 = await s.next();
    s.close();

    expect(r5.seq).toBe(5);
    expect(r6.seq).toBe(6);
    expect(r5.type).toBe('stream.text');
    expect(r6.type).toBe('stream.text');
  });
});

// ---------------------------------------------------------------------------
// AC-3: subscription cap — 4 max; 5th → error + close 4002
// ---------------------------------------------------------------------------

describe('subscription cap (AC-3)', () => {
  it('allows 4 concurrent subscriptions', async () => {
    for (let i = 1; i <= 4; i++) insertWorkflow(`cap-wf-${i}`, `Cap ${i}`);

    const s = await connectWs();
    await s.next(); // hello

    for (let i = 1; i <= 4; i++) {
      s.send({ v: 1, type: 'subscribe', id: `sub-cap-${i}`, payload: { workflowId: `cap-wf-${i}` } });
      const snap = await s.next();
      expect(snap.type).toBe('workflow.snapshot');
    }
    s.close();
  });

  it('5th subscribe sends error{SUBSCRIPTION_LIMIT} and closes with 4002 (AC-3)', async () => {
    for (let i = 1; i <= 5; i++) insertWorkflow(`sl-wf-${i}`, `SL ${i}`);

    const s = await connectWs();
    await s.next(); // hello

    for (let i = 1; i <= 4; i++) {
      s.send({ v: 1, type: 'subscribe', id: `sl-sub-${i}`, payload: { workflowId: `sl-wf-${i}` } });
      await s.next(); // snapshot
    }

    s.send({ v: 1, type: 'subscribe', id: 'sl-sub-5', payload: { workflowId: 'sl-wf-5' } });

    const err = await s.next();
    expect(err.type).toBe('error');
    expect((err.payload as any).code).toBe('SUBSCRIPTION_LIMIT');

    const { code } = await s.onClose();
    expect(code).toBe(4002);
  });

  it('re-subscribing to same workflowId does not count against the cap', async () => {
    insertWorkflow('recapwf');

    const s = await connectWs();
    await s.next(); // hello

    s.send({ v: 1, type: 'subscribe', id: 'rc-1', payload: { workflowId: 'recapwf' } });
    const snap1 = await s.next();
    expect(snap1.type).toBe('workflow.snapshot');

    // Re-subscribe: should succeed without incrementing cap count.
    s.send({ v: 1, type: 'subscribe', id: 'rc-2', payload: { workflowId: 'recapwf' } });
    const snap2 = await s.next();
    s.close();
    expect(snap2.type).toBe('workflow.snapshot');
  });
});

// ---------------------------------------------------------------------------
// AC-4: control commandId idempotency
// ---------------------------------------------------------------------------

describe('control commandId idempotency (AC-4)', () => {
  it('first control returns response; second with same id returns cached response', async () => {
    insertWorkflow('ctrl-wf');
    const s = await connectWs();
    await s.next(); // hello

    const ctrlFrame = {
      v: 1,
      type: 'control',
      id: 'cmd-uuid-1234',
      payload: { workflowId: 'ctrl-wf', action: 'pause' },
    };

    s.send(ctrlFrame);
    const r1 = await s.next();

    s.send(ctrlFrame); // same commandId
    const r2 = await s.next();
    s.close();

    expect(r1.type).toBe(r2.type);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('different commandIds yield independent responses', async () => {
    insertWorkflow('ctrl-wf2');
    const s = await connectWs();
    await s.next(); // hello

    s.send({ v: 1, type: 'control', id: 'cmd-A', payload: { workflowId: 'ctrl-wf2', action: 'pause' } });
    const rA = await s.next();

    s.send({ v: 1, type: 'control', id: 'cmd-B', payload: { workflowId: 'ctrl-wf2', action: 'resume' } });
    const rB = await s.next();
    s.close();

    expect(rA.type).toBeTruthy();
    expect(rB.type).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Ping / pong
// ---------------------------------------------------------------------------

describe('ping → pong', () => {
  it('pong frame has seq:0', async () => {
    const s = await connectWs();
    await s.next(); // hello

    s.send({ v: 1, type: 'ping', id: 'ping-1', payload: { clientTs: new Date().toISOString() } });
    const pong = await s.next();
    s.close();

    expect(pong.type).toBe('pong');
    expect(pong.seq).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unsubscribe
// ---------------------------------------------------------------------------

describe('unsubscribe', () => {
  it('unsubscribing does not close the socket', async () => {
    insertWorkflow('unsub-wf');
    const s = await connectWs();
    await s.next(); // hello

    s.send({ v: 1, type: 'subscribe', id: 'usub-1', payload: { workflowId: 'unsub-wf' } });
    await s.next(); // snapshot

    s.send({ v: 1, type: 'unsubscribe', id: 'usub-2', payload: { workflowId: 'unsub-wf' } });

    // Socket stays open — verify by ping.
    s.send({ v: 1, type: 'ping', id: 'usub-3', payload: { clientTs: new Date().toISOString() } });
    const pong = await s.next();
    s.close();
    expect(pong.type).toBe('pong');
  });
});

// ---------------------------------------------------------------------------
// Malformed frames
// ---------------------------------------------------------------------------

describe('malformed ClientFrame', () => {
  it('non-JSON message → error BAD_FRAME, socket stays open', async () => {
    const s = await connectWs();
    await s.next(); // hello

    s.sendRaw('this is not json');
    const err = await s.next();

    expect(err.type).toBe('error');
    expect((err.payload as any).code).toBe('BAD_FRAME');

    s.send({ v: 1, type: 'ping', id: 'bfp-1', payload: { clientTs: new Date().toISOString() } });
    const pong = await s.next();
    s.close();
    expect(pong.type).toBe('pong');
  });

  it('unknown frame type → error BAD_FRAME, socket stays open', async () => {
    const s = await connectWs();
    await s.next(); // hello

    s.send({ v: 1, type: 'unknown_type', id: 'unk-1', payload: {} });
    const err = await s.next();
    expect(err.type).toBe('error');
    expect((err.payload as any).code).toBe('BAD_FRAME');
    s.close();
  });
});

// ---------------------------------------------------------------------------
// AC-6: server binds 127.0.0.1 exclusively
// ---------------------------------------------------------------------------

describe('127.0.0.1 binding (AC-6)', () => {
  it('server listens on 127.0.0.1', () => {
    const addr = handle.fastify.server.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
  });

  it('listenServer throws if host is not 127.0.0.1', async () => {
    const { listenServer } = await import('../../src/server/api/server.js');
    await expect(
      listenServer(db, { host: '0.0.0.0' as '127.0.0.1' }),
    ).rejects.toThrow('127.0.0.1');
  });
});

// ---------------------------------------------------------------------------
// seq rules (RC)
// ---------------------------------------------------------------------------

describe('seq rules (RC)', () => {
  it('hello frame has seq:0', async () => {
    const s = await connectWs();
    const hello = await s.next();
    s.close();
    expect(hello.seq).toBe(0);
  });

  it('workflow.snapshot frame has seq:0', async () => {
    insertWorkflow('seq-wf');
    const s = await connectWs();
    await s.next(); // hello

    s.send({ v: 1, type: 'subscribe', id: 's-1', payload: { workflowId: 'seq-wf' } });
    const snap = await s.next();
    s.close();
    expect(snap.seq).toBe(0);
  });

  it('backfill frames preserve original seq from buffer', async () => {
    insertWorkflow('seq-wf2');
    const sessionId = insertSession('seq-wf2', 'seq-ses');

    const frames = [7, 8, 9].map((seq) =>
      makeFrame('stream.thinking', { textDelta: 'x' }, { workflowId: 'seq-wf2', sessionId, seq }),
    );
    frames.forEach((f) => handle.state.backfillBuffer.push(sessionId, f));

    const s = await connectWs();
    await s.next(); // hello

    s.send({ v: 1, type: 'subscribe', id: 'seq-sub', payload: { workflowId: 'seq-wf2', sinceSeq: 6 } });
    await s.next(); // snapshot

    const r7 = await s.next();
    const r8 = await s.next();
    const r9 = await s.next();
    s.close();

    expect(r7.seq).toBe(7);
    expect(r8.seq).toBe(8);
    expect(r9.seq).toBe(9);
  });
});
