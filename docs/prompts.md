# Prompts

Yoke ships a tiny prompt-template engine: it splices `{{variables}}` into the file
referenced by `prompt_template:` and hands the result to the agent. That's the entire
language. No loops, no conditionals, no partials.

This page covers:

- The template syntax (Mustache-flavored, but minimal).
- The variable inventory.
- How to write prompts that read well to the agent.

---

## Syntax

Two kinds of token, both spelled with double curly braces and no whitespace inside:

```
{{variable_name}}            top-level lookup
{{variable_name.field}}      dot traversal into an object
{{variable_name.a.b.c}}      arbitrary depth
```

That's it. There is **no** `{{#each}}`, **no** `{{#if}}`, **no** `{{> partial}}`,
**no** `{{ name }}` (whitespace inside braces). Anything else is left alone — text
like `{{ this }}` or `{{ foo }}` passes through verbatim.

### Missing keys

A token whose path doesn't resolve produces `[MISSING:<path>]` in the output.
Rendering does **not** throw. So if you typo `{{itemstate.status}}`, you'll see
`[MISSING:itemstate.status]` in the assembled prompt, not a crash. Good for debugging
your prompt; bad if you ignore it.

### Serialization

| Leaf type | Rendered as |
|---|---|
| string | the string, as-is |
| object / array | pretty-printed JSON (`JSON.stringify(value, null, 2)`) |
| number / boolean inside an object accessed via dot | JSON-stringified |
| `null` / `undefined` | `[MISSING:<path>]` |

This is convenient — `{{item}}` dumps the entire item as JSON; `{{item.acceptance_criteria}}`
dumps just the array as JSON. The agent reads JSON fine, so don't worry about
pre-formatting.

---

## Variable inventory

The harness builds the context object on every phase. Some variables are always
available; others only when the stage is `run: per-item`.

### Always available

| Variable | Type | Source |
|---|---|---|
| `{{workflow_name}}` | string | The name you typed in the New Workflow modal. |
| `{{stage_id}}` | string | The current stage's `id`. |
| `{{stage.items_from}}` | string | The current stage's manifest path (empty for `once` stages). |
| `{{architecture_md}}` | string | Contents of `architecture.md` at the worktree root, or `""` if absent. Useful for "read this first" preambles. |
| `{{git_log_recent}}` | string | Output of `git log --oneline -20` in the worktree. |
| `{{user_injected_context}}` | string | Free-form context string the dashboard can attach to a workflow run. |

### Per-item only (when `stage.run: per-item` and an item is selected)

| Variable | Type | Source |
|---|---|---|
| `{{item_id}}` | string | The id JSONPath-extracted from the manifest. |
| `{{item}}` | object | The full opaque item object from the manifest. Use `{{item.<field>}}` to get any field. |
| `{{item_state}}` | object | Harness-tracked state, **not** part of the manifest. Fields below. |
| `{{item_state.status}}` | string | E.g. `pending`, `in_progress`, `complete`, `awaiting_user`. |
| `{{item_state.current_phase}}` | string | The phase about to run. |
| `{{item_state.retry_count}}` | number | How many outer-ladder retries have fired. |
| `{{item_state.blocked_reason}}` | string | If blocked, why; else `[MISSING:...]`. |
| `{{handoff}}` | array | Parsed contents of `handoff.json` at the worktree root — the handoff entries appended by previous phases for this item. |
| `{{recent_diff}}` | string | `git diff` output between the configured refs (empty unless your phase resolves them). |

> **Note:** The skills file historically referenced `{{handoff_entries}}` and
> `{{items_summary}}`. The current engine produces `{{handoff}}` only, and
> `items_summary` isn't built. Until those names are aliased or implemented,
> reference `{{handoff}}` directly. Templates using `{{handoff_entries}}` will
> render as `[MISSING:handoff_entries]` — not fatal, but useless to the agent.

### `item.<field>` is whatever's in your manifest

Items are opaque to the harness — Yoke doesn't read your fields, it just hands the
parsed object to the engine. If your `features.json` looks like:

```json
{
  "features": [
    {
      "id": "feat-auth",
      "description": "Email + password auth with reset flow",
      "acceptance_criteria": ["AC-1: …", "AC-2: …"],
      "review_criteria": ["RC-1: …"],
      "depends_on": [],
      "category": "backend"
    }
  ]
}
```

then in your prompt you can write `{{item.description}}`, `{{item.acceptance_criteria}}`
(rendered as a JSON array), `{{item.depends_on}}`, etc. Custom fields are fine —
they just need to be in the manifest.

---

## Writing prompts for Yoke

A few habits that pay off.

### 1. Pin the role with a "read this first" line

Define an agent persona at `docs/agents/<role>.md` and have the prompt reference it:

```
You are the implementer. Read `docs/agents/implementer.md` in full before
proceeding.
```

This keeps the prompt short and the persona reusable across phases.

### 2. Demand a one-sentence declaration

Force the agent to say what it's about to do before it does it. This makes
mid-stream debugging much easier:

```
State in one sentence what you are about to build, then proceed.
```

### 3. Show the agent the state, don't describe it

Drop the variables in directly. The agent reads JSON fine:

```
## Feature spec
{{item}}

## Current state
{{item_state}}

## Handoff history for this feature
{{handoff}}

## Recent commits in this worktree
{{git_log_recent}}
```

### 4. Be explicit about deliverables

End the prompt with what to produce and when to stop:

```
When done, append a handoff entry via the typed writer:

```bash
cat <<'JSON' | node scripts/append-handoff-entry.js
{
  "phase": "implement",
  "attempt": <retry_count + 1>,
  "ts": "<ISO timestamp>",
  "note": "<one paragraph: what was built, what tests cover it, what is deferred>",
  "intended_files": ["<files modified>"],
  "deferred_criteria": [],
  "known_risks": []
}
JSON
```

Stop after the writer returns exit 0.
```

### 5. For review phases, demand a verdict file

The harness doesn't read agent text. It reads exit codes from your `post:` gates,
and your gates read files. So a review prompt should write a structured verdict:

```
Write `review-verdict.json` at the worktree root with one of:
  {"verdict":"PASS"}
  {"verdict":"FAIL","blocking_issues":["..."],"notes":"..."}

Do not re-implement. Stop after the verdict file is written.
```

Then your `review.post` runs `scripts/check-review-verdict.js`, which reads that
file and exits 0 / 1, which feeds the action grammar.

---

## A complete `prompts/implement.md`

```
You are the implementer. Read `docs/agents/implementer.md` before proceeding.

State in one sentence what you are about to build, then proceed.

You are implementing feature **{{item_id}}** for workflow **{{workflow_name}}**.

## Feature spec
{{item}}

## Current state
Phase: {{item_state.current_phase}} | Attempt: {{item_state.retry_count}}

## Architecture
{{architecture_md}}

## Handoff entries for this feature
{{handoff}}

## Recent commits
{{git_log_recent}}

## Recent diff
{{recent_diff}}

## User guidance
{{user_injected_context}}

---

Implement the feature. Write tests covering each acceptance criterion. Commit in
small batches. Run `pnpm test` and `pnpm typecheck` locally and fix any failures
before declaring done.

When done, append a handoff entry via the typed writer — never edit `handoff.json`
directly:

```bash
cat <<'JSON' | node scripts/append-handoff-entry.js
{
  "phase": "implement",
  "attempt": <retry_count + 1>,
  "ts": "<ISO 8601 timestamp>",
  "note": "<what was built, tests added, anything deferred>",
  "intended_files": ["<files modified>"],
  "deferred_criteria": [],
  "known_risks": []
}
JSON
```

Stop after the writer returns exit 0.
```

---

## A complete `prompts/review.md`

```
You are the reviewer. Read `docs/agents/reviewer.md` before proceeding.

State in one sentence what you are about to verify, then proceed.

You are reviewing feature **{{item_id}}** for workflow **{{workflow_name}}**.

## Feature spec
{{item}}

## Implementer's handoff
{{handoff}}

## Diff under review
{{recent_diff}}

## Recent commits
{{git_log_recent}}

---

For each acceptance criterion and review criterion in the feature spec, cite
specific evidence from the diff or the code. Identify blocking issues separately
from non-blocking observations.

Write `review-verdict.json` at the worktree root:

  {"verdict":"PASS"}

or

  {"verdict":"FAIL","blocking_issues":["..."],"notes":"..."}

If FAIL, also append a handoff entry with phase "review" via
`scripts/append-handoff-entry.js`, including the same blocking issues.

Do not re-implement. Stop after the verdict file (and handoff entry, if FAIL) are
written.
```

---

## Common mistakes

### Handlebars syntax

```
{{#each item.acceptance_criteria}}
- {{this}}
{{/each}}
```

This **is not supported**. The token `{{#each item.acceptance_criteria}}` doesn't
match the engine's identifier pattern, so it passes through verbatim — your prompt
will literally contain the `{{#each …}}` text. Reference the array as a single
value (`{{item.acceptance_criteria}}`) and let the agent render it.

### Whitespace inside braces

```
{{ workflow_name }}      ← does NOT match; passes through as-is
{{workflow_name}}        ← matches
```

### Inventing variables

Anything not in the inventory above resolves to `[MISSING:<path>]`. If you find
yourself wanting `{{item.score}}` or `{{previous_review_verdict}}`, the answer is
either:

- **Put it in the manifest** (and reference via `{{item.<field>}}`), or
- **Read it from a file in the prompt** (have the agent open the file), or
- **Pipe it through `handoff.json`** (the previous phase appends it; this phase reads
  it via `{{handoff}}`).

---

## See also

- [Configuration reference](configuration.md) — `prompt_template`, `pre`, `post`.
- [Templates guide](templates.md) — pipeline shapes that drive these prompts.
- [Recipes](recipes/) — full prompts for real workflows.
