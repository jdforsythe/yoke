import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDbPool } from '../../src/server/storage/db.js';
import type { DbPool } from '../../src/server/storage/db.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-db-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTmpDb(): { pool: DbPool; dbPath: string } {
  const dbPath = path.join(tmpDir, 'test.db');
  const pool = openDbPool(dbPath);
  return { pool, dbPath };
}

// ---------------------------------------------------------------------------
// PRAGMA verification — writer connection
// ---------------------------------------------------------------------------

describe('openDbPool — writer PRAGMAs', () => {
  it('journal_mode returns wal on the writer', () => {
    const { pool } = makeTmpDb();
    try {
      expect(pool.writer.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      pool.close();
    }
  });

  it('synchronous returns 1 (NORMAL) on the writer', () => {
    const { pool } = makeTmpDb();
    try {
      // NORMAL = 1 in the SQLite integer encoding
      expect(pool.writer.pragma('synchronous', { simple: true })).toBe(1);
    } finally {
      pool.close();
    }
  });

  it('foreign_keys returns 1 (ON) on the writer', () => {
    const { pool } = makeTmpDb();
    try {
      expect(pool.writer.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      pool.close();
    }
  });

  it('busy_timeout returns 5000 on the writer', () => {
    const { pool } = makeTmpDb();
    try {
      expect(pool.writer.pragma('busy_timeout', { simple: true })).toBe(5000);
    } finally {
      pool.close();
    }
  });
});

// ---------------------------------------------------------------------------
// schema_migrations bootstrap — idempotency
// ---------------------------------------------------------------------------

describe('openDbPool — schema_migrations bootstrap', () => {
  it('creates schema_migrations table on first open', () => {
    const { pool } = makeTmpDb();
    try {
      const row = pool.writer
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
        )
        .get();
      expect(row).toBeDefined();
    } finally {
      pool.close();
    }
  });

  it('schema_migrations has version (PK) and applied_at columns', () => {
    const { pool } = makeTmpDb();
    try {
      // Insert and re-read to confirm column contract
      pool.writer
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(1, new Date().toISOString());
      const row = pool.writer
        .prepare('SELECT version, applied_at FROM schema_migrations WHERE version = 1')
        .get() as { version: number; applied_at: string } | undefined;
      expect(row?.version).toBe(1);
      expect(typeof row?.applied_at).toBe('string');
    } finally {
      pool.close();
    }
  });

  it('opening an already-migrated database is a no-op (idempotent)', () => {
    const { dbPath, pool: pool1 } = makeTmpDb();
    pool1.close();
    // Second open: schema_migrations already exists — must not throw
    const pool2 = openDbPool(dbPath);
    try {
      const row = pool2.writer
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
        )
        .get();
      expect(row).toBeDefined();
    } finally {
      pool2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Read-only connections — enforcement at connection level
// ---------------------------------------------------------------------------

describe('openDbPool — reader()', () => {
  it('reader() returns the same connection on repeated calls', () => {
    const { pool } = makeTmpDb();
    try {
      expect(pool.reader()).toBe(pool.reader());
    } finally {
      pool.close();
    }
  });

  it('reader has busy_timeout=5000', () => {
    const { pool } = makeTmpDb();
    try {
      expect(pool.reader().pragma('busy_timeout', { simple: true })).toBe(5000);
    } finally {
      pool.close();
    }
  });

  it('reader has foreign_keys=ON', () => {
    const { pool } = makeTmpDb();
    try {
      expect(pool.reader().pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      pool.close();
    }
  });

  it('reader cannot execute DDL write (CREATE TABLE throws SQLITE_READONLY)', () => {
    const { pool } = makeTmpDb();
    try {
      expect(() => {
        pool.reader().exec('CREATE TABLE forbidden (id INTEGER)');
      }).toThrow();
    } finally {
      pool.close();
    }
  });

  it('reader cannot execute DML write (INSERT throws SQLITE_READONLY)', () => {
    const { pool } = makeTmpDb();
    try {
      expect(() => {
        pool
          .reader()
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
          )
          .run(99, new Date().toISOString());
      }).toThrow();
    } finally {
      pool.close();
    }
  });

  it('reader can execute SELECT (read is not blocked)', () => {
    const { pool } = makeTmpDb();
    try {
      expect(() => {
        pool.reader().prepare('SELECT 1 AS n').get();
      }).not.toThrow();
    } finally {
      pool.close();
    }
  });
});

// ---------------------------------------------------------------------------
// PRAGMAs applied on every connection open — not a once-per-process singleton
// ---------------------------------------------------------------------------

describe('openDbPool — PRAGMAs set on every open', () => {
  it('a second pool on the same file has journal_mode=wal on writer', () => {
    const { dbPath, pool: pool1 } = makeTmpDb();
    pool1.close();
    const pool2 = openDbPool(dbPath);
    try {
      expect(pool2.writer.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      pool2.close();
    }
  });

  it('a second pool reader has busy_timeout=5000', () => {
    const { dbPath, pool: pool1 } = makeTmpDb();
    pool1.close();
    const pool2 = openDbPool(dbPath);
    try {
      expect(pool2.reader().pragma('busy_timeout', { simple: true })).toBe(5000);
    } finally {
      pool2.close();
    }
  });

  it('a second pool writer has foreign_keys=ON', () => {
    const { dbPath, pool: pool1 } = makeTmpDb();
    pool1.close();
    const pool2 = openDbPool(dbPath);
    try {
      expect(pool2.writer.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      pool2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// DbPool.close()
// ---------------------------------------------------------------------------

describe('openDbPool — close()', () => {
  it('close() marks the writer connection as closed', () => {
    const { pool } = makeTmpDb();
    pool.close();
    expect(pool.writer.open).toBe(false);
  });
});
