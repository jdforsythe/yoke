# Yoke — Build Progress

## feat-fault-injector — implement attempt 0 (2026-04-13)

Implemented `feat-fault-injector` in a single focused commit. **`src/server/fault/injector.ts`** (new): exports `Checkpoint` string union (`bootstrap_ok | session_ok | artifact_validators | post_commands_ok`), `FaultInjector` interface with `check(checkpoint)`, `NoopFaultInjector` (empty body — zero overhead in production, AC-1), `ActiveFaultInjector` (holds a `ReadonlySet<Checkpoint>`; `check()` throws `FaultInjectionError` synchronously at armed checkpoints — no sleep hacks, RC-3), and `FaultInjectionError` (carries `.checkpoint` for instanceof dispatch, AC-5). No `process.env` lookup inside the class; the caller constructs the right implementation (RC-4). **Scheduler wiring** (`src/server/scheduler/scheduler.ts`): added `faultInjector?: FaultInjector` to `SchedulerOpts`, defaults to `new NoopFaultInjector()`; four `check()` call-sites: at `bootstrap_ok` (after `runBootstrap()` succeeds, before `applyItemTransition`) with `FaultInjectionError` caught to fire `bootstrap_fail` immediately (AC-2); at `artifact_validators` (after validators pass, before post commands); at `post_commands_ok` (after post commands complete); at `session_ok` (immediately before `session_ok` is committed). Faults at the last three checkpoints leave the session row as `running` with the live PID so that `buildCrashRecovery` on the next scheduler restart detects the stale PID and fires `session_fail` (AC-3). **Tests**: 10 unit tests in `tests/fault/injector.test.ts` (all checkpoint variants, FaultInjectionError identity, edge cases); 4 integration tests in `tests/scheduler/crash-recovery.test.ts` covering AC-2 (bootstrap_ok fault → `bootstrap_failed`), AC-3/AC-4a-b (session_ok fault + new scheduler restart → stale PID recovery → item leaves `in_progress`), AC-4c (`rate_limited` item with unknown resetAt promoted immediately by new scheduler tick), and the no-op happy path. 931 tests pass; `tsc --noEmit` clean.

## feat-artifact-validators — implement attempt 0 (2026-04-13)

Implemented the full `feat-artifact-validators` feature in two focused commits.

**`src/server/artifacts/validator.ts`** (new): Exports `validateArtifacts(artifacts, worktreePath)` which iterates every declared `OutputArtifact` independently, collecting failures without short-circuit (AC-5). For each artifact: (1) checks existence and raises `validator_fail` for missing required artifacts — catching `ENOENT` rather than propagating it (AC-4, RC-3); (2) skips schema validation when no `schema` field is configured; (3) parses the artifact as JSON and raises `validator_fail` for unparseable content; (4) reads the schema file fresh on every call — never from a cache (RC-2); (5) validates with `Ajv2020({ allErrors: true, verbose: true })` so errors carry `instancePath`, `schemaPath`, and `data` (the offending value) (AC-6). The `schemaId` in each `ArtifactFailure` comes from the schema's `$id` field, falling back to the schema file path (AC-2). New AJV instance per artifact guarantees no cross-run compiled-validator retention. Returns `{ kind: 'validators_ok' }` only when all artifacts pass (AC-3). 17 unit tests cover all AC/RC criteria plus edge cases (invalid JSON, unreadable schema, schema change between calls, no-schema existence check).

**Scheduler wiring** (`src/server/scheduler/scheduler.ts`): Added `ArtifactValidatorFn` injectable type and `artifactValidator?` to `SchedulerOpts`. In `_runSession`, after the agent exits cleanly (`exitCode === 0`), `artifactValidatorFn` is called with `phaseConfig.output_artifacts` and `worktreePath` **before** post commands run (RC-4). On `validator_fail`: fires the `validator_fail` event via `applyItemTransition`, closes the session, and returns — post commands are not called. On `validators_ok`: continues to post commands unchanged. The constructor defaults to a lazy-imported `validateArtifacts` so production code requires no changes; tests supply a stub. 4 new scheduler integration tests: AV-1 (validators pass → `completed`), AV-2 (`validator_fail` → `awaiting_retry`), AV-3 (post runner not called on failure), AV-4 (correct `artifacts` + `worktreePath` forwarded).

917 tests pass; `tsc --noEmit` clean.

## feat-prepost-runner — implement attempt 1 (2026-04-13)

Single blocking fix from review attempt 1 (RC-5): changed `SIGKILL_GRACE_MS` from 5,000 ms to 10,000 ms in `src/server/prepost/runner.ts` to match the process manager's documented SIGTERM+10s grace+SIGKILL escalation contract. Updated the associated code comment. All 31 prepost runner tests pass; `tsc --noEmit` clean.

## feat-prepost-runner — implement attempt 0 (2026-04-13)

Implemented the full pre/post command runner feature across four focused commits.

**Wildcard enforcement at config load time (AC-4)**: Added `"required": ["*"]` to the `actionsMap` JSON schema definition (`docs/design/schemas/yoke-config.schema.json`). AJV now rejects any pre/post command whose `actions` map omits the catch-all wildcard entry at load time rather than at runtime. Four new loader tests cover both rejection and acceptance cases.

**`PrePostRunRecord` type + `runs` field (AC-6 data collection)**: Added the `PrePostRunRecord` interface to `src/server/prepost/runner.ts`. Every `RunCommandsResult` variant now carries a `runs: PrePostRunRecord[]` array. The runner populates one record per command with `commandName`, `argv`, `when`, `startedAt`, `endedAt`, `exitCode`, and `actionTaken` (null for timeout, spawn failure, or unhandled exit). Made `shell: false` explicit in the spawn options (RC-1). Updated all 24 existing runner tests and added 7 new tests covering the runs array across every result kind.

**Engine `prepost_runs` write (AC-6, RC-4)**: Added `prepostRuns?: PrePostRunRecord[]` to `GuardContext` in `src/server/pipeline/engine.ts`. Added the `writePrepostRun()` helper and wired it inside `applyItemTransition`'s `db.transaction()`, after the standard state mutation, so every run record is atomically persisted alongside its corresponding state transition.

**Scheduler wiring**: Updated `_runSession` in `src/server/scheduler/scheduler.ts` to collect `preRuns` from pre command results and pass them — together with `postRuns` — as `guardCtx.prepostRuns` to every `applyItemTransition` call that follows. Pre-only runs are passed to `pre_command_failed` and `session_fail` (non-zero exit); pre + post runs are passed to `session_ok` and `post_command_action`. Three new scheduler integration tests verify that `prepost_runs` rows appear in SQLite for the pre-success, pre-fail, and post-success paths.

All 896 tests pass; `tsc --noEmit` clean.

## feat-process-mgr-scripted — implement attempt 2 (2026-04-13)

Fixed the architectural import-direction inversion flagged as a known risk in attempt 1: the Scheduler (server layer) was importing `readRecordMarker` and `clearRecordMarker` directly from `src/cli/record.ts`, violating the rule that server modules must not import from the CLI layer.

**`src/server/process/record-marker.ts`** (new): Canonical home for `RecordMarker` type, `readRecordMarker`, and `clearRecordMarker`. Documented with the marker file schema and the rationale for its placement in the server layer. **`src/cli/record.ts`** now re-exports these three symbols from the server module via `export type` / `export { }` re-export syntax so existing tests and the CLI command handler continue to work without any changes. **`src/server/scheduler/scheduler.ts`** import updated from `../../cli/record.js` → `../process/record-marker.js` — the only edit needed on the consumer side.

No behaviour change; 883 tests pass; `tsc --noEmit` clean.

## feat-process-mgr-scripted — implement attempt 1 (2026-04-13)

Completed AC-2 (the only previously deferred acceptance criterion): `yoke record` capture mode now fully tee-s a live session's stream-json output to a JSONL fixture file.

**`FixtureWriter`** (`src/server/process/fixture-writer.ts`): New class that opens a JSONL fixture file, writes a version-1 header, appends `stdout`/`stderr`/`exit` records synchronously (preserving event order without async buffering), and enforces a 64 KiB stderr cap matching the scheduler's own accumulator. 12 unit tests cover record ordering, the cap, idempotent `close()`, and a round-trip replay via `ScriptedProcessManager`.

**Scheduler capture tee** (`src/server/scheduler/scheduler.ts`): In `_runSession`, after spawn succeeds, `readRecordMarker(this.config.configDir)` is checked. If a marker is present, a `FixtureWriter` is opened and wired as a tee alongside the existing `stdout_line`/`stderr_data` handlers. The writer is closed and the marker cleared at every session-exit path (normal end, rate-limited, and stopped-mid-run). Two integration tests in `tests/scheduler/scheduler.test.ts` verify the full path: fixture written + marker cleared when recording, and no fixture directory created without a marker.

All 883 tests pass; `tsc --noEmit` clean.

## feat-process-mgr-scripted — implement attempt 0 (2026-04-13)

Completed the two remaining gaps in the existing `ScriptedProcessManager` implementation to fully satisfy `feat-process-mgr-scripted`.

**Fixture version checking** (`src/server/process/scripted-manager.ts`): Added `{ "type": "header", "version": 1 }` support to `parseFixture()`. When a header record is the first non-blank line, the version is validated against `CURRENT_FIXTURE_VERSION = 1`; an unrecognised value (including wrong type such as `"1"` as string) throws `Error('Unsupported fixture version: N (expected 1)')`. Fixtures without a header continue to work (backward compatibility for inline test fixtures). The `CURRENT_FIXTURE_VERSION` constant is exported so callers can reference it. The module comment was updated with a full format spec and a failure-mode fixture index (RC-3).

**Failure-mode fixtures** (`tests/fixtures/scripted-manager/`): Created four JSONL fixture files mapping to named rows in the plan-draft3 §D35 Failure Modes table (RC-4): `session-ok.jsonl` (clean exit, exit 0), `nonzero-exit-transient.jsonl` (exit 1 + ECONNRESET stderr), `nonzero-exit-permanent.jsonl` (exit 1 + "Cannot find module" stderr), `rate-limit-mid-stream.jsonl` (rate_limit_event with numeric `resetsAt`, then exit 0). All four include a version-1 header.

**Tests** (`tests/process/scripted-manager.test.ts`): 8 new tests covering AC-5 (header accept/reject) and AC-3 (one replay integration test per failure-mode fixture). The rate-limit fixture test wires `StreamJsonParser` inline to verify `rate_limit_detected` fires with the expected `resetAt` value. 869 tests pass; `tsc --noEmit` clean.

**Deferred**: `yoke record` capture mode (AC-2) — writing fixture files by tee-ing live session stdout — remains deferred to `feat-record-capture-wiring` as planned.

## feat-scheduler — implement attempt 1 (2026-04-13)

Closed three deferred test gaps from attempt 0 and fixed the RC-2 blocker from the review.

**AC-4/AC-5/AC-6 tests** (`tests/scheduler/scheduler.test.ts`): Added three integration tests that exercise previously untested code paths. AC-4: `prepostRunner` returning `stop-and-ask` for `when='pre'` blocks `ProcessManager.spawn` — verified by asserting `spawnCount=0` and `item.status='awaiting_user'`. AC-5: `prepostRunner` returning `{ fail: { reason: ... } }` for `when='post'` after a successful session exit forwards the action to `applyItemTransition` via `post_command_action` — item reaches `awaiting_retry` (not `complete`). AC-6: a `rate_limit_event` JSON stdout line triggers `StreamJsonParser`→`rate_limit_detected` event→`applyItemTransition(rate_limit_detected)`→item transitions to `rate_limited`; a 200 ms probe after the cancel confirms `spawnCount` stays at 1 (backoff window `resetsAt=9999999999` prevents re-spawn).

**RC-2 fix** (`src/server/pipeline/engine.ts`, `src/server/scheduler/scheduler.ts`): The review found direct `db.writer` calls in `Scheduler._handleStageComplete`. Extracted two new engine-layer functions: `applyStageAdvance(db, workflowId, nextStageId)` and `applyWorkflowComplete(db, workflowId, finalStatus)`, both wrapped in `db.transaction()`. `_handleStageComplete` now calls these instead of `db.writer` directly — zero `db.writer` calls remain in `scheduler.ts`. Added 5 engine integration tests (writer update, reader atomicity, both `completed`/`completed_with_blocked` values). 861 tests pass; `tsc --noEmit` clean (5 pre-existing errors in scripted-manager.test.ts only).

## feat-scheduler — implement attempt 0 (2026-04-13)

Implemented the Scheduler orchestration loop that drives the Yoke pipeline end-to-end. Six files created or modified across three modules.

**WS broadcast layer** (`src/server/api/ws.ts`, `src/server/api/server.ts`): Added `WsClientRegistry` — a class that owns all WebSocket socket tracking (register/subscribe/unsubscribe/broadcast) so the scheduler can push frames without importing or touching sockets directly. `broadcast(workflowId, sessionId, frameType, payload)` stamps a monotonic seq via `SessionSeqStore`, pushes to `BackfillBuffer` for reconnect backfill, and fans out to all subscribers open on the workflow. `ServerState` now exposes `registry: WsClientRegistry`. `listenServer` switched to `createServer` internally in `start.ts` so callers can access `state.registry`.

**Engine session helpers** (`src/server/pipeline/engine.ts`): Added three lifecycle functions: `insertSession` (creates sessions row with `status='running'`, `pid=null` — called before spawn so SQLite concurrency counts are accurate); `updateSessionPid` (fills in real pid/pgid after spawn returns); `endSession` (marks session `ended`, writes token usage from `SessionUsage`). These are the RC-2-mandated engine functions that prevent direct `db.writer` calls in the scheduler.

**Ingestion** (`src/server/scheduler/ingest.ts`): `ingestWorkflow(db, config)` seeds one workflow row and one item per pipeline stage. Items are chained via `depends_on` so stage N+1 waits for stage N's item to reach a terminal state. Idempotent: returns the existing workflow id when a live (non-terminal) workflow for the same project.name + configDir is found (`isResume: true`).

**Scheduler** (`src/server/scheduler/scheduler.ts`): Main `Scheduler` class with injectable `processManager`, `worktreeManager`, `prepostRunner`, `assemblePrompt`, and `broadcast`. On `start()`: ingest → crash-recovery (transitions stale `in_progress` items to `awaiting_retry`/`awaiting_user` via `session_fail`) → poll loop. Poll loop (default 500 ms): re-reads all non-terminal workflows from SQLite (RC-1), drives items through `pending → ready → bootstrapping → in_progress → complete` state machine via `applyItemTransition` + engine helpers. Concurrency enforced by counting SQLite `running` sessions + `inFlight` map entries (RC-5, max 4 by default). `_handleStageComplete` advances `workflows.current_stage` on stage completion and marks `workflows.status = completed/completed_with_blocked` when the last stage is done. Rate-limit handling: `rate_limit_detected` event from StreamJsonParser fires `rate_limit_detected` transition; retried after `resetAt`. Retry backoff: 5 s in-memory timer before `backoff_elapsed`. `stop()`: sets `stopped=true`, clears timer, cancels all in-flight handles, awaits drain within `gracePeriodMs`. Early-exit `stopped` guards at `_doBootstrapThenSpawn` entry, `_runSession` entry, post-spawn, and post-exit to prevent DB access after close.

**CLI wiring** (`src/cli/start.ts`): Switched from `listenServer` to `createServer` to access `state.registry`. Instantiates production deps: `JigProcessManager`, `WorktreeManager({ repoRoot: config.configDir })`, `runCommands` as `prepostRunner`, an inline `assemblePromptFn` adapter that builds a production `GitHelper` (runs `git log/diff` via `execFile`) and calls `buildPromptContext → assemblePrompt`. `scheduler.stop()` is called before `fastify.close()` in the shutdown path. `StartHandle` now exposes `scheduler` for integration tests.

**Tests** (`tests/scheduler/scheduler.test.ts`): 10 integration tests (real SQLite + migrations, inline stub deps, no real git/worktrees/agent). Covers AC-1 (ingest), AC-2 (crash recovery), AC-3 (state machine end-to-end + bootstrap_fail), AC-5 (worktree_path persisted), AC-7 (item.state broadcast), AC-8 (graceful drain), RC-5 (concurrency cap). All 853 tests pass; `tsc --noEmit` clean (5 pre-existing errors in scripted-manager.test.ts only).

## feat-cli — implement attempt 0 (2026-04-13)

Implemented all six CLI subcommands via `commander` under `src/cli/`. `init.ts` creates `.yoke.yml` and three example prompt templates (implement/plan/review) with a hard-coded pre-flight check that exits non-zero if any target already exists — no `--force` flag exists. `start.ts` calls `loadConfig`, opens SQLite, runs migrations, calls `listenServer`, logs the URL, and writes `.yoke/server.json` for URL discovery by other commands; `close()` removes the file and shuts down cleanly. `status.ts` resolves the server URL (--url > `.yoke/server.json` > default 7777), fetches `GET /api/workflows`, and formats a table with id/name/status/stage/active-sessions; ECONNREFUSED → human-readable message. Also added `active_sessions` subquery to the workflow list endpoint in `server.ts`. `cancel.ts` posts to `POST /api/workflows/:id/control` with `action=cancel` and a fresh `crypto.randomUUID()` commandId per invocation; workflowId is percent-encoded. `doctor.ts` runs four checks (Node >= 20, SQLite via direct `better-sqlite3` open, git >= 2.20, `.yoke.yml` valid) and prints `[PASS]/[FAIL]` with actionable per-check remediation text; `checkGit()` accepts an injectable executor for unit testability. `record.ts` writes `.yoke/record.json` (marker with `{ enabled, capturePath, createdAt }`) and exports `readRecordMarker`/`clearRecordMarker` for the pipeline engine to consume at session-spawn time. `ScriptedProcessManager` in `src/server/process/scripted-manager.ts` replays JSONL fixture files (stdout/stderr/exit records) via `ScriptedSpawnHandle`; deterministic fake PID; cancel emits SIGTERM exit; implicit exit(0) for fixtures without an exit record. 79 new tests across 7 test files. All 843 tests pass; `tsc --noEmit` clean.

## feat-fastify-ws — implement attempt 1 (2026-04-13)

Fixed the single RC-3 blocker from the attempt-0 review: `server.ts` was calling `db.writer` directly inside the attention ack endpoint, violating the invariant that the API layer has no SQLite write path. Resolved by introducing `AckAttentionFn` / `ServerCallbacks` types and making `createServer(db, callbacks)` accept an optional second parameter. The `POST /api/workflows/:id/attention/:attentionId/ack` endpoint now delegates the entire `pending_attention` read+write to `callbacks.ackAttention`; if no callback is wired it returns 501 Not Implemented. The API module itself has zero `db.writer` references. Updated `listenServer()` to forward `callbacks`. Updated `tests/api/fastify-http.test.ts` to supply the callback (doing the same write that was previously inline) and added a new RC-3 test confirming the 501 path when the callback is absent. 1 new test (RC-3 enforcement), 10 modified tests (updated server setup). All 764 tests pass; `tsc --noEmit` clean.

## feat-fastify-ws — implement attempt 0 (2026-04-13)

Implemented the Fastify HTTP + WebSocket server in four modules. `src/server/api/frames.ts` exports all protocol TypeScript types from protocol-websocket.md §8 and §2 payload shapes (`ServerFrame`, `ClientFrame`, all payload variants), plus `makeFrame()` and `makeErrorFrame()` factory helpers. `src/server/api/idempotency.ts` exports `IdempotencyStore` — an in-memory Map with explicit 5-minute TTL; `get()` evicts stale entries on access; `evictExpired()` for GC; no persistence (5-min window resets on restart, which is acceptable per spec). `src/server/api/ws.ts` exports `SessionSeqStore` (monotonic seq per sessionId starting at 1; non-session frames use seq:0), `BackfillBuffer` (in-memory ring buffer max 500 frames per session; returns `null` when sinceSeq predates retained history → caller emits backfill.truncated), and `createWsHandler(ctx)` — a factory that returns a per-connection handler implementing the full Yoke WS protocol: hello frame sent immediately on connect (AC-1); protocol version check → close 4001 on mismatch (AC-1); subscription cap of 4 concurrent workflowIds per client → error + close 4002 on the 5th subscribe (AC-3); subscribe sends workflow.snapshot then backfill frames or backfill.truncated with httpFetchUrl (AC-2); control commandId idempotency via IdempotencyStore (AC-4); ping → pong; ack is a no-op advisory. `src/server/api/server.ts` exports `createServer(db)` — registers `@fastify/websocket`, mounts the WS route at `/stream` on the root Fastify instance (not inside a sub-plugin scope to avoid decoration scoping issues), and registers all seven §7 HTTP companion endpoints: `GET /api/workflows` (keyset pagination), `GET /api/workflows/:id/timeline`, `GET /api/sessions/:id/log` (delegates to `readLogPage`), `GET /api/workflows/:id/usage`, `GET /api/workflows/:id/usage/timeseries`, `POST /api/workflows/:id/control` (idempotent), `POST /api/workflows/:id/attention/:attentionId/ack` (the one API-layer SQLite write); binds exclusively to 127.0.0.1 (D57 — `listenServer()` throws on any other host). All reads use `db.reader()`; only the attention ack endpoint calls `db.writer`. Two key implementation discoveries: (1) `@fastify/websocket` v8 passes `SocketStream` (a Duplex stream wrapper) to the handler, not the raw `WebSocket` — the raw socket is at `connection.socket`; (2) the WS hello frame can arrive in the same TCP read as the 101 upgrade response before any `message` listener is registered — solved by buffering messages in a queue from the moment the WebSocket is created (before `'open'` fires), making the `WsSession` test helper race-condition-safe. 59 new tests: 24 in `tests/api/fastify-ws.test.ts` (real Fastify server + real `ws.WebSocket` connections) and 35 in `tests/api/fastify-http.test.ts` (all §7 endpoints via `fastify.inject()`). All 763 tests pass; `tsc --noEmit` clean.

## feat-session-log-store — implement attempt 2 (2026-04-13)

Implemented the Pre/Post Runner to satisfy AC-2. `src/server/prepost/action-grammar.ts` exports two pure functions: `resolveAction(actions, exitCode)` — resolves an exit code to its declared `ActionValue` by exact string key match then wildcard `"*"` fallback, returning `null` for undeclared codes; `isContinue(action)` — true iff the action is the `"continue"` sentinel. `src/server/prepost/runner.ts` exports `runCommands(opts)` — iterates the command array sequentially, spawning each `PrePostCommand` with `shell:false` in the worktree CWD; each command gets a per-command wall-clock timeout (default `DEFAULT_TIMEOUT_S = 900 s`) with SIGTERM→5 s→SIGKILL escalation; stdout is read line-by-line via `readline.createInterface` and each line is written as a `prepost.command.stdout` frame to the `SessionLogWriter`; stderr chunks are split on newlines and written as `prepost.command.stderr` frames; `prepost.command.start` and `prepost.command.exit` frames bracket each command with metadata (`name`, `when`, `cmd`, `ts`, `exit_code`, `elapsed_ms`); all writes go through a serialised `_writeQueue` promise chain (same pattern as `_logChain` in `JigSpawnHandle`) ensuring frame order is preserved and the queue is drained before returning — log completeness for the caller is guaranteed; resolution of exit code → `ActionValue` via `action-grammar.ts`; returns a `RunCommandsResult` discriminated union (`complete | action | timeout | spawn_failed | unhandled_exit`) for the Pipeline Engine to act on; no SQLite writes, no action execution in this module. The `SessionLogWriter` is caller-provided and already open — the runner does not open or close it, allowing it to be shared with the Process Manager for the agent session. 47 new tests: 22 pure unit tests in `tests/prepost/action-grammar.test.ts` (exact match, wildcard, no-match, `isContinue`) and 25 integration tests in `tests/prepost/runner.test.ts` (real node children, real tmpdir, real JSONL log: complete path, action returned, unhandled exit, spawn failure, JSONL frame content, env injection, timeout). All 704 tests pass; `tsc --noEmit` clean.

## feat-session-log-store — implement attempt 1 (2026-04-13)

Fixed three blocking issues from the attempt-0 review. AC-1: wired `SessionLogWriter` into `JigProcessManager` — added `logWriter?: SessionLogWriter` to `SpawnOpts`; `JigSpawnHandle` appends each `stdout_line` event to the writer via a serialized promise chain (`_logChain`) so lines are written in arrival order with no interleaving; the chain drains and the writer closes before the `exit` event fires, giving callers waiting on `waitForExit()` an implicit log-completeness guarantee without any `setTimeout` polling. AC-4: added `openSessionLog(db, opts)` to `src/server/session-log/writer.ts` — computes the log path, writes `sessions.session_log_path` to SQLite via `db.writer` (before opening the file so the HTTP endpoint can serve the path immediately), creates parent directories, opens the writer, and returns `{ writer, logPath }` for the caller to pass to `ProcessManager.spawn()`; this is the production-code hook the orchestration layer will call at session spawn time. AC-2 explicitly recorded as a handoff dependency: `src/server/prepost/runner.ts` does not exist; when implemented it must open a `SessionLogWriter` at the same `logPath` and call `writeLine()` for each command output frame. Non-blocking fixes: deprecated `url.parse()` replaced with `new URL()` in `http.ts`; retention config reference comment added to `writer.ts` (RC-2). AC-6 test coverage strengthened: added `POST`, `DELETE`, and `PUT` method-level tests on the `/api/sessions/:id/log` path. 9 new tests (3 `openSessionLog` integration tests in `writer.test.ts`, 3 `logWriter` wiring tests in `jig-manager.test.ts`, 3 method-level tests in `session-log-http.test.ts`). All 657 tests pass; `tsc --noEmit` clean.

## feat-session-log-store (2026-04-13)

Implemented the Session Log Store in three modules. `src/server/session-log/writer.ts` exports `SessionLogWriter` — an append-only file writer backed by a `FileHandle` opened with `O_APPEND | O_CREAT` (`flag 'a'`); `open()` creates all parent directories and opens the handle; `writeLine(line)` appends the line + `\n` with no seek; `close()` nulls the handle and closes it idempotently (safe to call multiple times). Also exports `makeFingerprint(configDir)` (16-char SHA-256 hex of the configDir path) and `makeSessionLogPath({ configDir, workflowId, sessionId, homeDir? })` which constructs `~/.yoke/<fingerprint>/logs/<workflowId>/<sessionId>.jsonl` — the fingerprint prevents log path collisions between parallel yoke projects on the same machine (RC-4); the `~/.yoke/` anchor ensures log files survive worktree teardown and cleanup (AC-3). `src/server/session-log/reader.ts` exports `readLogPage(logPath, sinceSeq, limit)` — a streaming `readline`-based pager that skips the first `sinceSeq` lines, collects `limit + 1` lines to detect `hasMore`, and returns the `LogPage` struct (`entries`, `nextSeq`, `hasMore`); clamped to `MAX_PAGE_SIZE = 1000` per page; returns `null` if the file is inaccessible (AC-5 404 mapping); reads directly from the JSONL file without touching SQLite (RC-3). `src/server/api/http.ts` implements a Node.js `http.Server` factory `createHttpServer(db)` (Fastify migration deferred to feat-server-main) with one route: `GET /api/sessions/:id/log?sinceSeq=N&limit=M`; it queries `sessions.session_log_path` from SQLite via `db.reader()` as a path pointer only (RC-3); returns 404 for unknown sessions, `{ entries: [], nextSeq, hasMore: false }` when `session_log_path` is null or the file does not yet exist, and delegates all actual reading to `readLogPage()` (no write or delete paths — AC-6). 47 tests: 20 in `tests/session-log/writer.test.ts`, 15 in `tests/session-log/reader.test.ts`, 12 in `tests/api/session-log-http.test.ts`. All 648 tests pass; `tsc --noEmit` clean.

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
