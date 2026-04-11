# State Machine Transition Table

Source: plan-draft3.md §State Machine, §Retry, §Crash Recovery, §Phase
Pre/Post Commands (D50, D53, D61, D56).

The Pipeline Engine is the only component that applies transitions. Every
transition is: `(from_state, event) → (to_state, side_effects, guard)`
committed inside a single SQLite transaction (`db.transaction(fn)()`) before
any observable side effect.

## States (plan-draft3 §State Machine)

| State | Meaning |
|---|---|
| `pending` | feature not yet started |
| `ready` | dependencies complete, eligible to start |
| `bootstrapping` | worktree bootstrap running |
| `bootstrap_failed` | terminal until user action |
| `in_progress` | implementer session active |
| `awaiting_retry` | between failed attempt and next attempt (backoff) |
| `review` | reviewer orchestrator running |
| `review_invalid` | reviewer output failed schema validation |
| `rate_limited` | rate limit signaled; waiting with backoff (D61) |
| `awaiting_user` | retries exhausted or policy requires human decision |
| `blocked` | manual/dependency block |
| `complete` | all reviews passed |
| `abandoned` | user cancelled or workflow aborted |

## Events

Events are raised by concrete modules. This table is the closed set the
Pipeline Engine recognizes.

| Event | Raised by | Payload summary |
|---|---|---|
| `deps_satisfied` | Pipeline Engine on cascade | feature_id, satisfied dependency set |
| `phase_start` | Pipeline Engine (user command, auto-advance) | phase, retry_mode |
| `pre_commands_ok` | Pre/Post Runner | command list |
| `pre_command_failed` | Pre/Post Runner | name, exit_code, action |
| `session_spawned` | Process Manager | pid, pgid, session_id |
| `session_ok` | Process Manager | exit 0 + no error frames |
| `session_fail` | Process Manager | exit code, classifier tag |
| `rate_limit_detected` | Stream-JSON parser | reset_at (if present) |
| `rate_limit_window_elapsed` | rate_limit state timer | — |
| `post_command_ok` | Pre/Post Runner | command name |
| `post_command_action` | Pre/Post Runner | resolved action object |
| `validators_ok` | Artifact validators | paths |
| `validator_fail` | Artifact validators | path, ajv errors |
| `diff_check_ok` | Pipeline Engine | features.json unchanged |
| `diff_check_fail` | Pipeline Engine | disallowed-diff summary |
| `review_verdict_parsed` | Pipeline Engine | aggregated verdict |
| `review_verdict_missing` | Pipeline Engine | missing angles / criteria |
| `retry_budget_remaining` | retry-ladder | next_mode, next_attempt |
| `retries_exhausted` | retry-ladder | final classifier |
| `backoff_elapsed` | awaiting_retry timer | — |
| `user_retry` | HTTP control | commandId, optional inject |
| `user_block` | HTTP control | commandId, reason |
| `user_unblock_with_notes` | HTTP control | commandId, notes |
| `user_cancel` | HTTP control | commandId |
| `bootstrap_ok` | Worktree Manager | — |
| `bootstrap_fail` | Worktree Manager | error detail |

Guards and side effects are written as text below the table. They are not
prose "maybes" — every branch a concrete module can cause is enumerated.

---

## Transition table

Format: `(from, event) → to | guard | side_effects`. "side_effects" are
always additive; SQLite writes are implicit in every transition. A `—` in
guard means the transition is unconditional for that `(from, event)` pair.

### pending / ready

| From | Event | To | Guard | Side effects |
|---|---|---|---|---|
| `pending` | `deps_satisfied` | `ready` | all `depends_on` features have status ∈ {complete} | enqueue feature for scheduling |
| `pending` | `user_cancel` | `abandoned` | — | cascade-cancel dependents |
| `ready` | `phase_start` (implement/plan) | `bootstrapping` | worktree_path null or absent | invoke Worktree Manager.create |
| `ready` | `user_cancel` | `abandoned` | — | — |

### bootstrapping / bootstrap_failed

| From | Event | To | Guard | Side effects |
|---|---|---|---|---|
| `bootstrapping` | `bootstrap_ok` | `ready` → `in_progress` (same txn, then phase_start) | — | write worktree_path, branch_name |
| `bootstrapping` | `bootstrap_fail` | `bootstrap_failed` | — | insert `pending_attention{kind=bootstrap_failed}`, no auto-cleanup (§Worktree Management) |
| `bootstrap_failed` | `user_retry` | `bootstrapping` | user action recorded | re-run bootstrap |
| `bootstrap_failed` | `user_cancel` | `abandoned` | — | run teardown, remove worktree |

### in_progress

| From | Event | To | Guard | Side effects |
|---|---|---|---|---|
| `in_progress` | `pre_command_failed` → action `fail` | `awaiting_retry` or `awaiting_user` | per retry_ladder | log to events + prepost_runs |
| `in_progress` | `pre_command_failed` → action `stop-and-ask` | `awaiting_user` | — | insert pending_attention |
| `in_progress` | `pre_commands_ok` | `in_progress` | — | spawn agent session |
| `in_progress` | `session_spawned` | `in_progress` | — | stream-json parser attached |
| `in_progress` | `rate_limit_detected` | `rate_limited` | — | suppress heartbeat, schedule resume |
| `in_progress` | `session_ok` + `validators_ok` + `diff_check_ok` + all `post_command_ok` | `review` | all post actions were `continue` | enqueue review phase |
| `in_progress` | `session_ok` + any `post_command_action != continue` | per action (see below) | action map | execute goto/retry/stop/fail |
| `in_progress` | `validator_fail` | `awaiting_retry` | retry budget > 0 | increment retry_count |
| `in_progress` | `diff_check_fail` | `awaiting_retry` | retry budget > 0, classifier = `policy` | log forbidden diff (§File Contract D10) |
| `in_progress` | `session_fail` + classifier `transient` + budget | `awaiting_retry` | exponential-backoff window | record retry_history |
| `in_progress` | `session_fail` + classifier `permanent` | `awaiting_user` | — | insert pending_attention |
| `in_progress` | `session_fail` + classifier `unknown` | `awaiting_user` | — | default safe |
| `in_progress` | `retries_exhausted` | `awaiting_user` | — | — |
| `in_progress` | `user_cancel` | `abandoned` | — | SIGTERM process group |

### post_command_action dispatch

These rows expand the `session_ok + post_command_action` branch above.

| From | Action | To | Guard | Side effects |
|---|---|---|---|---|
| `in_progress` | `continue` | fallthrough to review (if last post) | — | — |
| `in_progress` | `{goto: <phase>}` | `ready` for `<phase>` | `max_revisits > current_visits` | increment revisit counter, phase_start |
| `in_progress` | `{goto-offset: ±N}` | `ready` for resolved phase | resolved phase exists and `max_revisits > visits` | — |
| `in_progress` | `{retry: {mode, max}}` | `awaiting_retry` | current retry_count < max | set next retry_mode |
| `in_progress` | `stop-and-ask` | `awaiting_user` | — | insert pending_attention |
| `in_progress` | `stop` | `abandoned` | — | cleanup worktree per config |
| `in_progress` | `{fail: {reason}}` | `awaiting_retry` if budget else `awaiting_user` | — | record reason in events |
| any | goto exceeds `max_revisits` | `awaiting_user` | — | insert pending_attention{kind=revisit_limit} |

### awaiting_retry

| From | Event | To | Guard | Side effects |
|---|---|---|---|---|
| `awaiting_retry` | `backoff_elapsed` | `in_progress` | retry budget remaining | compute next retry_mode from ladder, assemble prompt |
| `awaiting_retry` | `retries_exhausted` | `awaiting_user` | — | insert pending_attention |
| `awaiting_retry` | `user_cancel` | `abandoned` | — | — |

### rate_limited (D61)

| From | Event | To | Guard | Side effects |
|---|---|---|---|---|
| `rate_limited` | `rate_limit_window_elapsed` | `in_progress` | window reset_at ≤ now | fresh session (not `-c`); handoff.json seeded with last attempt |
| `rate_limited` | `user_retry` | `in_progress` | user forced early resume | fresh session |
| `rate_limited` | `user_cancel` | `abandoned` | — | — |
| `rate_limited` | `rate_limit_detected` | `rate_limited` | idempotent — refresh reset_at | extend timer |

### review / review_invalid

| From | Event | To | Guard | Side effects |
|---|---|---|---|---|
| `review` | `session_ok` | (parse verdicts) → `review` or `review_invalid` | — | ajv each `reviews/feature-N/*.json` |
| `review` | `review_verdict_parsed` verdict=pass | `complete` | every criterion has a verdict | unlock dependents via `deps_satisfied` cascade |
| `review` | `review_verdict_parsed` verdict=fail | `in_progress` (fresh) | review round < `max_review_rounds` | seed handoff.json entry with notes; retry_mode from `on_review_fail` (D56) |
| `review` | `review_verdict_parsed` verdict=fail | `awaiting_user` | review round == max | insert pending_attention |
| `review` | `review_verdict_missing` | `review_invalid` | — | — |
| `review_invalid` | `phase_start` | `review` | revisit ≤ 1 | delete partial `reviews/feature-N/*` before rerun |
| `review_invalid` | `retries_exhausted` | `awaiting_user` | — | — |
| `review` | `session_fail` + classifier `transient` | `awaiting_retry` | — | — |

### awaiting_user / blocked / complete / abandoned

| From | Event | To | Guard | Side effects |
|---|---|---|---|---|
| `awaiting_user` | `user_retry` | `in_progress` (fresh) | — | consume `user_injected_context` from handoff.json |
| `awaiting_user` | `user_block` | `blocked` | — | record blocked_reason |
| `awaiting_user` | `user_cancel` | `abandoned` | — | — |
| `blocked` | `user_unblock_with_notes` | `in_progress` (fresh) | — | append handoff entry seeded with notes |
| `blocked` | `user_cancel` | `abandoned` | — | — |
| `blocked` | `deps_satisfied` | `blocked` | — | no-op (blocking is manual, not dep-driven) |
| `complete` | `deps_satisfied` | `complete` | — | no-op |
| `abandoned` | any | `abandoned` | — | no-op |

### Cascade on terminal transitions (D08, D59)

A transition to `awaiting_user`, `blocked`, or `abandoned` triggers a
cascading `blocked` with `blocked_reason: "dependency <feat-id> <status>"`
on every transitive dependent, in the same SQLite transaction. Features
with no dependency relation continue to execute in topological order.

---

## Guard mechanics

- **Retry budget**: phase-level `max_outer_retries` minus `features.retry_count`
  in the current retry window; the window starts at the first transient
  failure and resets on `in_progress → review` (success).
- **Backoff**: exponential with jitter, upper bound at `retry_window_start +
  N` seconds where N comes from the classifier policy (transient only).
  Wall-clock timer handled by a single node-side scheduler — not a SQLite
  trigger.
- **Classifier**: the failure classifier consumes stderr + stream-json
  parse state + event context and returns one of
  `{transient, permanent, policy, unknown}`. `unknown` always routes to
  `awaiting_user` (D07).
- **max_revisits** (D53): tracked per `(feature_id, destination phase)`
  in a `pending_attention.payload` counter or equivalent in-memory
  projection seeded from `events` on restart.

---

## Test assertion list (unit + integration)

These assertions live in `src/server/state-machine/transitions.test.ts`
(unit) and `tests/integration/state-machine.spec.ts`. Each corresponds to
a failure mode table row (plan-draft3 §Failure Modes) or a v1 Acceptance
scenario (§v1 Acceptance).

1. Every `(state, event)` pair in this document has a defined row.
   Completeness test iterates the cartesian product and fails on any
   missing pair.
2. No `from → to` row targets a state not in the state enum.
3. `pending → ready` triggers only when all depends_on are `complete`;
   mixed states leave feature in `pending`.
4. `ready → bootstrapping → ready → in_progress` runs inside one logical
   scheduling tick (no intermediate external side effects visible).
5. `bootstrap_failed` never auto-transitions; only `user_retry` or
   `user_cancel` can leave it.
6. `in_progress → review` requires `session_ok ∧ validators_ok ∧
   diff_check_ok ∧ all post commands resolved to continue`.
7. `in_progress → awaiting_retry` on transient failure increments
   `features.retry_count` exactly once.
8. `in_progress → rate_limited` suppresses the heartbeat "stalled"
   warning for the duration of the state (D61, §Heartbeat).
9. `rate_limited → in_progress` only on `rate_limit_window_elapsed` or
   explicit `user_retry`; never on `session_ok` (no session to observe).
10. `review → complete` requires every planner-defined
    `acceptance_criterion` and `review_criterion` has a verdict; missing
    → `review_invalid`.
11. `review_invalid` deletes partial review files before rerunning.
12. `review → in_progress` on fail uses the `on_review_fail.retry_mode`
    override (D56); default is `fresh`.
13. `post_command_action={goto: X}` transitions `in_progress → ready` for
    X; `max_revisits` counter increments and trips at the configured
    bound.
14. `post_command_action={goto-offset: N}` resolves against the
    declared phase graph in edge order; unknown offset → `fail` with
    reason `"offset out of bounds"`.
15. `post_command_action=stop-and-ask` always lands in `awaiting_user`
    with a `pending_attention` row; banner visible until acknowledged.
16. `user_cancel` is accepted from every non-terminal state and always
    terminates in `abandoned`.
17. Terminal transitions of a feature cascade-block every transitive
    dependent in the same transaction.
18. Every transition writes an `events` row with the same
    `(workflow_id, feature_id, session_id, phase)` correlation set used
    by structured logging.
19. On harness restart, transitions recorded in SQLite are idempotent:
    replaying the recovery path produces zero state delta.
20. `pre_command_failed` with no matching action key falls through to
    `"*"`; absent `"*"` is a config-validation error at load time.

---

## Restart projection

Plan-draft3 §Crash Recovery: on restart, the Pipeline Engine rebuilds its
short-lived projection by:

1. Load all workflows with non-terminal status.
2. For each feature, read its latest `session` row and probe
   `kill(pid, 0)`; any stale PID marks its session `cancelled` and the
   feature lands in `awaiting_user` (default, D60) or `in_progress`
   (`auto_resume: true`).
3. For features in `review`, delete partial `reviews/feature-N/*` files.
4. For features in `rate_limited`, reseat the window timer from the
   last known `reset_at` on the corresponding `events` row.
5. Write a `recovery_state` JSON on each affected workflow for the
   dashboard banner (D27).

No transition is applied during restart itself — restart only sets
`recovery_state`; the user's subsequent `user_retry` or `auto_resume`
fires the normal `(awaiting_user, user_retry) → in_progress` row.
