# Yoke — Build Progress

## feat-process-mgr-ndjson (2026-04-13)

Implemented `src/server/process/stream-json.ts` — the NDJSON line-buffered stream-json parser that
consumes Claude Code `--output-format stream-json` stdout and emits six typed events: `stream.text`,
`stream.thinking`, `stream.tool_use`, `stream.tool_result`, `stream.usage`, `stream.system_notice`,
plus `rate_limit_detected` and `parse_error`. The parser is a `StreamJsonParser extends EventEmitter`
with two input methods: `feed(line: string)` for complete lines (used by the JigProcessManager
readline path) and `feedChunk(data: string)` for arbitrary byte chunks with a `flush()` to drain the
partial-line buffer. Splitting is on LF (`\n`) only — matches the empirical finding that Claude Code
never emits CRLF. Two streaming modes are handled transparently: in default mode, complete `assistant`
events yield `stream.text`/`stream.thinking` with `final:true`; in `--include-partial-messages` mode,
`stream_event content_block_delta` events yield deltas with `final:false` and `stream_event
content_block_stop` emits an empty-delta `final:true` event, while the duplicate `assistant` text/
thinking events are suppressed. `stream.tool_use` is always emitted from the complete `assistant`
event. Rate-limit detection fires when `rate_limit_event.rate_limit_info.status !== "allowed"` with
`resetAt` extracted from `resetsAt`. Malformed JSON lines emit `parse_error` (the Pipeline Engine is
responsible for incrementing `sessions.status_flags.parse_errors` in SQLite on receipt). 39 tests in
`tests/process/stream-json.test.ts` covering all 6 acceptance criteria and all 4 review criteria
against two empirically captured fixture files (`capture-default-mode.jsonl` = research capture-1,
`capture-partial-messages.jsonl` = research capture-4); all 370 tests pass; `tsc --noEmit` clean.

## feat-process-mgr-live (2026-04-13)

Implemented `src/server/process/manager.ts` and `src/server/process/jig-manager.ts` — the
`ProcessManager` interface and its production implementation. `manager.ts` exports `ProcessError`
(discriminated kind: `epipe | spawn_failed | stdin_error`), `SpawnOpts` (command + args from
ResolvedConfig only, no hard-coded strings), `SpawnHandle` (typed event overloads: `stdout_line`,
`stderr_data`, `stderr_cap_reached`, `exit`, `error`; plus `isAlive()` and `cancel()`), and
`ProcessManager` (single `spawn(opts)` method — no JigProcessManager-specific leakage). `jig-manager.ts`
exports only `JigProcessManager`; the internal `JigSpawnHandle extends EventEmitter` is not exported.
Key mechanics: `detached:true` gives the child its own process group (`pgid === pid`); `child.unref()`
allows the event loop to exit without waiting (zombie reap documented in a code comment); EPIPE is
caught as a named failure class in the stdin `error` handler (not a generic catch) and re-raised as
`ProcessError{ kind: 'epipe' }`; stderr is capped at 64 KB in the `data` stream handler (slice-before-emit,
never accumulate all bytes first); `stderr_cap_reached` is emitted once; `cancel()` sends SIGTERM to the
entire process group (`process.kill(-pgid, 'SIGTERM')`), waits `gracePeriodMs` (default 10 000 ms),
then escalates to SIGKILL. The SIGTERM→SIGKILL escalation test uses a readiness protocol (child writes
`"ready\n"` after registering its handler) to eliminate the signal-before-handler-registration race. 22
integration tests in `tests/process/jig-manager.test.ts`; all 331 tests pass; `tsc --noEmit` clean.

## feat-state-machine-tests (2026-04-12)

Added `tests/state-machine/transitions-assertions.test.ts` — the full 19-assertion
unit test suite for the state machine, mapped 1-to-1 to the §Test assertion list in
`docs/design/state-machine-transitions.md`. All 19 named assertions are present and
none are skipped. Assertion 1 is the completeness test: it defines the 33 documented
non-abandoned pairs explicitly and verifies each returns a defined result from
`transition()`, plus checks that all 27 events are handled by `abandoned` and that
undocumented pairs return `undefined` (no phantom rows). Assertions 2–19 cover valid
to-states, guard semantics (`deps_satisfied` requires `complete` deps, `complete`
requires all four conditions), bootstrap-failed non-auto-transition, phase advance
atomicity, goto/max_revisits, stop-and-ask, user_cancel universality (with the
bootstrapping gap documented), cascade side effects, logging side effects,
idempotency of the crash recovery path (referential equality of pure function
outputs), and stage-level events as workflow-level concerns. 64 new tests; total
309 tests pass; all tests run in ~10ms (pure data-structure assertions, no I/O).

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

## feat-state-machine (2026-04-12)

Implemented the state machine module in full under `src/server/state-machine/`.
Three new TypeScript modules: `states.ts` (11-element `State` and 27-element
`Event` union literal types), `transitions.ts` (the `TRANSITIONS` const typed as
`{ [S in State]: Partial<Record<Event, TransitionResult>> }` — the mapped-type
key forces a compile-time error when a new State is added without a corresponding
entry; the `abandoned` row is typed as `satisfies Record<Event, TransitionResult>`
so adding a new Event also errors; every row is runtime-frozen via
`Object.freeze`; `transition()` is a pure lookup with no I/O), and
`classifier.ts` (`classify(stderr, parseState): FailureClass` — tags
rate-limit/overload patterns as `transient`, auth/permission patterns as
`permanent`, content-policy patterns as `policy`, and all other patterns as
`unknown`; parse state — parse_errors count + last event type — is a required
input per RC-3 and affects classification when the stream was wholly
unparseable). The `session_fail` TRANSITIONS entry has a conditional result with
three guarded outcomes: `classifier=transient → awaiting_retry`,
`classifier=permanent → awaiting_user`, `classifier=unknown → awaiting_user`,
so `unknown` can never reach a retry path. One known gap filed in handoff.json:
`(bootstrapping, user_cancel)` is absent from state-machine-transitions.md;
the test explicitly documents this as "not in the doc." 122 new tests across
`tests/state-machine/transitions.test.ts` (49) and `tests/state-machine/classifier.test.ts` (73);
all 245 tests pass; `tsc --noEmit` clean.

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
