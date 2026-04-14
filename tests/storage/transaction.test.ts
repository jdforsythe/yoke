/**
 * Integration tests for DbPool.transaction<T>.
 *
 * Acceptance criteria:
 *   AC-1  A transaction writing to two tables is atomic: either both rows are
 *         visible or neither is after a simulated mid-transaction crash.
 *   AC-2  An exception thrown inside fn causes rollback; the exception is
 *         re-thrown to the caller without wrapping.
 *   AC-3  Concurrent reader connections do not see partial writes during a
 *         transaction.
 *   AC-5  fn receives a typed Database.Database and returns T; the outer call
 *         returns T. (Verified by tsc --noEmit; runtime check confirms value.)
 *
 * Review criteria:
 *   RC-1  No catch block inside the wrapper that swallows exceptions.
 *         (Structural: the implementation is trivially inspectable. Tests
 *         verify the observable contract: same exception object re-thrown.)
 *   RC-3  The wrapper is not a global; it is injected via DbPool.
 *         (Structural: no module-level transaction state; pool.transaction is
 *         called through the injected pool, not via a module singleton.)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import type { DbPool } from '../../src/server/storage/db.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-txn-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makePool(): DbPool {
  const dbPath = path.join(tmpDir, `${Math.random().toString(36).slice(2)}.db`);
  const pool = openDbPool(dbPath);
  applyMigrations(pool.writer, migrationsDir);
  return pool;
}

/** Minimal workflow row for FK-safe inserts into child tables. */
function insertWorkflow(pool: DbPool, id: string): void {
  pool.writer
    .prepare(
      `INSERT INTO workflows
         (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, 'test', '{}', '[]', '{}', 'pending', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    )
    .run(id);
}

/** Count rows in a table from a given connection. */
function countRows(pool: DbPool, table: 'workflows' | 'events', useReader = false): number {
  const conn = useReader ? pool.reader() : pool.writer;
  const row = conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// AC-5 — Typed return value
// ---------------------------------------------------------------------------

describe('DbPool.transaction — typed return value (AC-5)', () => {
  it('returns the value produced by fn', () => {
    const pool = makePool();
    try {
      const result = pool.transaction(() => 42);
      expect(result).toBe(42);
    } finally {
      pool.close();
    }
  });

  it('returns a complex value produced by fn', () => {
    const pool = makePool();
    try {
      const result = pool.transaction((db) => {
        const row = db.prepare('SELECT 1 AS x').get() as { x: number };
        return { computed: row.x + 1 };
      });
      expect(result).toEqual({ computed: 2 });
    } finally {
      pool.close();
    }
  });

  it('fn receives the writer Database connection (AC-5)', () => {
    const pool = makePool();
    try {
      pool.transaction((db) => {
        // If db is the writer, we can insert a row without it throwing.
        db.prepare(
          `INSERT INTO workflows
             (id, name, spec, pipeline, config, status, created_at, updated_at)
           VALUES ('wf-typecheck', 'test', '{}', '[]', '{}', 'pending',
                   '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        ).run();
      });
      // Row committed — verify it is visible via writer.
      const row = pool.writer
        .prepare("SELECT id FROM workflows WHERE id = 'wf-typecheck'")
        .get();
      expect(row).toBeDefined();
    } finally {
      pool.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2 — Exception re-throw without wrapping
// ---------------------------------------------------------------------------

describe('DbPool.transaction — exception re-throw (AC-2)', () => {
  it('re-throws a plain Error thrown inside fn', () => {
    const pool = makePool();
    try {
      expect(() =>
        pool.transaction(() => {
          throw new Error('sentinel-error');
        }),
      ).toThrow('sentinel-error');
    } finally {
      pool.close();
    }
  });

  it('re-throws the exact same Error instance (not a new wrapper)', () => {
    const pool = makePool();
    try {
      const original = new Error('exact-instance');
      let caught: unknown;
      try {
        pool.transaction(() => {
          throw original;
        });
      } catch (e) {
        caught = e;
      }
      // Must be the same object reference — better-sqlite3 does not wrap.
      expect(caught).toBe(original);
    } finally {
      pool.close();
    }
  });

  it('re-throws a non-Error thrown value (string)', () => {
    const pool = makePool();
    try {
      let caught: unknown;
      try {
        pool.transaction(() => {
          throw 'string-throw';
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBe('string-throw');
    } finally {
      pool.close();
    }
  });

  it('exception message is not augmented with rollback information', () => {
    const pool = makePool();
    try {
      let caughtMessage = '';
      try {
        pool.transaction(() => {
          throw new Error('bare-message');
        });
      } catch (e) {
        caughtMessage = (e as Error).message;
      }
      expect(caughtMessage).toBe('bare-message');
    } finally {
      pool.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-1 — Atomicity: two-table write
// ---------------------------------------------------------------------------

describe('DbPool.transaction — atomicity (AC-1)', () => {
  it('commits both rows when fn succeeds', () => {
    const pool = makePool();
    try {
      pool.transaction((db) => {
        db.prepare(
          `INSERT INTO workflows
             (id, name, spec, pipeline, config, status, created_at, updated_at)
           VALUES ('wf-ok', 'test', '{}', '[]', '{}', 'pending',
                   '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        ).run();
        db.prepare(
          `INSERT INTO events (ts, workflow_id, event_type, level, message)
           VALUES ('2026-01-01T00:00:00Z', 'wf-ok', 'test_event', 'info', 'hello')`,
        ).run();
      });
      expect(countRows(pool, 'workflows')).toBe(1);
      expect(countRows(pool, 'events')).toBe(1);
    } finally {
      pool.close();
    }
  });

  it('rolls back BOTH rows when fn throws after writing to two tables (simulated crash)', () => {
    const pool = makePool();
    try {
      const wfId = 'wf-crash';
      expect(() =>
        pool.transaction((db) => {
          // Write 1: insert workflow row.
          db.prepare(
            `INSERT INTO workflows
               (id, name, spec, pipeline, config, status, created_at, updated_at)
             VALUES (?, 'test', '{}', '[]', '{}', 'pending',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
          ).run(wfId);
          // Write 2: insert event row referencing the workflow.
          db.prepare(
            `INSERT INTO events (ts, workflow_id, event_type, level, message)
             VALUES ('2026-01-01T00:00:00Z', ?, 'test_event', 'info', 'mid-crash')`,
          ).run(wfId);
          // Simulated mid-transaction crash.
          throw new Error('simulated-crash');
        }),
      ).toThrow('simulated-crash');

      // Neither row must be visible.
      expect(countRows(pool, 'workflows')).toBe(0);
      expect(countRows(pool, 'events')).toBe(0);
    } finally {
      pool.close();
    }
  });

  it('rolls back the first write when fn throws before the second write', () => {
    const pool = makePool();
    try {
      expect(() =>
        pool.transaction((db) => {
          db.prepare(
            `INSERT INTO workflows
               (id, name, spec, pipeline, config, status, created_at, updated_at)
             VALUES ('wf-partial', 'test', '{}', '[]', '{}', 'pending',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
          ).run();
          throw new Error('abort-after-first-write');
        }),
      ).toThrow('abort-after-first-write');

      expect(countRows(pool, 'workflows')).toBe(0);
    } finally {
      pool.close();
    }
  });

  it('a second successful transaction after a rolled-back one starts clean', () => {
    const pool = makePool();
    try {
      // First transaction: fails.
      expect(() =>
        pool.transaction((db) => {
          db.prepare(
            `INSERT INTO workflows
               (id, name, spec, pipeline, config, status, created_at, updated_at)
             VALUES ('wf-a', 'test', '{}', '[]', '{}', 'pending',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
          ).run();
          throw new Error('first-fail');
        }),
      ).toThrow('first-fail');

      // Second transaction: succeeds.
      pool.transaction((db) => {
        db.prepare(
          `INSERT INTO workflows
             (id, name, spec, pipeline, config, status, created_at, updated_at)
           VALUES ('wf-b', 'test', '{}', '[]', '{}', 'pending',
                   '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        ).run();
      });

      // Only wf-b must exist.
      expect(countRows(pool, 'workflows')).toBe(1);
      const row = pool.writer
        .prepare("SELECT id FROM workflows WHERE id = 'wf-b'")
        .get();
      expect(row).toBeDefined();
    } finally {
      pool.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3 — Reader isolation: partial writes not visible during transaction
// ---------------------------------------------------------------------------

describe('DbPool.transaction — reader isolation (AC-3)', () => {
  it('reader cannot see an uncommitted workflow row during a transaction', () => {
    const pool = makePool();
    try {
      pool.transaction((db) => {
        // Insert a row inside the transaction.
        db.prepare(
          `INSERT INTO workflows
             (id, name, spec, pipeline, config, status, created_at, updated_at)
           VALUES ('wf-iso', 'test', '{}', '[]', '{}', 'pending',
                   '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        ).run();

        // The reader (separate connection, WAL snapshot) must not see it yet.
        const readerCount = countRows(pool, 'workflows', /* useReader */ true);
        expect(readerCount).toBe(0);
      });

      // After commit the reader must see it.
      const readerCount = countRows(pool, 'workflows', /* useReader */ true);
      expect(readerCount).toBe(1);
    } finally {
      pool.close();
    }
  });

  it('reader cannot see either uncommitted row when transaction has two writes', () => {
    const pool = makePool();
    try {
      pool.transaction((db) => {
        db.prepare(
          `INSERT INTO workflows
             (id, name, spec, pipeline, config, status, created_at, updated_at)
           VALUES ('wf-2r', 'test', '{}', '[]', '{}', 'pending',
                   '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        ).run();
        db.prepare(
          `INSERT INTO events (ts, workflow_id, event_type, level, message)
           VALUES ('2026-01-01T00:00:00Z', 'wf-2r', 'state_change', 'info', 'x')`,
        ).run();

        // Neither table visible to reader mid-transaction.
        expect(countRows(pool, 'workflows', true)).toBe(0);
        expect(countRows(pool, 'events', true)).toBe(0);
      });

      // Both visible after commit.
      expect(countRows(pool, 'workflows', true)).toBe(1);
      expect(countRows(pool, 'events', true)).toBe(1);
    } finally {
      pool.close();
    }
  });

  it('reader sees no rows after a two-write transaction is rolled back', () => {
    const pool = makePool();
    try {
      expect(() =>
        pool.transaction((db) => {
          db.prepare(
            `INSERT INTO workflows
               (id, name, spec, pipeline, config, status, created_at, updated_at)
             VALUES ('wf-rb', 'test', '{}', '[]', '{}', 'pending',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
          ).run();
          db.prepare(
            `INSERT INTO events (ts, workflow_id, event_type, level, message)
             VALUES ('2026-01-01T00:00:00Z', 'wf-rb', 'state_change', 'info', 'x')`,
          ).run();
          throw new Error('rollback-trigger');
        }),
      ).toThrow('rollback-trigger');

      // Reader sees nothing after rollback.
      expect(countRows(pool, 'workflows', true)).toBe(0);
      expect(countRows(pool, 'events', true)).toBe(0);
    } finally {
      pool.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Nested transaction: better-sqlite3 uses savepoints for nested calls
// ---------------------------------------------------------------------------

describe('DbPool.transaction — nested call via db.transaction (better-sqlite3 savepoint)', () => {
  it('nested transaction inside outer transaction commits as part of outer', () => {
    const pool = makePool();
    try {
      pool.transaction((db) => {
        insertWorkflow(pool, 'wf-outer');
        // better-sqlite3 automatically uses savepoints for nested transactions.
        db.transaction(() => {
          db.prepare(
            `INSERT INTO events (ts, workflow_id, event_type, level, message)
             VALUES ('2026-01-01T00:00:00Z', 'wf-outer', 'nested', 'info', 'inner')`,
          ).run();
        })();
      });

      expect(countRows(pool, 'workflows')).toBe(1);
      expect(countRows(pool, 'events')).toBe(1);
    } finally {
      pool.close();
    }
  });
});
