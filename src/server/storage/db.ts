import Database from 'better-sqlite3';

export interface DbPool {
  readonly writer: Database.Database;
  reader(): Database.Database;
  close(): void;
}

/**
 * PRAGMAs applied to the writer connection.
 * busy_timeout is first so it protects even the schema_migrations bootstrap
 * from SQLITE_BUSY before migrations run.
 */
function applyWriterPragmas(db: Database.Database): void {
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
}

/**
 * PRAGMAs applied to read-only connections.
 * journal_mode is already WAL (inherited from the database file written by
 * the writer); attempting to set it on a readonly connection is skipped to
 * avoid a potential SQLITE_READONLY error on some SQLite builds.
 * synchronous is omitted for the same reason — readers don't fsync writes.
 */
function applyReaderPragmas(db: Database.Database): void {
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
}

/**
 * Creates the schema_migrations bootstrap table idempotently.
 * Uses CREATE TABLE IF NOT EXISTS so a second call on an already-migrated
 * database is a no-op.
 */
function bootstrapMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

/**
 * Opens the database at dbPath and returns a DbPool.
 *
 * - writer: single read-write connection with all four PRAGMAs set.
 * - reader(): returns a pre-opened read-only connection; enforced at the
 *   connection level via { readonly: true }, not by convention.
 * - close(): closes both connections.
 *
 * No module-level singleton is exported. Callers must inject this pool.
 */
export function openDbPool(dbPath: string): DbPool {
  const writer = new Database(dbPath);
  applyWriterPragmas(writer);         // busy_timeout set BEFORE migrations
  bootstrapMigrationsTable(writer);

  const readerConn = new Database(dbPath, { readonly: true });
  applyReaderPragmas(readerConn);

  return {
    writer,
    reader(): Database.Database {
      return readerConn;
    },
    close(): void {
      readerConn.close();
      writer.close();
    },
  };
}
