import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Applies forward-only numbered SQL migration files from migrationsDir to the
 * writer connection.
 *
 * Conventions:
 *   - File names must match /^\d{4}_.*\.sql$/ (e.g. 0001_core_tables.sql).
 *   - Files are applied in lexicographic (version-number) order.
 *   - Already-applied versions (present in schema_migrations) are skipped.
 *   - Each migration is wrapped in a transaction; the version is recorded in
 *     schema_migrations on success. If the SQL fails the transaction rolls back
 *     and the error propagates to the caller.
 *
 * schema_migrations must already exist when this is called — bootstrapped by
 * openDbPool before migrations run.
 *
 * @throws {Error} if migrationsDir cannot be read, a SQL file cannot be read,
 *                 or a migration SQL statement fails.
 */
export function applyMigrations(
  writer: Database.Database,
  migrationsDir: string,
): void {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  const checkApplied = writer.prepare<[number]>(
    'SELECT version FROM schema_migrations WHERE version = ?',
  );
  const recordApplied = writer.prepare<[number, string]>(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  );

  for (const file of files) {
    const version = parseInt(file.slice(0, 4), 10);
    if (checkApplied.get(version) !== undefined) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    writer.transaction(() => {
      writer.exec(sql);
      recordApplied.run(version, new Date().toISOString());
    })();
  }
}
