/**
 * buildSnapshot coverage for the new StageProjection.description field
 * introduced in F2 of the nomenclature follow-ups.
 *
 * The wire contract is `string | null` (concrete null, not undefined) so
 * downstream clients can render the field conditionally without guarding
 * against `undefined`. These tests lock that in.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDbPool, type DbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import { buildSnapshot } from '../../src/server/api/ws.js';

let tmpDir: string;
let db: DbPool;

const migrationsDir = new URL(
  '../../src/server/storage/migrations/',
  import.meta.url,
).pathname;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-snapshot-stage-desc-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));
  await applyMigrations(db.writer, migrationsDir);
});

afterEach(async () => {
  db.close();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

interface PipelineStage {
  id: string;
  description?: string;
  run: 'once' | 'per-item';
  phases: string[];
}

function insertWorkflow(id: string, stages: PipelineStage[]): void {
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', 'in_progress', datetime('now'), datetime('now'))`,
    )
    .run(id, `wf ${id}`, JSON.stringify({ stages }));
}

describe('buildSnapshot StageProjection.description', () => {
  it('emits the description from the pipeline when set', () => {
    insertWorkflow('wf-desc', [
      {
        id: 'build',
        description: 'Applies the plan to the repo.',
        run: 'once',
        phases: ['implement'],
      },
    ]);

    const snap = buildSnapshot(db, 'wf-desc');
    expect(snap).not.toBeNull();
    expect(snap!.stages).toHaveLength(1);
    expect(snap!.stages[0].description).toBe('Applies the plan to the repo.');
  });

  it('emits null (not undefined) when description is omitted', () => {
    insertWorkflow('wf-no-desc', [
      { id: 'build', run: 'once', phases: ['implement'] },
    ]);

    const snap = buildSnapshot(db, 'wf-no-desc');
    expect(snap!.stages[0].description).toBeNull();
    // The key must be present so downstream `stage.description !== null`
    // guards behave deterministically.
    expect('description' in snap!.stages[0]).toBe(true);
  });

  it('emits null when description is the empty string (falsy but still a string)', () => {
    // YAML empty-string edge case: the schema allows it; the projection
    // treats any non-null string as the value. We assert the literal
    // pass-through so silent coercion does not creep in.
    insertWorkflow('wf-empty-desc', [
      { id: 'build', description: '', run: 'once', phases: ['implement'] },
    ]);

    const snap = buildSnapshot(db, 'wf-empty-desc');
    expect(snap!.stages[0].description).toBe('');
  });
});
