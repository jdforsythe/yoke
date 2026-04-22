# Plan Draft 2 → Draft 3 Change Log

Synthesis of four Phase α critiques (`docs/critiques/{architect,backend,frontend,qa}.md`) against `docs/idea/plan-draft2.md`. Each decision below is labeled **Accept** (baked into draft3). All originally Needs-input items (D50–D61) were resolved in Phase α.5 — see section Q. Several resolutions reframed the original proposal based on user feedback; those are marked **Accept (reframed)**.

Source tags: `[A]` architect, `[B]` backend, `[F]` frontend, `[Q]` QA.

---

## A. Core principles & architectural honesty

**D01 — The "adapter-ready" escape hatch is aspirational; drop it. [A,§7]**  
**Accept.** Claude-Code-isms (stream-json, `-c`, hook model, subagent review) are in the pipeline engine, not behind an adapter. Draft3 declares v1 explicitly Claude-Code-native. A non-Claude-Code backend would be a rewrite, not a plugin. This frees the v1 code from pretending to be neutral.

**D02 — "Token usage is the user's problem" contradicts the optional usage gate. [A]**  
**Accept.** Draft3 principle rewritten: "Token usage is observed, not managed — except for an opt-in pre-flight check." Usage gate stays in v1.1.

**D03 — Pipeline Engine and State Store are not separate modules. [A]**  
**Accept.** Draft3 collapses the diagram: the SQLite row is the single source of truth for workflow/feature/session state; the pipeline engine reads, transitions, writes, re-reads; no in-memory cache is authoritative. Any in-memory object is a short-lived projection.

**D04 — "Artifact Store" conflates worktree files and harness session logs. [A]**  
**Accept.** Draft3 splits into **Worktree Artifacts** (agent-produced, lives in worktree, deleted on cleanup) and **Session Log Store** (harness-produced, lives in `.yoke/`, survives cleanup). The Artifact Store box is removed from the architecture diagram.

---

## B. State machine & phase model

**D05 — Phase model is hard-coded despite "configurable pipeline" claim. [A]**  
**Accept.** Draft3 decouples state machine from phase names. The state machine knows three transition kinds: (1) phase-complete (artifact produced + validated), (2) phase-failed (retries exhausted), (3) phase-branch (output artifact directs re-entry). Phase names become labels on nodes in a user-defined graph, not enum values. `features.current_phase` is free-text.

**D06 — State machine is prose, not definition. [Q,A]**  
**Accept.** Draft3 adds an explicit `(from_state, event) → (to_state, side_effects, guard)` transition table as a TypeScript const. Unit test asserts every `(state, event)` has a defined transition. New states added: `awaiting_retry`, `awaiting_user`, `review_invalid`, `rate_limited`, `bootstrap_failed`, `abandoned`.

**D07 — `blocked` is a black hole. [Q]**  
**Accept.** Draft3 adds failure classification: `transient` / `permanent` / `policy` / `unknown`. Transient failures use exponential backoff + per-window retry budget, not a monotonic counter. `blocked` becomes user-reachable with "retry with notes" action.

**D08 — Feature dependency ordering (`depends_on`) is load-bearing for v1. [A,B]**  
**Accept.** Topological sort moves into v1. On feature failure, transitive dependents auto-block with `blocked_reason: "dependency feat-NNN failed"`. Cycles rejected at planning-validation time. Parallel scheduling of independent features remains v1.1.

**D09 — Phase model should accommodate iterative planning from day one. [A]**  
**Accept** (structural, not feature). Draft3's phase-branch transition type supports a planner that emits `features.json` with `needs_more_planning: true` and re-enters the plan phase. The *feature* (iterative planning UX) remains v1.1; the *structural affordance* ships in v1.

---

## C. File-artifact integrity & the features.json problem

**D10 — "Agents may only change these fields of features.json" is a prayer, not enforcement. [A]**  
**Accept.** Draft3 makes `features.json` in the worktree a **read-only projection**. The canonical feature store is the SQLite `features` table. Implementers update status via a narrow channel: they append lines to `.yoke/status-updates.jsonl` in the worktree; the harness reads this after session end and updates SQLite. Any write to `features.json` itself is rejected at phase-completion time (harness snapshots before, diffs after; non-trivial changes fail the phase).

**D11 — Prompt Assembler has hidden dependency on worktree + git. [A]**  
**Accept.** Draft3 defines a `PromptContext` object built by the Pipeline Engine from Worktree Manager + State Store + git helper, passed into a pure Prompt Assembler (`(template, context) → string`). Enables dry-run preview.

**D12 — Session → artifact provenance missing. [A]**  
**Accept.** Draft3 adds `features.created_by_session_id` + `features.last_updated_by_session_id` columns. Adds `artifact_writes` table `(session_id, artifact_path, written_at, sha256)` for full provenance.

**D13 — Handoff between phases needs a structured channel, not free-form progress.md. [Q]**  
**Accept.** Draft3 adds `handoff.json` per feature (append-only) with `{intended_files, deferred_criteria, known_risks, retry_history[], reviewer_notes_seen[]}`. progress.md stays as the free-form narrative, but handoff.json is the structured contract. Context-injection from the dashboard goes through handoff.json.

---

## D. Review architecture

**D14 — File-artifact principle breaks at review (subagent results flow through orchestrator context). [A]**  
**Accept.** Draft3 revises the review model: each subagent reviewer writes its verdict directly to `reviews/feature-N/<angle>.json` via its own Write tool. The orchestrator session is a thin spawner that never sees verdict content — its only job is to invoke subagents in sequence. Aggregation is deterministic code in the pipeline engine (`any(fail) → fail`), not a prompt. This closes the rubber-stamping loophole and makes verdicts tamper-resistant.

---

## E. Protocol layer: stream-json parsing + WebSocket envelope

**D15 — stream-json parsing assumes framing that isn't specified. [B]**  
**Accept.** Draft3 commits to Claude Code's stream-json as NDJSON (one JSON object per line, `\n`-delimited). Parser uses a line-buffered reader (`readline` or hand-rolled splitter): accumulate bytes, split on `\n`, parse complete lines, carry the trailing partial line. Behavior spec: (a) parse failure → log + skip + tag session; (b) line > 16MB → truncate + mark session tainted; (c) stderr is a separate stream, never mixed into the parser.  
*NB: This assumption must be empirically verified in Phase γ research task (see runbook).*

**D16 — Token usage parsing is underspecified. [B,A]**  
**Accept** (structure).  
Draft3 stores usage as columns (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) with an opaque `raw_usage TEXT` for future fields. Adds `parent_session_id` so resumed sessions chain; per-session usage is the delta from that session; per-feature usage is the sum across the chain.  
*Open:* exact event type to parse — needs verification in Phase γ research.

**D17 — WebSocket protocol is entirely unspecified. [F]**  
**Accept.** Draft3 adds a "WebSocket Protocol" section with the envelope:
- Server→client: `{ v: 1, type, workflowId, sessionId?, seq, ts, payload }`
- Client→server: `{ v: 1, type, id, payload }`
- Server types: `hello`, `workflow.snapshot`, `workflow.update`, `feature.update`, `session.started`, `session.ended`, `stream.chunk`, `stream.tool_use`, `stream.tool_result`, `stream.text`, `stream.thinking`, `stream.usage`, `stream.system_notice`, `notice`, `error`, `pong`
- Client types: `subscribe`, `unsubscribe`, `control`, `ack`, `ping`
- Per-session monotonic `seq` for gap detection; explicit `hello` with protocol version; refuse connection on version mismatch.

**D18 — Client render model for stream-json chunks is undefined. [F]**  
**Accept.** Draft3 specifies a normalized event model the client reduces wire frames into:
- `TextBlock` (accumulates deltas until frozen)
- `ToolCall` (status: pending/running/ok/error, linked to result by tool_use_id)
- `ThinkingBlock` (collapsed by default)
- `SystemNotice` (session lifecycle, retries, hook failures, rate-limits, stderr)
- `UsageUpdate` (feeds the HUD, not rendered inline)

**D19 — Backfill-on-reconnect unspecified. [F]**  
**Accept.** Draft3 adds: client sends `subscribe { workflowId, sinceSeq? }`; server replies with `workflow.snapshot` + bounded backfill from stored session log; on `sinceSeq` older than retained buffer, server returns `backfill.truncated` + HTTP URL for paged fetch. Client dedupes by `(sessionId, seq)`.

**D20 — Subscription model for multi-workflow monitoring missing. [F]**  
**Accept.** Single multiplexed socket per client; explicit `subscribe`/`unsubscribe` by workflowId; server only sends subscribed streams plus a lightweight `workflow.index.update` frame. Cap of 4 concurrent streaming subscriptions; extras degrade to polled snapshots.

---

## F. Process lifecycle

**D21 — `child.stdin.pipe()` ignores EPIPE and backpressure. [B]**  
**Accept.** Draft3: prompts assembled in-memory, single `child.stdin.end(buffer)` call. `child.stdin.on('error')` attached before writing; EPIPE treated as "child died during prompt send." Prompt size validated at assembly time with a configurable ceiling (default 4MB). `spawn` vs `error` events handled separately (ENOENT arrives on error).

**D22 — SIGTERM + "wait briefly" is not a process lifecycle. [B]**  
**Accept.** Draft3 spec:
- Spawn children with `detached: true` + own session so each gets a process group.
- Shutdown: `process.kill(-pgid, 'SIGTERM')`, wait 10s, `process.kill(-pgid, 'SIGKILL')`.
- Sessions table stores `{pid, pgid, started_at}`. On restart, probe each with `kill(pid, 0)`, reap stale processes, mark cancelled.
- Add `yoke doctor` command to list dangling processes.

**D23 — Heartbeat on stdout-silence false-positives on long tool calls. [B,Q]**  
**Accept.** Draft3 distinguishes two signals:
1. **Liveness** — PID alive AND (if in a tool_use) the tool has not exceeded its per-tool wall-clock budget.
2. **Stream activity** — stdout-silence threshold applies only *outside* a tool_use.  
Heartbeat *never kills*; it surfaces a warning in the UI. User decides. Activity-timeout thresholds are configurable, with sane defaults per tool class.

---

## G. Retry + recovery

**D24 — Retry conflates intra-session hook loop and outer harness re-invocation. [B]**  
**Accept.** Draft3 renames: `max_outer_retries` (harness re-invokes after session ends in failure) vs. `max_inner_hook_retries` (Stop hook's own counter in a worktree state file). Hook writes its counter to `.yoke/hook-state.json` and exits 0 after N to hand control back. Plan documents the sequence explicitly.

**D25 — Retry modes should branch. [Q,B]**  
**Accept.** Draft3 defines `retry_mode: continue | fresh_with_failure_summary | fresh_with_diff`. Default escalation ladder: attempt 1 = `continue`, attempt 2 = `fresh_with_failure_summary` (harness writes summary into `handoff.json`, spawns fresh session), attempt 3 = `awaiting_user`.

**D26 — `-c` is a context-recovery mechanism, not crash-recovery. [A,B]**  
**Accept.** Draft3 splits:
- **Continuation** = intra-phase resume with `-c` when retry_mode is `continue`. Soft optimization.
- **Resumption** = post-crash recovery. Always a fresh session; harness reconstructs context from artifacts + progress.md + handoff.json + git log. `-c` is attempted as a soft optimization only, never load-bearing. Recovery correctness does not depend on it.

**D27 — Recovery from dirty worktree unspecified. [B]**  
**Accept.** Draft3: before any resume attempt, harness inspects `git status`. If dirty, auto-stash with `yoke-crash-stash-<timestamp>` name (configurable to `commit-wip` instead). Stash surfaced in dashboard. For `review` state at crash, partial `reviews/feature-N/*` files are deleted before re-running.

---

## H. Hooks & quality gates

**D28 — Hook contract has no completion signal; harness can't verify enforcement happened. [A]**  
**Accept.** Draft3 adds a minimal hook contract: the Stop hook must write `.yoke/last-check.json` on success listing which gates ran and their outcomes. Harness validates this file before accepting phase completion. Absent file → phase rejected with "implementer did not declare quality gate results." Dashboard displays the manifest.

**D29 — Hook exit code semantics unverified. [B]**  
**Accept** (structure).  
Draft3 adds a "Hook Contract" subsection specifying exit code mapping for each hook type, hook stdin JSON schema, and hook stdout JSON schema. Values are marked "to be verified in Phase γ research" — do not guess.

**D30 — Stop-hook-as-gate is not tamper-proof. [Q]**  
**Accept** (partial).  
Draft3 adds:
- Checksum the hook script + `package.json` (or equivalent) at workflow start.
- Stop hook output includes a signed manifest `{test_count, test_pass_count, file_checksums_of_test_files}` the harness sanity-checks against the prior session.
- Reviewer checks that test files were touched alongside production files (anti-skip heuristic).
- **Skeptical re-run mode** deferred: see D50 in open questions.

**D31 — Hook failures beyond `exit 2` unhandled. [Q]**  
**Accept.** Draft3: harness validates hook existence + executability at workflow start (fail fast). Hook stdout/stderr captured with byte cap. **Hook is the single allowed wall-clock timeout exception** — configurable, default 15 minutes. Hung hook killed and reported. Hook checksum verified at Stop; divergence is a hard fail.

---

## I. Testability

**D32 — No mocking strategy; plan is untestable as written. [Q]**  
**Accept.** Draft3 introduces a `ProcessManager` interface with two implementations:
- `JigProcessManager` — production
- `ScriptedProcessManager` — replays recorded stream-json JSONL + injected exit codes + injected stderr + configurable timing.

Draft3 adds a `yoke record` mode that captures real sessions into fixtures. At least one fixture per phase in Must-Have v1.

**D33 — Crash recovery has no test strategy. [Q]**  
**Accept.** Draft3 adds a `FaultInjector` seam with named checkpoints: `before_persist`, `after_persist_before_spawn`, `after_spawn_before_ack`, `during_artifact_read`, `during_hook_exec`, `during_cleanup`. Each checkpoint can be configured to `panic`, `exit`, `kill-9-child`, or `corrupt-next-write`. Tests drive the pipeline, trigger fault, invoke recovery, assert convergence. SQLite state transitions wrapped in transactions with explicit fsync.

---

## J. Observability & failure enumeration

**D34 — No correlation IDs, no structured log schema, no timeline endpoint. [Q]**  
**Accept.** Draft3 defines a structured log schema: every record has `{ts, workflow_id, feature_id, phase, session_id, attempt, event_type, level, message, ...extra}`. Every child process receives these as env vars. Harness logs go through an enforcing logger. Adds `GET /workflows/:id/timeline` endpoint merging SQLite events + per-session JSONL — **promoted to v1**.

**D35 — Failure modes not enumerated. [Q]**  
**Accept.** Draft3 adds a "Failure Modes" table with columns `{failure, detection, user-visible outcome, recovery action, test fixture}`. Entries include: jig not installed, jig profile missing, worktree create fails, SQLite locked/corrupt, bootstrap command fails, rate limit mid-stream, OAuth expired mid-stream, process killed externally, GitHub API down, gh unauthenticated, prompt template missing, template variable undefined, features.json schema mismatch, branch name collision, clock skew, disk full mid-write, hook missing, hook hang, malformed stream-json. Every listed failure requires a fixture.

**D36 — v1 checklist is a feature list, not a release gate. [Q]**  
**Accept.** Draft3 adds a "v1 Acceptance" section — concrete scenarios QA phase mechanically runs. Release gate = all green. See runbook Phase ζ.

---

## K. Security & threat model

**D37 — `--dangerously-skip-permissions` default has no threat model. [B,Q]**  
**Accept.** Draft3 adds a "Threat Model" section:
- Spec content is **untrusted input** (may be pasted from Slack, GitHub, etc.).
- The agent may attempt actions outside its scope (prompt injection, confused deputy).
- The developer machine is the trust boundary.

Mitigations in v1:
- `yoke init` scaffolds a `PreToolUse` deny hook: writes outside worktree path; reads of `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`; curated Bash deny-list (`curl|sh`, `rm -rf /`, `chmod -R 777`, etc.).
- Config flag `safety_mode: strict | default | yolo`.
- First-run approval required for any `init.sh` generated by a planner.
- Sandboxing (firejail, sandbox-exec) remains a v2 concern. **Needs-input D51.**

---

## L. SQLite & persistence

**D38 — No migration story, missing indexes, WAL not explicit. [B]**  
**Accept.** Draft3:
- Adds `schema_migrations` table + forward-only migration runner (SQL files in `migrations/`).
- Declares indexes: `idx_features_workflow`, `idx_sessions_workflow`, `idx_workflows_status`, `idx_sessions_feature`.
- Explicit `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL`.
- All state transitions wrapped in `db.transaction(...)()`.
- Dashboard reads use a separate read-only connection.
- Adds an append-only `events` table for state machine debug trace (promoted from v1.1 to v1).

**D39 — `token_usage TEXT` blob prevents aggregation queries. [A]**  
**Accept.** See D16.

---

## M. Worktree management

**D40 — Worktree creation has unhandled race conditions and failure modes. [B]**  
**Accept.** Draft3:
- Branch names always suffixed with workflow id: `yoke/<name>-<shortid>`, never reused.
- Bootstrap is its own phase in the state machine (`bootstrap_failed` is a terminal state for manual inspection; no auto-cleanup).
- Config guide documents bootstrap is responsible for reproducing gitignored state.
- New `.yoke/teardown.sh` hook runs before `git worktree remove` (stops containers, etc.).
- Cleanup order: kill tracked child pids → run teardown → `git worktree remove --force` → handle unmerged-branch case.
- Never auto-cleanup a worktree whose branch has unpushed commits unless PR creation succeeded.

---

## N. Frontend / rendering

**D41 — Virtualization unscoped. [F]**  
**Accept.** Draft3 commits to `@tanstack/react-virtual` with variable-size + measure-on-mount. Follow-tail mode auto-scrolls within N pixels of bottom, detaches on upscroll, "Jump to latest" pill to reattach. Text deltas buffered in 16ms rAF flush. Hard cap 10k events in-memory; older events paged from server log. Persistent scroll position across tab switches.

**D42 — Manual control state machine missing. [F]**  
**Accept.** Draft3 adds a control matrix keyed on `(workflow.status, feature.status, session.status)` producing `{allowed, requiresConfirm, optimisticState}`. Every control RPC carries client-generated `commandId`; server idempotent on it. UI shows pending state until server echoes transition.

**D43 — "Inject context" has no state model. [F,Q]**  
**Accept.** Draft3 commits to: inject-context queues for the next session of the target feature. Shown as pending chip on the feature card with edit/cancel until consumed, then immutable annotation on the consuming session. Stored in `handoff.json`. Live mid-session injection explicitly out of scope.

**D44 — Feature board does not scale to 50+ features. [F]**  
**Accept.** Draft3 specifies: group by `category` (collapsible, localStorage-persisted), status filter chips with counts, fuzzy text search over id+description, deep-link `/workflows/:id/features/:featureId`, sticky header with currently-streaming feature pinned, j/k keyboard nav.

**D45 — Browser push requires machinery the plan ignores. [F]**  
**Accept.** Draft3: service worker + explicit one-time permission-gesture banner. `registration.showNotification` for background tabs. Denied → in-app toast + persistent bell badge. Never re-prompt. OS-level push while browser closed is explicitly out of scope — macOS native covers that case.

**D46 — Review fan-out rendering needs a special case. [F]**  
**Accept.** Draft3: detect `Task` tool_use in the orchestrator stream, render each as a collapsible subagent row with parsed child events, summary strip at top of review panel with per-angle status dots. Subagents run sequentially — no promise of true parallel live panes.

**D47 — Workflow history list is undefined. [F]**  
**Accept.** Draft3: `GET /api/workflows?status=&q=&before=&limit=` with keyset pagination. UI gets filter bar, date range, archive toggle, star-to-pin, link to artifacts dir.

**D48 — GitHub button states not enumerated. [F]**  
**Accept.** Draft3 defines `githubState: {status, prNumber?, prUrl?, prState?, error?, lastCheckedAt}` with states `disabled | unconfigured | idle | creating | created | failed`.

**D48a — Session log storage must be v1, not v1.1. [F,Q]**  
**Accept.** Backfill-on-reconnect and debugging both depend on stored stream-json. Storage + HTTP paging endpoint promoted to v1 Must-Have. Searchable log viewer stays v1.1.

---

## O. Notifications

**D49 — Fire-and-forget hides failures that matter most. [Q,F]**  
**Accept.** Draft3 classifies:
- `info` — fire-and-forget (feature started, etc.)
- `requires_attention` — retried with backoff across channels; persisted as "pending user attention" in SQLite; surfaced as a dashboard banner until acknowledged.  
The dashboard banner is authoritative; push/native is best-effort augmentation.

---

## P. Scope movements (v1 ↔ v1.1)

| Item | Draft2 | Draft3 | Reason |
|---|---|---|---|
| Feature dependency ordering (topo sort) | v1.1 | **v1** | `depends_on` already in v1 schema; incoherent otherwise. [D08] |
| Session log storage + paging endpoint | v1.1 | **v1** | Backfill-on-reconnect depends on it. [D48a] |
| Structured log schema + timeline endpoint | v1.1 | **v1** | Cannot debug v1 without it. [D34] |
| `events` append-only table | implied v1.1 | **v1** | Cheap now; debug trace is load-bearing. [D38] |
| Failure modes table + fixtures | not listed | **v1** | Release gate. [D35] |
| v1 Acceptance scenarios | not listed | **v1** | Release gate. [D36] |
| Handoff.json cross-phase channel | not listed | **v1** | Solves the leak. [D13] |
| PreToolUse safety hook scaffolding | not listed | **v1** | Threat model. [D37] |
| ScriptedProcessManager + fixtures | not listed | **v1** | Untestable otherwise. [D32] |
| FaultInjector | not listed | **v1** | Crash recovery verification. [D33] |
| Optional usage gate | v1.1 | v1.1 | Unchanged. [D02] |
| Iterative planning (feature) | v1.1 | v1.1 | Structure moved to v1 [D09]; UX stays v1.1. |
| Searchable log viewer UI | v1.1 | v1.1 | Unchanged; storage is v1 but viewer is not. |
| Parallel workflows | v1 | v1.1 | Halves v1 failure surface. [D52] |
| Pre/post phase command hooks | not listed | **v1** | Core configurable quality-gate path. [D50] |
| Phase transition via condition commands | part of v1.1 iterative planning | **v1** | Generalizes re-plan into any branching. [D53] |
| Jig as dependency | implied | **optional (docs only)** | Command-agnostic spawn. [D55] |
| `keep_awake` opt-in | not listed | **v1** | Laptop overnight workflows. [D60] |
| Passive rate-limit auto-retry | partial | **v1** | Enter `rate_limited`, resume after reset. [D61] |
| Proactive budget pause | not listed | v1.1 | Workflow-level % threshold. [D61] |

---

## Q. Resolved decisions (D50–D61)

**D50 — Configurable pre/post phase command hooks. [Q]**  
**Accept (reframed).** Instead of a polyglot test-rerun engine, the harness supports `pre:` and `post:` command arrays per phase. Each command runs in the worktree at the phase boundary; exit 0 = pass, nonzero = failure path (see D53). Output captured to the session log and displayed in the dashboard. This subsumes "skeptical re-run" (drop your test command in `post:`), enables static analysis enforcement, and lowers the barrier for quality gating — users who don't want to write a Claude Stop hook can configure `post:` commands instead. No polyglot runner in the harness; it's just shell.

**D51 — Sandboxing deferred to v2. [Q,B]**  
**Accept.** v1 ships example PreToolUse safety templates + `safety_mode` config + threat model doc. Strong sandboxing (firejail, sandbox-exec, Docker) is v2.

**D52 — v1 ships single-workflow; parallel is v1.1. [Q]**  
**Accept.** Roughly halves v1 failure surface. Multiple Yoke *instances* of the same user are fine — only concurrent workflows within one instance are deferred.

**D53 — Phase transitions via condition commands. [A]**  
**Accept (reframed).** Generalizes iterative re-planning into any branching. Each `post:` command declares per-exit-code actions. Supported actions:
- `continue` — proceed to next phase in graph
- `goto: <phase-name>` — absolute jump
- `goto-offset: +N` / `goto-offset: -N` — relative jump in the declared graph order
- `retry: { mode: continue | fresh_with_failure_summary | fresh_with_diff, max: N }`
- `stop-and-ask` — enter `awaiting_user`
- `stop` — terminate workflow
- Loop guard `max_revisits: N` per destination prevents infinite cycles; exceeding it collapses to `awaiting_user`.

Users wire any artifact/command to any action. Example in plan-draft3. Locked to neither `features.json` nor any other artifact shape.

**D54 — `architecture.md` is both input and output. [A]**  
**Accept.** If present, planner reads it; proposed changes go to `architecture-proposed.md` for user approval. If absent, planner drafts one. Works for greenfield and brownfield.

**D55 — Jig is optional; hooks are Claude's. [A,B]**  
**Accept (reframed — significant shift).**  
- Yoke spawns a user-configured command per phase. Default is `claude` directly; `jig run <profile> --` is documented as a recommended layer but is not required or assumed by any harness code. Yoke's config schema has `command: string` and `args: string[]` per phase; phase definitions may also set env vars and working dir.
- Hooks live in Claude's namespace (`.claude/hooks/` or wherever jig profiles point). Yoke does **not** own a hook directory and does not install hooks into one. 
- Yoke ships **example templates** under `docs/templates/hooks/` that users can copy into `.claude/hooks/` (optionally scaffolded by `yoke init`) but the install decision is the user's.
- Quality gating is the user's choice among: (a) a Claude Stop hook, (b) Yoke `post:` commands (D50), (c) both, or (d) neither. All four are supported. `.yoke/last-check.json` becomes an **optional convention** — if a user's Stop hook emits it, the dashboard displays it; the harness does not require its presence to accept a phase.
- Harness accepts phase completion when: (1) agent session ended with exit 0 AND no stream-json error frames, (2) all configured `post:` commands passed, (3) any configured artifact validators passed. Nothing else.
- Reviewer subagent scoping: recommended via jig profiles in docs, but Yoke does not assume it. If the user is running plain `claude`, the scoping responsibility is theirs (or handled via Claude's own tool-permission configuration).

**D56 — Review-triggered re-implement: fresh by default, configurable. [A]**  
**Accept.** Default is fresh; review findings become `handoff.json` entries seeding the new session. Per-phase override `on_review_fail: { retry_mode: continue | fresh }` available in config.

**D57 — Always single-user; multiple instances of same user allowed. [F]**  
**Accept.** No auth ever. Dashboard binds 127.0.0.1 only. Running `yoke start` twice (different ports, different project dirs) is supported — that is the only "multi" dimension.

**D58 — Retention: SQLite forever, logs 30d/2GB, worktrees on workflow completion. [Q,F,B]**  
**Accept.** All configurable. Remote forwarding of stream-json logs (e.g., for team-wide analysis) is the user's concern — not a v1 harness feature.

**D59 — Workflow continues non-dependent features when one blocks. [Q]**  
**Accept.** Cascade-block dependents. Workflow reaches "completed with blocked features" terminal state with a summary notification.

**D60 — Laptop-primary + opt-in keep-awake. [Q]**  
**Accept.** Default is laptop-primary (sleep → wake reconciliation, stale sessions cancelled). New config option `keep_awake: true` (workflow-level or global): on workflow start, Yoke spawns a platform child that prevents idle sleep while still allowing screen blank / screensaver:
- macOS: `caffeinate -i -w <yoke-pid>` (auto-dies with yoke)
- Linux: `systemd-inhibit --what=idle --who=yoke --why="<workflow-id>" sleep infinity`
- Windows: deferred (Win32 API call required).
Child killed on workflow terminal state. User sees a "keeping machine awake" chip in the dashboard.

**D61 — Rate-limit handling tiered. [Q]**  
**Accept (tiered).**
- **v1 (passive auto-retry):** parse rate-limit from stream-json error frames, extract reset timestamp, enter first-class `rate_limited` state, suppress stall heartbeat, auto-resume via fresh session after reset. `handoff.json` already captures continuable state. Notify at `requires_attention`.
- **v1.1 (proactive pause near ceiling):** user sets a workflow-wide `usage_pause_threshold` (percent of current window, default unset). Harness accumulates usage from stream `UsageUpdate` events. Crossing threshold → signal active session to wrap up (`fresh_with_failure_summary` with "approaching usage ceiling, save state cleanly and stop" in `handoff.json`), then pause workflow in `awaiting_retry` until user resumes or ceiling resets. No per-step/per-feature budgets — the pause is workflow-wide.
- **v2 (active polling):** status-line polling or ephemeral probe sessions for precise ceiling visibility.

---

## Summary of dispositions

- **Accepted into draft3:** 61 decisions (D01–D61). D50, D53, D55, D61 accepted *reframed* from their original proposed defaults.
- **Needs user input:** none — all resolved.
- **Deferred / unchanged:** none.

The draft3 plan (see `plan-draft3.md`) incorporates every decision. The `⚠ needs-confirm` markers have been removed and replaced with the final text.

---

## R. Phase γ empirical corrections (2026-04-12)

Non-blocking corrections from `docs/research/hook-semantics.md`. None
require architectural amendment; all affect docs/templates scope only.

**R01 — Hook configuration path.**  
Plan references `.claude/hooks/` directory (lines 473, 477, 944 of
plan-draft3). Empirically, hooks are JSON entries in
`.claude/settings.json` under the `"hooks"` key. There is no
`.claude/hooks/` directory. **Impact:** `yoke init` scaffolding would
need to (a) copy script files somewhere the user chooses and (b) show
the user what JSON to merge into `.claude/settings.json`, rather than
copying files into a hook directory. Affects Phase ε/ζ docs and `yoke
init` UX, not v1 core engine.

**R02 — Default hook timeout.**  
Plan says "15 min, same ceiling as hooks" (line 181). Actual default
for Claude Code command hooks is **600 seconds (10 minutes)**, not 15
min. The Yoke `post:` command timeout default should be set
independently (plan already says "configurable per command").

**R03 — `stop_hook_active` replaces counter file.**  
Plan references "inner retry counter in `.yoke/hook-state.json`"
(line 145) for Stop hook loop prevention. Claude Code provides a
simpler built-in mechanism: `stop_hook_active` boolean in the hook's
stdin JSON. When `true`, the hook has already fired once this turn and
triggered a continuation — the hook should exit 0 to break the cycle.
The example templates should use this instead of maintaining a counter
file. `.yoke/hook-state.json` is unnecessary for this purpose.

---

## S. List-view `depends_on` surfacing (2026-04-22)

**S01 — `ItemProjection` gains `dependsOn` and `displayDescription`.**
The FeatureBoard list view now shows a "Waiting on: …" line for
pending/blocked items whose deps aren't `complete`, answering the
"concurrency budget free but sessions idle" question directly. The
`blocked_reason` row UUIDs are translated to stable IDs at render
time. `items_display.description` is a new optional JSONPath that
feeds a per-card description line. Backend projection is
snapshot-only (dep lists only mutate in the seeder). Closes the
`## List view depends_on` future-work entry.
