/**
 * Tests for buildSnapshot projection of `dependsOn` and `displayDescription`.
 *
 * Covers:
 *   - Same-stage dep: B depends on A → B.dependsOn === [A.stable_id]
 *   - Cross-stage dep where dependency row has no stable_id (once-stage):
 *       falls back to the raw row UUID
 *   - items_display.description JSONPath: populates displayDescription from
 *     JSON-parsed items.data
 *   - items_display.description not configured → displayDescription is null
 *   - malformed depends_on JSON → dependsOn === [] (no throw)
 *   - malformed items.data JSON → displayDescription === null (no throw)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDbPool, type DbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import { buildSnapshot } from '../../src/server/api/ws.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: DbPool;

const migrationsDir = new URL(
  '../../src/server/storage/migrations/',
  import.meta.url,
).pathname;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-snapshot-deps-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));
  await applyMigrations(db.writer, migrationsDir);
});

afterEach(async () => {
  db.close();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PipelineStage {
  id: string;
  run: 'once' | 'per-item';
  phases: string[];
  items_display?: { title?: string; subtitle?: string; description?: string };
}

function insertWorkflow(id: string, stages: PipelineStage[]): void {
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', 'in_progress', datetime('now'), datetime('now'))`,
    )
    .run(id, `wf ${id}`, JSON.stringify({ stages }));
}

interface ItemInsert {
  id: string;
  workflowId: string;
  stageId: string;
  stableId: string | null;
  status?: string;
  data: unknown;
  dependsOn?: string[] | string; // string allows injecting malformed JSON
}

function insertItem(opts: ItemInsert): void {
  const dependsOn =
    opts.dependsOn === undefined
      ? null
      : typeof opts.dependsOn === 'string'
        ? opts.dependsOn
        : JSON.stringify(opts.dependsOn);
  db.writer
    .prepare(
      `INSERT INTO items
        (id, workflow_id, stage_id, data, status, current_phase,
         depends_on, retry_count, stable_id, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?, datetime('now'))`,
    )
    .run(
      opts.id,
      opts.workflowId,
      opts.stageId,
      typeof opts.data === 'string' ? opts.data : JSON.stringify(opts.data),
      opts.status ?? 'pending',
      dependsOn,
      opts.stableId,
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSnapshot dependsOn projection', () => {
  it('translates row UUIDs to stable IDs for same-stage deps', () => {
    const wfId = 'wf-1';
    insertWorkflow(wfId, [
      { id: 'stage-1', run: 'per-item', phases: ['implement'] },
    ]);
    insertItem({
      id: 'row-A',
      workflowId: wfId,
      stageId: 'stage-1',
      stableId: 'feat-a',
      status: 'complete',
      data: {},
    });
    insertItem({
      id: 'row-B',
      workflowId: wfId,
      stageId: 'stage-1',
      stableId: 'feat-b',
      status: 'pending',
      data: {},
      dependsOn: ['row-A'],
    });

    const snap = buildSnapshot(db, wfId);
    expect(snap).not.toBeNull();
    const b = snap!.items.find((i) => i.id === 'row-B')!;
    expect(b.dependsOn).toEqual(['feat-a']);
  });

  it('falls back to row UUID when dep has no stable_id (once-stage parent)', () => {
    const wfId = 'wf-2';
    insertWorkflow(wfId, [
      { id: 'plan', run: 'once', phases: ['plan'] },
      { id: 'build', run: 'per-item', phases: ['implement'] },
    ]);
    // Once-stage row: stable_id is NULL
    insertItem({
      id: 'row-plan',
      workflowId: wfId,
      stageId: 'plan',
      stableId: null,
      status: 'complete',
      data: {},
    });
    insertItem({
      id: 'row-build-1',
      workflowId: wfId,
      stageId: 'build',
      stableId: 'feat-1',
      status: 'pending',
      data: {},
      dependsOn: ['row-plan'],
    });

    const snap = buildSnapshot(db, wfId);
    const b = snap!.items.find((i) => i.id === 'row-build-1')!;
    expect(b.dependsOn).toEqual(['row-plan']);
  });

  it('returns [] when depends_on is NULL', () => {
    const wfId = 'wf-3';
    insertWorkflow(wfId, [
      { id: 'stage-1', run: 'once', phases: ['main'] },
    ]);
    insertItem({
      id: 'row-solo',
      workflowId: wfId,
      stageId: 'stage-1',
      stableId: null,
      data: {},
    });

    const snap = buildSnapshot(db, wfId);
    expect(snap!.items[0].dependsOn).toEqual([]);
  });

  it('returns [] when depends_on JSON is malformed (no throw)', () => {
    const wfId = 'wf-4';
    insertWorkflow(wfId, [
      { id: 'stage-1', run: 'per-item', phases: ['main'] },
    ]);
    insertItem({
      id: 'row-X',
      workflowId: wfId,
      stageId: 'stage-1',
      stableId: 'feat-x',
      data: {},
      dependsOn: 'not-json',
    });

    const snap = buildSnapshot(db, wfId);
    expect(snap!.items[0].dependsOn).toEqual([]);
  });
});

describe('buildSnapshot displayDescription projection', () => {
  it('extracts description via items_display.description JSONPath', () => {
    const wfId = 'wf-desc-1';
    insertWorkflow(wfId, [
      {
        id: 'stage-1',
        run: 'per-item',
        phases: ['implement'],
        items_display: { description: '$.description' },
      },
    ]);
    insertItem({
      id: 'row-1',
      workflowId: wfId,
      stageId: 'stage-1',
      stableId: 'feat-1',
      data: { description: 'Fix the foo', other: 'ignored' },
    });

    const snap = buildSnapshot(db, wfId);
    expect(snap!.items[0].displayDescription).toBe('Fix the foo');
  });

  it('returns null when items_display.description is not configured', () => {
    const wfId = 'wf-desc-2';
    insertWorkflow(wfId, [
      { id: 'stage-1', run: 'per-item', phases: ['implement'] },
    ]);
    insertItem({
      id: 'row-1',
      workflowId: wfId,
      stageId: 'stage-1',
      stableId: 'feat-1',
      data: { description: 'Would extract if configured' },
    });

    const snap = buildSnapshot(db, wfId);
    expect(snap!.items[0].displayDescription).toBeNull();
  });

  it('returns null when items.data is malformed JSON (no throw)', () => {
    const wfId = 'wf-desc-3';
    insertWorkflow(wfId, [
      {
        id: 'stage-1',
        run: 'per-item',
        phases: ['implement'],
        items_display: { description: '$.description' },
      },
    ]);
    insertItem({
      id: 'row-1',
      workflowId: wfId,
      stageId: 'stage-1',
      stableId: 'feat-1',
      data: 'not-json',
    });

    const snap = buildSnapshot(db, wfId);
    expect(snap!.items[0].displayDescription).toBeNull();
  });

  it('returns null when JSONPath resolves to no match', () => {
    const wfId = 'wf-desc-4';
    insertWorkflow(wfId, [
      {
        id: 'stage-1',
        run: 'per-item',
        phases: ['implement'],
        items_display: { description: '$.missing' },
      },
    ]);
    insertItem({
      id: 'row-1',
      workflowId: wfId,
      stageId: 'stage-1',
      stableId: 'feat-1',
      data: { description: 'present' },
    });

    const snap = buildSnapshot(db, wfId);
    expect(snap!.items[0].displayDescription).toBeNull();
  });
});
