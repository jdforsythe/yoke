# Yoke — Build Progress

## feat-pipeline-engine — implement attempt 2 (2026-04-13)

Fixed the AC-5 blocker identified in the second review: `WorktreeManager.createWorktree()` was writing `branch_name` and `worktree_path` directly to the `workflows` row, and `runBootstrap()` was inserting `pending_attention` rows — both violating the architectural invariant that the Pipeline Engine is the sole SQLite mutator. Removed the `db: DbPool` parameter from both methods and removed `workflowId` from `RunBootstrapOpts` (it was only used for the removed write). The `bootstrap_fail` pending_attention insertion is already covered by the `TRANSITIONS` table's sideEffects label, so the engine's `applyItemTransition()` already handles it when the orchestration loop fires the event. Added `applyWorktreeCreated(params)` to `engine.ts`: writes `branch_name` + `worktree_path` to `workflows` and inserts a `worktree_created` events row inside a single `db.transaction()` (AC-6). Removed 4 SQLite-asserting tests from `manager.test.ts` (the SQLite writes no longer exist there); updated all `createWorktree()` and `runBootstrap()` call sites to drop the `db` argument. Added 3 new engine integration tests for `applyWorktreeCreated()` covering the workflows update, events row, and reader-visible atomicity. 601 tests pass; `tsc --noEmit` clean.

## feat-pipeline-engine — implement attempt 1 (2026-04-13)

Fixed two blocking issues from the attempt-0 review. AC-1: widened the `stageComplete` guard from `newState === 'complete'` to `STAGE_TERMINAL_STATES.has(newState)` so that `awaiting_user → blocked` (user_block) and `awaiting_user → abandoned` (user_cancel) also fire the stage-complete probe when the item is the last non-terminal one — previously these paths silently stalled the pipeline. RC-4: added `needsApproval?: boolean` to `ApplyItemTransitionParams`; when `stageComplete=true` and `needsApproval=true`, the engine inserts `pending_attention{kind='stage_needs_approval'}` and sets `workflows.status='pending_stage_approval'` inside the same transaction (AC-6), satisfying the "inserts pending_attention and pauses workflow" criterion; the resume path fires when the orchestration loop delivers `stage_approval_granted` and resets `workflows.status`. Also addressed non-blocking feedback: `StaleSesssion` typo corrected to `StaleSession` (deprecated alias kept for one release); `buildCrashRecovery` now commits all `recovery_state` writes for affected workflows in a single `db.transaction()` rather than individual unpaired writes, making the startup probe all-or-nothing. Added 10 new integration tests covering the widened stageComplete guard (user_block and user_cancel paths), RC-4 pending_attention insertion, workflow status update, atomicity via reader connection, policy classifier → awaiting_user, and multi-workflow crash-recovery transaction. All 602 tests pass; `tsc --noEmit` clean.

## feat-pipeline-engine (2026-04-13)

Implemented the Pipeline Engine in two modules under `src/server/pipeline/`. `retry-ladder.ts` exports `computeRetryDecision({ retryCount, maxOuterRetries, retryLadder })` — a pure function with no I/O that maps retry_count to the next retry mode from the configured ladder (`DEFAULT_RETRY_LADDER = ['continue', 'fresh_with_failure_summary', 'awaiting_user']`, `DEFAULT_MAX_OUTER_RETRIES = 3`); `'awaiting_user'` at any ladder index acts as an early-exhaustion sentinel; entries past the end of the ladder also signal exhaustion (AC-3). `engine.ts` exports three public functions: (1) `applyItemTransition(params)` — the core atomic operation: reads current item and workflow state from SQLite inside `db.transaction()`, looks up `(state, event)` in `TRANSITIONS`, evaluates guards (`checkAllDepsComplete` for `deps_satisfied`, worktree_path for `phase_start`, classifier result + retry budget for `session_fail`, revisit counter from events table for `goto` actions), updates `items.status/current_phase/retry_count`, writes an events row with full correlation (workflow_id, item_id, session_id, stage, phase, attempt) for every transition, writes `pending_attention` rows when side-effect labels indicate so, and cascade-blocks all transitive dependents in the same transaction via BFS when the new state is `awaiting_user/blocked/abandoned` — setting `blocked_reason` and writing a `cascade_block` events row for each (AC-2, RC-5); `stageComplete` is returned as true when `checkStageCompleteInTxn` finds all items terminal after the transition (AC-1); (2) `checkStageComplete(db, workflowId, stageId)` — standalone read-only probe counting total vs terminal items (complete/blocked/abandoned) — returns false for empty stages (AC-1); (3) `buildCrashRecovery(db)` — reads all non-terminal workflows, finds `running` sessions with non-null PIDs, probes each with `process.kill(pid, 0)` (ESRCH → stale, EPERM → alive), writes `recovery_state` JSON on affected workflows with `{workflowId, staleSessions, detectedAt}`, and does NOT apply any item state transitions (AC-4, RC-2). max_revisits is tracked per `(item_id, destination_phase)` pair via `prepost.revisit` events in the events table — counted within the same transaction before each goto, with a new revisit event inserted for every successful goto (RC-3). 67 tests: 18 pure unit tests in `tests/pipeline/retry-ladder.test.ts` and 49 integration tests in `tests/pipeline/engine.test.ts` (real SQLite, real migrations, real PID probes using process.pid for alive tests and 99999999 for stale). All 592 tests pass; `tsc --noEmit` clean.

## feat-prompt-asm (2026-04-13)

Implemented the Prompt Assembler module in three files under `src/server/prompt/`. `engine.ts` exports `replaceTemplateVars(template, ctx)` — a hand-rolled `{{name}}` replacer using a single `TOKEN_RE` regex (`[A-Za-z_][A-Za-z0-9_.]*`), dot-path traversal via segment-by-segment object walk, `[MISSING:path]` output on any missing key or null/undefined leaf (AC-2, never throws), and `JSON.stringify(v, null, 2)` for non-string values (AC-1 — objects/arrays serialize to stable pretty-printed JSON). `assembler.ts` exports `assemblePrompt(template, ctx, options?)` — a pure wrapper with no I/O (RC-1); `templatePath` in options is informational only (AC-3, AC-5: calling this without spawning anything produces the full prompt string). `context.ts` exports `buildPromptContext(inputs)` — the async context builder that: reads `architecture.md`, `progress.md`, and `handoff.json` from the worktree via `readFileOrEmpty` (ENOENT → `""`, all other errors re-thrown); parses `item.data` as an opaque JSON blob and stores the whole parsed object under `ctx["item"]` without accessing any named fields (AC-4, RC-3); projects `item_state` from harness columns (`status`, `current_phase`, `retry_count`, `blocked_reason`) — separate from the opaque blob (AC-1); reads `handoff.json` and serializes its `entries` array as the `{{handoff}}` value (AC-6: most-recent handoff entries); calls the injected `git.logRecent(20)` for `{{git_log_recent}}` and `git.diffRange(from, to)` when `diffFrom` is provided; returns a fully-populated `PromptContext` with all standard variables present. `GitHelper` is an injected interface (no subprocess in tests). 73 tests: 43 pure unit tests in `tests/prompt/assembler.test.ts` (no SQLite, no filesystem — RC-4) and 30 integration tests in `tests/prompt/context.test.ts` (real tmpdir, stub git helper). All 525 tests pass; `tsc --noEmit` clean.

## feat-worktree-mgr (2026-04-13)

Implemented the Worktree Manager in two modules under `src/server/worktree/`. `branch.ts` exports four pure functions: `slugify()` (lowercases, collapses non-alphanumeric runs to `-`, trims, truncates at 40 chars, falls back to `'workflow'`), `makeShortId()` (strips UUID hyphens, takes first 8 chars), `makeBranchName()` (produces `yoke/<slug>-<shortid>` pattern), and `makeWorktreeDirName()` (same suffix, no prefix — safe for filesystem use; no path-traversal characters possible since the character set is `[a-z0-9-]` only). `manager.ts` exports `WorktreeManager` with four public methods: (1) `createWorktree()` — runs `git worktree add -b <branch> <path>` then writes `branch_name` and `worktree_path` to the `workflows` row inside a single `db.transaction()` call (AC-1, RC-4 path validation via `_validateWorktreePath` using `path.resolve` + `startsWith(base + sep)`); (2) `runBootstrap()` — iterates `commands` with `sh -c` in declared order, stops on first non-zero exit, inserts `pending_attention{kind='bootstrap_failed'}` via `db.transaction()` and returns a `BootstrapEvent` discriminated union for the Pipeline Engine to apply to the state machine — this module never calls `transition()` (RC-1, AC-2, AC-3); (3) `runTeardown()` — checks for `.yoke/teardown.sh` existence with `fs.existsSync`, runs it via `execFileAsync('sh', [script], {cwd})` if present, treats absence as non-error and non-zero exit as non-fatal warning (AC-4); (4) `cleanup()` — pre-checks branch retention with `git log <branch> --not --remotes --oneline` (reads remote state, not local refs — RC-2), calls the injectable `CheckPrFn` if unpushed commits exist, refuses (logs warning, returns `{worktreeRemoved: false}`) when both conditions hold (AC-5), then in order: kills tracked pids (SIGTERM → 50ms poll → SIGKILL), runs `runTeardown()`, runs `git worktree remove --force` (the `--force` flag is only invoked after teardown — RC-3), retains branch by default (AC-6). `CheckPrFn` is injectable for testability; default production implementation calls `gh pr list --head <branch> --json number` and treats any failure (gh not installed, no auth) as `false` (conservative direction). Tests: 26 unit tests in `tests/worktree/branch.test.ts` and 34 integration tests in `tests/worktree/manager.test.ts` using a real git repo (created via `gitInit` in `beforeEach`, with a bare repo as fake remote for retention tests), real SQLite with migrations applied, and `CheckPrFn` stubs. All 452 tests pass; `tsc --noEmit` clean.

## feat-process-mgr-heartbeat (2026-04-13)

Implemented `src/server/process/heartbeat.ts` — the two-signal heartbeat for a running child process. The `Heartbeat` class owns a single `setInterval` (tick = `liveness_interval_s` from `ResolvedConfig`). On each tick, it calls `isRateLimited()` fresh (AC-5/RC-2 — suppression state is never cached); if not suppressed, it runs two independent probes: (1) the liveness probe calls `process.kill(pid, 0)` — signal 0 delivers no signal but causes ESRCH if the PID is gone — and emits one `stream.system_notice{subtype:'liveness_stale'}` warning on the first ESRCH (subsequent ESRCH is muted since the session is ending); (2) the stream-activity watchdog computes `Date.now() - lastStdoutAt` and emits one `stream.system_notice{subtype:'stream_idle'}` if idle time exceeds `activity_timeout_s`; the watchdog is reset by `notifyStdoutLine()` so each new idle period can warn once. Neither probe sends SIGTERM or SIGKILL (RC-1). `stop()` calls `clearInterval` (RC-3). Added `liveness_interval_s?: number` (default 30 s) to `Heartbeat` in `src/shared/types/config.ts` and to the schema `$def` in `docs/design/schemas/yoke-config.schema.json` — required to satisfy AC-4 (interval from `ResolvedConfig`, not hard-coded). 22 tests in `tests/process/heartbeat.test.ts` using vitest fake timers and `vi.spyOn(process, 'kill')` cover all 5 acceptance criteria and 3 review criteria; all 392 tests pass; `tsc --noEmit` clean.

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
