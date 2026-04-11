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
```

Rules:

- A variable reference is `{{` + ASCII identifier (`[A-Za-z_][A-Za-z0-9_]*`) + `}}`.
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
  context:  ...to implement {{foo}} for this feat...
  known:    feature_spec, feature_id, workflow_name, architecture_md,
            progress_md, handoff_entries, git_log_recent, recent_diff,
            user_injected_context
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
§Configuration. Availability per phase:

| Variable | Plan phase | Implement phase | Review phase |
|---|---|---|---|
| `workflow_name` | ✔ | ✔ | ✔ |
| `feature_id` | — | ✔ | ✔ |
| `feature_spec` | — (plan produces it) | ✔ | ✔ |
| `acceptance_criteria` | — | ✔ (serialized) | ✔ |
| `review_criteria` | — | ✔ | ✔ |
| `architecture_md` | ✔ (may be absent → empty string) | ✔ | ✔ |
| `progress_md` | — | ✔ | ✔ |
| `handoff_entries` | — | ✔ (JSON array, pretty-printed) | ✔ |
| `git_log_recent` | ✔ (last 20 commits) | ✔ | ✔ |
| `recent_diff` | — | ✔ (HEAD vs last review commit, or empty) | ✔ |
| `user_injected_context` | — | ✔ (string; empty if none) | ✔ |
| `feature_list` | ✔ (formatted JSON for re-plan) | — | — |
| `review_angle` | — | — | ✔ (subagent-specific) |

"Serialized" means the context builder converts arrays/objects to a
stable pretty-printed string (`JSON.stringify(x, null, 2)` or a purpose
rendering) before insertion. The template engine itself only
substitutes strings; non-string values are a context-builder bug.

Additional phase-specific variables are allowed and are declared at
the phase level in `src/server/prompt/context.ts`; the engine itself
doesn't distinguish standard from custom.

---

## 4. PromptContext builder interface

```ts
// src/server/prompt/context.ts
export interface PromptContext {
  [key: string]: string;
}

export interface PromptContextInputs {
  workflow: WorkflowRow;                    // from SQLite
  feature?: FeatureRow;                     // present in implement/review
  handoff?: HandoffFile;                    // parsed handoff.json
  worktreePath: string;
  architectureMdPath?: string;              // absolute path or undefined
  progressMdPath?: string;
  git: {
    logRecent(n: number): Promise<string>;
    diffRange(from: string, to: string): Promise<string>;
  };
  userInjectedContext?: string;
  reviewAngle?: string;                     // only for review subagents
}

export async function buildPromptContext(
  phase: PhaseLabel,
  inputs: PromptContextInputs
): Promise<PromptContext>;
```

The builder:

1. Reads `architecture_md` and `progress_md` from the worktree (or
   returns `""` if absent).
2. Loads `handoff.json` via the Worktree Manager and serializes the
   entries array.
3. Calls `git.logRecent(20)` and `git.diffRange(...)` as needed.
4. Returns a plain `PromptContext` (all string values). The Pipeline
   Engine then calls `assemblePrompt(template, context)` — which is
   pure.

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

Template `prompts/implement.md`:

```
You are implementing {{feature_id}} for workflow {{workflow_name}}.

## Feature spec
{{feature_spec}}

## Architecture
{{architecture_md}}

## Progress so far
{{progress_md}}

## Handoff entries for this feature
{{handoff_entries}}

## Recent commits
{{git_log_recent}}

## Current diff vs last reviewed commit
{{recent_diff}}

## User-injected guidance
{{user_injected_context}}
```

PromptContext (built by the Pipeline Engine):

```ts
{
  feature_id: "feat-001",
  workflow_name: "add-auth",
  feature_spec: "User can log in with email and password\n- accepts ...",
  architecture_md: "# Architecture\n\n...",
  progress_md: "# Progress\n\n- scaffolded routes...",
  handoff_entries: "[\n  {\n    \"phase\": \"implement\", ...",
  git_log_recent: "abcd123 scaffold\n1234567 schema\n...",
  recent_diff: "diff --git a/src/auth/login.ts ...",
  user_injected_context: ""
}
```

Output: the resolved string, handed to `child.stdin.end(buffer)` by
the Process Manager.

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
