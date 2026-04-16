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

**Resolution (2026-04-12).** Accepted: ship `prepost_runs` table.
Defined in `schemas/sqlite-schema.sql`. Table now includes `stage`
column per Issue 1.

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

**Resolution (2026-04-12).** Accepted: ship minimal built-in classifier
with the rules above. No user config surface in v1.

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

**Resolution (2026-04-12).** Accepted: per-item serial — at most one
item in non-terminal state per workflow in v1. Note: with the
stages/items rename (Issues 1–2), "feature" becomes "item" throughout.

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

**Resolution (2026-04-12).** Accepted: `events` retention governed by
`sqlite: "forever"` in v1. Compaction deferred to v1.1.

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

**Resolution (2026-04-12).** Accepted: fixture manifest includes all
three signal types. The default is forced by the test requirements.

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

**Resolution (2026-04-11).** `goto-offset` is cut entirely from v1.
The feature was solving the wrong problem: the primary use case (lint/test
gate on implement → fix it → retry) is covered by `retry: {inject: stderr}`,
and the rare case of jumping to a different phase is covered more readably
by named `goto: <phase>`. The relative-numeric-jump form adds config
complexity and the ordering ambiguity documented above for no practical
gain. Action grammar for v1 is: `continue`, `goto: <phase>`, `retry`,
`stop-and-ask`, `stop`, `fail`. `goto-offset` is not a v1.1 candidate
unless a concrete use case emerges.

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

**Resolution (2026-04-11).** The `architecture-proposed.md` artifact and the
concept of a required planner node are both rejected. Yoke is fully
configurable — workflows may have no planner node at all (e.g. a bare
`implement → review` for a simple bug fix). The harness must not assume any
specific node or output file exists.

**Resolution updated (2026-04-12, Issue 1 — stages replace nodes+edges).**
With the stages model, edges no longer exist. `needs_approval` moves to a
stage-level attribute: `needs_approval: true` on a stage causes the harness
to enter `awaiting_user` before starting that stage, inserting a
`pending_attention{kind=stage_needs_approval}` row. The user approves via the
dashboard or CLI, which emits a `stage_approval_granted` event. Example:

```yaml
pipeline:
  stages:
    - id: plan
      run: once
      phases: [plan]
    - id: implementation
      run: per-item
      items_from: features.json
      items_list: $.features
      items_id: $.id
      phases: [implement, review]
      needs_approval: true    # pause before starting this stage
```

For the *conditional* case (pause only if the planner's structured output
signals complexity), a `post:` command on the planning phase using `jq` to
inspect the output JSON and exit non-zero, mapped to `stop-and-ask`, is the
appropriate mechanism — that is the existing pre/post action grammar and
requires no new schema.

Action: `needs_approval` added to `schemas/yoke-config.schema.json` stage
definition. `stage_approval_granted` event and `stage_needs_approval`
attention kind added to `state-machine-transitions.md`.

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

**Resolution (2026-04-11).** The question's premise is wrong: Yoke has no
required node types. There is no mandatory "reviewer" phase — users may run
plan+implement only, implement-only, or any topology they choose. The
recommendation of plan+implement+review+loop is documentation-level guidance,
not a harness constraint.

Consequences:

1. **No per-node hook scoping.** Jig profiles and per-node PreToolUse hook
   setups for reviewer scoping are out of scope for v1. Too complex to
   configure, too tied to an assumed workflow shape the user may not use.

2. **Hook templates dropped entirely.** `docs/templates/hooks/` is removed.
   The only two identified use cases were:
   - Reviewer write-scoping: moot given no required reviewer node.
   - Stop-quality for static analysis: the user still has to edit the template
     to name their own toolchain script, so the template provides a scaffold
     but not a working default. This is better served by a code snippet in the
     quick start / best practices docs where it can be annotated with context.
   PreToolUse safety guidance (worktree confinement, secret-read blocking)
   likewise moves to the quick start docs as a documented pattern rather than
   a shipped file.

3. **`yoke init` interactive opt-in.** Init may offer an opinionated default
   workflow config (plan+implement+review+loop) as an interactive prompt. The
   user chooses whether to accept it. No hooks are installed.

Action: remove `docs/templates/hooks/` from the architecture directory tree;
remove section 3 from `hook-contract.md`; move safety/quality-gate hook
examples to the quick start / best practices documentation (Phase ε or ζ
scope — not a Phase β artifact). Update `runbook.md` artifact locations.

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

**Resolution (2026-04-12).** Accepted: accept at config-load time,
warn at runtime. Proceed without keep-awake on unsupported platforms.

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

**Resolution (2026-04-12, Issue 2 + Issue 3).** With opaque items,
the harness no longer projects a `features.json` file into the
worktree. Instead:
- Item data is injected into prompt templates via `{{item}}` (opaque
  user data) and `{{item_state}}` (harness state). See
  `prompt-template-spec.md` §3.
- The item manifest file (`items_from`) is not modified by the harness.
  A diff check ensures agents don't modify it either.
- For phases that need the full items listing (e.g., planning), a
  `{{items_summary}}` template variable provides a harness-generated
  summary of all items with their current states.
- The projection concept is replaced by template injection. No
  per-phase file write/delete cycle.

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

**Resolution (2026-04-11).** All persistent yoke data moves to
`~/.yoke/<fingerprint>/`, where `<fingerprint>` is the SHA of the
repo's initial commit (first commit reachable from no parent —
`git rev-list --max-parents=0 HEAD`). A `meta.json` alongside it
stores the human-readable origin URL for browsability. This layout
survives worktree deletion, repo path changes, wipe-and-re-clone,
and external tooling that removes repo directories without invoking
yoke cleanup.

Canonical layout:

```
~/.yoke/
  <initial-commit-sha>/
    meta.json              ← {"origin": "github.com/owner/repo", "first_seen": "..."}
    yoke.db                ← single SQLite DB for all workflows in this repo
    yoke.port              ← port the running server is bound to (runtime, deleted on clean exit)
    yoke.pid               ← PID of the running server process (runtime, deleted on clean exit)
    logs/
      <workflow-id>/
        <session-id>.jsonl
```

Multiple instances in different worktrees share the same `yoke.db`
(SQLite WAL mode; yoke is append-heavy so write contention is
minimal). Each instance auto-selects a free port at startup, writes
it to `yoke.port`, and a second instance finding `yoke.port`
already populated picks the next available port and overwrites it
— so `yoke.port` always reflects the most recently started instance.
`yoke open` reads `yoke.port` to know where to point the browser;
users with two parallel instances open two browser tabs.

`workflow-id + session-id` remains sufficient for uniqueness within
the DB. No new ID dimension is needed. The `logging.session_logs_dir`
config key is removed; the path is always derived from the fingerprint
and is not user-configurable in v1.

---

## Q-cascading-renames — artifacts outside this revision scope need feature→item renames

**What I need to know.** Nothing — this is a tracking note, not a
question. The following artifacts were not in the β.3 revision scope
but contain stale `feature_id`, `features.json`, or `YOKE_FEATURE_ID`
references that should be updated in a follow-up pass:

- `schemas/pre-post-action-grammar.md` — `feature_id` in loop guard
  description, `features.json` in the ordering section.
- `threat-model.md` — `features.json` diff check references.
- `protocol-stream-json.md` — `feature_id` in structured log schema.

**Why it blocks design.** It doesn't block; these are terminology
inconsistencies, not semantic errors. The documents' meaning is clear
from context.

**Default if no response.** Fix in the next architect session that
touches these files.

**Resolution (2026-04-12).** Noted for follow-up. Not blocking.

---

## Resolution summary

All questions now have Resolution blocks. Resolved 2026-04-11 to
2026-04-12 across two passes.

| Question | Resolution |
|---|---|
| Q-prepost-table | **Accepted.** Ship `prepost_runs` table. |
| Q-classifier-inputs | **Accepted.** Minimal built-in classifier, no user config in v1. |
| Q-multi-feature-parallel-in-review | **Accepted.** Per-item serial in v1. |
| Q-events-table-retention | **Accepted.** `sqlite: "forever"` in v1. |
| Q-scripted-pm-fidelity | **Accepted.** Fixture manifest includes all three signal types. |
| Q-goto-offset-scope | **Cut from v1.** Named `goto` covers all practical use cases. |
| Q-architecture-proposed-lifecycle | **Rejected original; updated for stages.** `needs_approval` on stage definition. |
| Q-subagent-scoping-in-default-config | **Hook templates dropped.** Safety examples move to docs. |
| Q-keep-awake-windows | **Accepted.** Accept at config-load time, warn at runtime. |
| Q-features-json-projection-timing | **Replaced by template injection.** `{{item}}` + `{{item_state}}`. |
| Q-session-log-directory-collisions | **Accepted.** `~/.yoke/<fingerprint>/` layout. |

---

## Q-needs-approval-enforcement — `pending_stage_approval` not enforced by scheduler

**Identified during:** feat-pipeline-hardening audit (2026-04-16).

**What.** The Pipeline Engine correctly sets `workflows.status = 'pending_stage_approval'`
when a stage completes and the next stage has `needs_approval: true` (engine.ts line ~1073).
However, the Scheduler's `_processWorkflow` never checks this status — it processes all
non-terminal workflows and items' `deps_satisfied` checks pass based on item status alone.
A workflow paused for stage approval would have its next-stage items start processing
immediately, bypassing the approval gate.

Additionally, the `stage_approval_granted` event is defined in the State/Event union types
but has no HTTP endpoint to fire it, and the only TRANSITIONS entry for it is the
`abandoned` no-op. There is no way to unblock a workflow paused for stage approval.

**Risk.** Low — `needs_approval` is not used in the current pipeline config. The feature is
documented in state-machine-transitions.md and the engine supports it, but it is not wired
end-to-end.

**Resolution path.** Implement when `feat-control-matrix` is built (the dashboard feature
already plans an `approve-stage` button). The scheduler needs a guard in `_processWorkflow`
to skip items in the stage following a `pending_stage_approval` workflow, and an HTTP
endpoint / WS control handler needs to fire `stage_approval_granted` + reset workflow status.
