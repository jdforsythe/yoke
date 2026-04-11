# Open Questions — Phase β (Core Design)

Questions surfaced while translating plan-draft3.md into design
artifacts. Each entry states what is needed, why it blocks design, and
what the architect will default to if the user does not respond within
24 hours. Per plan-draft3 discipline, no silent fixes: anything here is
a flag for the user, not a unilateral change.

All open items from Phase α.5 (D50–D61) are resolved in plan-draft3;
the questions below are new and arose from the act of producing
concrete schemas, DDL, and protocol specs.

---

## Q-prepost-table — `prepost_runs` table is not in plan-draft3

**What I need to know.** Is adding a `prepost_runs` SQLite table (to
record one row per `pre:` / `post:` command execution, including
`name`, `argv`, `exit_code`, `action_taken`, `stdout_path`,
`stderr_path`) an accepted extension of plan-draft3 §SQLite Schema?

**Why it blocks design.** Plan-draft3 §v1 Acceptance scenario 3
requires the test suite to verify "`post:` command failing → declared
action applied (retry / fail / goto) and observed behavior matches."
Verifying this requires persistent evidence that each command ran and
that a specific resolved action was applied. The only persistent
surfaces plan-draft3 names are `events` (too unstructured for query)
and `sessions` (one row per agent session, not per command). Either
we add a `prepost_runs` table or we encode the same data as typed
`events` rows with a strict `event_type` and a JSON `extra` payload.

**Default if no response.** Ship `prepost_runs` as defined in
`schemas/sqlite-schema.sql` and flag the addition in the
commit message so reviewers can challenge. The table is purely
additive and cheap to remove if rejected.

---

## Q-classifier-inputs — failure classifier inputs are not enumerated

**What I need to know.** Plan-draft3 §State Machine (D07) promises a
failure classifier returning `transient | permanent | policy |
unknown`, but does not enumerate the inputs the classifier reads. Is
the classifier:
  (a) pattern-matching on stream-json error frames + stderr,
  (b) rule-driven by the post-command action map (e.g. an explicit
      `fail: {reason}` implies `policy`),
  (c) some combination,
and is the user allowed to add custom rules via config?

**Why it blocks design.** The transition table's `session_fail +
classifier <tag>` rows depend on a deterministic classifier, and the
unit tests for it can't be written without an input schema.

**Default if no response.** Ship a minimal built-in classifier with
the following rules, and mark it as internal-only (no user config
surface in v1):
  - Exit code `141` (SIGPIPE) → `transient`.
  - Exit code `137` (SIGKILL) → `transient`.
  - Exit code `127` / ENOENT → `permanent`.
  - Any stream-json frame classified as rate_limit → `transient` (but
    the state-machine routes `rate_limit_detected` first, so this
    rarely fires).
  - Explicit `fail: {reason}` from a post-command action → `policy`.
  - Anything else → `unknown` → `awaiting_user`.
  User-extensible rules become a v1.1 feature request.

---

## Q-multi-feature-parallel-in-review — review phase fan-out per feature

**What I need to know.** Plan-draft3 §Review Architecture says the
review orchestrator spawns subagents "in sequence" and §Client Render
Model says "subagents run sequentially — no promise of true parallel
live panes." But the implement phase runs per-feature and v1 is
single-workflow (D52); is there any expectation that two **features**
of the same workflow can be in `review` concurrently? Plan-draft3
§Phase Implement says features run in topological order but is
ambiguous on whether `in_progress → review → complete` is
per-feature-sequential or per-feature-parallel.

**Why it blocks design.** If features can be in `review` concurrently
the `events` + `pending_attention` tables need per-feature scoping
(already done), the WS subscription model stays unchanged (workflow-
scoped), but the reviewer orchestrator needs to cope with multiple
concurrent `reviews/feature-N/*.json` trees. If features are strictly
serial, a simpler per-feature lock suffices.

**Default if no response.** Per-feature serial: at most one feature
per workflow in non-terminal state at a time. Plan-draft3 §v1
Acceptance does not require concurrent features; parallel features
move to v1.1 alongside parallel workflows (D52).

---

## Q-events-table-retention — `events` retention is not specified

**What I need to know.** Plan-draft3 §Retention names `sqlite:
"forever"`, `stream_json_logs`, and `worktrees` but does not discuss
the `events` table specifically. The events table is append-only and
can grow without bound if the user runs a long-lived instance. Is
"forever" intended to cover it, or should there be a separate
retention dial?

**Why it blocks design.** The migration runner and `retention` config
schema can't be finalized without knowing.

**Default if no response.** Treat `events` as covered by `sqlite:
"forever"` in v1 and add a best-effort compaction job to v1.1 (new
config key `retention.events.max_age_days`). Document the
"events grows without bound" consequence in the config guide.

---

## Q-scripted-pm-fidelity — ScriptedProcessManager fidelity scope

**What I need to know.** Plan-draft3 §Testability (D32) mandates a
`ScriptedProcessManager` that replays captured stream-json with
"configurable timing, injected exit codes, injected stderr." Does
scripted replay need to also:
  (a) simulate rate-limit frame detection,
  (b) simulate `kill(pid, 0)` probe semantics for restart recovery,
  (c) replay `pre:` / `post:` command output?

**Why it blocks design.** The fixture format for v1 must carry every
signal a real run would. If (a)-(c) are all required, the fixture
schema is larger than a simple JSONL file — it needs a manifest
`{streamJsonPath, stderrPath, exitCode, events[], prepostRuns[]}`.

**Default if no response.** Fixture manifest includes all three. The
`plan-happy-path`, `rate-limit-midstream`, and `hook-fail-then-retry`
fixtures (plan-draft3 §Testability) are impossible without them, so
the default is forced.

---

## Q-goto-offset-scope — how offset "declared graph order" is computed

**What I need to know.** Plan-draft3 §Phase Pre/Post Commands defines
`goto-offset: ±N` as "relative jump in declared graph order." The
order is underspecified when the pipeline DAG has branches (e.g.
plan → implement → review, with review → implement on fail). Is the
intended order:
  (a) YAML authorship order of `pipeline.nodes`,
  (b) topological linearization of `pipeline.edges`,
  (c) the linearization used by the state machine for the default
      "continue" event?

**Why it blocks design.** `goto-offset: -1` from `review` should go
back to `implement`, which all three interpretations agree on. But
`goto-offset: +1` from `review` is ambiguous — option (a) goes to
the next declared node (might be `complete` or a sibling), option
(b) might choose a different branch.

**Default if no response.** `schemas/pre-post-action-grammar.md` §4
defines the order as "topological linearization with ties broken by
`pipeline.nodes` authorship order." Flag this as the architect's
decision in the PR description; challenge-ready.

---

## Q-architecture-proposed-lifecycle — `architecture-proposed.md` flow

**What I need to know.** Plan-draft3 §Workflow Lifecycle: Plan (D54)
says the planner may emit `architecture-proposed.md` for user
approval. What is the state-machine flow that gates on approval?
Options:
  (a) Approval is out-of-band (user diffs the file and `git mv`s it
      themselves; harness is oblivious),
  (b) Approval is a first-class state (`awaiting_user` with an
      attention banner linking to a diff view),
  (c) A `post:` command on the plan phase checks for the file and
      routes to `stop-and-ask`.

**Why it blocks design.** Option (b) requires a new
`pending_attention.kind = "architecture_proposal"` and a dashboard
diff renderer; option (a) requires nothing; option (c) is pure config.

**Default if no response.** Ship option (c): the example `plan` phase
in `docs/templates/config/` includes a `post:` command that checks
for the file and routes to `stop-and-ask`. No new schema, no new
dashboard surface. The user can upgrade to option (b) if they want
when the dashboard grows a generic attention-diff view.

---

## Q-subagent-scoping-in-default-config — how does default init scope reviewers?

**What I need to know.** Plan-draft3 D14 and D55 say reviewer
subagent scoping is the user's responsibility ("jig profiles are
recommended; Claude tool permissions or PreToolUse deny hook work
too"). What does `yoke init` ship as the default? Options:
  (a) No default scoping — users must add their own.
  (b) A PreToolUse example template that enforces the narrow Write
      scope for review.
  (c) A dedicated `reviewer` phase template that uses `jig run
      reviewer --` if `jig` is on PATH at init time.

**Why it blocks design.** The example `docs/templates/hooks/` content
depends on this. Also affects v1 Acceptance: if the default config
has no reviewer scoping, the `review-happy-path` fixture may not
exercise scoping at all.

**Default if no response.** Option (b): ship
`docs/templates/hooks/PreToolUse-review-scope.md` as a template the
user can copy, with an example that denies Write outside
`reviews/feature-*/`. Do not install it. Call this out in the
template README.

---

## Q-keep-awake-windows — Windows users in v1

**What I need to know.** Plan-draft3 D60 defers Windows `keep_awake`
to v1.1. Is the v1 config schema supposed to accept `keep_awake:
true` on Windows and emit a warning, or reject it outright at
config-load time?

**Why it blocks design.** `schemas/yoke-config.schema.json` currently
accepts the flag unconditionally; enforcement happens at runtime.
If rejection is preferred, we'd need a platform check in the config
loader (breaking platform portability of `.yoke.yml` files).

**Default if no response.** Accept at config-load time, warn at
runtime, proceed without keep-awake. This matches "laptop-primary,
warn don't break" posture.

---

## Q-features-json-projection-timing — when does the harness write it?

**What I need to know.** Plan-draft3 §File Contract: "the canonical
feature store is the SQLite `features` table. `features.json` in the
worktree is a snapshot written by the harness before each phase and
deleted after." Is "deleted after" strictly after the phase's
post-phase diff check passes, or only after the entire workflow
terminates? If strictly per-phase, a crash mid-phase leaves an
orphan file.

**Why it blocks design.** The Worktree Manager's cleanup ordering
and the crash-recovery projection depend on this.

**Default if no response.** Per-phase: write before `phase_start`,
delete after the post-phase diff check runs (regardless of its
outcome, so a fail still cleans up). On restart, the recovery path
removes any `features.json` in the worktree before re-projecting.
This matches "the canonical store is SQLite" strictly.

---

## Q-session-log-directory-collisions — session log path when `.yoke/logs` spans workflows

**What I need to know.** Plan-draft3 §Configuration specifies
`logging.session_logs_dir: .yoke/logs`. Is the path scoped
per-workflow (`.yoke/logs/<workflow-id>/<session-id>.jsonl`) or
flat (`.yoke/logs/<session-id>.jsonl`)? The plan does not say.

**Why it blocks design.** Scoped layout helps with retention /
workflow cleanup; flat layout simplifies the paging endpoint.
Multiple instances of Yoke (D57) must not collide.

**Default if no response.** Workflow-scoped:
`.yoke/logs/<workflow-id>/<session-id>.jsonl`. Each session's
`sessions.session_log_path` column stores the absolute path so the
paging endpoint does not need to reconstruct it. Multiple instances
use separate project directories by convention.

---

## Summary of defaults (what I'll do if silence)

1. Ship `prepost_runs` table (Q-prepost-table).
2. Ship minimal built-in classifier (Q-classifier-inputs).
3. Per-feature serial review (Q-multi-feature-parallel-in-review).
4. `events` retention governed by `sqlite: "forever"` (Q-events).
5. Scripted PM fixture manifest covers stream/exit/stderr/prepost
   (Q-scripted-pm-fidelity).
6. `goto-offset` order = topological + authorship tiebreak
   (Q-goto-offset-scope).
7. `architecture-proposed.md` gated via `post:` + `stop-and-ask`
   (Q-architecture-proposed-lifecycle).
8. Reviewer scoping = PreToolUse example template (copy-on-opt-in)
   (Q-subagent-scoping-in-default-config).
9. `keep_awake` on Windows warns-and-ignores (Q-keep-awake-windows).
10. `features.json` projection is per-phase (Q-features-json-timing).
11. Session log layout is workflow-scoped
    (Q-session-log-directory-collisions).

All defaults are flagged in the commit message so reviewers can
challenge them in the PR thread.
