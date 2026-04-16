# Prompt Template Engine Spec

Source: plan-draft3.md §Configuration → Prompt template engine (D11),
§File Contract, §Core Design Principles #1 (file-artifact
communication), §Phase Implement (input prompt via stdin).

The template engine is a hand-rolled minimal Mustache-style replacer.
No code execution, no file I/O, no shell. The Prompt Assembler is a
pure function `(template: string, ctx: PromptContext) => string`.
PromptContext is a plain object built by the Pipeline Engine from
Worktree Manager + SQLite + git helper and passed in. This shape
enables dry-run previews, unit testing, and the v1.1 "preview prompt"
dashboard affordance.

---

## 1. Syntax

Exactly one syntactic form:

```
{{variable_name}}
{{variable_name.field.subfield}}
```

Rules:

- A variable reference is `{{` + dotted identifier (`[A-Za-z_][A-Za-z0-9_.]*`) + `}}`.
- Dot-separated paths are resolved by walking the context object.
  `{{item.description}}` looks up `ctx["item"]["description"]` (Issue 2).
  Missing intermediate keys are a hard error; the template engine does
  not silently produce `undefined`.
- Whitespace inside the braces is **not** permitted in v1. `{{ foo }}`
  is a template error at assembly time (caller can `trim()` manually
  if they want spaces).
- Nested references, partials, conditionals, loops, HTML escaping,
  comments: **not supported**. Any non-matching `{{ ... }}` is a
  hard error at assembly time.
- Literal `{{` cannot appear in a template; if we ever need it, we
  add an escape. In v1 the rule is: templates never emit literal
  `{{`. Linter enforces this at load time.

---

## 2. Undefined-variable behavior

**Hard error**, with full context:

```
PromptTemplateError: unknown variable "foo"
  template: prompts/implement.md
  offset:   line 42 column 7
  context:  ...to implement {{foo}} for this item...
  known:    item, item_id, item_state, workflow_name, stage_id,
            architecture_md, handoff_entries,
            git_log_recent, recent_diff, user_injected_context
```

No empty-string fallback, no silent-substitute default. Plan-draft3:
"Undefined variable → hard error at assembly time with variable name +
template path."

A variable whose resolved value is `null` or `undefined` at assembly
time is also an error — the Pipeline Engine is responsible for
handing in a fully-populated context. If a variable is genuinely
optional (e.g., `user_injected_context` may be absent), the context
builder MUST substitute an empty string explicitly, not leave the key
missing.

---

## 3. Standard variables per phase

The variable inventory is declared in
`src/server/prompt/context.ts` (Phase δ) and frozen per plan-draft3
§Configuration. Revised per Issue 2 and Issue 3: feature-specific
variables replaced with opaque `item` and `item_state`.

### 3.1 Variables available in all phases

| Variable | Description |
|---|---|
| `workflow_name` | Project name from config |
| `stage_id` | Current stage identifier (Issue 1) |
| `architecture_md` | Contents of `architecture.md` if present, else empty string |
| `git_log_recent` | Last 20 commits (formatted) |
| `user_injected_context` | User-injected context string; empty if none (D43) |

### 3.2 Variables available in per-item stage phases

| Variable | Description |
|---|---|
| `item` | Opaque user data object from the item manifest (Issue 2). Templates access fields via dot traversal: `{{item.description}}`, `{{item.acceptance_criteria}}`, `{{item.my_custom_field}}`. The harness does not interpret any field names. |
| `item_id` | The stable item identifier extracted by `items_id` |
| `item_state` | Harness-tracked state object (Issue 3). Available fields: `item_state.status`, `item_state.current_phase`, `item_state.retry_count`, `item_state.blocked_reason` |
| `handoff_entries` | JSON array of handoff entries for this item (pretty-printed). Each entry includes a `note` field with the agent's narrative summary. |
| `recent_diff` | HEAD vs last completed-phase commit, or empty |

### 3.3 Variables available in once-stage phases

| Variable | Description |
|---|---|
| `items_summary` | Summary of all items with their current states (for planning/documentation phases that need full context) |

### 3.4 Custom variables

Additional phase-specific variables are allowed and are declared at
the phase level in `src/server/prompt/context.ts`; the engine itself
doesn't distinguish standard from custom.

### 3.5 Serialization

Objects and arrays in the context (including `item` and `item_state`)
are serialized to stable pretty-printed JSON
(`JSON.stringify(x, null, 2)`) when used at the top level (e.g.,
`{{item}}`). When accessed via dot traversal (e.g.,
`{{item.description}}`), the resolved leaf value is inserted as a
string. Non-string leaf values are serialized as JSON.

---

## 4. PromptContext builder interface

```ts
// src/server/prompt/context.ts
export interface PromptContext {
  [key: string]: string | Record<string, unknown>;
}

export interface PromptContextInputs {
  workflow: WorkflowRow;                    // from SQLite
  stage: StageConfig;                       // current stage config (Issue 1)
  item?: ItemRow;                           // present in per-item stages (Issue 2)
  itemState?: ItemStateProjection;          // harness state for current item (Issue 3)
  handoff?: HandoffFile;                    // parsed handoff.json
  worktreePath: string;
  architectureMdPath?: string;              // absolute path or undefined
  progressMdPath?: string;
  git: {
    logRecent(n: number): Promise<string>;
    diffRange(from: string, to: string): Promise<string>;
  };
  userInjectedContext?: string;
}

export async function buildPromptContext(
  phase: PhaseLabel,
  inputs: PromptContextInputs
): Promise<PromptContext>;
```

The builder:

1. Reads `architecture_md` from the worktree (or returns `""` if absent).
2. For per-item stages: populates `item` from `items.data` (opaque
   JSON blob, Issue 2) and `item_state` from harness-state columns
   (Issue 3).
3. Loads `handoff.json` via the Worktree Manager and serializes the
   entries array.
4. Calls `git.logRecent(20)` and `git.diffRange(...)` as needed.
5. Returns a `PromptContext` with string and object values. Object
   values (e.g., `item`, `item_state`) support dot-traversal in
   templates. The Pipeline Engine then calls
   `assemblePrompt(template, context)` — which is pure.

Testing rule: every unit test of prompt assembly uses a hand-rolled
`PromptContext` literal. There is no "partial context" in production;
either the builder produces a complete map or it throws.

---

## 5. Assembler interface (pure)

```ts
// src/server/prompt/assembler.ts
export function assemblePrompt(
  template: string,
  ctx: PromptContext,
  options?: { templatePath?: string }
): string;
```

Behavior:

- Single-pass scan left-to-right.
- On encountering `{{name}}`, look up `ctx[name]`.
- On hit, splice the string value into the output.
- On miss or malformed token, throw `PromptTemplateError` with
  `templatePath`, line, column, and known-keys list.

Size ceiling: the assembled prompt is returned as a plain string; the
Pipeline Engine validates its byte length against the configured
ceiling (default 4 MB per plan-draft3 §Process Management D21) before
handing it to the Process Manager. Over-ceiling is a phase failure
with a clear error (plan-draft3 §Failure Modes).

---

## 6. Shell-exec'd strings are NOT interpolated (security)

Plan-draft3 §Configuration explicit rule:

> Bootstrap `commands` and similar shell-exec'd strings do **not**
> interpolate variables in v1 (eliminates injection vector). Run with
> `spawn(cmd, args, {shell: false})`.

Concretely, the following user-facing config strings are **not** run
through the prompt assembler, and any `{{var}}` in them is a literal
(and typically a config-lint warning at load time):

- `worktrees.bootstrap.commands`
- `worktrees.teardown.script`
- `phases.<name>.pre[*].run`
- `phases.<name>.post[*].run`
- `github.*` — none are interpolated

The template engine is used **only** for files referenced by
`phases.<name>.prompt_template`.

---

## 7. Template loading

- Templates are loaded at config-load time (not lazily at phase start),
  so missing files surface as startup errors (plan-draft3 §Failure
  Modes: "prompt template missing").
- Template files are UTF-8, newline-normalized to `\n`, no BOM. The
  loader strips a BOM if present.
- A template's variable set is discovered via a simple regex scan at
  load time and cached. At assembly time we can fast-path the
  `PromptContext` check: assert every discovered variable has a value
  before running the splice loop.
- Templates are not hot-reloaded during a workflow; edits take effect
  on the next workflow start.

---

## 8. Dry-run preview

The pipeline engine exposes a preview helper:

```ts
export async function previewPrompt(
  workflowId: string,
  phase: PhaseLabel,
  featureId?: string
): Promise<{ prompt: string; context: PromptContext; bytes: number }>;
```

This calls the same context builder and assembler used in production;
the only difference is it does not spawn a child. Used by the v1.1
"preview prompt" dashboard feature and by unit tests.

---

## 9. Example

Template `prompts/implement.md` (using opaque item data, Issue 2):

```
You are implementing {{item_id}} for workflow {{workflow_name}}.

## Feature spec
{{item.description}}

## Acceptance criteria
{{item.acceptance_criteria}}

## Current status
Phase: {{item_state.current_phase}}, attempt: {{item_state.retry_count}}

## Architecture
{{architecture_md}}

## Handoff entries for this item
{{handoff_entries}}

## Recent commits
{{git_log_recent}}

## Current diff vs last completed phase
{{recent_diff}}

## User-injected guidance
{{user_injected_context}}
```

PromptContext (built by the Pipeline Engine):

```ts
{
  item_id: "feat-001",
  item: {
    id: "feat-001",
    description: "User can log in with email and password",
    acceptance_criteria: ["- accepts email/password", "- returns JWT"],
    review_criteria: ["- no plaintext passwords", "- rate limiting"],
    depends_on: [],
    category: "auth"
  },
  item_state: {
    status: "in_progress",
    current_phase: "implement",
    retry_count: 0,
    blocked_reason: null
  },
  workflow_name: "add-auth",
  stage_id: "implementation",
  architecture_md: "# Architecture\n\n...",
  handoff_entries: "[\n  {\n    \"phase\": \"implement\", ...",
  git_log_recent: "abcd123 scaffold\n1234567 schema\n...",
  recent_diff: "diff --git a/src/auth/login.ts ...",
  user_injected_context: ""
}
```

Output: the resolved string, handed to `child.stdin.end(buffer)` by
the Process Manager.

Note: `{{item.acceptance_criteria}}` resolves to a serialized JSON
array. The template author controls the rendering — if they want
bullet points, they write a template that expects bullet-point strings
in the item object, or they use `{{item}}` for the full JSON blob and
let the agent parse it.

---

## 10. Out of scope for v1

- Partials / includes (`{{> partial}}`)
- Section blocks (`{{#if}} ... {{/if}}`)
- Loops (`{{#each}} ... {{/each}}`)
- HTML/shell escaping
- Whitespace control (`{{- foo -}}`)
- File-based variable expansion (`{{file:path.md}}`)
- Dynamic variables from `post:` command outputs

If any of these become necessary, they land as a v1.1 spec update and
re-enter through the change-log. The plan-draft3 position is
deliberately minimal: the engine is a variable substituter, not a
templating framework.
