# Pre/Post Command Action Grammar

Source: plan-draft3.md §Phase Pre/Post Commands (D50, D53).

This document is the normative definition of the `actions:` map used in
`phases.<name>.pre[*].actions` and `phases.<name>.post[*].actions`. The
JSON Schema for a single action is defined in
`yoke-config.schema.json#/$defs/action`; this file explains the semantics,
evaluation rules, and interactions with the retry ladder and artifact
validators.

---

## 1. Keys (exit-code matching)

An `actions:` map has string keys:

- `"0"`, `"1"`, `"2"`, …, `"255"` — exact exit code match.
- `"*"` — wildcard, matched when no exact key exists.

Resolution order when a command exits with code `K`:

1. If `actions[String(K)]` exists, use that action.
2. Else if `actions["*"]` exists, use that action.
3. Else the config is invalid; the Pipeline Engine treats this as a
   transition-time failure with classifier `policy` and raises a
   `pending_attention{kind=config_error}`. Configuration loading **must**
   reject this case at load time (`ajv` validation: if `pre` or `post` is
   present, its `actions` map must be non-empty and must resolve every
   realistic exit code via at least one key — we enforce presence of
   `"*"` OR a non-empty integer key set via a conditional schema below).

Plan-draft3 rule: signal-terminated commands are reported to the engine
as an exit code of `128 + signum`. Matching uses that integer.

---

## 2. Actions (plan-draft3 §Phase Pre/Post Commands)

| Action | Shape | Effect |
|---|---|---|
| `continue` | string `"continue"` | Proceed to next command in the same array. On the last command of a `post:` array, fire a `complete` event for the phase; on the last command of `pre:`, the phase proceeds to the agent spawn. |
| `goto: <phase-name>` | `{goto, max_revisits?}` | Absolute jump. The pipeline's next phase for this feature becomes `<phase-name>`. Increments the `(feature, <phase-name>)` revisit counter. |
| `goto-offset: ±N` | `{goto-offset, max_revisits?}` | Relative jump in the declared-graph order (see §4). N must be non-zero. |
| `retry` | `{retry: {mode, max}}` | Re-run the same phase with `mode ∈ {continue, fresh_with_failure_summary, fresh_with_diff}` up to `max` times. Feeds into the outer retry ladder (see §5). |
| `stop-and-ask` | string `"stop-and-ask"` | Workflow enters `awaiting_user`; a `pending_attention{kind=post_command_stop_and_ask}` row is inserted. |
| `stop` | string `"stop"` | Workflow enters `abandoned` terminally. |
| `fail` | `{fail: {reason}}` | Phase fails with `reason`; enters the outer retry ladder (see §5). |

The engine evaluates actions **sequentially**: if command #1 returns
`{retry}`, commands #2..N are not executed. The resolved action is
recorded in `prepost_runs.action_taken` (see `sqlite-schema.sql`).

---

## 3. `max_revisits` (loop guard)

Applies to `goto` and `goto-offset`. Tracked per `(feature_id,
destination_phase_label)`. Default is 3.

- On each execution of a `goto*` action, increment the counter.
- If `counter > max_revisits`, the action is dropped and the state
  machine routes to `awaiting_user` with `pending_attention{kind=
  revisit_limit, payload={feature_id, destination, limit, count}}`.
- The counter is persisted in the `events` table as event_type
  `"prepost.revisit"` so it survives restart; the Pipeline Engine
  rebuilds an in-memory count from the event stream on load.
- Counters **reset** when the feature reaches `complete`; they do not
  reset across phase reruns triggered by retries.

Rationale: plan-draft3 §Phase Pre/Post Commands explicitly mandates
"loop guard: each goto* action supports max_revisits: N (default 3)
per destination."

---

## 4. `goto-offset` resolution

The declared-graph order is a topological linearization of the
`pipeline.edges` DAG with ties broken by the order of `pipeline.nodes`
keys in the YAML document (user authorship order). This order is
computed once at config-load time and cached on the `ResolvedConfig`.

Resolution for `goto-offset: N` from phase `P`:

1. Look up `P`'s index `i` in the declared order.
2. Compute `j = i + N`.
3. If `j < 0` or `j >= len(order)`, this is a **load-time** error when
   `N` is out of bounds relative to *every* possible `P`. Otherwise it
   is a **runtime** `fail: {reason: "offset out of bounds"}` raised by
   the action runner, which feeds the outer retry ladder.
4. `order[j]` is the destination phase name. It must exist as a node in
   the graph (a config-load invariant, always true given step 1).

Edge cases:
- A graph with cycles is rejected at load time (plan-draft3 §Workflow
  Lifecycle: Plan "depends_on forms a DAG" — same rule applies to the
  pipeline graph).
- `goto-offset: 0` is rejected by the JSON Schema (`not: {const: 0}`).
- `goto: <same-phase>` is legal and is the canonical self-loop pattern
  for iterative planning.

---

## 5. Interaction with the outer retry ladder

The outer retry ladder is defined in plan-draft3 §Retry: `attempt 1 =
continue; attempt 2 = fresh_with_failure_summary; attempt 3 =
awaiting_user` (configurable via `phases.<name>.retry_ladder`).

Action grammar hooks into it as follows:

- `retry: {mode, max}` — The Pipeline Engine treats this action as
  "advance the retry counter by one and use the caller-specified mode
  for the next attempt." It does **not** reset or override the outer
  ladder; instead, the action's `max` is the maximum number of times
  this specific command's `retry` branch may fire before the Pipeline
  Engine escalates the classifier to `policy` (routing the feature to
  `awaiting_user`).
- `fail: {reason}` — Treated equivalently to `session_fail` with
  classifier `policy` and the supplied reason. The outer retry ladder
  decides whether to enter `awaiting_retry` or go straight to
  `awaiting_user` based on remaining budget.
- `continue` — No retry counter mutation.
- `goto*` — No retry counter mutation. `max_revisits` is the only loop
  guard; the outer retry counter is orthogonal.

Composability rule: **the outer retry ladder decides eligibility; the
action grammar chooses the branch.** When both fire on the same
session, the action grammar wins on "which phase next" and the retry
ladder wins on "which retry mode" if the action is `retry` without an
explicit `mode`.

---

## 6. Interaction with artifact validators

Artifact validators (`output_artifacts[*].schema`) run **after** the
agent session exits and **before** the `post:` array. Validator outcome
is a hard input to the `session_ok` / `validator_fail` events described
in `state-machine-transitions.md`.

Order of evaluation for a finished Implement phase:

```
session exit
  ├─ stream-json final frame consumed → session_ok / session_fail
  ├─ artifact validators run          → validators_ok / validator_fail
  ├─ features.json diff check         → diff_check_ok / diff_check_fail
  └─ post: commands run in order      → per-command action resolution
```

A validator failure short-circuits the `post:` array entirely: no
`post:` command runs if validators already failed. This ensures that
`post:` exit-code actions never observe a worktree in a known-invalid
state. Users who want to gate on validator output can still declare a
`post:` command like `jq .ok reviews/feature-N/security.json` — but it
runs only on valid-artifact paths.

---

## 7. Implementation contract (Phase δ)

The Pre/Post Runner exposes one typed function per command:

```ts
interface ResolvedAction {
  kind:
    | "continue"
    | "goto"
    | "goto-offset"
    | "retry"
    | "stop-and-ask"
    | "stop"
    | "fail";
  goto?: string;
  gotoOffset?: number;
  maxRevisits?: number;
  retry?: { mode: "continue" | "fresh_with_failure_summary" | "fresh_with_diff"; max: number };
  failReason?: string;
}

function runCommand(cmd: PrePostCommand, ctx: RunCtx): Promise<{
  exitCode: number;
  action: ResolvedAction;
  stdoutPath: string;
  stderrPath: string;
  startedAt: string;
  endedAt: string;
}>;
```

The Pipeline Engine consumes `ResolvedAction` and executes it inside a
SQLite transaction, recording one `prepost_runs` row and one `events`
row per command.

---

## 8. JSON Schema for a single `actions` map

This schema is a sharpening of the embedded definition in
`yoke-config.schema.json`; it exists here so reviewers have a
standalone copy to cite when the grammar changes.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://yoke.local/schemas/pre-post-actions.schema.json",
  "title": "actions map",
  "type": "object",
  "minProperties": 1,
  "propertyNames": { "pattern": "^([0-9]+|\\*)$" },
  "additionalProperties": {
    "oneOf": [
      { "type": "string", "enum": ["continue", "stop-and-ask", "stop"] },
      {
        "type": "object", "additionalProperties": false,
        "required": ["goto"],
        "properties": {
          "goto": { "type": "string", "minLength": 1 },
          "max_revisits": { "type": "integer", "minimum": 1, "default": 3 }
        }
      },
      {
        "type": "object", "additionalProperties": false,
        "required": ["goto-offset"],
        "properties": {
          "goto-offset": { "type": "integer", "not": { "const": 0 } },
          "max_revisits": { "type": "integer", "minimum": 1, "default": 3 }
        }
      },
      {
        "type": "object", "additionalProperties": false,
        "required": ["retry"],
        "properties": {
          "retry": {
            "type": "object", "additionalProperties": false,
            "required": ["mode", "max"],
            "properties": {
              "mode": { "type": "string", "enum": ["continue", "fresh_with_failure_summary", "fresh_with_diff"] },
              "max": { "type": "integer", "minimum": 1 }
            }
          }
        }
      },
      {
        "type": "object", "additionalProperties": false,
        "required": ["fail"],
        "properties": {
          "fail": {
            "type": "object", "additionalProperties": false,
            "required": ["reason"],
            "properties": { "reason": { "type": "string", "minLength": 1 } }
          }
        }
      }
    ]
  }
}
```

---

## 9. Example (from plan-draft3 §Phase Pre/Post Commands)

```yaml
phases:
  plan:
    post:
      - name: "check-needs-more-planning"
        run: ["jq", "-e", ".needs_more_planning == true", "features.json"]
        actions:
          "0": { goto: "plan", max_revisits: 3 }
          "1": "continue"
          "*": { fail: { reason: "planning-check errored" } }
```

Evaluation: exit 0 → re-enter plan up to three times per feature; exit
1 → continue to next phase in the graph; any other exit → policy fail
with the stated reason, routed through the outer retry ladder.
