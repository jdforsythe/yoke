/**
 * Integration tests for migrate.ts — feat-db-migrations acceptance and review criteria.
 *
 * AC-1  Fresh DB applies a migration file and records the version in schema_migrations.
 * AC-2  Running on a DB where that version is already recorded skips it, emits no error.
 * AC-3  A .sql file numbered lower than the highest applied version panics with a
 *       message naming both versions.
 * AC-4  A migration with a SQL syntax error rolls back completely; schema_migrations
 *       is not updated for that version.
 * AC-5  Migrations are applied in numeric order regardless of filesystem readdir order.
 *
 * RC-2  Version comparison is numeric (version 10 sorts after version 9).
 * RC-3  Runner refuses to apply if schema_migrations contains a version higher than
 *       any known file (forward-only guard).
 * RC-4  No migration file is executed more than once per database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyMigrations } from '../../src/server/storage/migrate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations ' +
      '(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  return db;
}

function makeDir(parent: string, name: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSql(dir: string, filename: string, sql: string): void {
  fs.writeFileSync(path.join(dir, filename), sql, 'utf-8');
}

function appliedVersions(db: Database.Database): number[] {
  return (
    db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as {
      version: number;
    }[]
  ).map((r) => r.version);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-migrate-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC-1: Fresh DB applies migration and records version
// ---------------------------------------------------------------------------

describe('AC-1: fresh DB applies migration and records version', () => {
  it('applies 0001 and records version 1 in schema_migrations', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    writeSql(migrDir, '0001_initial.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);');

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    applyMigrations(db, migrDir);

    const row = db
      .prepare('SELECT version FROM schema_migrations WHERE version = 1')
      .get() as { version: number } | undefined;
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t1'")
      .get();
    db.close();

    expect(row?.version).toBe(1);
    expect(tableExists).toBeDefined();
  });

  it('applies multiple migrations on a fresh DB', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    writeSql(migrDir, '0001_t1.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);');
    writeSql(migrDir, '0002_t2.sql', 'CREATE TABLE t2 (id INTEGER PRIMARY KEY);');
    writeSql(migrDir, '0003_t3.sql', 'CREATE TABLE t3 (id INTEGER PRIMARY KEY);');

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    applyMigrations(db, migrDir);

    expect(appliedVersions(db)).toEqual([1, 2, 3]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// AC-2: Already-applied versions are skipped
// ---------------------------------------------------------------------------

describe('AC-2: already-applied versions are skipped without error', () => {
  it('calling applyMigrations twice on the same DB is idempotent', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    writeSql(migrDir, '0001_t1.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);');

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    applyMigrations(db, migrDir);

    expect(() => applyMigrations(db, migrDir)).not.toThrow();
    expect(appliedVersions(db)).toHaveLength(1);
    db.close();
  });

  it('only applies newly added migration on second call', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    writeSql(migrDir, '0001_t1.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);');
    writeSql(migrDir, '0002_t2.sql', 'CREATE TABLE t2 (id INTEGER PRIMARY KEY);');

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    applyMigrations(db, migrDir); // applies 0001 and 0002

    writeSql(migrDir, '0003_t3.sql', 'CREATE TABLE t3 (id INTEGER PRIMARY KEY);');
    applyMigrations(db, migrDir); // should skip 0001, 0002; apply 0003

    expect(appliedVersions(db)).toEqual([1, 2, 3]);
    db.close();
  });

  it('no migration SQL is re-executed on repeated calls', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    // If CREATE TABLE were executed twice, it would throw "table already exists"
    writeSql(migrDir, '0001_t1.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);');

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    applyMigrations(db, migrDir);

    // Second call must not re-run the CREATE TABLE statement
    expect(() => applyMigrations(db, migrDir)).not.toThrow();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// AC-3: Panic when file version < highest applied version
// ---------------------------------------------------------------------------

describe('AC-3: throws when migration file has version lower than highest applied', () => {
  it('throws with a message naming both the file version and the max applied version', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    // Apply only version 2 first
    writeSql(migrDir, '0002_t2.sql', 'CREATE TABLE t2 (id INTEGER PRIMARY KEY);');

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    applyMigrations(db, migrDir); // DB now has version 2 applied

    // Retroactively add version 1 — regression
    writeSql(migrDir, '0001_t1.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);');

    let error: Error | undefined;
    try {
      applyMigrations(db, migrDir);
    } catch (e) {
      error = e as Error;
    }
    db.close();

    expect(error).toBeDefined();
    expect(error!.message).toContain('version 1'); // file version
    expect(error!.message).toContain('version 2'); // max applied
  });

  it('error message names the specific retroactive file and the highest applied version', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    writeSql(migrDir, '0005_t5.sql', 'CREATE TABLE t5 (id INTEGER PRIMARY KEY);');

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    applyMigrations(db, migrDir); // DB now has version 5 applied

    // Retroactively add version 3
    writeSql(migrDir, '0003_t3.sql', 'CREATE TABLE t3 (id INTEGER PRIMARY KEY);');

    let error: Error | undefined;
    try {
      applyMigrations(db, migrDir);
    } catch (e) {
      error = e as Error;
    }
    db.close();

    expect(error).toBeDefined();
    expect(error!.message).toContain('version 3'); // retroactive file version
    expect(error!.message).toContain('version 5'); // max applied version
  });

  it('does not apply the retroactive file when regression is detected', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    writeSql(migrDir, '0003_t3.sql', 'CREATE TABLE t3 (id INTEGER PRIMARY KEY);');

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    applyMigrations(db, migrDir); // version 3 applied

    writeSql(migrDir, '0002_t2.sql', 'CREATE TABLE t2 (id INTEGER PRIMARY KEY);');

    try {
      applyMigrations(db, migrDir);
    } catch {
      // expected
    }

    // Version 2 must NOT have been inserted into schema_migrations
    expect(appliedVersions(db)).toEqual([3]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// AC-4: SQL syntax error causes complete rollback
// ---------------------------------------------------------------------------

describe('AC-4: SQL syntax error causes complete rollback', () => {
  it('failed migration is not recorded in schema_migrations', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    writeSql(migrDir, '0001_valid.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);');
    writeSql(migrDir, '0002_invalid.sql', 'THIS IS NOT VALID SQL!!!;');

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    // Both files discovered in one call: 0001 commits its own transaction,
    // then 0002 throws — the call propagates the error.
    expect(() => applyMigrations(db, migrDir)).toThrow();

    // 0001 committed before 0002 failed; only version 1 is recorded.
    expect(appliedVersions(db)).toEqual([1]);
    db.close();
  });

  it('table created in same migration as syntax error does not persist', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    // Migration creates a table then hits a syntax error in the same file
    writeSql(
      migrDir,
      '0001_partial.sql',
      'CREATE TABLE partial_tbl (id INTEGER PRIMARY KEY);\nINVALID SQL HERE;',
    );

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    expect(() => applyMigrations(db, migrDir)).toThrow();

    // The table must NOT exist — the transaction was rolled back
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='partial_tbl'")
      .get();
    db.close();

    expect(tableExists).toBeUndefined();
  });

  it('schema_migrations is not updated for the failed version', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    writeSql(
      migrDir,
      '0001_bad.sql',
      'CREATE TABLE bad_tbl (id INTEGER PRIMARY KEY);\nBAD SYNTAX;',
    );

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    try {
      applyMigrations(db, migrDir);
    } catch {
      // expected
    }

    expect(appliedVersions(db)).toHaveLength(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// AC-5: Numeric ordering regardless of filesystem readdir order
// ---------------------------------------------------------------------------

describe('AC-5: migrations applied in numeric order regardless of readdir order', () => {
  it('applies 3 migrations in version order even if written to disk in reverse', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    // Write in reverse order to exercise sort independence from filesystem order
    writeSql(migrDir, '0003_t3.sql', 'CREATE TABLE t3 (id INTEGER PRIMARY KEY);');
    writeSql(migrDir, '0001_t1.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);');
    writeSql(migrDir, '0002_t2.sql', 'CREATE TABLE t2 (id INTEGER PRIMARY KEY);');

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    expect(() => applyMigrations(db, migrDir)).not.toThrow();

    expect(appliedVersions(db)).toEqual([1, 2, 3]);
    db.close();
  });

  it('a migration that depends on a prior table applies after that prior table exists', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    // 0002 inserts into t1 which is created by 0001 — ordering is critical
    writeSql(migrDir, '0002_insert.sql', "INSERT INTO t1 VALUES (42);");
    writeSql(migrDir, '0001_t1.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);');

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    expect(() => applyMigrations(db, migrDir)).not.toThrow();

    const row = db.prepare('SELECT id FROM t1').get() as { id: number } | undefined;
    db.close();
    expect(row?.id).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// RC-2: Numeric version comparison (version 10 sorts after version 9)
// ---------------------------------------------------------------------------

describe('RC-2: numeric version comparison — version 10 applied after version 9', () => {
  it('applies versions 1-10 in numeric order', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    for (let v = 1; v <= 10; v++) {
      const padded = String(v).padStart(4, '0');
      writeSql(migrDir, `${padded}_t${v}.sql`, `CREATE TABLE t${v} (id INTEGER PRIMARY KEY);`);
    }

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    applyMigrations(db, migrDir);

    const versions = appliedVersions(db);
    db.close();

    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Version 10 must appear after version 9 (numeric, not lexicographic)
    expect(versions.indexOf(10)).toBeGreaterThan(versions.indexOf(9));
  });
});

// ---------------------------------------------------------------------------
// RC-3: Forward-only guard — schema_migrations version > max known file version
// ---------------------------------------------------------------------------

describe('RC-3: refuses to apply when schema_migrations has version higher than any known file', () => {
  it('throws naming the max DB version and max file version', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    writeSql(migrDir, '0001_t1.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);');
    writeSql(migrDir, '0002_t2.sql', 'CREATE TABLE t2 (id INTEGER PRIMARY KEY);');

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    // Simulate a DB that had version 5 applied (files were since deleted/moved)
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (5, '2026-01-01T00:00:00Z')",
    ).run();

    let error: Error | undefined;
    try {
      applyMigrations(db, migrDir);
    } catch (e) {
      error = e as Error;
    }
    db.close();

    expect(error).toBeDefined();
    expect(error!.message).toContain('version 5'); // DB max
    expect(error!.message).toContain('version 2'); // file max
  });

  it('throws when migrations directory is empty but DB has applied versions', () => {
    const migrDir = makeDir(tmpDir, 'empty-migrations');
    // no files

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-01-01T00:00:00Z')",
    ).run();

    let error: Error | undefined;
    try {
      applyMigrations(db, migrDir);
    } catch (e) {
      error = e as Error;
    }
    db.close();

    expect(error).toBeDefined();
    expect(error!.message).toContain('version 1');
  });

  it('does not throw when max DB version equals max file version', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    writeSql(migrDir, '0001_t1.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);');

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    applyMigrations(db, migrDir); // version 1 applied, max file version = 1

    // Calling again: maxApplied(1) == maxFileVersion(1) — no RC-3 error
    expect(() => applyMigrations(db, migrDir)).not.toThrow();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// RC-4: No migration executed more than once per database
// ---------------------------------------------------------------------------

describe('RC-4: no migration executed more than once', () => {
  it('schema_migrations has exactly one row per version after N calls', () => {
    const migrDir = makeDir(tmpDir, 'migrations');
    writeSql(migrDir, '0001_t1.sql', 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);');

    const db = makeTestDb(path.join(tmpDir, 'test.db'));
    for (let i = 0; i < 5; i++) {
      applyMigrations(db, migrDir);
    }

    const rows = db
      .prepare('SELECT version FROM schema_migrations WHERE version = 1')
      .all();
    db.close();

    expect(rows).toHaveLength(1);
  });
});
