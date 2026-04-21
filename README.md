# Yoke

An open-source, configurable AI agent harness that wraps Claude Code to drive long-running, multi-phase software workflows — planning, implementation, review, QA — with state durability, crash recovery, and a live dashboard.

---

## Quick start

```sh
# Install dependencies
pnpm install

# Scaffold a template in your project directory
yoke init

# Edit the template to describe your workflow
$EDITOR .yoke/templates/default.yml

# Start the server
yoke start

# Open the dashboard URL shown in the terminal (e.g. http://127.0.0.1:7777)
# 1. Pick a template from the template picker grid.
# 2. Enter a workflow name (e.g. "add-auth-v2").
# 3. Click Run.
```

---

## What Yoke is

- **A harness, not an IDE.** Yoke launches Claude Code (or any configured agent command) in git worktrees, captures stream-json output, persists state in SQLite, and enforces phase transitions defined by your template config.
- **Template-driven.** Each template (`*.yml` under `.yoke/templates/`) declares a reusable pipeline shape. You can have multiple templates (e.g. `build-only.yml`, `plan-build.yml`). One template creates many workflow instances, each with its own name and isolated worktree.
- **Command-agnostic.** Each phase declares `command` and `args`; default is `claude`. You can scope agent sessions however you like.
- **Quality gates are your choice.** Phase acceptance is: agent exited clean + all configured `post:` commands passed + artifact validators passed.
- **Single-user forever.** Binds to 127.0.0.1, no auth, no multi-tenant.
- **Laptop-primary.** Opt-in `keep_awake: true` spawns `caffeinate -i` (macOS) or `systemd-inhibit` (Linux) as a workflow child.
- **Dogfoods itself.** Yoke's own development is driven by Yoke.

---

## User flow

```
yoke init
   └─▶ .yoke/templates/default.yml created

Edit .yoke/templates/default.yml
   └─▶ set template.name, configure pipeline stages and phases

yoke start [--config-dir <repo-root>]
   └─▶ server starts at http://127.0.0.1:7777
   └─▶ scheduler pauses all in-flight workflows (startup-pause)

Open the dashboard
   └─▶ template picker grid shows all .yoke/templates/*.yml files

Pick a template → enter workflow name → click Run
   └─▶ POST /api/workflows creates a workflow instance in SQLite
   └─▶ workflow appears in the sidebar with status "pending"

Click Continue in the PausedBanner (or wait — it auto-continues after startup)
   └─▶ scheduler picks up the workflow on the next tick
   └─▶ agent sessions spawn per phase; output streams live in the dashboard
```

---

## Template structure

A template lives at `.yoke/templates/<name>.yml`:

```yaml
version: "1"

template:
  name: build-only          # displayed in the UI picker
  description: "One-shot build phase (no plan or review)"

pipeline:
  stages:
    - id: implement
      run: per-item          # or: once
      items_from: docs/idea/features.json
      items_list: "$.features"
      items_id: "$.id"
      phases:
        - implement

phases:
  implement:
    command: claude
    args:
      - "--output-format"
      - "stream-json"
      - "--verbose"
    prompt_template: .yoke/prompts/implement.md
    post:
      - name: run-tests
        run: ["pnpm", "test"]
        actions:
          "0": continue
          "*":
            retry:
              mode: fresh_with_failure_summary
              max: 2
```

---

## CLI reference

| Command | Description |
|---|---|
| `yoke init` | Scaffold `.yoke/templates/default.yml` in the current directory |
| `yoke start [--config-dir <path>] [--port <n>]` | Start the pipeline engine and dashboard |
| `yoke status` | Show running workflow status |
| `yoke cancel <workflow-id>` | Cancel a running workflow |
| `yoke doctor` | Validate `.yoke/templates/` configuration |

### `yoke start` flags

| Flag | Default | Description |
|---|---|---|
| `--config-dir <path>` | `.` (cwd) | Repo root containing `.yoke/` folder |
| `--port <n>` | `7777` | Server port |
| `--no-scheduler` | — | Dev mode: serve the API/WS from the existing DB without advancing items |

> **Note:** the old `--config <file>` flag has been removed. Use `--config-dir` to point at the repo root; templates are discovered automatically under `.yoke/templates/`.

---

## Dashboard surfaces

- **Template picker** — grid of all `.yoke/templates/*.yml` files with name and description. Click to open the new-workflow modal.
- **Workflow list** — sidebar showing all workflow instances (name, status, last-updated). Filter by status.
- **Feature board** — per-item status cards for the current workflow.
- **Live stream pane** — real-time agent output (text, tool calls, thinking blocks).
- **Review panel** — specialized view for phases that use the `Task` tool.
- **Control matrix** — Cancel / Pause / Continue / Retry buttons scoped to the current workflow and item state.
- **Attention banner** — actionable notices (bootstrap failures, user-intervention prompts). Click Resume or Dismiss.
- **GitHub button** — Create PR or view the auto-created PR once the workflow completes.

---

## Configuration reference

See `docs/design/schemas/yoke-config.schema.json` for the full JSON Schema.

Key top-level fields:

```yaml
version: "1"          # required; must be "1"
template:
  name: string        # required; shown in the UI picker
  description: string # optional; shown in the UI picker

pipeline:
  stages:
    - id: string
      run: once | per-item
      phases: [string, ...]
      # per-item only:
      items_from: string         # JSONPath source file (relative to worktree)
      items_list: string         # JSONPath expression selecting the array
      items_id: string           # JSONPath expression for the stable item id
      items_depends_on: string   # JSONPath for dependency array (optional)

phases:
  <name>:
    command: string
    args: [string, ...]
    prompt_template: string      # path relative to repo root
    pre: [...]                   # pre-phase commands (optional)
    post: [...]                  # post-phase commands (optional)
    max_outer_retries: number    # default 3
    retry_ladder: [continue, fresh_with_failure_summary, awaiting_user]

github:                          # optional; enables auto-PR on workflow complete
  enabled: true
  auto_pr: true
  pr_target_branch: main
  auth_order: [env:GITHUB_TOKEN, gh:auth:token]

worktrees:
  base_dir: .worktrees
  bootstrap:
    commands: [string, ...]

runtime:
  keep_awake: true               # spawns caffeinate / systemd-inhibit

rate_limit:
  handling: passive              # back off silently when rate-limited
```

---

## Migrating from an older `.yoke.yml`

If you have a root `.yoke.yml` file from before the templates refactor, see
`docs/idea/migration-templates-refactor.md` for a step-by-step guide.

---

## Repo layout

```
src/
  cli/                   # yoke init, start, status, cancel, doctor
  server/
    api/                 # Fastify HTTP + WebSocket
    config/              # YAML loader, AJV validation, path resolver
    pipeline/            # state machine engine, retry ladder, control executor
    scheduler/           # tick loop, worktree lifecycle, ingest
    github/              # auto-PR, push, auth adapters
    notifications/       # attention notices, desktop push
    storage/             # SQLite pool, migrations
    worktree/            # git worktree manager, branch allocator
    prompt/              # prompt assembler (pure), context builder
    process/             # process manager, stream-json parser
  shared/
    types/               # shared TypeScript types (WorkflowRow, State, Config)
  web/
    src/                 # React dashboard (Vite + Tailwind)
    e2e/                 # Playwright end-to-end tests
docs/
  design/                # architecture, protocol specs, schemas
  agents/                # agent persona files (backend, frontend, qa)
  idea/                  # feature manifests, future work, runbook
tests/                   # Vitest unit + integration tests
```

---

## Development

```sh
pnpm install           # install all dependencies
pnpm test              # run Vitest unit + integration tests
pnpm typecheck         # TypeScript type check (root + web workspace)
pnpm --filter web dev  # start the Vite dev server for the dashboard
pnpm --filter web test:e2e  # run Playwright e2e tests
pnpm build             # build the server CLI
pnpm --filter web build     # build the dashboard
```

---

## License

TBD (will be set before the first public release).
