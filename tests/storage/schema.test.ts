/**
 * Integration tests for migration 0001_core_tables.sql and migrate.ts.
 *
 * Covers all feat-db-schema acceptance criteria:
 *   AC-1  All seven tables exist; PRAGMA table_info returns exact columns.
 *   AC-2  FK constraints enforced (nonexistent workflow_id raises FK error).
 *   AC-3  ON DELETE CASCADE propagates workflow deletion to all children.
 *   AC-4  Partial index idx_pending_attention_open present and used by EXPLAIN.
 *   AC-5  Column types are exactly TEXT or INTEGER — no VARCHAR anywhere.
 *   AC-6  No columns beyond what sqlite-schema.sql specifies.
 *
 * Also covers review criteria:
 *   RC-1  Partial index WHERE acknowledged_at IS NULL.
 *   RC-2  items.data is TEXT (opaque blob), not split columns.
 *   RC-3  prepost_runs.when_phase CHECK (pre|post) enforced.
 *   RC-4  sessions.parent_session_id FK references sessions(id).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../src/server/storage/migrate.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-schema-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDb(): Database.Database {
  const dbPath = path.join(tmpDir, `${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  applyMigrations(db, migrationsDir);
  return db;
}

function tableInfo(db: Database.Database, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

function colNames(db: Database.Database, table: string): string[] {
  return tableInfo(db, table).map((c) => c.name);
}

function colTypes(db: Database.Database, table: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of tableInfo(db, table)) out[c.name] = c.type;
  return out;
}

// Minimal valid workflow row
function insertWorkflow(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
     VALUES (?, 'wf', 'spec', '[]', '{}', 'pending', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(id);
}

function insertItem(db: Database.Database, id: string, workflowId: string): void {
  db.prepare(
    `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
     VALUES (?, ?, 'stage-1', '{}', 'pending', '2026-01-01T00:00:00Z')`,
  ).run(id, workflowId);
}

function insertSession(db: Database.Database, id: string, workflowId: string): void {
  db.prepare(
    `INSERT INTO sessions (id, workflow_id, stage, phase, agent_profile, started_at, status)
     VALUES (?, ?, 'stage-1', 'implement', 'default', '2026-01-01T00:00:00Z', 'running')`,
  ).run(id, workflowId);
}

// ---------------------------------------------------------------------------
// AC-1 — All seven tables exist; PRAGMA table_info returns exact columns
// ---------------------------------------------------------------------------

describe('AC-1: all seven tables present after migration 0001', () => {
  const tables = [
    'workflows',
    'items',
    'sessions',
    'events',
    'artifact_writes',
    'pending_attention',
    'prepost_runs',
  ] as const;

  for (const table of tables) {
    it(`table ${table} exists`, () => {
      const db = makeDb();
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table);
      db.close();
      expect(row).toBeDefined();
    });
  }

  it('workflows has exactly 12 columns', () => {
    const db = makeDb();
    const names = colNames(db, 'workflows');
    db.close();
    expect(names).toEqual([
      'id', 'name', 'spec', 'pipeline', 'config', 'status',
      'current_stage', 'worktree_path', 'branch_name', 'recovery_state',
      'created_at', 'updated_at',
    ]);
  });

  it('items has exactly 13 columns', () => {
    const db = makeDb();
    const names = colNames(db, 'items');
    db.close();
    expect(names).toEqual([
      'id', 'workflow_id', 'stage_id', 'data', 'status', 'current_phase',
      'depends_on', 'retry_count', 'retry_window_start',
      'created_by_session_id', 'last_updated_by_session_id',
      'blocked_reason', 'updated_at',
    ]);
  });

  it('sessions has exactly 22 columns', () => {
    const db = makeDb();
    const names = colNames(db, 'sessions');
    db.close();
    expect(names).toEqual([
      'id', 'workflow_id', 'item_id', 'parent_session_id',
      'stage', 'phase', 'agent_profile', 'pid', 'pgid',
      'started_at', 'ended_at', 'exit_code',
      'input_tokens', 'output_tokens',
      'cache_creation_input_tokens', 'cache_read_input_tokens',
      'raw_usage', 'session_log_path', 'status', 'status_flags',
      'last_event_at', 'last_event_type',
    ]);
  });

  it('events has exactly 12 columns', () => {
    const db = makeDb();
    const names = colNames(db, 'events');
    db.close();
    expect(names).toEqual([
      'id', 'ts', 'workflow_id', 'item_id', 'session_id',
      'stage', 'phase', 'attempt', 'event_type', 'level', 'message', 'extra',
    ]);
  });

  it('artifact_writes has exactly 5 columns', () => {
    const db = makeDb();
    const names = colNames(db, 'artifact_writes');
    db.close();
    expect(names).toEqual(['id', 'session_id', 'artifact_path', 'written_at', 'sha256']);
  });

  it('pending_attention has exactly 6 columns', () => {
    const db = makeDb();
    const names = colNames(db, 'pending_attention');
    db.close();
    expect(names).toEqual([
      'id', 'workflow_id', 'kind', 'payload', 'created_at', 'acknowledged_at',
    ]);
  });

  it('prepost_runs has exactly 15 columns', () => {
    const db = makeDb();
    const names = colNames(db, 'prepost_runs');
    db.close();
    expect(names).toEqual([
      'id', 'session_id', 'workflow_id', 'item_id',
      'stage', 'phase', 'when_phase', 'command_name', 'argv',
      'started_at', 'ended_at', 'exit_code',
      'action_taken', 'stdout_path', 'stderr_path',
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC-2 — FK constraints enforced
// ---------------------------------------------------------------------------

describe('AC-2: FK constraints enforced', () => {
  it('inserting item with nonexistent workflow_id raises FK error', () => {
    const db = makeDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
           VALUES ('item-1', 'no-such-workflow', 'stage-1', '{}', 'pending', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('inserting session with nonexistent workflow_id raises FK error', () => {
    const db = makeDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO sessions (id, workflow_id, stage, phase, agent_profile, started_at, status)
           VALUES ('sess-1', 'no-such-workflow', 's', 'p', 'default', '2026-01-01T00:00:00Z', 'running')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('inserting event with nonexistent workflow_id raises FK error', () => {
    const db = makeDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO events (ts, workflow_id, event_type, level, message)
           VALUES ('2026-01-01T00:00:00Z', 'no-such-wf', 'test', 'info', 'msg')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('inserting artifact_write with nonexistent session_id raises FK error', () => {
    const db = makeDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO artifact_writes (session_id, artifact_path, written_at, sha256)
           VALUES ('no-such-sess', '/a/b.ts', '2026-01-01T00:00:00Z', 'abc123')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('inserting pending_attention with nonexistent workflow_id raises FK error', () => {
    const db = makeDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
           VALUES ('no-such-wf', 'blocked_item', '{}', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('inserting prepost_run with nonexistent workflow_id raises FK error', () => {
    const db = makeDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO prepost_runs (workflow_id, stage, phase, when_phase, command_name, argv, started_at)
           VALUES ('no-such-wf', 's', 'p', 'pre', 'lint', '[]', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// AC-3 — ON DELETE CASCADE propagates workflow deletion
// ---------------------------------------------------------------------------

describe('AC-3: ON DELETE CASCADE from workflow', () => {
  it('deleting a workflow removes all child items, sessions, events, artifact_writes, pending_attention, prepost_runs', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf-1');
    insertItem(db, 'item-1', 'wf-1');
    insertSession(db, 'sess-1', 'wf-1');

    // event linked to workflow
    db.prepare(
      `INSERT INTO events (ts, workflow_id, event_type, level, message)
       VALUES ('2026-01-01T00:00:00Z', 'wf-1', 'test', 'info', 'hello')`,
    ).run();

    // artifact_write linked to session
    db.prepare(
      `INSERT INTO artifact_writes (session_id, artifact_path, written_at, sha256)
       VALUES ('sess-1', '/x.ts', '2026-01-01T00:00:00Z', 'sha')`,
    ).run();

    // pending_attention linked to workflow
    db.prepare(
      `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
       VALUES ('wf-1', 'blocked_item', '{}', '2026-01-01T00:00:00Z')`,
    ).run();

    // prepost_run linked to workflow
    db.prepare(
      `INSERT INTO prepost_runs (workflow_id, stage, phase, when_phase, command_name, argv, started_at)
       VALUES ('wf-1', 's', 'p', 'post', 'lint', '[]', '2026-01-01T00:00:00Z')`,
    ).run();

    // delete the workflow
    db.prepare(`DELETE FROM workflows WHERE id = 'wf-1'`).run();

    expect(db.prepare(`SELECT id FROM items WHERE workflow_id = 'wf-1'`).all()).toHaveLength(0);
    expect(db.prepare(`SELECT id FROM sessions WHERE workflow_id = 'wf-1'`).all()).toHaveLength(0);
    expect(db.prepare(`SELECT id FROM events WHERE workflow_id = 'wf-1'`).all()).toHaveLength(0);
    expect(
      db.prepare(`SELECT id FROM artifact_writes WHERE session_id = 'sess-1'`).all(),
    ).toHaveLength(0);
    expect(
      db.prepare(`SELECT id FROM pending_attention WHERE workflow_id = 'wf-1'`).all(),
    ).toHaveLength(0);
    expect(
      db.prepare(`SELECT id FROM prepost_runs WHERE workflow_id = 'wf-1'`).all(),
    ).toHaveLength(0);

    db.close();
  });

  it('sessions.item_id is SET NULL (not cascade) when item is deleted', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf-2');
    insertItem(db, 'item-2', 'wf-2');
    insertSession(db, 'sess-2', 'wf-2');

    // link session to item
    db.prepare(`UPDATE sessions SET item_id = 'item-2' WHERE id = 'sess-2'`).run();
    db.prepare(`DELETE FROM items WHERE id = 'item-2'`).run();

    const sess = db.prepare(`SELECT item_id FROM sessions WHERE id = 'sess-2'`).get() as
      | { item_id: string | null }
      | undefined;
    expect(sess).toBeDefined();
    expect(sess!.item_id).toBeNull();

    db.close();
  });
});

// ---------------------------------------------------------------------------
// AC-4 — Partial index idx_pending_attention_open present and used by EXPLAIN
// ---------------------------------------------------------------------------

describe('AC-4: partial index on pending_attention WHERE acknowledged_at IS NULL', () => {
  it('index idx_pending_attention_open exists in sqlite_master', () => {
    const db = makeDb();
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pending_attention_open'`,
      )
      .get();
    db.close();
    expect(row).toBeDefined();
  });

  it('EXPLAIN QUERY PLAN uses idx_pending_attention_open for WHERE acknowledged_at IS NULL', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf-eqp');

    // Insert one open and one acknowledged row
    db.prepare(
      `INSERT INTO pending_attention (workflow_id, kind, payload, created_at)
       VALUES ('wf-eqp', 'blocked_item', '{}', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO pending_attention (workflow_id, kind, payload, created_at, acknowledged_at)
       VALUES ('wf-eqp', 'crash_recovery_required', '{}', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')`,
    ).run();

    type EqpRow = { id: number; parent: number; notused: number; detail: string };
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM pending_attention
         WHERE workflow_id = ? AND acknowledged_at IS NULL`,
      )
      .all('wf-eqp') as EqpRow[];

    db.close();

    const detail = plan.map((r) => r.detail).join('\n');
    expect(detail).toMatch(/idx_pending_attention_open/i);
  });
});

// ---------------------------------------------------------------------------
// AC-5 — Column types are exactly TEXT or INTEGER (no VARCHAR)
// ---------------------------------------------------------------------------

describe('AC-5: column types are TEXT or INTEGER only', () => {
  const tables = [
    'workflows',
    'items',
    'sessions',
    'events',
    'artifact_writes',
    'pending_attention',
    'prepost_runs',
  ] as const;

  for (const table of tables) {
    it(`all columns in ${table} are TEXT or INTEGER`, () => {
      const db = makeDb();
      const types = colTypes(db, table);
      db.close();
      for (const [col, typ] of Object.entries(types)) {
        expect(['TEXT', 'INTEGER'], `column ${table}.${col} has type ${typ}`).toContain(typ);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// AC-6 — No columns beyond what sqlite-schema.sql specifies (already covered
//         by AC-1 exact column list assertions; this suite verifies count)
// ---------------------------------------------------------------------------

describe('AC-6: no extra columns in any table', () => {
  it('column counts match the schema exactly', () => {
    const db = makeDb();
    const counts: Record<string, number> = {
      workflows: 12,
      items: 13,
      sessions: 22,
      events: 12,
      artifact_writes: 5,
      pending_attention: 6,
      prepost_runs: 15,
    };
    for (const [table, expected] of Object.entries(counts)) {
      const actual = tableInfo(db, table).length;
      expect(actual, `${table} column count`).toBe(expected);
    }
    db.close();
  });
});

// ---------------------------------------------------------------------------
// RC-2 — items.data is TEXT (opaque blob)
// ---------------------------------------------------------------------------

describe('RC-2: items.data is TEXT', () => {
  it('items.data column has type TEXT', () => {
    const db = makeDb();
    const col = tableInfo(db, 'items').find((c) => c.name === 'data');
    db.close();
    expect(col?.type).toBe('TEXT');
  });
});

// ---------------------------------------------------------------------------
// RC-3 — prepost_runs.when_phase CHECK (pre|post) enforced
// ---------------------------------------------------------------------------

describe('RC-3: prepost_runs.when_phase CHECK constraint', () => {
  it('when_phase = pre is accepted', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf-pp');
    expect(() =>
      db
        .prepare(
          `INSERT INTO prepost_runs (workflow_id, stage, phase, when_phase, command_name, argv, started_at)
           VALUES ('wf-pp', 's', 'p', 'pre', 'lint', '[]', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).not.toThrow();
    db.close();
  });

  it('when_phase = post is accepted', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf-pp2');
    expect(() =>
      db
        .prepare(
          `INSERT INTO prepost_runs (workflow_id, stage, phase, when_phase, command_name, argv, started_at)
           VALUES ('wf-pp2', 's', 'p', 'post', 'lint', '[]', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).not.toThrow();
    db.close();
  });

  it('when_phase = both is rejected by CHECK constraint', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf-pp3');
    expect(() =>
      db
        .prepare(
          `INSERT INTO prepost_runs (workflow_id, stage, phase, when_phase, command_name, argv, started_at)
           VALUES ('wf-pp3', 's', 'p', 'both', 'lint', '[]', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint/i);
    db.close();
  });

  it('when_phase = empty string is rejected by CHECK constraint', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf-pp4');
    expect(() =>
      db
        .prepare(
          `INSERT INTO prepost_runs (workflow_id, stage, phase, when_phase, command_name, argv, started_at)
           VALUES ('wf-pp4', 's', 'p', '', 'lint', '[]', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint/i);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// RC-4 — sessions.parent_session_id FK references sessions(id)
// ---------------------------------------------------------------------------

describe('RC-4: sessions.parent_session_id FK references sessions(id)', () => {
  it('inserting a session with nonexistent parent_session_id raises FK error', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf-ps');
    expect(() =>
      db
        .prepare(
          `INSERT INTO sessions (id, workflow_id, stage, phase, agent_profile, started_at, status, parent_session_id)
           VALUES ('child-sess', 'wf-ps', 's', 'p', 'default', '2026-01-01T00:00:00Z', 'running', 'no-such-parent')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('inserting a session with a valid parent_session_id succeeds', () => {
    const db = makeDb();
    insertWorkflow(db, 'wf-ps2');
    insertSession(db, 'parent-sess', 'wf-ps2');
    expect(() =>
      db
        .prepare(
          `INSERT INTO sessions (id, workflow_id, stage, phase, agent_profile, started_at, status, parent_session_id)
           VALUES ('child-sess2', 'wf-ps2', 's', 'p', 'default', '2026-01-01T00:00:00Z', 'running', 'parent-sess')`,
        )
        .run(),
    ).not.toThrow();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// migrate.ts — runner behavior
// ---------------------------------------------------------------------------

describe('applyMigrations — runner behavior', () => {
  it('records version 1 in schema_migrations after applying 0001', () => {
    const db = makeDb();
    const row = db
      .prepare('SELECT version FROM schema_migrations WHERE version = 1')
      .get() as { version: number } | undefined;
    db.close();
    expect(row?.version).toBe(1);
  });

  it('calling applyMigrations twice is idempotent (no duplicate row, no error)', () => {
    const db = makeDb();
    // makeDb already called applyMigrations once; call again
    expect(() => applyMigrations(db, migrationsDir)).not.toThrow();
    const rows = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').all();
    db.close();
    expect(rows).toHaveLength(1);
  });

  it('non-sql files in migrations dir are ignored', () => {
    // Make a fresh DB pointing at a copy of migrations dir that has an extra file
    const customDir = fs.mkdtempSync(path.join(tmpDir, 'custom-migrations-'));
    fs.copyFileSync(
      path.join(migrationsDir, '0001_core_tables.sql'),
      path.join(customDir, '0001_core_tables.sql'),
    );
    fs.writeFileSync(path.join(customDir, 'README.md'), '# ignore me');

    const dbPath = path.join(tmpDir, 'custom.db');
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    expect(() => applyMigrations(db, customDir)).not.toThrow();
    const row = db
      .prepare('SELECT version FROM schema_migrations WHERE version = 1')
      .get() as { version: number } | undefined;
    db.close();
    expect(row?.version).toBe(1);
  });
});
