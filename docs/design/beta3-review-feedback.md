# Phase β.3 Review Feedback

User review of Phase β design artifacts, conducted 2026-04-11 to 2026-04-12.
This file is input to a new β.1 architect session that will update the affected
design artifacts. Do not delete this file until the revised artifacts pass the
β.3 gate.

---

## Issue 1: Pipeline needs a "stages" layer

### Problem

The current `pipeline` config (`nodes` + `edges`) has no way to express that
some phases run once per workflow and others run once per item. The harness
implicitly knows that "plan" runs once and "implement + review" iterate over
features — but that knowledge is baked into the engine, not declared in config.

### Agreed direction

Add a `stages` concept. A stage is the **iteration unit**: it groups an ordered
sequence of phases and declares whether they run `once` (per workflow) or
`per-item` (per item in a manifest file). Stage-to-stage transitions are always
sequential (stage N completes, then stage N+1 starts). Stage-level `goto` is
deferred — not a v1 or v1.1 concern.

```yaml
pipeline:
  stages:
    - id: plan
      run: once
      phases: [plan]

    - id: implementation
      run: per-item
      items_from: features.json       # read after "plan" stage completes
      phases: [implement, review]     # sequential within each item

    - id: documentation
      run: once
      phases: [update-docs]
```

Within a `per-item` stage, phases are ordered. The existing `post:` action
grammar (`goto: <phase>`, `retry`, etc.) applies to phase-to-phase transitions
**within** the same stage for the same item. This naturally handles the
review-fail-to-implement retry loop.

### Cascading effects

- `yoke-config.schema.json` `pipeline` section: replace `nodes` + `edges` with
  `stages` array. Each stage has `id`, `run`, `phases`, and (for `per-item`
  stages) `items_from` + `items_id` + optional `items_display`.
- `state-machine-transitions.md`: transitions now scoped within stages; add
  stage-level completion events.
- `protocol-websocket.md`: subscription model may need stage awareness.
- `architecture.md`: Pipeline Engine description must reflect stages.
- `open-questions.md` Q-architecture-proposed-lifecycle resolution references
  `edges` with `needs_approval: true` — rethink for stage-based model. Likely
  becomes a stage-level attribute or an `on_stage_complete` action.

---

## Issue 2: Items must be opaque — minimum contract only

### Problem

The current `features.schema.json` encodes the entire vocabulary of the default
plan-implement-review workflow: `acceptance_criteria`, `review_criteria`,
`category`, `priority`, `depends_on`, etc. The harness validates against this
schema, which forces every user into our decomposition model. Users with
different mental models (tasks, stories, modules, components) cannot use the
iteration machinery without producing fake "features" in our format.

### Agreed direction

The harness requires **three things** from the item manifest, configured
per-stage:

```yaml
items_from: features.json       # path to the file (written by a prior "once" stage or pre-existing)
items_list: $.features          # JSONPath expression -> array of item objects
items_id: $.id                  # JSONPath expression evaluated per item -> stable string ID
```

Everything else in the item object is **opaque**. The harness:

1. Reads the file at `items_from`
2. Evaluates `items_list` to get the array
3. For each element, evaluates `items_id` to get a stable identifier
4. Stores each item in SQLite as an opaque JSON blob keyed by that ID
5. Passes each item to prompt templates as `{{item}}` — users reference fields
   via template traversal (`{{item.description}}`, `{{item.acceptance_criteria}}`,
   `{{item.my_custom_field}}`)

No field names are baked into the harness. No ID patterns are enforced (the
`^feat-[a-z0-9][a-z0-9-]*$` regex is gone from the harness contract; it may
remain in the default workflow's recommended schema).

For dashboard rendering, an optional `items_display` config:

```yaml
items_display:
  title: $.description           # what to show as the row label
  subtitle: $.category           # optional secondary text
```

If omitted, the dashboard shows the raw ID.

### Cascading effects

- `features.schema.json`: becomes a **recommended** schema for the default
  workflow, not a harness requirement. Ships as
  `docs/templates/schemas/features.schema.json` or similar. Remove all
  harness-state fields (status, blocked_reason, implemented_in_commit,
  current_phase, created_by_session_id, last_updated_by_session_id) — those
  belong in SQLite only.
- `review.schema.json`: same treatment — becomes a recommended format for the
  default workflow's review prompt templates. The harness does NOT parse review
  files; pass/fail is determined by the review phase's `post:` commands or by
  the agent writing to `.yoke/status-updates.jsonl`.
- `handoff.schema.json`: the `feature_id` field pattern is no longer a harness
  constraint. The harness-managed handoff entries should reference items by
  whatever ID the `items_id` expression extracts.
- `yoke-config.schema.json`: add `items_from`, `items_list`, `items_id`,
  `items_display` to the stage definition.
- `prompt-template-spec.md`: replace feature-specific variables
  (`{{feature_spec}}`, `{{acceptance_criteria}}`) with `{{item}}` traversal.
  Document that the template engine walks the opaque item object.
- `sqlite-schema.sql`: the `features` table should probably be renamed to
  `items` and store opaque `data TEXT NOT NULL` (JSON blob) alongside
  harness-state columns.

---

## Issue 3: Harness state must be separated from user data

### Problem

The current `features.schema.json` mixes two concerns:

- **User data** (what the planner defined): `description`, `acceptance_criteria`,
  `review_criteria`, `category`, `priority`, `depends_on`
- **Harness state** (what the harness tracks over time): `status`,
  `blocked_reason`, `implemented_in_commit`, `current_phase`,
  `created_by_session_id`, `last_updated_by_session_id`

This mix is what makes the schema feel coercive. The planner produces data; the
harness tracks state. These should live in different places.

### Agreed direction

- **User data** lives in the item file (opaque to harness, as described in
  Issue 2). The planner writes it. The harness reads it only to enumerate items
  and extract IDs.
- **Harness state** lives in SQLite only. The `items` (formerly `features`)
  table has columns for `status`, `current_stage`, `current_phase`,
  `retry_count`, `blocked_reason`, etc. These are never in the user's file.

When the harness injects per-item context into prompt templates, it provides
both:
- `{{item}}` — the opaque user data blob (from the item file / SQLite `data` column)
- `{{item_state}}` — the harness-tracked state (status, phase, retry count, etc.)

This way, a prompt template can say:

```markdown
## Feature
{{item.description}}

## Current status
Phase: {{item_state.current_phase}}, attempt: {{item_state.retry_count}}
```

### Cascading effects

- `features.schema.json`: purge all harness-state fields.
- `sqlite-schema.sql`: `items` table has explicit state columns + opaque `data`
  JSON blob.
- `protocol-websocket.md`: item state events carry both the item ID and the
  harness state, not the full user data blob (unless the dashboard needs it for
  display, in which case it requests it separately).

---

## Issue 4: Review aggregation is not a harness primitive

### Context (follows from Issues 1-3)

The current design has the harness reading `reviews/feature-N/*.json`, parsing
them against `review.schema.json`, and aggregating verdicts (any fail -> fail).
With opaque items and user-defined workflows, this doesn't hold: a user might
not have a review phase at all, or their review output might be in a completely
different format.

### Agreed direction

Review aggregation is **not** built into the harness engine. Instead:

- A review phase is just a phase like any other.
- Whether review "passed" or "failed" is determined by the phase's `post:`
  commands. For example, a post command that reads
  `reviews/item-{{item_id}}/*.json` and checks for any `"verdict": "fail"`.
- The default workflow ships this post command as part of the recommended
  `.yoke.yml` template.
- The harness provides the primitives: the `post:` action grammar routes
  `fail` back to an earlier phase in the same stage (e.g., `goto: implement`).

`review.schema.json` remains as a recommended schema for the default workflow's
review agents, but the harness never parses review files.

### Cascading effects

- `architecture.md`: remove any mention of built-in review aggregation from the
  Pipeline Engine or Artifact Store modules.
- `state-machine-transitions.md`: `review_pass` and `review_fail` events become
  generic `phase_complete` and `phase_fail` events driven by post-command
  outcomes, not by review-file parsing.
- `yoke-config.schema.json`: `max_review_rounds` and `on_review_fail` on phase
  definitions may be redundant — they're subsumed by the stage-scoped `post:`
  action grammar with `goto` + `max_revisits`. Evaluate whether they add
  enough convenience to justify dedicated config keys.

---

## Summary of affected artifacts

| Artifact | Change scope |
|----------|-------------|
| `schemas/yoke-config.schema.json` | Major rewrite: stages, item config, remove review-specific keys |
| `schemas/features.schema.json` | Demote to recommended template; purge harness state fields |
| `schemas/review.schema.json` | Demote to recommended template; harness no longer parses |
| `schemas/handoff.schema.json` | Remove hardcoded ID pattern; adapt to opaque item IDs |
| `schemas/sqlite-schema.sql` | Rename features -> items; add opaque data column; adjust state columns |
| `architecture.md` | Pipeline Engine rewrite for stages; remove review aggregation |
| `state-machine-transitions.md` | Scope transitions to stages; generalize review events |
| `protocol-websocket.md` | Stage awareness; item state vs item data separation |
| `prompt-template-spec.md` | `{{item}}` + `{{item_state}}` variables; remove feature-specific vars |
| `open-questions.md` | Update Q-architecture-proposed-lifecycle for stage model |
| `hook-contract.md` | May need updates re: review phase contract |
