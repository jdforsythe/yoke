# Yoke — Plan Draft 3

Supersedes `plan-draft2.md`. Incorporates all decisions from `change-log.md` (D01–D61). Phase α.5 is closed — the `⚠ needs-confirm` markers that previously lived here have been resolved and removed.

Section headings track draft2 where possible for side-by-side comparison.

---

## Vision

Yoke is a configurable orchestration harness that wraps Claude Code (via `jig`) to enable reliable, long-running, autonomous software development on a Max subscription. Work is decomposed into configurable phases, each running as an independent agent session with scoped tools and context. Agents communicate exclusively through **file artifacts** — not message passing, not shared context. A lightweight server manages the workflow state machine, captures structured logs, and provides a web UI for monitoring and intervention.

**Yoke is Claude-Code-native.** It does not pretend to be adapter-ready for other agents. Every core mechanism — stream-json parsing, `-c` continuation, hook-based quality gates, `Task`-tool subagents — is a Claude-Code-ism by design, not behind an adapter. A different backend would be a rewrite. This is deliberate. See §Principles.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                 Web Dashboard (React + Vite)              │
│  Workflow list · Feature board · Live streaming pane     │
│  Manual controls · GitHub buttons · System notices       │
└──────────────────────┬───────────────────────────────────┘
                       │ WebSocket (envelope + seq)
┌──────────────────────▼───────────────────────────────────┐
│                  Yoke Server (Node / TS)                  │
│                                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Pipeline Engine                       │   │
│  │  state machine · transition table · ajv validators│   │
│  │  (reads & writes SQLite directly — SQLite is the  │   │
│  │  single source of truth for workflow state)       │   │
│  └──────┬─────────────────────┬──────────────────────┘   │
│         │                     │                          │
│  ┌──────▼─────────┐    ┌──────▼──────────┐              │
│  │  Process Mgr   │    │  Worktree Mgr   │              │
│  │  spawn + group │    │  create/boot/   │              │
│  │  stream-json   │    │  stash/cleanup  │              │
│  │  NDJSON parser │    │                 │              │
│  │  heartbeat     │    └─────────────────┘              │
│  └──────┬─────────┘                                      │
│         │                                                │
│  ┌──────▼─────────┐    ┌─────────────────┐              │
│  │ Session Log    │    │  Prompt Asm     │              │
│  │ Store (.yoke/) │    │  pure fn        │              │
│  │ JSONL captures │    │  (tmpl, ctx)→str│              │
│  │ survives wtree │    └─────────────────┘              │
│  │ cleanup        │                                      │
│  └────────────────┘    ┌─────────────────┐              │
│                        │  GitHub (oct+gh)│              │
│  ┌────────────────┐    └─────────────────┘              │
│  │ SQLite (WAL)   │                                      │
│  │ ← canonical →  │    ┌─────────────────┐              │
│  │ workflows      │    │ Notification Svc│              │
│  │ features       │    │ info | attn     │              │
│  │ sessions       │    └─────────────────┘              │
│  │ events         │                                      │
│  │ artifact_writes│                                      │
│  │ schema_migr.   │                                      │
│  └────────────────┘                                      │
└──────────────────────────────────────────────────────────┘
          │ stdin pipe to child_process (detached pgroup)
          ▼
┌──────────────────────────────────────────────────────────┐
│              Agent Execution (command-agnostic)            │
│                                                           │
│  spawn(cfg.command, cfg.args)  // default: claude         │
│    e.g. claude -p --output-format stream-json             │
│    or   jig run <profile> -- (if user configures it)      │
│  Prompt delivered via stdin (one-shot buffer)             │
│  Quality gating (user's choice):                          │
│    - Claude Stop hook (project-owned) AND/OR              │
│    - Yoke post-phase commands (D50)                       │
│  Subagents write reviews directly to reviews/feat-N/      │
│  All work in isolated git worktrees                       │
└──────────────────────────────────────────────────────────┘
```

Key moves from draft2:
- "State Store" is no longer a separate box — it is SQLite, which is Pipeline Engine's backing tape. [D03]
- "Artifact Store" is split into **Session Log Store** (harness-owned, survives cleanup) and **Worktree Artifacts** (agent-produced, cleaned with worktree). [D04]
- `artifact_writes` and `events` tables added for provenance + debug trace. [D12, D38]

---

## Core Design Principles

1. **Agents communicate through files, not messages.** Planner writes `features.json` (projection only — see §File Contract), `architecture.md`, `handoff.json` seed. Implementer reads those, writes code + appends to `handoff.json` (with a prose `note`) + `.yoke/status-updates.jsonl`. Reviewer subagents write directly to `reviews/feature-N/<angle>.json`. No agent-to-agent message passing. No shared context.

2. **Quality gates are the user's choice of mechanism; the harness just runs what you configure.** Users may wire quality gates via (a) a Claude Stop hook, (b) Yoke `post:` commands (D50), (c) both, or (d) neither at their own risk. The harness accepts phase completion when the configured acceptance conditions pass — the agent session exited cleanly, every `post:` command returned success, and every configured artifact validator passed. Yoke does not own a hook namespace. Yoke ships example templates users can copy; `yoke init` can scaffold them on opt-in. `.yoke/last-check.json` is an **optional convention**: if a user's Stop hook emits it, the dashboard displays its contents; the harness does not require its presence. [D28, D30, D50, D55]

3. **Yoke orchestrates, Claude Code executes.** Yoke decides what to do next and whether previous work was valid. Claude Code does the work. Yoke never edits user code.

4. **Claude-Code-native, unapologetically — but not jig-dependent.** stream-json, `-c`, Claude hooks, `Task` subagents are not behind an adapter. v1 assumes Claude Code. It does **not** assume `jig`: each phase declares the command it spawns (default `claude`); `jig` is a documented-recommended layer for agent-profile scoping, not a dependency. [D01, D55]

5. **Token usage is observed, not managed — except for an opt-in pre-flight check.** Yoke tracks and reports usage. It does not throttle. A single opt-in usage gate per phase (v1.1) is the only exception. [D02]

6. **SQLite is the single source of truth for workflow state.** The Pipeline Engine holds no durable in-memory state. Read, transition, write, re-read. Any in-memory object is a short-lived projection. [D03]

7. **Phase names are labels, not enums.** The state machine knows transitions, not phase identities. Users define pipelines as graphs; Yoke does not hard-code "plan → implement → review." [D05]

8. **Artifact integrity is structural, not prompted.** Rules about "agents must not edit X" are enforced by the harness diffing before/after, not by asking the agent nicely. [D10]

---

## Workflow Lifecycle

### Phase: Plan

A planner session, fresh context, read-only tools (Read, Glob, Grep, LS).

**Input:** user-provided spec (text/markdown/file) + `architecture.md` if present. If absent, planner drafts one. If present, planner reads it and may propose updates, written to `architecture-proposed.md` for user approval (never mutates `architecture.md` directly). [D54]

**Output artifacts:**
- `features.json` — agent-produced, but a **projection only** (see §File Contract). Harness ingests into SQLite as canonical.
- `architecture-proposed.md` — if the planner wants to propose changes to an existing `architecture.md`.
- `init.sh` — optional bootstrap. Requires first-run user approval (threat model, §Threat Model).

Planner defines `acceptance_criteria` and `review_criteria` per feature. Review criteria come from (a) planner-specific per-feature criteria, (b) configured review agent definitions (security, complexity, etc.).

Harness validates: `features.json` parses, matches schema, ≥1 feature, each has description + acceptance criteria + review criteria, `depends_on` forms a DAG.

### Phase: Implement (per feature, topologically ordered)

A fresh implementer session per feature. Full tools (Read, Edit, Write, Bash, Glob, Grep + configured MCP).

**Input prompt (via stdin, one-shot buffer):**
- Feature spec (pulled from SQLite, not worktree)
- Architecture.md (if present)
- `handoff.json` entries relevant to this feature (each entry carries a `note` with the prior session's narrative) (structured cross-phase context, including any queued inject-context, retry history, reviewer notes from prior attempts)
- Recent git log (last 20 commits)

**Output:**
- Code changes committed to git
- `.yoke/status-updates.jsonl` appended (narrow status channel — this is how the implementer reports status to SQLite)
- `handoff.json` entry for this attempt (intended_files, deferred_criteria, known_risks)
- `.yoke/last-check.json` — **optional**, written by a user-configured Stop hook if the user chose that quality-gate path

**Permission mode:** Claude permission mode is whatever the user's command configuration requests (commonly `bypassPermissions` in agent workflows). Yoke does not set this; it passes through args/env to the spawned command.

**Quality gates (user-configured, two paths):**
- **Claude Stop hook** (project-owned, lives in `.claude/hooks/` or equivalent) — runs typecheck/lint/test/build. Exit 2 blocks stop and feeds stderr back. Inner retry counter (if the user implements one) lives in `.yoke/hook-state.json`. [D24, D28, D31]
- **Yoke `post:` commands** (phase-level, see §Phase Pre/Post Commands) — harness runs after session exit. Exit 0 = pass; nonzero branches per D53. Lower-barrier than writing a hook.

Users may use either path, both, or neither. Yoke `init` offers an optional quick-start that scaffolds example templates the user can keep, edit, or delete.

**Retry:** when the session ends in failure, harness follows the outer-retry ladder: attempt 1 = `continue` (soft, `-c`-based); attempt 2 = `fresh_with_failure_summary` (handoff.json updated, new session); attempt 3 = `awaiting_user`. Configurable per phase. [D25]

### Phase: Review (per feature)

Orchestrator session spawns N subagent reviewers in sequence. Each subagent is scoped to read-only tools (Read, Bash, Glob, Grep) plus a narrow Write scoped to `reviews/feature-N/<angle>.json`. How that scoping is enforced depends on the user's command configuration — jig profiles are the recommended mechanism in the docs, but Claude's own tool-permission config or a PreToolUse deny hook are equally valid. The orchestrator never sees verdict content. [D14, D55]

Harness aggregates after the orchestrator exits: deterministic `any(fail) → fail`. Aggregation lives in the Pipeline Engine, not in a prompt.

Each reviewer verdict must cover every `acceptance_criteria` and `review_criteria` entry with explicit pass/fail+notes. Missing coverage → reject the review as `review_invalid`, re-run.

On fail:
- Review-triggered re-implement defaults to a **fresh** session; review notes become handoff.json entries seeding it. Per-phase config override: `on_review_fail: { retry_mode: continue | fresh }`. [D56]
- Max review rounds configurable, default 2, then `awaiting_user`.

### Completion

When all features reach `complete` or `blocked`, harness runs the summary, notifies user (severity: `info`), optionally creates a PR.

---

## Phase Pre/Post Commands [D50, D53]

A lightweight, configurable way to run arbitrary shell commands at phase boundaries with exit-code semantics. This is the primary mechanism for users who want enforcement without writing a Claude Stop hook, and the primary mechanism for phase-transition branching (replaces the hard-coded "iterative planner" affordance).

### Semantics

Each phase node in the pipeline may declare `pre:` and `post:` command arrays:

- `pre:` runs in the worktree **before** Yoke spawns the agent for that phase. A failing `pre:` step blocks the phase from starting. Typical use: env validation, git cleanliness, port availability.
- `post:` runs in the worktree **after** the agent session exits (exit 0 AND no stream-json error frames). `post:` commands run sequentially. A command's exit code maps to an **action** declared in that command's spec.

Both `pre:` and `post:` commands run with `spawn(cmd, args, {shell: false})`, CWD = worktree path, stdout/stderr captured to the session log and surfaced in the dashboard (same rendering path as `SystemNotice`), wall-clock timeout configurable per command (default 15 min, same ceiling as hooks).

No polyglot runner: Yoke runs whatever shell command you give it and reads `$?`. Users bring their own static analyzers, test runners, schema validators, etc.

### Action grammar

Each command declares `actions: { <exit-code or wildcard> → <action> }`. Supported actions:

| Action | Effect |
|---|---|
| `continue` | proceed to next command in the same array, or on the last command, fire `complete` event for the phase |
| `goto: <phase-name>` | absolute jump: next phase becomes `<phase-name>` |
| `goto-offset: +N` / `goto-offset: -N` | relative jump in declared graph order (allows "go back one step") |
| `retry: { mode, max }` | re-run the phase with the given retry mode; `mode` is `continue \| fresh_with_failure_summary \| fresh_with_diff`; exhaustion → `awaiting_user` |
| `stop-and-ask` | set workflow to `awaiting_user` with a message |
| `stop` | terminal: workflow abandoned |
| `fail: { reason }` | phase fails; normal outer retry ladder applies |

Loop guard: each `goto*` action supports `max_revisits: N` (default 3) per destination. Exceeding it collapses to `awaiting_user` to prevent infinite loops.

### Example (iterative planning via post-command, not hardcoded)

```yaml
phases:
  plan:
    command: claude
    args: ["-p", "--output-format", "stream-json"]
    prompt_template: "prompts/plan.md"
    output_artifacts:
      - { path: "features.json", schema: "schemas/features.schema.json", required: true }
    post:
      - name: "check-needs-more-planning"
        run: ["jq", "-e", ".needs_more_planning == true", "features.json"]
        actions:
          0: { goto: "plan", max_revisits: 3 }   # 0 = the jq predicate matched; re-plan
          1: "continue"                          # 1 = predicate false; proceed
          "*": { fail: { reason: "planning-check errored" } }

  implement:
    command: claude
    args: ["-p", "--output-format", "stream-json"]
    prompt_template: "prompts/implement.md"
    pre:
      - name: "worktree-clean"
        run: ["git", "diff", "--quiet"]
        actions: { 0: "continue", "*": "stop-and-ask" }
    post:
      - name: "static-analysis"
        run: ["./scripts/check.sh"]
        actions:
          0: "continue"
          "*": { retry: { mode: "continue", max: 1 } }
      - name: "surface-claude-hook-manifest"    # optional: user has a Stop hook writing .yoke/last-check.json
        run: ["test", "-f", ".yoke/last-check.json"]
        actions: { 0: "continue", "*": "continue" }   # non-fatal; display only
```

The example is illustrative — none of the commands, artifacts, or action choices are hard-coded into the harness. Users with a different workflow wire different commands and actions.

### Interaction with Claude Stop hooks

Both paths can coexist. A user with a mature Claude Stop hook already enforcing tests/lint/build may skip `post:` entirely. A user who wants to stay out of hooks can drive all gating through `post:`. A user who wants layered defense can do both — the Stop hook gates the session, and a `post:` command asserts `.yoke/last-check.json` shape as a secondary check. Yoke treats both as equivalent inputs to phase completion.

---

## State Machine (new in draft3)

### States

| State | Meaning |
|---|---|
| `pending` | feature not yet started |
| `ready` | dependencies complete, eligible to start |
| `bootstrapping` | worktree bootstrap running |
| `bootstrap_failed` | terminal until user action; no auto-cleanup |
| `in_progress` | implementer session active |
| `awaiting_retry` | between failed attempt and next attempt (backoff window) |
| `review` | reviewer orchestrator running |
| `review_invalid` | reviewer output failed schema validation; re-run |
| `rate_limited` | Claude Code signaled rate limit; waiting with backoff |
| `awaiting_user` | all retries exhausted or policy requires human decision |
| `blocked` | manual/dependency block; user-reachable with "retry with notes" |
| `complete` | all reviews passed |
| `abandoned` | user cancelled or workflow aborted |

### Transition table

Implemented as a TypeScript `const` with a unit test asserting every `(state, event)` pair has a defined transition. Draft3 ships the full table as `src/server/state-machine/transitions.ts`; critical rows summarized here:

```
(pending, deps_satisfied)             → ready
(ready, implement_phase_start)        → bootstrapping → in_progress
(in_progress, session_ok + manifest)  → review
(in_progress, session_fail + budget)  → awaiting_retry
(in_progress, rate_limit_detected)    → rate_limited
(awaiting_retry, backoff_done)        → in_progress
(rate_limited, probe_ok)              → in_progress
(review, all_verdicts_pass)           → complete
(review, any_verdict_fail + budget)   → in_progress (fresh)
(review, verdict_missing_or_invalid)  → review_invalid
(review_invalid, rerun)               → review
(*, retries_exhausted)                → awaiting_user
(awaiting_user, user_retry)           → in_progress
(awaiting_user, user_block)           → blocked
(blocked, user_unblock_with_notes)    → in_progress (fresh + handoff)
(*, user_cancel)                      → abandoned
```

Every feature failure runs through the **failure classifier**: `transient | permanent | policy | unknown`. Transient uses exponential backoff in a retry window, not a monotonic counter. Default unknown → `awaiting_user`. [D07]

### Dependency cascading

Topological sort is v1. On `in_progress → awaiting_user` or `blocked`, the harness marks all transitive dependents with `blocked` + `blocked_reason: "dependency <feat-id> <status>"`. [D08]

---

## File Contract

### features.json (in worktree — **read-only projection**)

The canonical feature store is the SQLite `features` table. `features.json` in the worktree is a snapshot written by the harness before each phase and deleted after. The implementer may **read** it but not write it.

Status updates from the implementer go through a narrow channel: the implementer appends lines to `.yoke/status-updates.jsonl`. Harness parses after session end and updates SQLite. The harness post-phase diff check rejects any non-whitespace change to `features.json` itself. [D10]

```json
{
  "project": "project-name",
  "created": "2026-04-11T12:00:00Z",
  "features": [
    {
      "id": "feat-001",
      "category": "auth",
      "description": "User can log in with email and password",
      "priority": 1,
      "depends_on": [],
      "acceptance_criteria": [
        "Login form accepts email and password",
        "Invalid credentials show error message",
        "Successful login redirects to dashboard"
      ],
      "review_criteria": [
        "No credentials stored in plaintext",
        "Rate limiting on login attempts",
        "Input sanitization on all form fields"
      ],
      "status": "pending",
      "current_phase": "plan",
      "blocked_reason": null,
      "implemented_in_commit": null,
      "created_by_session_id": "sess-abc",
      "last_updated_by_session_id": "sess-abc"
    }
  ]
}
```

### .yoke/status-updates.jsonl (implementer → harness)

```jsonl
{"feature_id":"feat-001","status":"review","commit":"abc1234","ts":"..."}
```

### handoff.json (structured cross-phase channel)

Per-workflow, append-only. Each entry carries a `note` (prose narrative) plus structured metadata. [D13]

```json
{
  "feature_id": "feat-001",
  "entries": [
    {
      "phase": "implement",
      "attempt": 1,
      "session_id": "sess-abc",
      "ts": "...",
      "intended_files": ["src/auth/login.ts", "src/auth/login.test.ts"],
      "deferred_criteria": [],
      "known_risks": ["bcrypt cost factor hardcoded at 10"],
      "retry_history": [],
      "reviewer_notes_seen": [],
      "user_injected_context": null
    }
  ]
}
```

User "inject context" entries queue here as `user_injected_context` and are consumed by the next session of that feature. [D43]

### reviews/feature-N/<angle>.json

Each reviewer subagent writes its own file. Schema is fixed:

```json
{
  "feature_id": "feat-001",
  "reviewer": "security",
  "reviewed_commit": "abc1234",
  "verdict": "fail",
  "acceptance_criteria_verdicts": [
    {"criterion": "Login form accepts email and password", "pass": true, "notes": ""}
  ],
  "review_criteria_verdicts": [
    {"criterion": "No credentials stored in plaintext", "pass": true, "notes": ""}
  ],
  "additional_issues": [
    {"severity": "high", "category": "security", "description": "...", "file": "...", "suggestion": "..."}
  ]
}
```

Every planner-defined criterion must appear in its verdicts array. Harness rejects incomplete reviews as `review_invalid`.

---

## Protocol Layer — stream-json parsing + WebSocket

### stream-json parsing [D15, D16]

**Framing:** NDJSON (one JSON object per line, `\n`-delimited). ⚠ empirical verification required in Phase γ research (see runbook).

**Parser:**
- Line-buffered reader: accumulate bytes in a `Buffer`, split on `\n`, parse complete lines, carry the trailing partial forward.
- Use `readline.createInterface({ input: child.stdout, crlfDelay: Infinity })` or a hand-rolled splitter. **Never** `JSON.parse` raw `data` chunks.
- Parse failure → log + skip + set `sessions.status_flags.parse_errors += 1`, do not crash pipeline.
- Line > 16 MB → truncate, mark session tainted with an `event`.
- stderr is a separate stream — never mixed into the JSON parser.

**Token usage:** extracted from stream-json events, written to `sessions` columns:
- `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `raw_usage TEXT`
- Resumed sessions chain via `parent_session_id`; per-session = delta, per-feature = sum across chain.
- Exact event carrying usage → **to verify in Phase γ research**.

### WebSocket envelope [D17]

**Server → client:**
```ts
interface ServerFrame {
  v: 1;
  type: ServerFrameType;
  workflowId: string;
  sessionId?: string;
  seq: number;        // monotonic per session
  ts: string;
  payload: unknown;
}
```
Types: `hello`, `workflow.snapshot`, `workflow.update`, `feature.update`, `session.started`, `session.ended`, `stream.chunk`, `stream.tool_use`, `stream.tool_result`, `stream.text`, `stream.thinking`, `stream.usage`, `stream.system_notice`, `notice`, `error`, `pong`, `backfill.truncated`, `workflow.index.update`.

**Client → server:**
```ts
interface ClientFrame {
  v: 1;
  type: 'subscribe' | 'unsubscribe' | 'control' | 'ack' | 'ping';
  id: string;    // client-generated commandId (idempotency)
  payload: unknown;
}
```

On connect, server emits `hello { v: 1, serverVersion }`. Client refuses mismatched version instead of silent garbage rendering.

### Backfill on reconnect [D19]

Client sends `subscribe { workflowId, sinceSeq? }`. Server replies with `workflow.snapshot` + bounded backfill from the Session Log Store, then switches to live. If `sinceSeq` is older than retained buffer, server returns `backfill.truncated` with an HTTP URL for paged fetch. Client dedupes by `(sessionId, seq)`.

### Subscription model [D20]

Single multiplexed socket per client. Explicit `subscribe`/`unsubscribe` by workflowId. Server only sends subscribed workflows + a lightweight `workflow.index.update` for the sidebar list. Cap: 4 concurrent streaming subscriptions; extras degrade to polled snapshots.

---

## Client Render Model [D18]

The client reduces wire frames into normalized events, distinct from the wire format:

| Event | Behavior |
|---|---|
| `TextBlock` | Mutable; deltas accumulate until `content_block_stop`, then frozen. Rendered as a stable component with mutable text ref. |
| `ToolCall` | Tool name, input JSON, status `pending → running → ok/error`, linked to `tool_result` by `tool_use_id`. Collapsible. |
| `ThinkingBlock` | Collapsed by default, muted treatment. |
| `SystemNotice` | Session start/end, retries, hook failures, rate-limit detection, harness state transitions. Left-rule accent, severity colored. [D49 feeds into this] |
| `UsageUpdate` | Not rendered inline; feeds the HUD. |

Virtualization: `@tanstack/react-virtual` with variable-size + measure-on-mount. Follow-tail within N pixels of bottom; detach on upscroll; "Jump to latest" pill. Text deltas buffered in 16ms rAF flush. Hard cap 10k events in-memory; older events paged from Session Log Store. Persistent scroll position across tab switches. [D41]

---

## Hooks Integration [D55]

Yoke does **not** own a hook directory. Claude Code's hooks are the project's own — installed wherever Claude Code expects them (e.g., `.claude/hooks/`), managed however the user manages them (plain files, jig profiles, etc.). Yoke's job is to *interoperate* with whatever the user configures, not to install or replace it.

### What Yoke provides

1. **Example templates** in `docs/templates/hooks/`. Users copy these into their Claude hook directory if they want a quick-start. `yoke init` may offer to scaffold them on opt-in; it never overwrites existing hooks.
2. **A conventional data channel** — any Claude Stop hook that writes `.yoke/last-check.json` in the worktree will have that manifest surfaced in the dashboard and (if the user declares it) validated via `post:` commands. The manifest shape is documented; the channel is **optional** — Yoke does not require it.
3. **Acceptance rules** for a phase (see Principle #2): agent exit clean + all `post:` commands passed + all configured artifact validators passed. Nothing more, nothing less.

### Optional: `.yoke/last-check.json` manifest

Users who want a structured manifest from a Claude Stop hook into the dashboard can emit this shape:

```json
{
  "hook_version": "1",
  "ran_at": "...",
  "gates": [
    { "name": "typecheck", "ok": true, "duration_ms": 1203 },
    { "name": "lint",      "ok": true, "duration_ms": 890 },
    { "name": "test",      "ok": true, "duration_ms": 5420, "test_count": 42, "pass_count": 42 },
    { "name": "build",     "ok": true, "duration_ms": 8100 }
  ]
}
```

If present, dashboard renders it as part of the phase summary. If absent, nothing breaks — the user is either gating through `post:` commands instead or has chosen not to gate. No tamper check runs by default; a user wanting one configures a `post:` command that asserts checksums of their hook files.

### Example-template quality gating (opt-in)

The bundled example template set is designed to work out of the box if the user opts in at `yoke init`:

- **PreToolUse safety template** — denies writes outside the worktree path, denies reads of `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.gnupg`, and curated Bash deny-list patterns. `safety_mode: strict | default | yolo` toggles aggressiveness.
- **Stop quality template** — runs project-type-detected typecheck/lint/test/build commands and emits `.yoke/last-check.json`.

These are examples. Users may edit, delete, or ignore them entirely. Yoke does not re-install them on subsequent runs.

### Hook failure modes (when a user *does* install hooks)

Documented in `docs/research/hook-semantics.md` after Phase γ. Yoke's interaction surface with hooks is: it spawns the agent, the agent (or Claude runtime) invokes hooks, the agent session exits. Yoke interprets the exit as it would any other session outcome. Hook *internals* are the user's problem.

### Hook exit code semantics (to verify in Phase γ research) [D29]

Research task captures real Claude Code hook behavior: exit code meanings, stdin JSON schema, stdout JSON schema, timeout behavior. Documented in `docs/research/hook-semantics.md`. Yoke templates refer to that document rather than hard-coding guesses.

---

## Worktree Management [D40]

### Lifecycle

```
User starts workflow "add-auth"
  │
  ├─► Harness creates worktree at .worktrees/yoke-add-auth-<shortid>
  │   (branch: yoke/add-auth-<shortid>, never reused)
  │
  ├─► Runs bootstrap commands (own phase in state machine)
  │    on success → ready
  │    on failure → bootstrap_failed (no auto-cleanup; user inspects)
  │
  ├─► All agent sessions run in the worktree directory
  │
  ├─► Commits land on yoke/add-auth-<shortid>
  │
  ├─► On completion: harness can create PR
  │
  └─► Cleanup: kill tracked child pids → run .yoke/teardown.sh →
      git worktree remove --force → branch handling
```

### Rules

- **Branch naming:** always suffix with short workflow id; never reuse.
- **Bootstrap atomicity:** bootstrap_failed is a terminal state pending user action. No auto-cleanup.
- **Gitignored state reproduction:** bootstrap is responsible for reproducing `.env`, containers, etc. Document this clearly in the config guide.
- **Teardown:** `.yoke/teardown.sh` runs before `git worktree remove` — stops containers, closes sockets, etc.
- **Cleanup order:** kill children → teardown → remove worktree → handle branch.
- **Unpushed commits:** never auto-cleanup a worktree whose branch has unpushed commits unless PR creation succeeded.

### Configuration

```yaml
worktrees:
  base_dir: ".worktrees"
  branch_prefix: "yoke/"
  auto_cleanup: true
  cleanup_tool: "git"       # git | lazyworktree | custom
  bootstrap:
    commands:
      - "pnpm install"
  teardown:
    script: ".yoke/teardown.sh"
```

---

## Process Management

### Spawning [D21, D22, D55]

Spawn is command-agnostic. Each phase declares `command: string` and `args: string[]` in the pipeline config. Default is `claude`. Users who want profile scoping configure `command: "jig"` with `args: ["run", "<profile>", "--", ...]`.

```ts
const child = spawn(phase.command, phase.args, {
  cwd: worktreePath,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ...phaseEnv, ...correlationEnv },
  detached: true,       // own process group for clean shutdown
});

child.stdin.on('error', handleEpipe);
child.stdin.end(promptBuffer);  // one-shot, in-memory

const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on('line', parseStreamJsonLine);

child.stderr.on('data', captureStderrWithCap);
child.on('error', handleSpawnError);  // ENOENT lands here, not stderr
child.on('exit', handleExit);
```

Prompt size ceiling validated at assembly time (default 4 MB). Larger → phase fails with a clear error.

### Shutdown

- SIGTERM on the process group: `process.kill(-child.pid, 'SIGTERM')`.
- Wait 10 s.
- SIGKILL escalation: `process.kill(-child.pid, 'SIGKILL')`.
- `sessions` rows carry `{pid, pgid, started_at}` for post-crash reaping.
- `yoke doctor` command lists dangling processes.

### Heartbeat [D23]

Two signals, not one:
1. **Liveness** — PID alive AND (if inside a tool_use) the tool hasn't exceeded its per-tool wall-clock budget.
2. **Stream activity** — stdout-silence threshold applies **only outside** a tool_use.

Heartbeat **never kills**. It emits a `SystemNotice` warning. User decides. Defaults: activity-timeout 90 s outside tool_use; per-tool budgets configurable.

---

## Crash Recovery [D26, D27]

### Core rule

`-c` is a soft optimization for intra-phase continuation. **Crash recovery does not depend on `-c`.** Recovery is always a fresh session; the harness reconstructs context from artifacts + `handoff.json` + git log + Session Log Store.

### On harness SIGTERM/SIGINT

1. Every transition is already persisted (SQLite + fsync'd WAL); nothing to save.
2. SIGTERM each child process group.
3. Wait 10 s; SIGKILL stragglers.
4. Exit.

### On harness restart

1. Load workflow state from SQLite.
2. For each `in_progress` workflow:
   - Probe each session PID with `kill(pid, 0)`; mark stale sessions `cancelled`.
   - Inspect worktree: if `git status` is dirty, auto-stash as `yoke-crash-stash-<ts>` (configurable to `commit-wip`). Surface stash in UI.
   - For `review` state: delete any partial `reviews/feature-N/*` files so re-run starts clean.
   - Enter `awaiting_user` by default: user clicks "Resume" to fire a fresh session (or "Cancel").
   - Optionally auto-resume if `auto_resume: true` is set; default is `false` (laptop-primary target expects user acknowledgment after wake). [D60]

### Dashboard surface

Workflow cards show a `recoveryState` banner after a restart: `{ recoveredAt, priorStatus, resumeMethod, uncommittedChanges, lastKnownSessionId }`. Persists until user acknowledges.

---

## SQLite Schema [D38]

WAL mode explicit. All state transitions wrapped in transactions. Dashboard reads use a separate read-only connection.

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  spec TEXT NOT NULL,
  pipeline TEXT NOT NULL,       -- JSON: phase graph
  config TEXT NOT NULL,         -- JSON: resolved config
  status TEXT NOT NULL,
  worktree_path TEXT,
  branch_name TEXT,
  recovery_state TEXT,          -- JSON when applicable
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_workflows_status ON workflows(status);

CREATE TABLE features (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  feature_data TEXT NOT NULL,   -- JSON: canonical feature object
  status TEXT NOT NULL,
  current_phase TEXT,           -- free-text label
  depends_on TEXT NOT NULL,     -- JSON array of feature ids
  retry_count INTEGER DEFAULT 0,
  retry_window_start TEXT,      -- for transient backoff
  created_by_session_id TEXT,
  last_updated_by_session_id TEXT,
  blocked_reason TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_features_workflow ON features(workflow_id);
CREATE INDEX idx_features_status ON features(workflow_id, status);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  feature_id TEXT REFERENCES features(id),
  parent_session_id TEXT REFERENCES sessions(id),  -- for -c chains
  phase TEXT NOT NULL,
  agent_profile TEXT NOT NULL,
  pid INTEGER,
  pgid INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_creation_input_tokens INTEGER DEFAULT 0,
  cache_read_input_tokens INTEGER DEFAULT 0,
  raw_usage TEXT,
  session_log_path TEXT,
  status TEXT NOT NULL,
  status_flags TEXT,            -- JSON: parse_errors, tainted, manifest_missing, etc.
  last_event_at TEXT,
  last_event_type TEXT
);
CREATE INDEX idx_sessions_workflow ON sessions(workflow_id, feature_id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  workflow_id TEXT,
  feature_id TEXT,
  session_id TEXT,
  phase TEXT,
  attempt INTEGER,
  event_type TEXT NOT NULL,
  level TEXT NOT NULL,          -- debug|info|warn|error
  message TEXT NOT NULL,
  extra TEXT                    -- JSON
);
CREATE INDEX idx_events_workflow ON events(workflow_id, ts);

CREATE TABLE artifact_writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  artifact_path TEXT NOT NULL,
  written_at TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
CREATE INDEX idx_artifact_writes_session ON artifact_writes(session_id);

CREATE TABLE pending_attention (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  kind TEXT NOT NULL,           -- e.g. "blocked_feature", "crash_recovery_required"
  payload TEXT NOT NULL,        -- JSON
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);
```

Migration runner: forward-only, numbered SQL files in `migrations/`, run in a transaction on startup.

---

## Configuration

```yaml
# .yoke.yml
version: "1"

project:
  name: "my-saas-app"

# Pipeline: phase graph (not just a list)
pipeline:
  nodes:
    plan:       { phase: plan }
    implement:  { phase: implement }
    review:     { phase: review }
  edges:
    - { from: plan,       on: complete, to: implement }
    - { from: implement,  on: complete, to: review }
    - { from: review,     on: pass,     to: complete }
    - { from: review,     on: fail,     to: implement }

phases:
  plan:
    command: "claude"      # or: "jig" with args ["run","planner","--",...]
    args: ["-p", "--output-format", "stream-json"]
    prompt_template: "prompts/plan.md"
    output_artifacts:
      - { path: "features.json", schema: "schemas/features.schema.json", required: true }
    max_outer_retries: 2
    pre: []
    post:
      - name: "check-needs-more-planning"
        run: ["jq", "-e", ".needs_more_planning == true", "features.json"]
        actions:
          0: { goto: "plan", max_revisits: 3 }
          1: "continue"
          "*": { fail: { reason: "planning-check errored" } }

  implement:
    command: "claude"
    args: ["-p", "--output-format", "stream-json"]
    prompt_template: "prompts/implement.md"
    max_outer_retries: 3
    retry_ladder: ["continue", "fresh_with_failure_summary", "awaiting_user"]
    on_review_fail: { retry_mode: "fresh_with_failure_summary" }
    heartbeat:
      activity_timeout_s: 90
      per_tool_budgets:
        Bash: 900
        Edit: 30
    pre:
      - name: "worktree-clean"
        run: ["git", "diff", "--quiet"]
        actions: { 0: "continue", "*": "stop-and-ask" }
    post:
      - name: "static-analysis"  # or any command the user wants as a quality gate
        run: ["./scripts/check.sh"]
        actions:
          0: "continue"
          "*": { retry: { mode: "continue", max: 1 } }

  review:
    command: "claude"
    args: ["-p", "--output-format", "stream-json"]
    prompt_template: "prompts/review.md"
    max_review_rounds: 2
    output_artifacts:
      - { path: "reviews/feature-{feature_id}/", required: true }

worktrees:
  base_dir: ".worktrees"
  branch_prefix: "yoke/"
  auto_cleanup: true
  cleanup_tool: "git"
  bootstrap:
    commands:
      - "pnpm install"

notifications:
  enabled: true
  severity_map:
    workflow_complete: info
    feature_complete: info
    workflow_failed: requires_attention
    feature_blocked: requires_attention
    rate_limited: requires_attention
    crash_recovered: requires_attention
  mechanisms:
    - type: browser_push
    - type: macos_native

github:
  enabled: true
  auto_pr: true
  pr_target_branch: "main"
  auth_order: ["env:GITHUB_TOKEN", "gh:auth:token"]
  attach_artifacts_to_pr: true
  link_issues: true

retention:
  sqlite: "forever"
  stream_json_logs:
    max_age_days: 30
    max_total_bytes: 2_000_000_000
  worktrees: "workflow-completion"

logging:
  database: ".yoke/yoke.db"
  session_logs_dir: ".yoke/logs"
  retain_stream_json: true

runtime:
  keep_awake: false   # when true, spawn caffeinate / systemd-inhibit as workflow child [D60]

rate_limit:
  handling: "passive"     # v1: passive auto-retry after window reset
  # v1.1: add `usage_pause_threshold: 0.9` for proactive workflow-wide pause

ui:
  port: 3456
  bind: "127.0.0.1"
  auth: false   # localhost single-user, always [D57]
```

### Prompt template engine [D11]

Mustache-style `{{name}}` replacer, hand-rolled minimal. No code execution. Undefined variable → hard error at assembly time with variable name + template path. Templates are pure — no file I/O, no shell. `PromptContext` is built by the Pipeline Engine from Worktree Manager + State Store + git helper and passed in as a plain object.

Standard variables available to phases:
- `feature_spec`, `feature_id`, `workflow_name`, `architecture_md`, `progress_md`, `handoff_entries`, `git_log_recent`, `recent_diff`, `user_injected_context`

Bootstrap `commands` and similar shell-exec'd strings do **not** interpolate variables in v1 (eliminates injection vector). Run with `spawn(cmd, args, {shell: false})`.

---

## Web Dashboard

See protocol and render model above. Draft3 concrete specs:

- **Workflow list** — paginated (`GET /api/workflows?status=&q=&before=&limit=`), keyset on `created_at`, filter bar, archive toggle, star pin. [D47]
- **Feature board** — category groups, status chips, fuzzy search, deep links, sticky currently-streaming pin, j/k nav. [D44]
- **Live streaming pane** — virtualized, follow-tail, normalized render model, system notices interleaved. [D41, D18]
- **Review panel** — Task tool_use specialization: collapsible subagent rows, per-angle status strip, subagent runs shown sequentially. [D46]
- **Manual controls** — matrix-driven, commandId idempotency. [D42]
- **GitHub buttons** — full state enum. [D48]
- **Crash recovery banner** — explicit `recoveryState`, user acknowledges. [D27]
- **Browser push** — service worker, one-gesture permission grant, fallback toast + bell on deny. [D45]
- **macOS native notifications** — server-side via node-notifier, deep-link URL back to dashboard. [D45]
- **Attention banner** — pulls from `pending_attention` table; never cleared by push failure. [D49]

---

## Usage Tracking

See §Protocol for parsing rules. Stored per-session as columns (not blob). Aggregation endpoints:

- `GET /api/workflows/:id/usage?groupBy=feature|phase|profile|session`
- `GET /api/workflows/:id/usage/timeseries?bucket=hour|day`

Trends across workflows are v1.1.

---

## Review Architecture [D14]

Orchestrator session is a thin spawner. In the orchestrator prompt, the only allowed tool is `Task` (to spawn subagents). Each subagent:

1. Is scoped to Read, Bash, Glob, Grep + **Write** (scoped to `reviews/feature-N/<angle>.json` only). Scoping mechanism is whatever the user has wired in their command — jig profile is the recommended path in docs, Claude tool permissions or a PreToolUse deny hook work too.
2. Receives feature spec, acceptance criteria, review criteria, diff, architecture.md, handoff.json.
3. Writes its verdict **directly** to its own file.
4. Orchestrator never receives the verdict content.

Harness aggregates after orchestrator exits:
- Parse each JSON in `reviews/feature-N/` against schema.
- Any parse failure → `review_invalid`, re-run once.
- Every criterion must have a verdict → enforced by schema.
- Final verdict = `any(fail) → fail`.

---

## Threat Model [D37]

**Adversaries considered:**
1. **Prompt injection via spec.** Spec content is untrusted (may be pasted from Slack, GitHub issue, etc.). A malicious spec can instruct the planner to emit an `init.sh` that exfiltrates secrets.
2. **Confused-deputy agent.** A well-meaning but misaligned agent attempts actions outside its scope.
3. **Hook tampering.** Agent with Edit+Bash can rewrite the hook script to always pass.

**Trust boundary:** the developer's machine. Yoke's job is to give users the tools to prevent a workflow from escaping the worktree and touching user files, and to give users the tools to prevent silent quality-gate bypass. **Enforcement is opt-in** — users wire it through their own Claude hooks or through Yoke `post:` commands.

**v1 mitigations Yoke provides:**
- **PreToolUse safety template** (opt-in install at `yoke init`) — denies writes outside `worktreePath`, denies reads of `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.gnupg`, curated Bash deny-list (`curl ... | sh`, `wget ... | sh`, `rm -rf /`, `chmod -R 777`, writes to `/etc/`). The template is a file the user copies into their Claude hook directory — Yoke does not install or manage it post-init.
- **Config flag `safety_mode: strict | default | yolo`** — controls which variant of the example template `yoke init` offers. `strict` adds a network egress allowlist and denies Bash `sudo`. `yolo` scaffolds no safety template at all. The flag is advisory — it parameterizes the template, not a runtime-enforced harness behavior.
- **`init.sh` first-run approval** — any `init.sh` generated by a planner requires explicit user approval before execution.
- **Review anti-skip heuristic** — reviewer checks tests were touched alongside production files; `post:` commands let the user enforce additional assertions.

**v1 non-goals:**
- Sandboxing (firejail / sandbox-exec / Docker) — deferred to v2. [D51]
- Runtime-enforced allowlist or deny-list beyond what the user's own hooks do.
- Harness-managed hook integrity. If the user wants tamper detection, they add a `post:` command that checksums their hook files.

---

## Failure Modes [D35]

Every failure below has a test fixture in the v1 suite.

| Failure | Detection | User outcome | Recovery |
|---|---|---|---|
| configured command not found (ENOENT) | spawn error | clear error at workflow start naming the phase + command | fix config / PATH |
| configured command nonzero at start (e.g. jig profile missing) | early exit + stderr | phase fails with command + stderr snippet | fix user setup |
| worktree create fails (disk full) | git error | workflow start fails | free disk |
| worktree create fails (base branch missing) | git error | workflow start fails | fix base |
| bootstrap command fails | phase = bootstrap_failed | terminal state; no auto-cleanup | user inspects |
| SQLite locked | retry window; then fatal | attention banner | diagnose |
| SQLite corrupt on startup | integrity check | startup refuses | restore from backup; migration |
| rate limit mid-stream | stream-json event | `rate_limited` state, backoff | auto-resume after window |
| OAuth expired mid-stream | stream-json error | `awaiting_user`, notification | user refreshes auth |
| process killed externally | exit code | `awaiting_user` | user decides |
| laptop sleep / wake | stale PID on probe | session marked cancelled | user resumes |
| GitHub API down (auto-PR) | octokit error | button shows `failed`, manual fallback | retry or manual |
| gh unauthenticated | gh exit code | error with auth guidance | `gh auth login` |
| prompt template missing | load-time | workflow start fails | fix path |
| template variable undefined | assembly-time | phase fails with variable name | fix template |
| features.json schema mismatch | ajv | phase fails with path+message | fix spec |
| branch name collision | shouldn't happen (shortid suffix) | hard fail | bug |
| `pre:` command fails | nonzero exit | action per declared mapping (default: fail fast) | fix env / user action |
| `post:` command fails | nonzero exit | action per declared mapping | per user mapping |
| `post:` command hangs | 15 min timeout | killed + reported | diagnose |
| user hook hangs (if installed) | wall-clock ceiling | session killed | diagnose |
| stream-json parse error | per-line | counter bumps, skip line | inspect log |
| line > 16 MB | per-line | truncate, tainted flag | inspect log |
| disk full mid-write | WAL + write retry | tainted session, attention | free disk |
| stale inject-context | session consumed it | shown as consumed | n/a |
| review output missing criterion | schema reject | `review_invalid` → re-run | automatic |
| keep_awake helper dies unexpectedly | child exit | warning; workflow continues | automatic respawn attempt |

---

## Testability [D32, D33]

### ProcessManager interface

```ts
interface ProcessManager {
  spawn(opts: SpawnOpts): Promise<SpawnHandle>;
}

class JigProcessManager implements ProcessManager { /* production */ }
class ScriptedProcessManager implements ProcessManager {
  /* replays recorded stream-json JSONL with configurable timing,
     injected exit codes, injected stderr */
}
```

### `yoke record` mode

Captures a real session's stream-json + artifact file deltas into a fixture directory. Fixtures live in `tests/fixtures/<scenario>/`.

### Fixture coverage required for v1

At minimum one fixture per phase + at least one for each row in the Failure Modes table:
- `plan-happy-path`
- `implement-happy-path`
- `review-happy-path`
- `implement-hook-fail-then-retry`
- `implement-rate-limit-midstream`
- `implement-sigkill-midstream`
- `review-missing-criterion` (→ review_invalid)
- `malformed-stream-json-recovery`
- `bootstrap-fails`
- `hook-manifest-missing`
- `hook-checksum-tampered`

### FaultInjector

Checkpoints: `before_persist`, `after_persist_before_spawn`, `after_spawn_before_ack`, `during_artifact_read`, `during_hook_exec`, `during_cleanup`.

Actions per checkpoint: `panic | exit | kill-9-child | corrupt-next-write`.

Tests assert recovery converges to the same terminal state as an uninterrupted run.

---

## v1 Acceptance (Release Gate) [D36]

v1 is done when **all** of the following pass in CI against `ScriptedProcessManager` fixtures:

1. Scripted happy-path plan → implement → review → complete in < 5 s.
2. SIGTERM mid-implement → restart → workflow converges to same terminal state as uninterrupted run.
3. `post:` command failing → declared action applied (retry / fail / goto) and observed behavior matches.
4. `post:` command with `goto: <phase>` and `max_revisits: N` — revisit runs N times, then collapses to `awaiting_user`.
5. Configured command ENOENT → clean error at workflow start naming the phase and the missing binary.
6. Malformed features.json → schema error with path and message.
7. Worktree creation failure → clear error, workflow stays in pre-bootstrap state.
8. SQLite WAL crash during write → recovered on startup, no state loss.
9. `blocked` feature can be manually retried from UI with injected context.
10. Rate-limit fixture → `rate_limited` state → auto-resume after window → completion.
11. Review with missing criterion → `review_invalid` → re-run → pass.
12. Dashboard reconnect mid-stream → backfills from session log with no dupes, no gaps.
13. Dashboard manual control (pause/resume/cancel) applies exactly once per `commandId`.
14. `yoke doctor` reports dangling processes after simulated hard crash.
15. `keep_awake: true` fixture → platform helper spawned, dies with workflow.
16. Parallel workflows — **deferred to v1.1** per D52. Not part of v1 release gate.

Release gate = all green. Acceptance runs are recorded in `docs/releases/v1-acceptance-<timestamp>.md`.

---

## What Yoke Does NOT Do

- Not rate-limit management in v1 (passive auto-retry only; proactive pause is v1.1).
- Not an IDE. Dashboard monitors and controls; does not edit code.
- Not LLM-agnostic. Claude-Code-native by design.
- Not jig-dependent. `jig` is a recommended docs-level layer, never a runtime requirement. [D55]
- Not a CI/CD system.
- Not timeout-based (except: command wall-clock ceilings on hooks / `pre:` / `post:`, explicitly justified).
- Not a token optimizer.
- Not a hook installer / manager. Ships example templates; user owns their hook directory. [D55]
- **Not multi-user, ever.** Localhost single-user forever. Multiple Yoke instances of the same user are fine. [D57]
- **Not parallel-workflow in v1.** Single workflow at a time per instance. [D52]

---

## Requirements

### Must Have (v1)

- [ ] Pipeline engine reading `.yoke.yml`, phase graph (not just list)
- [ ] State machine with explicit transition table + unit-tested coverage
- [ ] Failure classifier (transient/permanent/policy/unknown) + exponential backoff
- [ ] Phase definitions with `command` / `args` (jig-agnostic), prompt template, output artifacts, success criteria
- [ ] **Phase `pre:` and `post:` command arrays** with exit-code action mapping, `max_revisits` loop guards, session-log capture [D50, D53]
- [ ] Prompt Assembler (pure fn) + Mustache-style template engine + `PromptContext` builder
- [ ] Process Manager with process-group isolation, SIGTERM→SIGKILL escalation, NDJSON line-buffered stream-json parser, EPIPE handling — **command-agnostic** (jig optional)
- [ ] Two-signal heartbeat (liveness + stream-activity), warnings only, never auto-kill
- [ ] Worktree Manager (create, bootstrap as a phase, teardown hook, cleanup)
- [ ] SQLite store with WAL, migrations, indexes, transactions, `events` + `artifact_writes` + `pending_attention` tables
- [ ] Artifact validators (ajv) for features.json and review files
- [ ] `handoff.json` as structured cross-phase channel
- [ ] `.yoke/status-updates.jsonl` narrow status channel from implementer
- [ ] features.json post-phase diff check (harness enforcement)
- [ ] Topological sort of `depends_on` + cascade-blocking
- [ ] Retry ladder (`continue` → `fresh_with_failure_summary` → `awaiting_user`) + configurable `on_review_fail` [D56]
- [ ] Crash recovery: fresh-session reconstruction; `-c` used only as soft optimization; dirty-worktree auto-stash
- [ ] `.yoke/last-check.json` **optional manifest display** in dashboard (user's choice to emit) [D55]
- [ ] Passive rate-limit handling: detect, enter `rate_limited`, wait for window, auto-resume [D61]
- [ ] `keep_awake` opt-in: platform-specific idle-inhibit child spawned with workflow [D60]
- [ ] `yoke init`: opt-in scaffolding of example hook templates + example `post:` command set; never overwrites existing files
- [ ] Threat model doc + `safety_mode: strict/default/yolo` parameterizing example templates
- [ ] Fastify HTTP + ws server with protocol envelope (v1 types, per-session `seq`, `hello`, subscribe/unsubscribe, backfill)
- [ ] Session Log Store (`.yoke/logs/`) with HTTP paging endpoint
- [ ] Structured log schema + `GET /api/workflows/:id/timeline`
- [ ] Token usage as columns + `parent_session_id` chaining
- [ ] Web dashboard: workflow list (paginated), feature board (grouped/filtered/searchable/nav), live streaming (virtualized + normalized render model), system notices interleaved, review fan-out rendering, crash recovery banner, manual controls (matrix + commandId), GitHub buttons (full state enum), attention banner, pre/post command output rendering
- [ ] Service-worker browser push + macOS native with deep-links
- [ ] Notifications severity classes + `pending_attention` table as authoritative
- [ ] Review orchestrator pattern: subagents write directly, harness aggregates
- [ ] `ScriptedProcessManager` + fixtures (one per failure mode) + `yoke record` mode
- [ ] `FaultInjector` seam + crash-recovery test suite
- [ ] Failure Modes table entries each covered by a fixture
- [ ] v1 Acceptance scenarios passing in CI
- [ ] CLI: `yoke init`, `yoke start`, `yoke status`, `yoke cancel`, `yoke doctor`
- [ ] Default prompt templates for plan / implement / review
- [ ] README, config guide, threat model doc, prompt template guide, **hook best-practices guide (mentions jig as recommended)**
- [ ] `version: "1"` schema pin + helpful ajv error messages

### Should Have (v1.1)

- [ ] Parallel workflows (concurrency contract, shared resource isolation, stress test) [D52]
- [ ] Proactive rate-limit pause: `usage_pause_threshold` workflow-wide percent; harness signals session to wrap up via handoff.json and pauses workflow [D61]
- [ ] Iterative planning UX polish (structural affordance already in v1 via `post:` + `goto`)
- [ ] Optional pre-step usage gate
- [ ] GitHub artifact attachment + issue linking
- [ ] Token usage reporting (per-feature/phase/profile) UI
- [ ] Searchable log viewer UI (storage is v1)
- [ ] Webhook notifications (Slack, Discord)
- [ ] Workflow report export
- [ ] Windows `keep_awake` implementation (macOS + Linux land in v1)

### Nice to Have (v2)

- [ ] Sandboxed execution (firejail / sandbox-exec / Docker)
- [ ] Active rate-limit polling (status-line or ephemeral probe sessions) [D61]
- [ ] Log analysis + failure pattern detection
- [ ] Automatic CLAUDE.md / prompt template suggestions
- [ ] Plugin system for custom validators between phases
- [ ] GitHub issue → workflow automation
- [ ] Electron wrapper

*Note: multi-user is never on the roadmap. Yoke is and stays single-user-per-instance. [D57]*

---

## Tech Stack

Unchanged from draft2 except:
- Add: `@tanstack/react-virtual`
- Add: hand-rolled Mustache-style template engine (or `mustache` pinned)
- Add: `ajv-errors` or custom error formatter
- Confirm: `better-sqlite3`, `fastify`, `ws`, `simple-git`, `node-notifier`, `octokit`, `commander`, `yaml`, `ajv`

---

## Build Order

Aligns with the dogfooding runbook (see `runbook.md`). Every bullet is an agent task driven either manually (Tier 0), via `yoke-v0` shell glue (Tier 0.5), or via v1 itself once the pipeline engine exists.

### Phase β — Core Design (Architect, Tier 0)
Architect produces `docs/design/`: module boundaries, schemas, API contracts, prompt-template spec, open-questions resolution, state machine transition table.

### Phase γ — Empirical Research + `yoke-v0` Bootstrap (Backend, Tier 0 → 0.5)
1. Research tasks capturing real Claude Code behavior (stream-json framing, `-c` semantics, Claude hook exit codes / stdin / stdout schema, token usage events, rate-limit stream-json frames) → `docs/research/*.md`.
2. Minimal `yoke-v0` shell script: template assembly + command-agnostic spawn (`claude` by default, or whatever the user's config names) + stream-json capture to `.yoke/logs/`.

### Phase δ — Core Engine (Backend, Tier 0.5)
Use `yoke-v0` to drive implementation of: config parser, SQLite store + migrations, pipeline engine + transition table, process manager (command-agnostic + Scripted), pre/post command runner + action grammar, worktree manager, optional-manifest reader, artifact validators, CLI, Session Log Store, fastify + ws skeleton with protocol envelope, passive rate-limit handling, `keep_awake` helper.

By end of δ, v1 self-hosts and graduates to Tier 1.

### Phase ε — Dashboard + Integrations (Frontend, Tier 1)
React app, normalized render model, virtualized live pane, control matrix, crash recovery banner, browser push + macOS native, GitHub buttons, attention banner, workflow history.

### Phase ζ — QA + Release (QA, Tier 1)
Failure Modes fixtures, FaultInjector tests, v1 Acceptance scenarios running in CI, docs pass, release.

---

## Resolved decisions (summary)

All open items from Phase α.5 are resolved. Full decision text lives in `change-log.md` §Q. Headline outcomes:

- **D50** Configurable `pre:` / `post:` shell commands per phase with exit-code action grammar (replaces polyglot runner).
- **D51** Sandboxing deferred to v2. `safety_mode` parameterizes example templates only.
- **D52** v1 is single-workflow. Parallel workflows in v1.1.
- **D53** Phase transitions via condition commands (`continue`, `goto`, `goto-offset`, `retry`, `stop-and-ask`, `stop`, `fail`) with `max_revisits` loop guards. Replaces hardcoded iterative-planning affordance.
- **D54** `architecture.md` is both an optional user-supplied input and a planner output (planner proposes edits via `architecture-proposed.md`).
- **D55** Jig is optional docs-only. Claude hooks live in Claude's namespace, owned by the user. Yoke ships example templates, no hook installation/management. Quality gating is the user's choice of Claude Stop hook and/or Yoke `post:` commands.
- **D56** Review-fail re-implement defaults to fresh, configurable via `on_review_fail: { retry_mode }`.
- **D57** Single-user forever. Dashboard binds 127.0.0.1. No auth, ever. Multiple Yoke instances of the same user are supported.
- **D58** SQLite forever, stream-json logs 30d/2GB, worktrees on completion. All configurable. Remote log forwarding is the user's concern.
- **D59** Workflow continues non-dependent features when one blocks; cascade-blocks dependents; terminal state "completed with blocked features."
- **D60** Laptop-primary. Opt-in `keep_awake: true` spawns `caffeinate -i` (macOS) / `systemd-inhibit` (Linux) as workflow child. Windows v1.1.
- **D61** Passive rate-limit handling in v1: enter `rate_limited`, wait for window, auto-resume. Proactive workflow-wide pause at configurable % threshold in v1.1. Active polling v2.
