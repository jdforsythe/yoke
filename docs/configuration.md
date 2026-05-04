# Configuration reference

Every Yoke template is a single YAML file at `.yoke/templates/<name>.yml`. The schema
that validates it lives at [`schemas/yoke-config.schema.json`](../schemas/yoke-config.schema.json)
(or `docs/design/schemas/yoke-config.schema.json` until the schema move lands).

This page is the human-readable companion. If something here disagrees with the
schema, the schema wins — and please file a bug.

> **Heads up:** every example below is a complete, schema-valid template you can paste
> into `.yoke/templates/` and run `yoke doctor` against. We don't ship lorem-ipsum.

---

## Top-level shape

```yaml
version: "1"           # required, must be the literal string "1"

template:              # required: identity, shown in the dashboard picker
  name: my-workflow
  description: "Plan + implement + review for a single feature pass"

pipeline:              # required: the stages your workflow runs through
  stages:
    - id: ...
      run: once | per-item
      phases: [...]

phases:                # required: at least one
  <name>:
    command: claude
    args: [...]
    prompt_template: prompts/<name>.md
    pre:  [...]        # optional
    post: [...]        # optional
    output_artifacts: [...]   # optional
    max_outer_retries: 2      # optional, default 2
    retry_ladder: [...]       # optional

worktrees:    {...}    # optional
github:       {...}    # optional
runtime:      {...}    # optional
rate_limit:   {...}    # optional
notifications:{...}    # optional
retention:    {...}    # optional
ui:           {...}    # optional
safety_mode:  default  # optional: "strict" | "default" | "yolo"
```

`additionalProperties: false` is set everywhere — typos fail at load time, not
runtime.

---

## `template`

Identity, shown in the dashboard picker.

```yaml
template:
  name: plan-build-review            # required, kebab-case is conventional
  description: "Three-phase loop with a review gate"   # optional but recommended
```

`template.name` is what appears on the picker card and is used in API URLs and
notifications. It does **not** have to match the YAML filename, but matching them
keeps `.yoke/templates/<name>.yml` predictable.

---

## `pipeline.stages`

A stage groups one or more phases and decides whether they run **once per workflow**
or **once per item** in a manifest.

### `run: once`

Use this for planning passes, architecture passes, polish passes — anything that runs
exactly one time per workflow run.

```yaml
pipeline:
  stages:
    - id: planning
      description: "Decompose the brief into features.json"
      run: once
      phases: [plan]
```

### `run: per-item`

Use this when the work decomposes into a manifest of items — features, chapters,
prospects — and you want each one to flow through the same set of phases in its own
git worktree.

```yaml
pipeline:
  stages:
    - id: implementation
      description: "Build each feature with a review loop"
      run: per-item
      items_from: docs/idea/features.json
      items_list: "$.features"
      items_id: "$.id"
      items_depends_on: "$.depends_on"        # optional
      items_display:
        title: "$.description"
        subtitle: "$.category"
      phases: [implement, review]
```

The `items_*` keys are JSONPath expressions evaluated against the file at
`items_from`. They are **required** when `run: per-item`:

| Key | What it does |
|---|---|
| `items_from` | Path to the manifest JSON, relative to the worktree. |
| `items_list` | JSONPath selecting the array of items. |
| `items_id` | JSONPath selecting a stable string id per item. |
| `items_depends_on` | Optional JSONPath selecting a `string[]` of item ids this item must wait for. |
| `items_display.title` / `subtitle` / `description` | Optional JSONPath expressions; control the dashboard row label. If omitted, the dashboard shows the raw item id. |

Items are **opaque** to Yoke. Whatever shape your JSON has, Yoke makes it available
to your prompts as `{{item}}` (the whole object) and `{{item.<field>}}` (dot
traversal). The harness never reads `acceptance_criteria` or any other named field
— that's between your prompt and your reviewer.

### `needs_approval`

```yaml
- id: implementation
  needs_approval: true
  run: per-item
  ...
```

When `true`, the harness halts the workflow before the stage starts and inserts an
attention notice. The user clicks **Continue** in the dashboard (or runs `yoke ack`)
to release it. Use this for "let me read the architecture before you start coding"
gates.

---

## `phases`

A phase is one agent session. Required keys:

```yaml
phases:
  implement:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions"]
    prompt_template: prompts/implement.md
```

| Key | Purpose |
|---|---|
| `command` | The binary to spawn. Almost always `claude`. Anything on `$PATH` works. |
| `args` | argv-form. Spawned with `shell: false`. |
| `prompt_template` | Path to the prompt file, relative to the repo root. |
| `cwd` | Optional; defaults to the worktree path. Rarely useful. |
| `env` | Optional `string → string` map merged into the agent process env. |
| `description` | Shown in the dashboard list view under the phase name. |
| `max_outer_retries` | Default 2. The cap on how many times the outer ladder fires. |
| `retry_ladder` | The retry mode sequence. Default: `[continue, fresh_with_failure_summary, awaiting_user]`. |
| `pre` / `post` | See [pre / post commands](#pre--post-commands) below. |
| `output_artifacts` | See [output artifacts](#output-artifacts) below. |
| `heartbeat` | See [heartbeat](#heartbeat) below. |
| `ui.renderer` | `"review"` or `"stream"` — pin which dashboard pane this phase uses. Default is autodetect. |

### Recommended `args`

For Claude Code:

```yaml
args:
  - "-p"
  - "--output-format"
  - "stream-json"
  - "--verbose"
  - "--dangerously-skip-permissions"
  - "--model"
  - "claude-sonnet-4-6"
```

`-p` is non-interactive print mode. `stream-json` is required — Yoke parses every
event from this stream. `--dangerously-skip-permissions` lets Claude execute tool
calls without per-call confirmation; this is the common choice because Yoke runs the
agent in an isolated worktree, but you can drop the flag if you want to confirm each
tool use interactively.

---

## Pre / post commands

`pre:` runs before the agent spawns; `post:` runs after the agent exits cleanly. Both
are arrays of objects with the same shape:

```yaml
post:
  - name: run-tests
    run: ["pnpm", "test"]
    timeout_s: 300            # optional, default 900
    env:                      # optional
      CI: "1"
    actions:
      "0": continue
      "*":
        retry: { mode: fresh_with_failure_summary, max: 2 }
```

| Key | Required | Notes |
|---|---|---|
| `name` | yes | Human label, surfaced in the dashboard. |
| `run` | yes | argv array. Spawned with `shell: false`. |
| `actions` | yes | Exit-code → action map. **Must include `"*"`.** |
| `timeout_s` | no | Default 900 (15 min). |
| `env` | no | Extra env vars. |

### The action grammar

The `actions:` map is the heart of Yoke's flow control. Keys are stringified exit
codes (`"0"`, `"1"`, …) or the wildcard `"*"`. Values are one of:

| Action | Shape | Effect |
|---|---|---|
| `continue` | the bare string `continue` | Move to the next command. On the last `post:` command, complete the phase. |
| `stop-and-ask` | `stop-and-ask` | Park the workflow in `awaiting_user`; surface an attention banner. |
| `stop` | `stop` | Park the workflow in `abandoned` (terminal). |
| `goto` | `{ goto: <phase>, max_revisits?: 3 }` | Re-enter the named phase. `max_revisits` per (item, destination) defaults to 3. |
| `retry` | `{ retry: { mode, max } }` | Re-run the same phase. `mode` is one of `continue`, `fresh_with_failure_summary`, `fresh_with_diff`. |
| `fail` | `{ fail: { reason: "..." } }` | Treat the phase as failed; the outer retry ladder decides what's next. |

The **`"*"` key is required** by the schema. Templates without it are rejected at
load time. This is deliberate: every gate must say what to do for unmatched exit
codes, even if that's "continue and ignore the failure."

#### Common patterns

**Strict gate** (block on any non-zero):

```yaml
- name: typecheck
  run: ["pnpm", "typecheck"]
  actions:
    "0": continue
    "*": { retry: { mode: fresh_with_failure_summary, max: 2 } }
```

**Advisory gate** (log but never block):

```yaml
- name: lint
  run: ["pnpm", "lint"]
  actions:
    "0": continue
    "*": continue
```

**Review verdict** (loop back to implement on FAIL):

```yaml
- name: check-verdict
  run: ["node", "scripts/check-review-verdict.js"]
  actions:
    "0": continue
    "1": { goto: implement, max_revisits: 3 }
    "*": stop-and-ask
```

**Hard fail** (abandon the run on a specific code):

```yaml
- name: smoke-test
  run: ["./scripts/smoke.sh"]
  actions:
    "0": continue
    "42": { fail: { reason: "smoke test detected data corruption" } }
    "*": { retry: { mode: fresh_with_failure_summary, max: 1 } }
```

#### Resolution order

When a command exits with code `K`:

1. If `actions[String(K)]` exists, use it.
2. Else use `actions["*"]`.
3. (Schema guarantees `"*"` always exists.)

Signal-terminated commands report as exit code `128 + signum`. So a `SIGTERM` (15)
shows up as `"143"`.

#### Loop guard

Every `goto` action increments a counter keyed on `(item, destination_phase)`. When
the counter exceeds `max_revisits` (default 3), the action is dropped and the
workflow enters `awaiting_user` instead. Counters reset when the item completes;
they survive across phase reruns triggered by `retry`.

---

## `output_artifacts`

Validate files the agent was supposed to write before any `post:` command runs.

```yaml
phases:
  plan:
    command: claude
    args: [...]
    prompt_template: prompts/plan.md
    output_artifacts:
      - path: docs/idea/features.json
        schema: schemas/features.schema.json
        required: true
```

| Key | Notes |
|---|---|
| `path` | Worktree-relative file path. Required. |
| `schema` | Optional path to a JSON schema. If present, the file is validated against it (AJV). |
| `required` | Default `true`. If `true`, missing file = phase fail. |

If validators fail, the `post:` array is skipped entirely — the worktree is in a
known-bad state, so running gates against it would just produce noise.

---

## `retry_ladder` and `max_outer_retries`

When a phase fails (agent exited non-zero, validators failed, or a `post:` action
returned `fail`), the outer retry ladder decides what mode to use for the next
attempt:

```yaml
phases:
  implement:
    max_outer_retries: 2
    retry_ladder:
      - continue                       # attempt 1: pick up where it left off
      - fresh_with_failure_summary     # attempt 2: new session, prior failure summarized
      - awaiting_user                  # attempt 3: park; user resumes via dashboard
```

`max_outer_retries: 2` means the ladder fires up to twice. Once exhausted, the item
is parked in `awaiting_user` regardless.

The `mode` you pick changes what the next agent session sees:
- `continue` — same session resumes mid-stream.
- `fresh_with_failure_summary` — new session, prompt augmented with a summary of
  what failed last time.
- `fresh_with_diff` — new session, prompt augmented with the diff from the previous
  attempt.
- `awaiting_user` — not a retry mode; pauses the workflow.

---

## `heartbeat`

Liveness probe for the running session. Defaults are sane; rarely tuned.

```yaml
phases:
  implement:
    heartbeat:
      liveness_interval_s: 30
      activity_timeout_s: 90
      per_tool_budgets:
        Bash: 300
        WebFetch: 60
```

If a tool call exceeds its budget, that's a signal — Yoke logs it but does not by
itself kill the session.

---

## `worktrees`

Yoke runs every workflow inside its own git worktree, branched off your current
HEAD. Defaults are usable; override only when you need to.

```yaml
worktrees:
  base_dir: .worktrees           # default ".worktrees"
  branch_prefix: my-workflow/    # default "yoke/"
  auto_cleanup: true             # default true
  cleanup_tool: git              # "git" | "lazyworktree" | "custom"
  bootstrap:
    commands:
      - "pnpm install"
      - "cp .env.example .env"
  teardown:
    script: "scripts/cleanup-worktree.sh"
```

`bootstrap.commands` run inside the freshly-created worktree before the first phase
starts. Use this to install dependencies, copy secrets, run `make setup`, etc.

---

## `github`

Optional auto-PR on workflow completion.

```yaml
github:
  enabled: true
  auto_pr: true
  pr_target_branch: main
  auth_order:
    - env:GITHUB_TOKEN
    - gh:auth:token
  attach_artifacts_to_pr: false
  link_issues: false
```

`auth_order` controls which credential source Yoke tries first. `gh:auth:token`
shells out to the GitHub CLI; `env:GITHUB_TOKEN` reads the env var. If both fail,
the GitHub button in the dashboard surfaces the error and you can retry manually.

If you don't want PRs, omit the `github:` block entirely (or set `enabled: false`).

---

## `runtime`

```yaml
runtime:
  keep_awake: true       # default false
```

When `true`, Yoke spawns a child process to prevent the OS from sleeping during the
workflow:

- macOS: `caffeinate -i`
- Linux: `systemd-inhibit`
- Windows: no-op (deferred to a later release)

The child is tied to the workflow lifetime — when the workflow ends, the inhibitor
is released.

---

## `rate_limit`

```yaml
rate_limit:
  handling: passive       # only valid value in v0.1.0
```

Today, Yoke only supports passive backoff — when Anthropic returns a rate-limit
response, the agent sleeps and retries. Active rate limiting (e.g. "pause when usage
exceeds 80%") is a planned future option.

---

## `notifications`

```yaml
notifications:
  enabled: true
  severity_map:
    requires_attention: requires_attention
    info: info
  mechanisms:
    - { type: browser_push }
    - { type: macos_native }
```

Defaults are fine for most users. The dashboard shows attention banners regardless
of these settings.

---

## `retention`

```yaml
retention:
  sqlite: forever                 # or { max_age_days: 90 }
  stream_json_logs:
    max_age_days: 30
    max_total_bytes: 1073741824   # 1 GiB
  worktrees: workflow-completion  # "workflow-completion" | "manual" | "on-disk-pressure"
```

`worktrees: workflow-completion` (the default) deletes the worktree as soon as the
workflow ends. Set to `manual` to keep it around for inspection.

---

## `safety_mode`

```yaml
safety_mode: default     # "strict" | "default" | "yolo"
```

Advisory parameter that the example safety-hook templates read. It does **not** alter
Yoke's runtime behavior — it's a knob your prompts and gate scripts can read to
adjust their own strictness.

---

## `ui`

```yaml
ui:
  port: 3456
  bind: "127.0.0.1"
  auth: false
```

`bind` is locked to `127.0.0.1` and `auth` is locked to `false` by schema — Yoke is
single-user, local-only, by design. The `port` here is informational; the live port
is set via `yoke start --port`.

---

## A complete L3 example

Plan + per-item implement + review with a loop-back gate. This template is
schema-valid, runs against `claude`, and matches the conventions in
[skills/yoke-setup.md](../skills/yoke-setup.md):

```yaml
version: "1"

template:
  name: plan-build-review
  description: "Plan into features.json, then implement+review per feature"

pipeline:
  stages:
    - id: planning
      run: once
      phases: [plan]

    - id: implementation
      run: per-item
      items_from: docs/idea/features.json
      items_list: "$.features"
      items_id: "$.id"
      items_depends_on: "$.depends_on"
      items_display:
        title: "$.description"
        subtitle: "$.category"
      phases: [implement, review]

phases:
  plan:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions"]
    prompt_template: prompts/plan.md
    output_artifacts:
      - path: docs/idea/features.json
        required: true
    max_outer_retries: 2
    post:
      - name: check-features-json
        run: ["node", "scripts/check-features-json.js",
              "docs/idea/features.json"]
        timeout_s: 30
        actions:
          "0": continue
          "1": { retry: { mode: fresh_with_failure_summary, max: 2 } }
          "2": { goto: plan, max_revisits: 3 }
          "*": stop-and-ask

  implement:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions"]
    prompt_template: prompts/implement.md
    max_outer_retries: 2
    retry_ladder: [continue, fresh_with_failure_summary, awaiting_user]
    post:
      - name: run-tests
        run: ["pnpm", "test"]
        timeout_s: 300
        actions:
          "0": continue
          "*": { retry: { mode: fresh_with_failure_summary, max: 2 } }

  review:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions"]
    prompt_template: prompts/review.md
    post:
      - name: check-verdict
        run: ["node", "scripts/check-review-verdict.js"]
        timeout_s: 10
        actions:
          "0": continue
          "1": { goto: implement, max_revisits: 3 }
          "*": stop-and-ask

worktrees:
  base_dir: .worktrees
  branch_prefix: pbr/
  bootstrap:
    commands: ["pnpm install"]

github:
  enabled: true
  auto_pr: true
  pr_target_branch: main
  auth_order: [env:GITHUB_TOKEN, gh:auth:token]

runtime:
  keep_awake: true

rate_limit:
  handling: passive
```

---

## Validating

```sh
yoke doctor
```

Checks every template under `.yoke/templates/` against the schema, plus prerequisite
binaries (Node, git, sqlite, claude) and that every `prompt_template` and `post:`
script referenced exists on disk.

---

## See also

- [Templates guide](templates.md) — pipeline shapes and when to pick each.
- [Prompts guide](prompts.md) — variables you can reference in a `prompt_template`.
- [Recipes](recipes/) — full end-to-end examples.
