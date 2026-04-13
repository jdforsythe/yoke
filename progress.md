# Yoke — Build Progress

## feat-db-setup (2026-04-12)

Implemented `src/server/storage/db.ts` — the `better-sqlite3` connection pool
that forms the storage foundation for Yoke. `openDbPool(dbPath)` opens a single
writer connection with all four PRAGMAs (`busy_timeout=5000` first, then
`journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`), bootstraps the
`schema_migrations` table with `CREATE TABLE IF NOT EXISTS` (idempotent on
re-open), then opens a separate read-only reader connection with `{
readonly: true }` (enforced at the connection level, not by convention) and
applies `busy_timeout` and `foreign_keys` to it. The module exports only the
`openDbPool` factory and the `DbPool` interface — no module-level singleton.
Added `better-sqlite3` + `@types/better-sqlite3` to package.json. 17
integration tests in `tests/storage/db.test.ts` cover every acceptance
criterion; all 48 tests pass, `tsc --noEmit` clean.

## feat-db-schema (2026-04-12)

Implemented `src/server/storage/migrations/0001_core_tables.sql` — DDL for all
seven core tables (workflows, items, sessions, events, artifact_writes,
pending_attention, prepost_runs) with all indexes and FK semantics exactly as
specified in `docs/design/schemas/sqlite-schema.sql`. The partial index
`idx_pending_attention_open` on `pending_attention(workflow_id) WHERE
acknowledged_at IS NULL` is present and verified by EXPLAIN QUERY PLAN in tests.
All FK ON DELETE CASCADE relationships cascade correctly from workflow deletion;
SET NULL is applied where specified (sessions.item_id, events.item_id,
events.session_id, prepost_runs.session_id, prepost_runs.item_id). The
`prepost_runs.when_phase` CHECK constraint (pre|post) is enforced by SQLite.
`src/server/storage/migrate.ts` provides the `applyMigrations(writer,
migrationsDir)` forward-only runner: skips already-applied versions, wraps each
migration in a transaction, records the version in schema_migrations on success.
42 new integration tests in `tests/storage/schema.test.ts`; all 90 tests pass,
`tsc --noEmit` clean.

## feat-db-migrations (2026-04-12)

Completed the forward-only migrations runner in `src/server/storage/migrate.ts`.
The existing `applyMigrations` skeleton (from feat-db-schema) already handled
discovery, transaction wrapping, and idempotent skip; this session added the two
missing regression guards: (1) a pre-loop RC-3 check that throws if
`schema_migrations` contains a version higher than the highest known file — a
forward-only invariant protecting against deleted or misplaced migration
directories; (2) a per-file AC-3 check that throws when an unapplied file has a
version lower than the highest already-applied version, naming both version
numbers in the error message. The sort comparator was made explicitly numeric
(`parseInt` subtraction) rather than lexicographic to satisfy RC-2. A dedicated
`tests/storage/migrate.test.ts` file (18 integration tests) covers all five
acceptance criteria (AC-1..AC-5) and the three relevant review criteria
(RC-2..RC-4); all 108 tests pass, `tsc --noEmit` clean.

## feat-db-transaction (2026-04-12)

Added `pool.transaction<T>(fn)` to the `DbPool` interface and implemented it in
`openDbPool`. The implementation is a single line: `writer.transaction(fn)(writer)`.
`better-sqlite3` handles BEGIN/COMMIT/ROLLBACK internally; if `fn` throws, it rolls
back and re-throws the original exception without wrapping. There is no catch block
in the wrapper — RC-1 is satisfied structurally, not by convention. The wrapper is
injected via `DbPool` (RC-3); no module-level transaction state exists. `fn` receives
`Database.Database` and returns `T`; the outer call returns `T` (AC-5, verified by
`tsc --noEmit`). 15 integration tests in `tests/storage/transaction.test.ts` cover
AC-1 (two-table write atomic after simulated mid-transaction crash, successful
commit, rollback + re-use), AC-2 (same Error instance re-thrown, no message
augmentation, non-Error throws pass through), AC-3 (reader cannot see uncommitted
WAL writes; sees them post-commit; sees nothing after rollback), and AC-5 (typed
return value, fn receives the writer connection). All 123 tests pass;
`tsc --noEmit` clean.

## feat-config-loader (2026-04-12)

Implemented the synchronous `.yoke.yml` config loader in full. The feature
comprises four new TypeScript modules: `src/shared/types/config.ts` (RawConfig
and ResolvedConfig type definitions, derived from the JSON schema), `src/server/
config/errors.ts` (ConfigLoadError with a discriminated `kind` field for
structured error handling), `src/server/config/resolve.ts` (pure, no-I/O path
resolver that deep-clones the raw config and converts all config-relative paths
to absolute using structuredClone + path.resolve), and `src/server/config/
loader.ts` (the synchronous entry point: readFileSync → yaml.parse → version
pin check → AJV compile/validate → resolveConfig). The project skeleton
(package.json, tsconfig.json, vitest.config.ts, updated .gitignore) was also
created from scratch as no Node project existed. All 31 tests pass; tsc
--noEmit clean.
