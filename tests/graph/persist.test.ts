import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDbPool, type DbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import { readGraph, writeGraph } from '../../src/server/graph/persist.js';
import { buildConfiguredGraph } from '../../src/server/graph/builder.js';
import { onceStageOnePhase } from './fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

let tmpDir: string;
let pool: DbPool;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-graph-persist-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  pool = openDbPool(dbPath);
  applyMigrations(pool.writer, MIGRATIONS_DIR);
});

afterEach(() => {
  pool.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertWorkflow(id: string): void {
  pool.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, 'wf', '{}', '{}', '{}', 'pending', ?, ?)`,
    )
    .run(id, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
}

describe('persist — migration 0006 graph_state round-trip', () => {
  it('migration adds graph_state column to workflows', () => {
    const info = pool.reader().prepare('PRAGMA table_info(workflows)').all() as Array<{
      name: string;
      type: string;
    }>;
    expect(info.find((c) => c.name === 'graph_state')).toMatchObject({
      name: 'graph_state',
      type: 'TEXT',
    });
  });

  it('readGraph returns null before any write', () => {
    insertWorkflow('wf-empty');
    expect(readGraph(pool, 'wf-empty')).toBeNull();
  });

  it('writeGraph followed by readGraph returns a deep-equal graph', () => {
    insertWorkflow('wf-1');
    const cfg = onceStageOnePhase();
    const graph = buildConfiguredGraph('wf-1', cfg);

    writeGraph(pool, 'wf-1', graph);
    const loaded = readGraph(pool, 'wf-1');

    expect(loaded).toEqual(graph);
  });

  it('writeGraph overwrites any prior value', () => {
    insertWorkflow('wf-1');
    const cfg = onceStageOnePhase();
    const g1 = buildConfiguredGraph('wf-1', cfg);
    writeGraph(pool, 'wf-1', g1);

    const g2 = { ...g1, finalizedAt: '2026-04-22T11:00:00Z' };
    writeGraph(pool, 'wf-1', g2);

    expect(readGraph(pool, 'wf-1')?.finalizedAt).toBe('2026-04-22T11:00:00Z');
  });
});
