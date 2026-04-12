import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Applies forward-only numbered SQL migration files from migrationsDir to the
 * writer connection.
 *
 * Conventions:
 *   - File names must match /^\d{4}_.*\.sql$/ (e.g. 0001_core_tables.sql).
 *   - Files are applied in ascending numeric version order (not lexicographic).
 *   - Already-applied versions (present in schema_migrations) are skipped.
 *   - Each migration is wrapped in a transaction; the version is recorded in
 *     schema_migrations on success. If the SQL fails the transaction rolls back
 *     and the error propagates to the caller.
 *
 * Guards:
 *   - Throws if schema_migrations contains a version higher than the highest
 *     known migration file (forward-only guard, RC-3).
 *   - Throws if a migration file has a version lower than the highest
 *     already-applied version and is not itself applied (regression guard, AC-3).
 *
 * schema_migrations must already exist when this is called — bootstrapped by
 * openDbPool before migrations run.
 *
 * @throws {Error} if migrationsDir cannot be read, a SQL file cannot be read,
 *                 a migration SQL statement fails, or a version regression is
 *                 detected.
 */
export function applyMigrations(
  writer: Database.Database,
  migrationsDir: string,
): void {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a.slice(0, 4), 10) - parseInt(b.slice(0, 4), 10));

  const fileVersions = files.map((f) => parseInt(f.slice(0, 4), 10));
  const maxFileVersion = fileVersions.reduce((max, v) => Math.max(max, v), 0);

  // Highest version recorded in schema_migrations (0 if table is empty).
  const maxRow = writer
    .prepare('SELECT COALESCE(MAX(version), 0) AS maxv FROM schema_migrations')
    .get() as { maxv: number };
  const maxApplied = maxRow.maxv;

  // RC-3: Forward-only guard. The database records a version for which no
  // migration file exists — a file was deleted or the wrong migrations
  // directory was used.
  if (maxApplied > maxFileVersion) {
    throw new Error(
      `schema regression: schema_migrations contains version ${maxApplied} but ` +
        `highest known migration file is version ${maxFileVersion}`,
    );
  }

  const checkApplied = writer.prepare<[number]>(
    'SELECT version FROM schema_migrations WHERE version = ?',
  );
  const recordApplied = writer.prepare<[number, string]>(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  );

  for (const file of files) {
    const version = parseInt(file.slice(0, 4), 10);

    if (checkApplied.get(version) !== undefined) continue;

    // AC-3: Regression guard. A file exists that was not part of the
    // migration sequence when the database was last migrated — applying it
    // now would insert a version below what the database already has,
    // violating forward-only semantics.
    if (version < maxApplied) {
      throw new Error(
        `schema regression: migration file ${file} has version ${version} which is ` +
          `lower than highest applied version ${maxApplied}`,
      );
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    writer.transaction(() => {
      writer.exec(sql);
      recordApplied.run(version, new Date().toISOString());
    })();
  }
}
