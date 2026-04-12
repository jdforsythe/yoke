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
