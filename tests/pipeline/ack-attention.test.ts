/**
 * Unit tests for src/server/pipeline/ack-attention.ts
 *
 * Coverage (RC-2: unit test covers ack path without a full server):
 *   - Successful ack: acknowledged_at written, broadcast called, result=acknowledged
 *   - Idempotent ack: second call returns already_acknowledged, no double-write,
 *     broadcast not called a second time
 *   - not_found: unknown attentionId returns not_found, broadcast not called
 *   - cross-workflow isolation: attentionId from workflow-A cannot be acked
 *     via workflow-B (returns not_found)
 *
 * Uses real SQLite with migrations.  Injects a mock AckBroadcastFn to verify
 * the broadcast side-effect without running a WebSocket server (RC-2).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDbPool, type DbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import { makeAckAttentionFn } from '../../src/server/pipeline/ack-attention.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

let tmpDir: string;
let pool: DbPool;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-ack-attn-test-'));
  pool = openDbPool(path.join(tmpDir, 'test.db'));
  applyMigrations(pool.writer, MIGRATIONS_DIR);
});

afterEach(() => {
  pool.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let wfSeq = 0;

function insertWorkflow(): string {
  wfSeq++;
  const id = `wf-${wfSeq}`;
  pool.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, 'Test Workflow', '{}', '{"stages":[]}', '{}', 'running', datetime('now'), datetime('now'))`,
    )
    .run(id);
  return id;
}

function insertAttention(workflowId: string, kind = 'awaiting_user_retry'): number {
  const result = pool.writer
    .prepare(
      `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
       VALUES (?, ?, '{}', datetime('now'))`,
    )
    .run(workflowId, kind);
  return Number(result.lastInsertRowid);
}

function getAttentionRow(id: number): { acknowledged_at: string | null } | undefined {
  return pool.writer
    .prepare('SELECT acknowledged_at FROM pending_attention WHERE id = ?')
    .get(id) as { acknowledged_at: string | null } | undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeAckAttentionFn', () => {
  it('sets acknowledged_at and returns acknowledged (AC-1, AC-2)', () => {
    const broadcastFn = vi.fn();
    const ack = makeAckAttentionFn(pool.writer, broadcastFn);

    const wfId = insertWorkflow();
    const attId = insertAttention(wfId);

    const result = ack(wfId, attId);

    expect(result).toEqual({ status: 'acknowledged', id: attId });

    const row = getAttentionRow(attId);
    expect(row?.acknowledged_at).toBeTruthy();
  });

  it('broadcasts workflow.update after successful ack (AC-3)', () => {
    const broadcastFn = vi.fn();
    const ack = makeAckAttentionFn(pool.writer, broadcastFn);

    const wfId = insertWorkflow();
    const attId = insertAttention(wfId);

    ack(wfId, attId);

    expect(broadcastFn).toHaveBeenCalledOnce();
    expect(broadcastFn).toHaveBeenCalledWith(wfId);
  });

  it('row disappears from the partial index (WHERE acknowledged_at IS NULL) after ack (AC-2)', () => {
    const ack = makeAckAttentionFn(pool.writer, vi.fn());
    const wfId = insertWorkflow();
    const attId = insertAttention(wfId);

    ack(wfId, attId);

    // The partial index filters out acknowledged rows.
    const openRows = pool.writer
      .prepare(
        'SELECT id FROM pending_attention WHERE workflow_id = ? AND acknowledged_at IS NULL',
      )
      .all(wfId) as Array<{ id: number }>;
    expect(openRows.find((r) => r.id === attId)).toBeUndefined();
  });

  it('second ack returns already_acknowledged and does not re-broadcast (idempotent)', () => {
    const broadcastFn = vi.fn();
    const ack = makeAckAttentionFn(pool.writer, broadcastFn);

    const wfId = insertWorkflow();
    const attId = insertAttention(wfId);

    const r1 = ack(wfId, attId);
    const r2 = ack(wfId, attId);

    expect(r1).toEqual({ status: 'acknowledged', id: attId });
    expect(r2).toEqual({ status: 'already_acknowledged', id: attId });

    // Broadcast only fires once (on the first ack).
    expect(broadcastFn).toHaveBeenCalledOnce();
  });

  it('returns not_found for an unknown attentionId and does not broadcast', () => {
    const broadcastFn = vi.fn();
    const ack = makeAckAttentionFn(pool.writer, broadcastFn);

    const wfId = insertWorkflow();
    const result = ack(wfId, 99999);

    expect(result).toEqual({ status: 'not_found' });
    expect(broadcastFn).not.toHaveBeenCalled();
  });

  it('returns not_found when attentionId belongs to a different workflow (cross-workflow isolation)', () => {
    const broadcastFn = vi.fn();
    const ack = makeAckAttentionFn(pool.writer, broadcastFn);

    const wfId1 = insertWorkflow();
    const wfId2 = insertWorkflow();
    const attId = insertAttention(wfId1); // belongs to wfId1

    // Attempting to ack via wfId2 should fail.
    const result = ack(wfId2, attId);

    expect(result).toEqual({ status: 'not_found' });
    expect(broadcastFn).not.toHaveBeenCalled();

    // Row for wfId1 should still be unacknowledged.
    const row = getAttentionRow(attId);
    expect(row?.acknowledged_at).toBeNull();
  });
});
