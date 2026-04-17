/**
 * Integration tests for phase_advance, stage_complete, and goto (engine-level).
 *
 * Coverage:
 *   - session_ok with morePhases=true → phase_advance (current_phase updated)
 *   - session_ok with morePhases=false on last item → stageComplete=true
 *   - applyStageAdvance updates workflows.current_stage
 *   - post_command_action goto within maxRevisits → in_progress at dest phase
 *   - post_command_action goto inserts prepost.revisit event
 *   - broadcast frames emitted correctly for each transition
 *
 * All tests use real SQLite with migrations. No Scheduler, no spawned processes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import type { DbPool } from '../../src/server/storage/db.js';
import {
  applyItemTransition,
  applyStageAdvance,
} from '../../src/server/pipeline/engine.js';
import type { ApplyItemTransitionResult } from '../../src/server/pipeline/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let tmpDir: string;
let pool: DbPool;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-goto-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  pool = openDbPool(dbPath);
  applyMigrations(pool.writer, MIGRATIONS_DIR);
});

afterEach(() => {
  pool.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

let wfSeq = 0;
let itemSeq = 0;

function makeWfId() { return `wf-${++wfSeq}`; }
function makeItemId() { return `item-${++itemSeq}`; }

function insertWorkflow(id: string) {
  pool.writer
    .prepare(`
      INSERT INTO workflows
        (id, name, spec, pipeline, config, status, created_at, updated_at, worktree_path)
      VALUES (?, 'test', '{}', '[]', '{}', 'in_progress',
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '/tmp/worktree')
    `)
    .run(id);
}

function insertItem(
  id: string,
  wfId: string,
  stageId: string,
  opts: { status?: string; phase?: string } = {},
) {
  pool.writer
    .prepare(`
      INSERT INTO items
        (id, workflow_id, stage_id, data, status, current_phase,
         depends_on, retry_count, blocked_reason, updated_at)
      VALUES (?, ?, ?, '{}', ?, ?, null, 0, null, '2026-01-01T00:00:00Z')
    `)
    .run(id, wfId, stageId, opts.status ?? 'in_progress', opts.phase ?? 'implement');
}

function getItem(id: string) {
  return pool.writer
    .prepare('SELECT * FROM items WHERE id = ?')
    .get(id) as { id: string; status: string; current_phase: string | null; retry_count: number } | undefined;
}

function getWorkflow(id: string) {
  return pool.writer
    .prepare('SELECT * FROM workflows WHERE id = ?')
    .get(id) as { id: string; current_stage: string | null; status: string } | undefined;
}

function countEvents(wfId: string, eventType: string): number {
  const row = pool.writer
    .prepare('SELECT COUNT(*) AS n FROM events WHERE workflow_id = ? AND event_type = ?')
    .get(wfId, eventType) as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// Broadcast capture helper
// ---------------------------------------------------------------------------

type BroadcastFrame = { workflowId: string; frameType: string; payload: unknown };

function makeBroadcastCapture() {
  const frames: BroadcastFrame[] = [];

  function simulateBroadcast(
    wfId: string,
    itemId: string,
    stageId: string,
    result: ApplyItemTransitionResult,
  ) {
    const item = pool.writer.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as
      | { retry_count: number; blocked_reason: string | null }
      | undefined;
    frames.push({
      workflowId: wfId,
      frameType: 'item.state',
      payload: {
        itemId,
        stageId,
        state: {
          status: result.newState,
          currentPhase: result.newPhase,
          retryCount: item?.retry_count ?? 0,
          blockedReason: item?.blocked_reason ?? null,
        },
      },
    });
  }

  return { frames, simulateBroadcast };
}

// ---------------------------------------------------------------------------
// Tests: phase_advance
// ---------------------------------------------------------------------------

describe('goto-and-advance — phase_advance', () => {
  it('session_ok with morePhases=true advances current_phase to nextPhase', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'implement' });

    const { frames, simulateBroadcast } = makeBroadcastCapture();

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_ok',
      guardCtx: {
        morePhases: true,
        nextPhase: 'review',
        allPostCommandsOk: true,
        validatorsOk: true,
        diffCheckOk: true,
      },
    });

    simulateBroadcast(wfId, itemId, 'stage1', result);

    expect(result.newState).toBe('in_progress');
    expect(result.newPhase).toBe('review');
    expect(getItem(itemId)?.current_phase).toBe('review');
    expect(getItem(itemId)?.status).toBe('in_progress');

    expect(frames[0].frameType).toBe('item.state');
    expect((frames[0].payload as any).state.status).toBe('in_progress');
    expect((frames[0].payload as any).state.currentPhase).toBe('review');
  });
});

// ---------------------------------------------------------------------------
// Tests: stage_complete
// ---------------------------------------------------------------------------

describe('goto-and-advance — stage_complete', () => {
  it('last item session_ok → stageComplete=true; applyStageAdvance updates current_stage', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'implement' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_ok',
      guardCtx: {
        morePhases: false,
        allPostCommandsOk: true,
        validatorsOk: true,
        diffCheckOk: true,
      },
    });

    expect(result.newState).toBe('complete');
    expect(result.stageComplete).toBe(true);

    // Drive stage advance
    applyStageAdvance(pool, wfId, 'stage2');
    expect(getWorkflow(wfId)?.current_stage).toBe('stage2');
  });

  it('stageComplete=false when other items are still pending', () => {
    const wfId = makeWfId();
    const itemA = makeItemId();
    const itemB = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemA, wfId, 'stage1', { status: 'in_progress', phase: 'implement' });
    insertItem(itemB, wfId, 'stage1', { status: 'pending', phase: 'implement' });

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId: itemA,
      sessionId: null,
      stage: 'stage1',
      phase: 'implement',
      attempt: 1,
      event: 'session_ok',
      guardCtx: { morePhases: false, allPostCommandsOk: true, validatorsOk: true, diffCheckOk: true },
    });

    expect(result.newState).toBe('complete');
    expect(result.stageComplete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: conditional goto from post_command_action
// ---------------------------------------------------------------------------

describe('goto-and-advance — goto from post_command_action', () => {
  it('goto within maxRevisits → in_progress at destination phase', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'review' });

    const { frames, simulateBroadcast } = makeBroadcastCapture();

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'review',
      attempt: 1,
      event: 'post_command_action',
      guardCtx: {
        postCommandAction: { kind: 'goto', goto: 'implement', maxRevisits: 3 },
      },
    });

    simulateBroadcast(wfId, itemId, 'stage1', result);

    expect(result.newState).toBe('in_progress');
    expect(result.newPhase).toBe('implement');
    expect(getItem(itemId)?.current_phase).toBe('implement');
    expect(getItem(itemId)?.status).toBe('in_progress');

    expect((frames[0].payload as any).state.status).toBe('in_progress');
    expect((frames[0].payload as any).state.currentPhase).toBe('implement');
  });

  it('goto inserts prepost.revisit event into events table', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'review' });

    applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'review',
      attempt: 1,
      event: 'post_command_action',
      guardCtx: {
        postCommandAction: { kind: 'goto', goto: 'implement', maxRevisits: 3 },
      },
    });

    expect(countEvents(wfId, 'prepost.revisit')).toBe(1);
  });

  it('goto exceeding maxRevisits → awaiting_user', () => {
    const wfId = makeWfId();
    const itemId = makeItemId();
    insertWorkflow(wfId);
    insertItem(itemId, wfId, 'stage1', { status: 'in_progress', phase: 'review' });

    // Pre-seed 3 revisit events to exhaust budget
    for (let i = 0; i < 3; i++) {
      pool.writer
        .prepare(`
          INSERT INTO events (ts, workflow_id, item_id, session_id, stage, phase, attempt,
                              event_type, level, message, extra)
          VALUES ('2026-01-01T00:00:00Z', ?, ?, null, 'stage1', 'review', ?,
                  'prepost.revisit', 'info', 'goto to phase "implement"',
                  '{"destination":"implement"}')
        `)
        .run(wfId, itemId, i);
    }

    const result = applyItemTransition({
      db: pool,
      workflowId: wfId,
      itemId,
      sessionId: null,
      stage: 'stage1',
      phase: 'review',
      attempt: 4,
      event: 'post_command_action',
      guardCtx: {
        postCommandAction: { kind: 'goto', goto: 'implement', maxRevisits: 3 },
      },
    });

    expect(result.newState).toBe('awaiting_user');
    expect(getItem(itemId)?.status).toBe('awaiting_user');
  });
});
